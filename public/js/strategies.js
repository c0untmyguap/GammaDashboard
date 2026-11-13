// Strategy legs, presets, and position analytics (P/L, greeks, stats).
import { bs, yearsTo, expiryMs, dte, clock } from './math.js';
import { nearestStrike } from './data.js';

let legSeq = 1;
export const mult = (leg) => (leg.type === 'S' ? 1 : 100);
export const sgn = (leg) => (leg.action === 'buy' ? 1 : -1);

// Builds a leg using live chain IV and mid price.
export function makeLeg(mkt, exp, type, k, action = 'buy', qty = 1) {
  if (type === 'S') return { id: legSeq++, action, qty, type, exp: null, k: null, iv: 0, entry: mkt.spot };
  const x = mkt.byExp.get(exp);
  const book = type === 'C' ? x.calls : x.puts;
  const o = book.get(k);
  const iv = o ? o.ivUsed : x.ivAt(k);
  const entry = o ? o.mid : bs(mkt.spot, k, Math.max(yearsTo(exp), 1e-6), iv, type).price;
  return { id: legSeq++, action, qty, type, exp, k, iv, entry: +entry.toFixed(2) };
}

export function sigmaMove(mkt, exp) {
  const x = mkt.byExp.get(exp);
  return mkt.spot * x.atmIv * Math.sqrt(Math.max(yearsTo(exp), 1 / 365));
}

// Picks strikes at offsets measured in 1-sigma expected moves, keeping distinct offsets on distinct strikes.
export function strikesForOffsets(mkt, exp, offsets) {
  const x = mkt.byExp.get(exp);
  const sm = sigmaMove(mkt, exp);
  const uniq = [...new Set(offsets)].sort((a, b) => a - b);
  const idxOf = (k) => x.strikes.indexOf(nearestStrike(x, k));
  const idx = uniq.map((o) => idxOf(mkt.spot + o * sm));
  for (let i = 1; i < idx.length; i++) if (idx[i] <= idx[i - 1]) idx[i] = Math.min(idx[i - 1] + 1, x.strikes.length - 1);
  const map = new Map(uniq.map((o, i) => [o, x.strikes[idx[i]]]));
  return offsets.map((o) => map.get(o));
}

// [action, type, sigmaOffset, qty, expSlot(0 = chosen, 1 = later)]
export const PRESETS = {
  'Long Call': [['buy', 'C', 0, 1]],
  'Long Put': [['buy', 'P', 0, 1]],
  'Short Put': [['sell', 'P', -0.75, 1]],
  'Covered Call': [['buy', 'S', 0, 100], ['sell', 'C', 0.75, 1]],
  'Bull Call Spread': [['buy', 'C', 0, 1], ['sell', 'C', 0.75, 1]],
  'Bear Put Spread': [['buy', 'P', 0, 1], ['sell', 'P', -0.75, 1]],
  'Bull Put Spread': [['sell', 'P', -0.5, 1], ['buy', 'P', -1, 1]],
  'Bear Call Spread': [['sell', 'C', 0.5, 1], ['buy', 'C', 1, 1]],
  'Long Straddle': [['buy', 'C', 0, 1], ['buy', 'P', 0, 1]],
  'Short Straddle': [['sell', 'C', 0, 1], ['sell', 'P', 0, 1]],
  'Long Strangle': [['buy', 'C', 0.75, 1], ['buy', 'P', -0.75, 1]],
  'Short Strangle': [['sell', 'C', 1, 1], ['sell', 'P', -1, 1]],
  'Iron Condor': [['buy', 'P', -1.25, 1], ['sell', 'P', -0.75, 1], ['sell', 'C', 0.75, 1], ['buy', 'C', 1.25, 1]],
  'Iron Butterfly': [['buy', 'P', -1, 1], ['sell', 'P', 0, 1], ['sell', 'C', 0, 1], ['buy', 'C', 1, 1]],
  'Call Butterfly': [['buy', 'C', -0.6, 1], ['sell', 'C', 0, 2], ['buy', 'C', 0.6, 1]],
  'Put Broken-Wing Butterfly': [['buy', 'P', 0.5, 1], ['sell', 'P', 0, 2], ['buy', 'P', -1, 1]],
  'Jade Lizard': [['sell', 'P', -0.75, 1], ['sell', 'C', 0.5, 1], ['buy', 'C', 1, 1]],
  'Put Butterfly': [['buy', 'P', 0.6, 1], ['sell', 'P', 0, 2], ['buy', 'P', -0.6, 1]],
  'Call Broken-Wing Butterfly': [['buy', 'C', 0.25, 1], ['sell', 'C', 0.75, 2], ['buy', 'C', 1.5, 1]],
  'Flyagonal (call fly + put diagonal)': [['buy', 'C', 0.25, 1], ['sell', 'C', 0.75, 2], ['buy', 'C', 1.5, 1], ['sell', 'P', -0.75, 1, 0], ['buy', 'P', -1, 1, 1]],
  'Put Flyagonal (put fly + call diagonal)': [['buy', 'P', -0.25, 1], ['sell', 'P', -0.75, 2], ['buy', 'P', -1.5, 1], ['sell', 'C', 0.75, 1, 0], ['buy', 'C', 1, 1, 1]],
  'Call Calendar': [['sell', 'C', 0, 1, 0], ['buy', 'C', 0, 1, 1]],
  'Put Diagonal': [['sell', 'P', -0.5, 1, 0], ['buy', 'P', -0.25, 1, 1]],
};

