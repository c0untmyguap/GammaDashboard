// AI trade bot: gamma-regime contextual learner.
//
// How it learns
//  1. Market context is built from active signals (gamma regime, distance to flip, location vs walls).
//  2. Each strategy template turns the current levels into concrete legs (e.g. iron condor shorts at the walls).
//  3. Training simulates many price paths whose dynamics depend on the gamma regime (dampened + pinned toward P1
//     when dealers are long gamma, trending + jumpy when short gamma). Every strategy is scored on the same path.
//  4. Outcomes update a Beta posterior (win rate) and expectancy per (context, strategy) stored in localStorage.
//  5. Paper trades you take are scored on the real closing price at expiration and fed back with higher weight.
//  Thompson sampling over the posteriors picks the sample trades, so the bot keeps exploring.
import { rng, fmt, dte, expiryMs, fmtExp } from './math.js';
import { makeLeg, sigmaMove, positionAt, strategyStats, netCost, describeLegs, firstExpiryMs, laterExp } from './strategies.js';
import { nearestStrike, loadCandles } from './data.js';

const KEY = 'gammadesk.bot.v1';
const SIM_W = 0.05; // weight of one simulated episode
const REAL_W = 2; // weight of one scored paper trade
const MAX_W = 400; // evidence cap per (context, strategy) so the bot stays adaptive

export const SIGNALS = [
  { id: 'regime', name: 'Gamma regime', desc: 'Sign of net dealer gamma: positive = dampened / mean-reverting, negative = amplified / trending.' },
  { id: 'flip', name: 'Distance to flip', desc: 'Whether spot sits within 0.3% of the zero-gamma flip, where regime changes are likely.' },
  { id: 'walls', name: 'Location vs walls', desc: 'Where spot sits inside the put wall to call wall range.' },
  { id: 'flow', name: 'Options flow', planned: true, desc: 'Planned: unusual volume and sweep direction.' },
  { id: 'vanna', name: 'Vanna & charm', planned: true, desc: 'Planned: dealer hedging flows from vol and time decay.' },
];

// Browser storage only; the server-side paper trader persists the brain itself.
const store = typeof window !== 'undefined' ? window.localStorage : null;

function load() {
  try {
    const b = store && JSON.parse(store.getItem(KEY));
    if (b && b.post) return { signals: { regime: true, flip: true, walls: true }, journal: [], fwd: {}, ...b };
  } catch (e) { /* ignore */ }
  return { post: {}, journal: [], fwd: {}, signals: { regime: true, flip: true, walls: true } };
}
export const brain = load();
export function save() { try { store?.setItem(KEY, JSON.stringify(brain)); } catch (e) { /* ignore */ } }
export function resetBrain() { brain.post = {}; save(); }

// ---- context ---------------------------------------------------------------
export const HORIZONS = [
  { id: 'daily', label: 'Intraday', desc: '0–1 DTE, nearest expiration, intraday (daily) levels' },
  { id: 'weekly', label: 'Weekly', desc: '~1 week out, weekly (≤7d) levels' },
  { id: 'monthly', label: 'Monthly', desc: '~1 month out, monthly (≤35d) levels' },
];

// Each horizon keeps its own memory: a 0DTE iron condor and a 30-day one behave very differently.
export function marketContext(lv, horizon = 'weekly') {
  const s = lv.spot, cw = lv.levels.CW?.price, pw = lv.levels.PW?.price;
  const parts = {};
  parts.regime = lv.regime === 'positive' ? '+γ' : '−γ';
  parts.flip = lv.flip == null ? 'no-flip' : Math.abs(s / lv.flip - 1) < 0.003 ? 'at-flip' : s > lv.flip ? 'above-flip' : 'below-flip';
  let loc = 'mid-range';
  if (cw && pw && cw > pw) {
    const p = (s - pw) / (cw - pw);
    loc = p < 0 ? 'below-PW' : p > 1 ? 'above-CW' : p < 0.25 ? 'near-PW' : p > 0.75 ? 'near-CW' : 'mid-range';
  }
  parts.walls = loc;
  const sig = SIGNALS.filter((g) => !g.planned && brain.signals[g.id]).map((g) => parts[g.id]).join(' | ') || 'all';
  return { key: `${horizon}: ${sig}`, horizon, ...parts };
}

