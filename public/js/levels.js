// Gamma exposure (GEX) and key level computation.
// Convention: dealers are assumed long calls / short puts sold by customers ->
// call GEX counts positive, put GEX negative. GEX = gamma * OI * 100 * S^2 * 1%  (dollar gamma per 1% move).
import { bsGamma, yearsTo, dte } from './math.js';

export const LEVEL_DEFS = [
  { id: 'P1', label: 'P1', color: '#22c55e', desc: 'Strike with the most positive net gamma. Acts as a magnet / pin and strong support-resistance while gamma is positive.' },
  { id: 'P2', label: 'P2', color: '#4ade80', desc: '2nd most positive net gamma strike.' },
  { id: 'P3', label: 'P3', color: '#86efac', desc: '3rd most positive net gamma strike.' },
  { id: 'N1', label: 'N1', color: '#ef4444', desc: 'Strike with the most negative net gamma. Dealers hedge with the move here, so price can accelerate through it.' },
  { id: 'N2', label: 'N2', color: '#f87171', desc: '2nd most negative net gamma strike.' },
  { id: 'N3', label: 'N3', color: '#fca5a5', desc: '3rd most negative net gamma strike.' },
  { id: 'CW', label: 'Call Wall', color: '#38bdf8', desc: 'Strike at or above spot with the largest call gamma. Often caps rallies.' },
  { id: 'PW', label: 'Put Wall', color: '#f59e0b', desc: 'Strike at or below spot with the largest put gamma. Often supports selloffs.' },
  { id: 'FLIP', label: 'Gamma Flip', color: '#e879f9', desc: 'Price where total dealer gamma crosses zero. Above: volatility dampened. Below: volatility amplified.' },
  { id: 'MP', label: 'Max Pain', color: '#a78bfa', desc: 'Strike where option holders lose the most at expiration.' },
  { id: 'EMU', label: 'EM High', color: '#94a3b8', desc: 'Spot + expected move (ATM straddle of the nearest selected expiration).' },
  { id: 'EML', label: 'EM Low', color: '#94a3b8', desc: 'Spot - expected move (ATM straddle of the nearest selected expiration).' },
];

export const GROUP_DEFS = [
  { id: 'daily', label: 'Daily', style: 0, desc: 'Nearest expiration only (0DTE / next session)' },
  { id: 'weekly', label: 'Weekly', style: 2, desc: 'All expirations in the next 7 days' },
  { id: 'monthly', label: 'Monthly', style: 3, desc: 'All expirations in the next 35 days' },
  { id: 'custom', label: 'Selected', style: 1, desc: 'The expirations you picked in the selector' },
];

export function groupExps(mkt, groupId, customExps) {
  const now = Date.now();
  switch (groupId) {
    case 'daily': return mkt.exps.slice(0, 1);
    case 'weekly': return mkt.exps.filter((e) => dte(e, now) <= 7);
    case 'monthly': return mkt.exps.filter((e) => dte(e, now) <= 35);
    default: return customExps;
  }
}

const MIN_T = 1 / (365 * 24 * 4); // 15 minutes floor keeps 0DTE gamma finite

