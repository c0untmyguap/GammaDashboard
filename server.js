// GammaDesk server: serves the web app, proxies market data, and runs the paper-trading bot.
// Options chain: CBOE delayed quotes (15-min delay). Candles: Yahoo Finance chart API.
// Run: node server.js   ->   http://localhost:5173
//
// Environment variables (all optional):
//   PORT          port to listen on (default 5173)
//   APP_PASSWORD  require this password (HTTP Basic auth, any username) for every page and API call
//   DATA_DIR      folder for the paper account files (default ./data)
//   PAPER=off     don't run the paper-trading bot
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildMarket } from './public/js/data.js';
import { computeLevels, groupExps } from './public/js/levels.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PASSWORD = process.env.APP_PASSWORD || '';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Index options live under a different CBOE file and several option roots (SPX monthlies + SPXW weeklies/dailies).
const CHAIN_SRC = { SPX: { cboe: '_SPX', roots: ['SPX', 'SPXW'] }, NDX: { cboe: '_NDX', roots: ['NDX', 'NDXP'] } };
// Yahoo symbols for candles (^GSPC is unreliable intraday; ^SPX matches CBOE).
const YAHOO = { SPX: '^SPX', ES: 'ES=F', NDX: '^NDX', NQ: 'NQ=F' };