// ---- strategy templates ------------------------------------------------------
function kit(mkt, exp) {
  const x = mkt.byExp.get(exp), ks = x.strikes, S = mkt.spot, sm = sigmaMove(mkt, exp);
  const pick = (t) => nearestStrike(x, t);
  const away = (k, dir, dist) => {
    let i = ks.indexOf(pick(k + dir * dist));
    const j = ks.indexOf(k);
    if (dir > 0 && i <= j) i = Math.min(j + 1, ks.length - 1);
    if (dir < 0 && i >= j) i = Math.max(j - 1, 0);
    return ks[i];
  };
  const L = (type, k, action, qty = 1) => makeLeg(mkt, exp, type, k, action, qty);
  // nearest gamma level above / below spot (at least a quarter sigma away), else a sigma-based fallback
  const above = (lv, ids, fb) => { const v = ids.map((id) => lv.levels[id]?.price).filter((p) => p && p > S + 0.25 * sm); return v.length ? Math.min(...v) : S + fb * sm; };
  const below = (lv, ids, fb) => { const v = ids.map((id) => lv.levels[id]?.price).filter((p) => p && p < S - 0.25 * sm); return v.length ? Math.max(...v) : S - fb * sm; };
  return { S, sm, pick, away, L, above, below };
}
const lvl = (lv, id) => lv.levels[id]?.price;
const $k = (v) => (v == null ? '—' : `$${(+v).toFixed(0)}`);