export function computeLevels(mkt, exps, spot = mkt.spot) {
  const now = Date.now();
  const rows = new Map();
  const items = []; // for the gamma profile
  const painOI = []; // [k, type, oi] for max pain
  const lo = spot * 0.7, hi = spot * 1.3;

  for (const e of exps) {
    const x = mkt.byExp.get(e);
    if (!x) continue;
    const T = Math.max(yearsTo(e, now), MIN_T);
    for (const [book, sign] of [[x.calls, 1], [x.puts, -1]]) {
      for (const o of book.values()) {
        const oi = o.oi > 0 ? o.oi : 0, vol = o.vol > 0 ? o.vol : 0;
        if (!oi && !vol) continue;
        if (oi) painOI.push([o.k, o.type, oi]);
        if (o.k < lo || o.k > hi) continue;
        const gex = oi ? bsGamma(spot, o.k, T, o.ivUsed) * oi * 100 * spot * spot * 0.01 : 0;
        let r = rows.get(o.k);
        if (!r) rows.set(o.k, (r = { k: o.k, cOI: 0, pOI: 0, cVol: 0, pVol: 0, cG: 0, pG: 0, net: 0 }));
        if (sign > 0) { r.cOI += oi; r.cVol += vol; r.cG += gex; } else { r.pOI += oi; r.pVol += vol; r.pG -= gex; }
        if (oi) items.push([o.k, T, o.ivUsed, oi * sign]);
      }
    }
  }

  const list = [...rows.values()].sort((a, b) => a.k - b.k);
  let totC = 0, totP = 0;
  for (const r of list) { r.net = r.cG + r.pG; r.abs = r.cG - r.pG; totC += r.cG; totP += r.pG; }
  const total = totC + totP;

  const pos = list.filter((r) => r.net > 0).sort((a, b) => b.net - a.net);
  const neg = list.filter((r) => r.net < 0).sort((a, b) => a.net - b.net);
  // Walls: largest call gamma at/above spot (resistance), largest put gamma at/below spot (support)
  const above = list.filter((r) => r.k >= spot), below = list.filter((r) => r.k <= spot);
  const callWall = (above.length ? above : list).reduce((m, r) => (!m || r.cG > m.cG ? r : m), null);
  const putWall = (below.length ? below : list).reduce((m, r) => (!m || r.pG < m.pG ? r : m), null);

  // Total gamma profile across hypothetical spot prices -> zero-gamma flip
  const prices = [], values = [];
  const N = 121, pLo = spot * 0.92, pHi = spot * 1.08;
  const near = items.filter((it) => Math.abs(it[0] / spot - 1) < 0.2);
  for (let i = 0; i < N; i++) {
    const s = pLo + ((pHi - pLo) * i) / (N - 1);
    let v = 0;
    for (const [k, T, iv, w] of near) v += w * bsGamma(s, k, T, iv);
    prices.push(s);
    values.push(v * 100 * s * s * 0.01);
  }
  let flip = null, bestD = Infinity;
  for (let i = 1; i < N; i++) {
    if ((values[i - 1] < 0) !== (values[i] < 0)) {
      const f = prices[i - 1] + ((prices[i] - prices[i - 1]) * -values[i - 1]) / (values[i] - values[i - 1]);
      if (Math.abs(f - spot) < bestD) { bestD = Math.abs(f - spot); flip = f; }
    }
  }

  // Max pain over strikes with open interest
  const strikes = [...new Set(painOI.map((p) => p[0]))].filter((k) => k > spot * 0.85 && k < spot * 1.15).sort((a, b) => a - b);
  let maxPain = null, minPain = Infinity;
  for (const K of strikes) {
    let pain = 0;
    for (const [k, t, oi] of painOI) pain += oi * (t === 'C' ? Math.max(K - k, 0) : Math.max(k - K, 0));
    if (pain < minPain) { minPain = pain; maxPain = K; }
  }

  // Expected move from ATM straddle of nearest selected expiration
  let em = null;
  const firstExp = [...exps].sort()[0];
  const fx = firstExp && mkt.byExp.get(firstExp);
  if (fx && fx.strikes.length) {
    const atm = fx.strikes.reduce((b, k) => (Math.abs(k - spot) < Math.abs(b - spot) ? k : b), fx.strikes[0]);
    const c = fx.calls.get(atm), p = fx.puts.get(atm);
    if (c && p) em = c.mid + p.mid;
  }

  const lv = {};
  pos.slice(0, 3).forEach((r, i) => (lv[`P${i + 1}`] = { price: r.k, gex: r.net }));
  neg.slice(0, 3).forEach((r, i) => (lv[`N${i + 1}`] = { price: r.k, gex: r.net }));
  if (callWall) lv.CW = { price: callWall.k, gex: callWall.cG };
  if (putWall) lv.PW = { price: putWall.k, gex: putWall.pG };
  if (flip) lv.FLIP = { price: flip, gex: 0 };
  if (maxPain) lv.MP = { price: maxPain };
  if (em) { lv.EMU = { price: spot + em }; lv.EML = { price: spot - em }; }

  const regime = total >= 0 ? 'positive' : 'negative';
  return { exps, rows: list, total, totC, totP, levels: lv, profile: { prices, values }, flip, em, regime, spot };
}