async function getChain(sym) {
  if (sym === 'ES') return getEsChain();
  const src = CHAIN_SRC[sym] || { cboe: sym, roots: [sym] };
  const r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${src.cboe}.json`, { headers: UA });
  if (!r.ok) throw new Error(`CBOE returned ${r.status} for ${sym}`);
  const d = await r.json();
  const { options, ...quote } = d.data;
  const re = new RegExp(`^(?:${src.roots.join('|')})(\\d{6})([CP])(\\d{8})$`);
  const expIndex = new Map();
  const expirations = [];
  const contracts = [];
  for (const o of options) {
    const m = o.option.match(re);
    if (!m) continue; // skips non-standard roots (e.g. binary B1SPY)
    const e = `20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`;
    if (!expIndex.has(e)) { expIndex.set(e, expirations.length); expirations.push(e); }
    // [expIdx, type, strike, bid, ask, last, iv, oi, volume, delta, gamma]
    contracts.push([expIndex.get(e), m[2], +m[3] / 1000, o.bid, o.ask, o.last_trade_price, o.iv, o.open_interest, o.volume, o.delta, o.gamma]);
  }
  return { symbol: sym, timestamp: d.timestamp, quote, expirations, contracts };
}

// ES-SPX basis: median difference of the last 6 matching 5-minute closes of ES=F and ^SPX.
async function getEsBasis() {
  return cached('basis:ES', 60_000, async () => {
    const [es, spx] = await Promise.all([getCandles('ES', '5m'), getCandles('SPX', '5m')]);
    const sp = new Map(spx.candles.map((c) => [c.time, c.close]));
    const diffs = es.candles.filter((c) => sp.has(c.time)).slice(-6).map((c) => c.close - sp.get(c.time)).sort((a, b) => a - b);
    if (!diffs.length) throw new Error('No overlapping ES/SPX bars for the basis');
    const last = es.candles[es.candles.length - 1];
    return { basis: diffs[Math.floor(diffs.length / 2)], es: last.close, esTime: last.time };
  });
}

// CME doesn't publish ES options data for free, so /ES gamma = SPX gamma shifted by the ES-SPX basis.
async function getEsChain() {
  const [spx, b] = await Promise.all([cached('chain:SPX', 60_000, () => getChain('SPX')), getEsBasis()]);
  const shift = Math.round(b.basis * 4) / 4; // ES ticks in 0.25s
  const q = spx.quote;
  return {
    ...spx, symbol: 'ES', basis: shift,
    // Spot is SPX-equivalent (SPX + basis) so ES levels are exactly SPX levels + basis; es_last is the live future.
    quote: { ...q, symbol: 'ES', current_price: q.current_price + shift, close: q.close + shift, prev_day_close: q.prev_day_close + shift, spx_price: q.current_price, basis: shift, es_last: b.es },
    contracts: spx.contracts.map((c) => { const x = c.slice(); x[2] = c[2] + shift; return x; }),
  };
}

// Compact gamma levels per expiration set, computed server-side (used by the bot, the trader and the index panel).
async function getGamma(sym) {
  return cached(`gamma:${sym}`, 60_000, async () => {
    const raw = await cached(`chain:${sym}`, 60_000, () => getChain(sym));
    const mkt = buildMarket(raw);
    const groups = {};
    for (const g of ['daily', 'weekly', 'monthly']) {
      const ex = groupExps(mkt, g, []);
      if (!ex.length) continue;
      const r = computeLevels(mkt, ex);
      groups[g] = { regime: r.regime, total: r.total, flip: r.flip, em: r.em, exps: ex, levels: Object.fromEntries(Object.entries(r.levels).map(([k, v]) => [k, v.price])) };
    }
    return { symbol: sym, spot: mkt.spot, timestamp: raw.timestamp, basis: raw.basis ?? null, groups };
  });
}

const INTERVALS = { '5m': ['5m', '5d'], '15m': ['15m', '1mo'], '15m60': ['15m', '60d'], '1h': ['60m', '3mo'], '1d': ['1d', '1y'] };
async function getCandles(sym, tf) {
  const [interval, range] = INTERVALS[tf] || INTERVALS['5m'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[sym] || sym)}?interval=${interval}&range=${range}&includePrePost=false`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Yahoo returned ${r.status}`);
  const d = await r.json();
  const res = d.chart && d.chart.result && d.chart.result[0];
  if (!res || !res.timestamp) throw new Error('No candle data');
  const q = res.indicators.quote[0];
  const candles = [];
  res.timestamp.forEach((t, i) => {
    if (q.open[i] == null || q.close[i] == null) return;
    candles.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
  });
  return { symbol: sym, tf, gmtoffset: res.meta.gmtoffset, candles };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Optional shared password (HTTP Basic auth; the username is ignored).
function authorized(req) {
  if (!PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); } // for hosting health checks
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GammaDesk", charset="UTF-8"' });
    return res.end('Password required');
  }
  try {
    if (url.pathname === '/api/paper') {
      if (!trader) return sendJson(res, 503, { error: 'Paper trader is starting' });
      return sendJson(res, 200, trader.snapshot());
    }
    if (url.pathname.startsWith('/api/')) {
      const sym = (url.searchParams.get('symbol') || 'SPY').toUpperCase();
      // ^ prefix allowed for Yahoo index symbols such as ^VIX (candles only)
      if (!/^\^?[A-Z_]{1,6}$/.test(sym)) return sendJson(res, 400, { error: 'Invalid symbol' });
      if (url.pathname === '/api/chain') return sendJson(res, 200, await cached(`chain:${sym}`, 60_000, () => getChain(sym)));
      if (url.pathname === '/api/gamma') return sendJson(res, 200, await getGamma(sym));
      if (url.pathname === '/api/candles') {
        const tf = url.searchParams.get('tf') || '5m';
        return sendJson(res, 200, await cached(`candles:${sym}:${tf}`, 60_000, () => getCandles(sym, tf)));
      }
      return sendJson(res, 404, { error: 'Unknown endpoint' });
    }
    const file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`GammaDesk running at http://localhost:${PORT}${PASSWORD ? ' (password protected)' : ''}`));

// Paper trader: runs the bot on a fake $10,000 account while this server is running.
let trader = null;
if (process.env.PAPER !== 'off') {
  import('./trader.mjs')
    .then((m) => {
      trader = m.start({
        getChain: (s) => cached(`chain:${s}`, 60_000, () => getChain(s)),
        getCandles: (s, tf) => cached(`candles:${s}:${tf}`, 60_000, () => getCandles(s, tf)),
        getGamma,
        dir: DATA_DIR,
      });
      console.log(`Paper trader running (state in ${path.join(DATA_DIR, 'paper-account.json')}). Keep this running during market hours.`);
    })
    .catch((e) => console.error('Paper trader failed to start:', e));
}