export const TEMPLATES = [
  {
    id: 'ic_walls', name: 'Iron Condor at walls', kind: 'credit', bias: 'range', vol: 'short',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const pw = lvl(lv, 'PW'), cw = lvl(lv, 'CW');
      const sp = pw && pw < S - 0.25 * sm ? pick(pw) : pick(S - 0.75 * sm);
      const sc = cw && cw > S + 0.25 * sm ? pick(cw) : pick(S + 0.75 * sm);
      return [L('P', away(sp, -1, 0.5 * sm), 'buy'), L('P', sp, 'sell'), L('C', sc, 'sell'), L('C', away(sc, 1, 0.5 * sm), 'buy')];
    },
    thesis: (lv, legs) => `Short ${legs[1].k}P / ${legs[2].k}C, anchored on the put wall ${$k(lvl(lv, 'PW'))} and call wall ${$k(lvl(lv, 'CW'))} (or ±0.75σ when a wall sits too close). Works when positive gamma keeps price inside the range.`,
  },
  {
    id: 'fly_p1', name: 'Call Butterfly pinned at P1', kind: 'debit', bias: 'range', vol: 'short',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const c = pick(lvl(lv, 'P1') ?? S);
      return [L('C', away(c, -1, 0.6 * sm), 'buy'), L('C', c, 'sell', 2), L('C', away(c, 1, 0.6 * sm), 'buy')];
    },
    thesis: (lv) => `Cheap bet that price pins to the largest positive-gamma strike P1 ${$k(lvl(lv, 'P1'))} into expiration.`,
  },
  {
    id: 'ifly_p1', name: 'Iron Butterfly at P1', kind: 'credit', bias: 'range', vol: 'short',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const c = pick(lvl(lv, 'P1') ?? S);
      return [L('P', away(c, -1, sm), 'buy'), L('P', c, 'sell'), L('C', c, 'sell'), L('C', away(c, 1, sm), 'buy')];
    },
    thesis: (lv) => `Collect rich premium centered on P1 ${$k(lvl(lv, 'P1'))}; profits most if dealer hedging pins price there.`,
  },
  {
    id: 'bps_pw', name: 'Bull Put Spread at put wall', kind: 'credit', bias: 'bull', vol: 'short',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const pw = lvl(lv, 'PW');
      let sp = pw && pw < S ? pick(pw) : pick(S - 0.5 * sm);
      if (sp >= S) sp = away(pick(S), -1, 0.5 * sm);
      return [L('P', away(sp, -1, 0.5 * sm), 'buy'), L('P', sp, 'sell')];
    },
    thesis: (lv, legs) => `Short ${legs[1].k}P at/below the put wall ${$k(lvl(lv, 'PW'))}, which acts as support: dealers buy as price falls toward it.`,
  },
  {
    id: 'bcs_cw', name: 'Bear Call Spread at call wall', kind: 'credit', bias: 'bear', vol: 'short',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const cw = lvl(lv, 'CW');
      let sc = cw && cw > S ? pick(cw) : pick(S + 0.5 * sm);
      if (sc <= S) sc = away(pick(S), 1, 0.5 * sm);
      return [L('C', sc, 'sell'), L('C', away(sc, 1, 0.5 * sm), 'buy')];
    },
    thesis: (lv, legs) => `Short ${legs[0].k}C at/above the call wall ${$k(lvl(lv, 'CW'))}, which acts as resistance: dealers sell into rallies toward it.`,
  },
  {
    id: 'call_debit', name: 'Call Debit Spread to target', kind: 'debit', bias: 'bull', vol: 'flat',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const k = pick(S);
      const ups = ['P1', 'P2', 'CW', 'EMU'].map((id) => lvl(lv, id)).filter((v) => v && v > S + 0.25 * sm);
      const tgt = ups.length ? Math.min(...ups) : S + sm;
      return [L('C', k, 'buy'), L('C', away(k, 1, tgt - k), 'sell')];
    },
    thesis: (lv, legs) => `Directional upside from ${legs[0].k} toward ${legs[1].k}, the next gamma level above spot.`,
  },
  {
    id: 'put_debit', name: 'Put Debit Spread to target', kind: 'debit', bias: 'bear', vol: 'flat',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const k = pick(S);
      const dns = ['N1', 'PW', 'FLIP', 'EML'].map((id) => lvl(lv, id)).filter((v) => v && v < S - 0.25 * sm);
      const tgt = dns.length ? Math.max(...dns) : S - sm;
      return [L('P', k, 'buy'), L('P', away(k, -1, k - tgt), 'sell')];
    },
    thesis: (lv, legs) => `Downside from ${legs[0].k} toward ${legs[1].k}, the next support level below spot (N1 ${$k(lvl(lv, 'N1'))}, put wall ${$k(lvl(lv, 'PW'))}).`,
  },
  {
    id: 'straddle', name: 'Long Straddle', kind: 'debit', bias: 'move', vol: 'long',
    build(m, lv, e) {
      const { S, pick, L } = kit(m, e);
      const k = pick(S);
      return [L('C', k, 'buy'), L('P', k, 'buy')];
    },
    thesis: (lv) => `Long volatility: negative gamma (flip ${$k(lv.flip)}) means dealer hedging amplifies moves in either direction.`,
  },
  {
    id: 'strangle', name: 'Long Strangle', kind: 'debit', bias: 'move', vol: 'long',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const k = pick(S);
      return [L('C', away(k, 1, 0.5 * sm), 'buy'), L('P', away(k, -1, 0.5 * sm), 'buy')];
    },
    thesis: () => 'Cheaper long-vol play that needs a breakout beyond half an expected move.',
  },
  {
    id: 'ic_em', name: 'Iron Condor at expected move', kind: 'credit', bias: 'range', vol: 'short',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const sp = pick(S - sm), sc = pick(S + sm);
      return [L('P', away(sp, -1, 0.5 * sm), 'buy'), L('P', sp, 'sell'), L('C', sc, 'sell'), L('C', away(sc, 1, 0.5 * sm), 'buy')];
    },
    thesis: (lv, legs) => `Short ${legs[1].k}P / ${legs[2].k}C at about ±1 expected move: a wider, higher-probability range trade that relies on positive gamma containing price.`,
  },
  {
    id: 'cfly_up', name: 'Call Butterfly at upside target', kind: 'debit', bias: 'bull', vol: 'short',
    build(m, lv, e) {
      const { pick, away, L, above, sm } = kit(m, e);
      const c = pick(above(lv, ['P1', 'P2', 'CW', 'FLIP'], 0.75));
      return [L('C', away(c, -1, 0.6 * sm), 'buy'), L('C', c, 'sell', 2), L('C', away(c, 1, 0.6 * sm), 'buy')];
    },
    thesis: (lv, legs) => `Low-cost bet on a drift up to ${legs[1].k}, the next gamma magnet above spot, and a pin there into expiration.`,
  },
  {
    id: 'pfly_down', name: 'Put Butterfly at downside target', kind: 'debit', bias: 'bear', vol: 'short',
    build(m, lv, e) {
      const { pick, away, L, below, sm } = kit(m, e);
      const c = pick(below(lv, ['N1', 'PW', 'FLIP', 'P2'], 0.75));
      return [L('P', away(c, 1, 0.6 * sm), 'buy'), L('P', c, 'sell', 2), L('P', away(c, -1, 0.6 * sm), 'buy')];
    },
    thesis: (lv, legs) => `Low-cost bet on a pullback to ${legs[1].k} (support / negative-gamma level below spot) and a pin there.`,
  },
  {
    id: 'bwb_put', name: 'Put Broken-Wing Butterfly at put wall', kind: 'credit', bias: 'bull', vol: 'short',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const pw = lvl(lv, 'PW');
      let c = pw && pw < S ? pick(pw) : pick(S - 0.5 * sm);
      if (c >= S) c = away(pick(S), -1, 0.5 * sm);
      return [L('P', away(c, 1, 0.4 * sm), 'buy'), L('P', c, 'sell', 2), L('P', away(c, -1, 0.8 * sm), 'buy')];
    },
    thesis: (lv, legs) => `Short 2× ${legs[1].k}P near the put wall with a wider lower wing: little risk if price rallies, max profit if price sinks to the wall and holds.`,
  },
  {
    id: 'cal_p1', name: 'Call Calendar at P1', kind: 'debit', bias: 'range', vol: 'long',
    build(m, lv, e) {
      const { S, pick, L } = kit(m, e);
      const k = pick(lvl(lv, 'P1') ?? S);
      const far = laterExp(m, e, Math.max(6, Math.round(dte(e))));
      return [L('C', k, 'sell'), makeLeg(m, far, 'C', nearestStrike(m.byExp.get(far), k), 'buy')];
    },
    thesis: (lv, legs) => `Sell the front ${legs[0].k}C and own a later one: collects time decay if dealer hedging keeps price pinned near P1 ${$k(lvl(lv, 'P1'))}.`,
  },
  {
    id: 'fly_mp', name: 'Butterfly at Max Pain', kind: 'debit', bias: 'range', vol: 'short',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const c = pick(lvl(lv, 'MP') ?? S);
      const t = c >= S ? 'C' : 'P'; // use the OTM side for tighter quotes
      return [L(t, away(c, -1, 0.5 * sm), 'buy'), L(t, c, 'sell', 2), L(t, away(c, 1, 0.5 * sm), 'buy')];
    },
    thesis: (lv, legs) => `Pin trade at max pain ${legs[1].k}, where option holders lose the most at expiration; strongest into expiration day.`,
  },
  {
    id: 'cbwb_cw', name: 'Call Broken-Wing Butterfly to call wall', kind: 'credit', bias: 'bull', vol: 'short',
    build(m, lv, e) {
      const { S, sm, pick, away, L, above } = kit(m, e);
      const c = pick(Math.min(above(lv, ['CW', 'P1', 'P2'], 0.75), S + 1.25 * sm));
      return [L('C', away(c, -1, 0.4 * sm), 'buy'), L('C', c, 'sell', 2), L('C', away(c, 1, 0.8 * sm), 'buy')];
    },
    thesis: (lv, legs) => `Short 2× ${legs[1].k}C at the upside gamma magnet with a wider upper wing: profits as price drifts up into it and stalls; little risk if price falls.`,
  },
  // Flyagonal: a broken-wing butterfly on one side of the market plus a diagonal on the other.
  // The fly targets a gamma magnet; the diagonal (short front-month, long later-month) collects
  // decay, adds positive vega, and cushions a move the other way.
  {
    id: 'flyag_call', name: 'Flyagonal: call fly up + put diagonal', kind: 'debit', bias: 'bull', vol: 'flat',
    build(m, lv, e) {
      const { S, sm, pick, away, L, above } = kit(m, e);
      const c = pick(Math.min(above(lv, ['CW', 'P1', 'P2'], 0.75), S + 1.25 * sm));
      const pw = lvl(lv, 'PW');
      let sp = pw && pw < S - 0.25 * sm ? pick(pw) : pick(S - 0.75 * sm);
      if (sp >= S) sp = away(pick(S), -1, 0.75 * sm);
      const far = laterExp(m, e, Math.max(6, Math.round(dte(e))));
      const lp = nearestStrike(m.byExp.get(far), sp - 0.25 * sm);
      return [L('C', away(c, -1, 0.5 * sm), 'buy'), L('C', c, 'sell', 2), L('C', away(c, 1, 0.75 * sm), 'buy'),
        L('P', sp, 'sell'), makeLeg(m, far, 'P', lp, 'buy')];
    },
    thesis: (lv, legs) => `Call broken-wing fly centered ${legs[1].k} (upside gamma magnet) plus a ${legs[3].k}P / ${legs[4].k}P put diagonal at the put wall: wide profit zone, decay from both sides, the diagonal cushions a selloff.`,
  },
  {
    id: 'flyag_put', name: 'Flyagonal: put fly down + call diagonal', kind: 'debit', bias: 'bear', vol: 'flat',
    build(m, lv, e) {
      const { S, sm, pick, away, L, below } = kit(m, e);
      const c = pick(Math.max(below(lv, ['PW', 'N1', 'P2'], 0.75), S - 1.25 * sm));
      const cw = lvl(lv, 'CW');
      let sc = cw && cw > S + 0.25 * sm ? pick(cw) : pick(S + 0.75 * sm);
      if (sc <= S) sc = away(pick(S), 1, 0.75 * sm);
      const far = laterExp(m, e, Math.max(6, Math.round(dte(e))));
      const lc = nearestStrike(m.byExp.get(far), sc + 0.25 * sm);
      return [L('P', away(c, 1, 0.5 * sm), 'buy'), L('P', c, 'sell', 2), L('P', away(c, -1, 0.75 * sm), 'buy'),
        L('C', sc, 'sell'), makeLeg(m, far, 'C', lc, 'buy')];
    },
    thesis: (lv, legs) => `Put broken-wing fly centered ${legs[1].k} (support / negative-gamma level below) plus a ${legs[3].k}C / ${legs[4].k}C call diagonal at the call wall: profits on a drift down, the diagonal cushions a rally.`,
  },
  {
    id: 'flyag_p1', name: 'Flyagonal: fly at P1 + put diagonal', kind: 'debit', bias: 'range', vol: 'flat',
    build(m, lv, e) {
      const { S, sm, pick, away, L } = kit(m, e);
      const c = pick(lvl(lv, 'P1') ?? S);
      const t = c >= S ? 'C' : 'P';
      const pw = lvl(lv, 'PW');
      let sp = pw && pw < Math.min(c, S) - 0.25 * sm ? pick(pw) : pick(Math.min(c, S) - 0.75 * sm);
      const far = laterExp(m, e, Math.max(6, Math.round(dte(e))));
      const lp = nearestStrike(m.byExp.get(far), sp - 0.25 * sm);
      return [L(t, away(c, -1, 0.5 * sm), 'buy'), L(t, c, 'sell', 2), L(t, away(c, 1, 0.5 * sm), 'buy'),
        L('P', sp, 'sell'), makeLeg(m, far, 'P', lp, 'buy')];
    },
    thesis: (lv, legs) => `Butterfly pinned at P1 ${legs[1].k} plus a ${legs[3].k}P / ${legs[4].k}P put diagonal: the fly pays on the pin, the diagonal earns decay and protects a break lower.`,
  },
];

