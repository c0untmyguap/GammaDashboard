// Schwab Trader API client (market data only): OAuth sign-in, token refresh, and option chains
// converted into the same compact format the CBOE loader produces.
//
// Setup: create an app at developer.schwab.com with the "Market Data" product, then put
// SCHWAB_APP_KEY, SCHWAB_APP_SECRET and SCHWAB_CALLBACK (exactly as registered) in .env.
// Sign-in: open the authorize URL, log in, copy the address you're redirected to (it fails to
// load on https://127.0.0.1, which is expected) and paste it into the app's Data panel.
// Schwab access tokens last 30 minutes (refreshed automatically); the sign-in itself lasts 7 days.
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.schwabapi.com';
const REFRESH_LIFETIME_MS = 7 * 864e5;
const INDEX = { SPX: '$SPX', NDX: '$NDX', RUT: '$RUT', VIX: '$VIX' }; // Schwab's index symbols

const etParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
const etIso = (ms) => { const p = etParts(ms); return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}:${p.second}`; };
const utcStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const ymd = (ms) => { const p = etParts(ms); return `${p.year}-${p.month}-${p.day}`; };

export function createSchwab({ dir, appKey, appSecret, callback = 'https://127.0.0.1' }) {
  const file = path.join(dir, 'schwab-tokens.json');
  let tokens = null;
  let lastError = null, lastOk = null;
  try { tokens = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { tokens = null; }
  const save = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 }); };
  const configured = () => Boolean(appKey && appSecret);
  const refreshExpiresAt = () => (tokens ? tokens.refresh_issued_at + REFRESH_LIFETIME_MS : 0);
  const connected = () => configured() && Boolean(tokens?.refresh_token) && Date.now() < refreshExpiresAt();

  async function tokenRequest(body) {
    const r = await fetch(`${API}/v1/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Schwab sign-in failed (${r.status}): ${j.error_description || j.error || 'unknown error'}`);
    return j;
  }

  // Accepts the full redirected URL (or just the code) and exchanges it for tokens.
  async function connect(pasted) {
    if (!configured()) throw new Error('Add SCHWAB_APP_KEY and SCHWAB_APP_SECRET to .env and restart the server first.');
    const raw = String(pasted || '').trim();
    let code = raw;
    if (/[?&]|:\/\//.test(raw)) { // a URL or query string: pull out ?code=
      try { code = new URL(raw.includes('://') ? raw : `https://x/?${raw.split('?').pop()}`).searchParams.get('code'); } catch { code = null; }
    }
    if (!code) throw new Error('No authorization code found. Paste the full address of the page Schwab redirected you to (it contains "?code=").');
    const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: callback });
    tokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 1800) * 1000, refresh_issued_at: Date.now() };
    save();
    lastError = null;
    return status();
  }

  function disconnect() {
    tokens = null;
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return status();
  }

  async function accessToken() {
    if (!connected()) throw new Error(tokens ? 'Schwab sign-in expired (7-day limit). Sign in again from the Data panel.' : 'Schwab is not connected.');
    if (Date.now() < tokens.expires_at - 60e3) return tokens.access_token;
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    tokens = { ...tokens, access_token: j.access_token, refresh_token: j.refresh_token || tokens.refresh_token, expires_at: Date.now() + (j.expires_in || 1800) * 1000 };
    save();
    return tokens.access_token;
  }

  async function get(p, params) {
    const url = `${API}${p}?${new URLSearchParams(params)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' } });
    if (r.status === 401) { tokens.expires_at = 0; } // force a refresh next time
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Schwab ${p} returned ${r.status}${t ? `: ${t.slice(0, 160)}` : ''}`);
    }
    return r.json();
  }

  // Option chain in the CBOE-compatible compact format used by the app.
  async function chain(sym, { days = 180 } = {}) {
    try {
      const now = Date.now();
      const d = await get('/marketdata/v1/chains', {
        symbol: INDEX[sym] || sym, contractType: 'ALL', strategy: 'SINGLE', range: 'ALL', includeUnderlyingQuote: 'true',
        fromDate: ymd(now), toDate: ymd(now + days * 864e5),
      });
      if (d.status && d.status !== 'SUCCESS') throw new Error(`Schwab chain status ${d.status}`);
      const out = toCompact(sym, d, now);
      lastOk = Date.now(); lastError = null;
      return out;
    } catch (e) {
      lastError = e.message;
      throw e;
    }
  }

  function status() {
    const exp = refreshExpiresAt();
    return {
      configured: configured(), connected: connected(), callback,
      signedInAt: tokens?.refresh_issued_at ?? null, expiresAt: tokens ? exp : null,
      hoursLeft: tokens ? Math.max(0, (exp - Date.now()) / 36e5) : null,
      lastOk, lastError,
    };
  }

  const authUrl = () => `${API}/v1/oauth/authorize?client_id=${encodeURIComponent(appKey || '')}&redirect_uri=${encodeURIComponent(callback)}`;

  return { configured, connected, connect, disconnect, chain, status, authUrl };
}

// Schwab chain JSON -> { symbol, timestamp, quote, expirations, contracts, source, delayed }
export function toCompact(sym, d, now = Date.now()) {
  const u = d.underlying || {};
  const spot = u.last || u.mark || d.underlyingPrice;
  const expIndex = new Map(), expirations = [], contracts = [];
  for (const [map, type] of [[d.callExpDateMap, 'C'], [d.putExpDateMap, 'P']]) {
    for (const [expKey, strikes] of Object.entries(map || {})) {
      const e = expKey.split(':')[0];
      for (const list of Object.values(strikes)) {
        for (const o of list) {
          if (o.isNonStandard || o.isMini) continue; // adjusted / mini contracts don't share the 100x deliverable
          if (!expIndex.has(e)) { expIndex.set(e, expirations.length); expirations.push(e); }
          const iv = o.volatility > 0 && o.volatility < 900 ? o.volatility / 100 : 0;
          const ok = (v) => (Number.isFinite(v) && v > -900 ? v : 0);
          // [expIdx, type, strike, bid, ask, last, iv, oi, volume, delta, gamma]
          contracts.push([expIndex.get(e), type, o.strikePrice, ok(o.bid), ok(o.ask), ok(o.last), iv, ok(o.openInterest), ok(o.totalVolume), ok(o.delta), ok(o.gamma)]);
        }
      }
    }
  }
  const quoteMs = u.quoteTime || u.tradeTime || now;
  return {
    symbol: sym, source: 'schwab', delayed: Boolean(d.isDelayed),
    timestamp: utcStamp(quoteMs),
    quote: {
      symbol: sym, current_price: spot, close: spot, prev_day_close: u.close ?? (spot - (u.change || 0)),
      price_change: u.change ?? 0, price_change_percent: u.percentChange ?? 0, iv30: d.volatility > 0 && d.volatility < 900 ? d.volatility : null,
      last_trade_time: etIso(u.tradeTime || quoteMs),
    },
    expirations, contracts,
  };
}
