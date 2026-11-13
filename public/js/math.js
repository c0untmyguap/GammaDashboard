// Black-Scholes-Merton pricing, greeks and time helpers.
export const CFG = { r: 0.04, q: 0.012 }; // risk-free rate, dividend yield (SPY ~1.2%)

const YEAR_MS = 365 * 864e5;
const SQ2PI = Math.sqrt(2 * Math.PI);
export const pdf = (x) => Math.exp(-0.5 * x * x) / SQ2PI;

// Abramowitz & Stegun 26.2.17, |err| < 7.5e-8
export function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = pdf(x) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

// type: 'C' | 'P' | 'S' (stock). T in years. Returns per-share values.
// theta per calendar day, vega & rho per 1 vol/rate point.
export function bs(S, K, T, sigma, type, r = CFG.r, q = CFG.q) {
  if (type === 'S') return { price: S, delta: 1, gamma: 0, theta: 0, vega: 0, rho: 0 };
  if (T <= 1e-7 || !(sigma > 0)) {
    const call = type === 'C';
    return { price: call ? Math.max(S - K, 0) : Math.max(K - S, 0), delta: call ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sq);
  const d2 = d1 - sigma * sq;
  const dq = Math.exp(-q * T), dr = Math.exp(-r * T), n1 = pdf(d1);
  const gamma = (dq * n1) / (S * sigma * sq);
  const vega = (S * dq * n1 * sq) / 100;
  const decay = -(S * dq * n1 * sigma) / (2 * sq);
  if (type === 'C') {
    const Nd1 = cdf(d1), Nd2 = cdf(d2);
    return { price: S * dq * Nd1 - K * dr * Nd2, delta: dq * Nd1, gamma, vega,
      theta: (decay - r * K * dr * Nd2 + q * S * dq * Nd1) / 365, rho: (K * T * dr * Nd2) / 100 };
  }
  const Nm1 = cdf(-d1), Nm2 = cdf(-d2);
  return { price: K * dr * Nm2 - S * dq * Nm1, delta: -dq * Nm1, gamma, vega,
    theta: (decay + r * K * dr * Nm2 - q * S * dq * Nm1) / 365, rho: (-K * T * dr * Nm2) / 100 };
}

export function bsGamma(S, K, T, sigma, q = CFG.q, r = CFG.r) {
  if (T <= 1e-7 || !(sigma > 0)) return 0;
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sq);
  return (Math.exp(-q * T) * pdf(d1)) / (S * sigma * sq);
}

// Expirations settle at 16:00 New York time.
function nyOffsetHours(d) {
  const s = d.toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });
  const m = s.match(/GMT([+-]\d+)/);
  return m ? +m[1] : -5;
}
const expCache = new Map();
export function expiryMs(e) {
  if (expCache.has(e)) return expCache.get(e);
  const [y, m, d] = e.split('-').map(Number);
  const off = nyOffsetHours(new Date(Date.UTC(y, m - 1, d, 20)));
  const ms = Date.UTC(y, m - 1, d, 16 - off);
  expCache.set(e, ms);
  return ms;
}
// Overridable clock so the backtester can price trades "as of" a past moment.
let nowFn = Date.now;
export const clock = () => nowFn();
export function withClock(ms, fn) {
  const prev = nowFn;
  nowFn = () => ms;
  try { return fn(); } finally { nowFn = prev; }
}
export const yearsTo = (e, fromMs = clock()) => (expiryMs(e) - fromMs) / YEAR_MS;
export const dte = (e, fromMs = clock()) => (expiryMs(e) - fromMs) / 864e5;
export const DAY_MS = 864e5;

export function fmtExp(e, withDow = true) {
  const [y, m, d] = e.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const mon = dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const dow = dt.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return withDow ? `${dow} ${mon} ${d}` : `${mon} ${d}${y !== new Date().getUTCFullYear() ? ` '${String(y).slice(2)}` : ''}`;
}

// Seeded PRNG + normal draws for reproducible simulations.
export function rng(seed = Date.now()) {
  let s = seed >>> 0 || 1;
  const u = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) + 0.5) / 4294967296; };
  let spare = null;
  u.normal = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    const a = u(), b = u(), R = Math.sqrt(-2 * Math.log(a));
    spare = R * Math.sin(2 * Math.PI * b);
    return R * Math.cos(2 * Math.PI * b);
  };
  return u;
}

export const fmt = {
  usd: (v, d = 0) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
  num: (v, d = 2) => (+v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
  pct: (v, d = 1) => `${(v * 100).toFixed(d)}%`,
  big: (v) => {
    const a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e9) return `${s}${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${s}${(a / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${s}${(a / 1e3).toFixed(0)}K`;
    return `${s}${a.toFixed(0)}`;
  },
  bigUsd: (v) => (v < 0 ? "-$" : "$") + fmt.big(Math.abs(v)),
  signed: (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`,
};