// Butterfly family (plain, iron, broken-wing, flyagonal) — the bot can be told to prefer these.
// Exit rules shared by training, the backtest and the trade cards.
// Profit target `tp` (20–50%) is a fraction of the spread's max profit: the credit for credit spreads,
// the max payoff for butterflies / flyagonals / debit spreads, the debit for unlimited long-vol trades.
// Targets are measured after round-trip fees.
// Butterflies rarely get near max profit before expiration, so the fly family has its own (lower) target.
export const EXIT = { tp: 0.5, flyTp: 0.2, creditSl: 2, debitSl: 0.5, flySl: 0.6 };
export function targetProfit(c) {
  const tp = FLY_FAMILY.has(c.t.id) ? EXIT.flyTp : EXIT.tp;
  if (c.cost < 0) return tp * -c.cost;
  if (c.st.unlimitedUp) return tp * c.cost;
  return tp * c.st.maxProfit;
}
export function exitHit(c, pl, fees) {
  if (pl - fees >= targetProfit(c)) return true;
  if (c.cost < 0) return pl <= -Math.min(EXIT.creditSl * -c.cost, c.risk);
  return pl <= -(FLY_FAMILY.has(c.t.id) ? EXIT.flySl : EXIT.debitSl) * c.cost;
}

export const FLY_FAMILY = new Set(['fly_p1', 'ifly_p1', 'cfly_up', 'pfly_down', 'bwb_put', 'fly_mp', 'cbwb_cw', 'flyag_call', 'flyag_put', 'flyag_p1']);