export function laterExp(mkt, exp, minDays = 6) {
  const t = expiryMs(exp) + minDays * 864e5;
  return mkt.exps.find((e) => expiryMs(e) >= t) || mkt.exps[mkt.exps.length - 1];
}

export function buildPreset(mkt, name, exp) {
  const tpl = PRESETS[name];
  const far = laterExp(mkt, exp);
  const optLegs = tpl.filter((t) => t[1] !== 'S');
  const ks = strikesForOffsets(mkt, exp, optLegs.map((t) => t[2]));
  let i = 0;
  return tpl.map(([action, type, , qty, slot]) => {
    if (type === 'S') return makeLeg(mkt, null, 'S', null, action, qty);
    const k = ks[i++];
    const e = slot === 1 ? far : exp;
    return makeLeg(mkt, e, type, nearestStrike(mkt.byExp.get(e), k), action, qty);
  });
}

// --- Analytics -------------------------------------------------------------

export function netCost(legs) {
  return legs.reduce((s, l) => s + sgn(l) * l.qty * mult(l) * l.entry, 0); // + debit, - credit
}

export function firstExpiryMs(legs) {
  const t = legs.filter((l) => l.type !== 'S').map((l) => expiryMs(l.exp));
  return t.length ? Math.min(...t) : clock() + 30 * 864e5;
}

// P/L and greeks of the whole position at underlying S, evaluation time atMs, IV multiplier ivMult.
export function positionAt(legs, S, atMs, ivMult = 1) {
  const out = { pl: 0, value: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  for (const l of legs) {
    const T = l.type === 'S' ? 0 : Math.max(yearsTo(l.exp, atMs), 0);
    const r = bs(S, l.k, T, l.iv * ivMult, l.type);
    const w = sgn(l) * l.qty * mult(l);
    out.value += w * r.price;
    out.pl += w * (r.price - l.entry);
    out.delta += w * r.delta;
    out.gamma += w * r.gamma;
    out.theta += w * r.theta;
    out.vega += w * r.vega;
    out.rho += w * r.rho;
  }
  return out;
}

// Max profit/loss, breakevens and probability of profit at the first expiration.
export function strategyStats(legs, spot, atmIv, ivMult = 1) {
  if (!legs.length) return null;
  const tEnd = firstExpiryMs(legs);
  const T = Math.max((tEnd - clock()) / (365 * 864e5), 1 / 365 / 24);
  const lo = spot * 0.5, hi = spot * 1.5, N = 1000;
  const xs = [], ys = [];
  for (let i = 0; i <= N; i++) {
    const s = lo + ((hi - lo) * i) / N;
    xs.push(s);
    ys.push(positionAt(legs, s, tEnd, ivMult).pl);
  }
  // also check extremes for unlimited payoff
  const far = positionAt(legs, spot * 3, tEnd, ivMult).pl;
  const zero = positionAt(legs, spot * 0.01, tEnd, ivMult).pl;
  // payoff kinks sit on strikes, so evaluate those exactly too
  const kinks = legs.filter((l) => l.type !== 'S').map((l) => positionAt(legs, l.k, tEnd, ivMult).pl);
  let maxP = Math.max(...ys, ...kinks, far, zero), maxL = Math.min(...ys, ...kinks, far, zero);
  const unlimitedUp = far > ys[N] + 1 && far > Math.max(...ys);
  const unlimitedDown = far < ys[N] - 1 && far < Math.min(...ys);

  const be = [];
  for (let i = 1; i <= N; i++) {
    if ((ys[i - 1] < 0) !== (ys[i] < 0) && ys[i] !== ys[i - 1]) {
      be.push(xs[i - 1] + ((xs[i] - xs[i - 1]) * -ys[i - 1]) / (ys[i] - ys[i - 1]));
    }
  }

  // Lognormal probability of profit at first expiry
  const sig = atmIv * ivMult * Math.sqrt(T);
  const mu = Math.log(spot) - 0.5 * sig * sig;
  let pop = 0;
  const cdfLn = (s) => 0.5 * (1 + erf((Math.log(s) - mu) / (sig * Math.SQRT2)));
  for (let i = 1; i <= N; i++) if ((ys[i] + ys[i - 1]) / 2 > 0) pop += cdfLn(xs[i]) - cdfLn(xs[i - 1]);
  if (ys[N] > 0) pop += 1 - cdfLn(hi);
  if (ys[0] > 0) pop += cdfLn(lo);

  return { maxProfit: maxP, maxLoss: maxL, unlimitedUp, unlimitedDown, breakevens: be, pop, cost: netCost(legs), tEnd };
}

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

export function describeLegs(legs) {
  return legs.map((l) => {
    const q = l.qty > 1 || l.type === 'S' ? `${l.qty}× ` : '';
    if (l.type === 'S') return `${l.action === 'buy' ? '+' : '-'}${l.qty} shares`;
    return `${l.action === 'buy' ? '+' : '-'}${q}${l.k}${l.type} ${l.exp.slice(5)}`;
  }).join(' / ');
}

export const legDte = (l) => (l.type === 'S' ? null : dte(l.exp));
