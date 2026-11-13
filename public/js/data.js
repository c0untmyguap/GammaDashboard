// Market data loading and chain normalization.
import { expiryMs, bs, yearsTo } from './math.js';

export function mid(o) {
  if (!o) return NaN;
  if (o.bid > 0 && o.ask > 0) return (o.bid + o.ask) / 2;
  if (o.ask > 0) return o.ask / 2;
  return o.last > 0 ? o.last : NaN;
}

async function getJson(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

// Builds { symbol, spot, quote, exps[], byExp: Map(exp -> {calls, puts, strikes, ivAt(k)}) }
export async function loadMarket(symbol) {
  return buildMarket(await getJson(`/api/chain?symbol=${encodeURIComponent(symbol)}`));
}

// Shared with the server-side paper trader, which passes the raw /api/chain payload.
export function buildMarket(j) {
  const now = Date.now();
  const spot = j.quote.current_price || j.quote.close;
  const byExp = new Map();
  for (const e of j.expirations) if (expiryMs(e) > now) byExp.set(e, { exp: e, calls: new Map(), puts: new Map(), strikes: [] });

  for (const c of j.contracts) {
    const x = byExp.get(j.expirations[c[0]]);
    if (!x) continue;
    const o = { type: c[1], k: c[2], bid: c[3], ask: c[4], last: c[5], iv: c[6], oi: c[7], vol: c[8], delta: c[9], gamma: c[10] };
    const book = o.type === 'C' ? x.calls : x.puts;
    const prev = book.get(o.k);
    if (prev) {
      // Same strike listed twice (e.g. SPX monthly + SPXW on the third Friday): combine open interest and
      // volume for gamma, and keep the more actively traded contract's quotes.
      const keep = (o.vol || 0) > (prev.vol || 0) ? o : prev;
      book.set(o.k, { ...keep, oi: (prev.oi || 0) + (o.oi || 0), vol: (prev.vol || 0) + (o.vol || 0) });
    } else book.set(o.k, o);
  }

  for (const x of byExp.values()) {
    x.strikes = [...new Set([...x.calls.keys(), ...x.puts.keys()])].sort((a, b) => a - b);
    // Volatility smile from OTM quotes (puts below spot, calls above); used to fill missing/garbage IVs.
    const pts = [];
    for (const k of x.strikes) {
      const o = k < spot ? x.puts.get(k) : x.calls.get(k);
      if (o && o.iv > 0.01 && o.iv < 3 && (o.bid > 0 || o.oi > 0)) pts.push([k, o.iv]);
    }
    x.smile = pts;
    x.ivAt = (k) => interp(pts, k, 0.2);
    for (const k of x.strikes) for (const o of [x.calls.get(k), x.puts.get(k)]) {
      if (!o) continue;
      o.ivUsed = o.iv > 0.01 && o.iv < 3 ? o.iv : x.ivAt(k);
      o.mid = mid(o);
      if (!(o.mid > 0)) o.mid = bs(spot, k, Math.max(yearsTo(x.exp, now), 1e-6), o.ivUsed, o.type).price;
    }
    x.atmIv = x.ivAt(spot);
  }

  const exps = [...byExp.keys()].sort();
  return { symbol: j.symbol, timestamp: j.timestamp, loadedAt: now, spot, quote: j.quote, exps, byExp, source: j.source || 'cboe', delayed: j.delayed !== false };
}

function interp(pts, k, fallback) {
  if (!pts.length) return fallback;
  if (k <= pts[0][0]) return pts[0][1];
  if (k >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= k) lo = m; else hi = m; }
  const [k0, v0] = pts[lo], [k1, v1] = pts[hi];
  return v0 + ((v1 - v0) * (k - k0)) / (k1 - k0 || 1);
}

export const loadCandles = (symbol, tf) => getJson(`/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}`);

// Nearest listed strike for an expiration.
export function nearestStrike(x, target) {
  let best = x.strikes[0], d = Infinity;
  for (const k of x.strikes) { const dd = Math.abs(k - target); if (dd < d) { d = dd; best = k; } }
  return best;
}