export function horizonExp(mkt, horizon) {
  const now = Date.now();
  const live = mkt.exps.filter((e) => dte(e, now) > 0.1);
  if (horizon === 'daily') return live[0];
  const target = horizon === 'weekly' ? 7 : 30;
  return live.reduce((b, e) => (Math.abs(dte(e, now) - target) < Math.abs(dte(b, now) - target) ? e : b), live[0]);
}

export function buildTemplates(mkt, lv, exp) {
  const out = [];
  for (const t of TEMPLATES) {
    try {
      const legs = t.build(mkt, lv, exp);
      const st = strategyStats(legs, mkt.spot, mkt.byExp.get(exp).atmIv);
      const risk = st.unlimitedDown ? Math.abs(netCost(legs)) * 3 : Math.max(-st.maxLoss, 1);
      out.push({ t, legs, st, risk, cost: netCost(legs) });
    } catch (e) { console.warn('template failed', t.id, e); }
  }
  return out;
}

// ---- simulation ------------------------------------------------------------
const FEES_PER_CONTRACT = 1.5; // commissions + slippage, round trip

function simulateEpisode(r, env, cands, mgmt) {
  const { S0, tStart, tEnd, iv, regimeMode, magnet, cw, pw, p } = env;
  const T = Math.max((tEnd - tStart) / (365 * 864e5), 1 / (365 * 24));
  const steps = Math.max(24, Math.min(240, Math.round(((tEnd - tStart) / 864e5) * 16)));
  const dt = T / steps;
  const pos = regimeMode === 'positive';
  const sig = iv * (pos ? p.rvPos : p.rvNeg);
  const kappa = p.pin / T;
  const checkEvery = Math.max(2, Math.round(steps / 12));
  let S = S0, prevRet = 0;
  const open = cands.map(() => true);
  const result = cands.map(() => null);

  for (let i = 1; i <= steps; i++) {
    const z = r.normal();
    let drift = 0, ret;
    if (pos) {
      if (magnet) drift += (kappa * (magnet - S)) / S;
      if (cw && S > cw) drift += (2 * kappa * (cw - S)) / S;
      if (pw && S < pw) drift += (2 * kappa * (pw - S)) / S;
      ret = drift * dt + sig * Math.sqrt(dt) * z;
    } else {
      ret = 0.25 * prevRet + sig * Math.sqrt(dt) * z;
      if (r() < 6 * dt) ret += (-0.015 + 0.01 * r.normal()) * (iv / 0.18); // downside-skewed jumps
    }
    prevRet = ret;
    S *= Math.exp(ret - 0.5 * sig * sig * dt);
    if (mgmt === 'managed' && i % checkEvery === 0 && i < steps) {
      const t = tStart + ((tEnd - tStart) * i) / steps;
      cands.forEach((c, j) => {
        if (!open[j]) return;
        const pl = positionAt(c.legs, S, t).pl;
        const hit = exitHit(c, pl, c.contracts * FEES_PER_CONTRACT); // targets measured after fees
        if (hit) { open[j] = false; result[j] = pl; }
      });
    }
  }
  cands.forEach((c, j) => { if (open[j]) result[j] = positionAt(c.legs, S, tEnd).pl; });
  return result.map((pl, j) => pl - cands[j].contracts * FEES_PER_CONTRACT);
}

function cell(ctxKey, id) {
  brain.post[ctxKey] ||= {};
  return (brain.post[ctxKey][id] ||= { a: 1, b: 1, w: 0, sumPl: 0, sumR: 0, n: 0, real: 0 });
}

function addObs(c, pl, risk, w) {
  const tot = c.a + c.b - 2;
  if (tot + w > MAX_W) { // decay old evidence
    const f = (MAX_W - w) / tot;
    c.a = 1 + (c.a - 1) * f; c.b = 1 + (c.b - 1) * f; c.sumPl *= f; c.sumR *= f; c.w *= f;
  }
  if (pl > 0) c.a += w; else c.b += w;
  c.w += w; c.sumPl += pl * w; c.sumR += (pl / risk) * w;
}

// Learn from an externally scored trade (backtest or forward test).
export function learnFrom(ctxKey, stratId, pl, risk, w) {
  const c = cell(ctxKey, stratId);
  addObs(c, pl, risk, w);
  c.n++;
}

export async function train(mkt, lv, horizon, episodes, p, mgmt, onProgress) {
  const exp = horizonExp(mkt, horizon);
  const ctx = marketContext(lv, horizon);
  const cands = buildTemplates(mkt, lv, exp).map((c) => ({ ...c, contracts: c.legs.reduce((s, l) => s + (l.type === 'S' ? 0 : l.qty), 0) }));
  const env = {
    S0: mkt.spot, tStart: Date.now(), tEnd: expiryMs(exp), iv: mkt.byExp.get(exp).atmIv,
    // intraday: price is pulled toward both P1 and session VWAP
    magnet: horizon === 'daily' && p.vwap && lvl(lv, 'P1') ? (lvl(lv, 'P1') + p.vwap) / 2 : lvl(lv, 'P1') ?? p.vwap,
    cw: lvl(lv, 'CW'), pw: lvl(lv, 'PW'), p,
  };
  const reliability = ctx.flip === 'at-flip' ? 0.5 : p.reliability;
  const r = rng((Date.now() ^ 0x9e3779b9) >>> 0);
  const batch = 100;
  for (let done = 0; done < episodes; done += batch) {
    for (let i = 0; i < Math.min(batch, episodes - done); i++) {
      const follows = r() < reliability;
      env.regimeMode = follows ? lv.regime : lv.regime === 'positive' ? 'negative' : 'positive';
      const pls = simulateEpisode(r, env, cands, mgmt);
      cands.forEach((c, j) => { const ce = cell(ctx.key, c.t.id); addObs(ce, pls[j], c.risk, SIM_W); ce.n++; });
    }
    onProgress((done + batch) / episodes);
    await new Promise((res) => setTimeout(res, 0));
  }
  save();
  return { exp, ctx, cands };
}

// ---- ranking & sample trades -------------------------------------------------
function gammaSample(k, r) { // Marsaglia-Tsang
  if (k < 1) return gammaSample(k + 1, r) * Math.pow(r(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = r.normal(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const betaSample = (a, b, r) => { const x = gammaSample(a, r); return x / (x + gammaSample(b, r)); };

function betaQuantile(a, b, q) { // normal approximation is fine for display
  const m = a / (a + b), v = (a * b) / ((a + b) ** 2 * (a + b + 1));
  return Math.min(1, Math.max(0, m + q * Math.sqrt(v)));
}

export function scoreOf(c, mode, winOverride) {
  const win = winOverride ?? c.a / (c.a + c.b);
  const ev = c.w ? c.sumR / c.w : 0;
  if (mode === 'win') return win;
  if (mode === 'ev') return ev;
  return 0.6 * win + 0.4 / (1 + Math.exp(-4 * ev));
}

export function leaderboard(ctxKey, mode) {
  const rows = TEMPLATES.map((t) => {
    const c = brain.post[ctxKey]?.[t.id];
    if (!c || !c.w) return { t, c: null };
    return {
      t, c, win: c.a / (c.a + c.b), lo: betaQuantile(c.a, c.b, -1.645), hi: betaQuantile(c.a, c.b, 1.645),
      avgPl: c.sumPl / c.w, evR: c.sumR / c.w, score: scoreOf(c, mode),
    };
  });
  return rows.sort((x, y) => (y.c ? y.score : -9) - (x.c ? x.score : -9));
}

export function sampleTrades(mkt, lv, horizon, mode, n = 3) {
  const exp = horizonExp(mkt, horizon);
  const ctx = marketContext(lv, horizon);
  const r = rng(Date.now() >>> 0);
  const cands = buildTemplates(mkt, lv, exp).map((c) => {
    const cl = brain.post[ctx.key]?.[c.t.id];
    if (!cl || !cl.w) return { ...c, cl: null, exp, ctx, horizon, win: null, evR: null, avgPl: null, pick: 0.5 };
    const drawn = betaSample(cl.a, cl.b, r); // Thompson sample keeps exploring
    return { ...c, cl, exp, ctx, horizon, win: cl.a / (cl.a + cl.b), evR: cl.sumR / cl.w, avgPl: cl.sumPl / cl.w, pick: scoreOf(cl, mode, drawn) };
  });
  return cands.sort((a, b) => b.pick - a.pick).slice(0, n);
}

// ---- paper journal ---------------------------------------------------------
export function addPaperTrade(tr, horizon = tr.horizon) {
  brain.journal.unshift({
    id: Date.now() + Math.random(), created: Date.now(), strat: tr.t.id, name: tr.t.name, ctx: tr.ctx.key, horizon,
    legs: tr.legs, spot: tr.legs.length ? tr.spotAtEntry : null, cost: tr.cost, risk: tr.risk,
    exp: new Date(firstExpiryMs(tr.legs)).toISOString(), expDate: tr.exp, status: 'open', pl: null, closePx: null,
    ...(tr.extra || {}),
  });
  save();
}

export async function scoreJournal(symbol) {
  const due = brain.journal.filter((j) => j.status === 'open' && Date.now() > expiryMs(j.expDate) + 3600e3);
  if (!due.length) return { scored: 0, pending: brain.journal.filter((j) => j.status === 'open').length };
  const { candles } = await loadCandles(symbol, '1d');
  const closeOn = (date) => {
    const c = candles.find((k) => new Date(k.time * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === date);
    return c ? c.close : null;
  };
  let scored = 0;
  for (const j of due) {
    const px = closeOn(j.expDate);
    if (px == null) continue;
    const pl = positionAt(j.legs, px, expiryMs(j.expDate)).pl;
    j.pl = pl; j.closePx = px; j.status = pl > 0 ? 'win' : 'loss';
    const ce = cell(j.ctx, j.strat);
    addObs(ce, pl, j.risk || 1, REAL_W); ce.real++;
    scored++;
  }
  save();
  return { scored, pending: brain.journal.filter((j) => j.status === 'open').length };
}

export function markJournal(mkt) {
  return brain.journal.map((j) => {
    if (j.status !== 'open' || !mkt) return { ...j, mark: j.pl };
    const live = j.legs.every((l) => l.type === 'S' || mkt.byExp.has(l.exp) || expiryMs(l.exp) < Date.now());
    return { ...j, mark: live ? positionAt(j.legs, mkt.spot, Math.min(Date.now(), expiryMs(j.expDate))).pl : null };
  });
}

export { describeLegs, fmt, fmtExp };
