// Server-side paper trader: runs the bot on a $10,000 fake account during market hours.
//
// Each trading session (ET):
//   09:35+   train the bot on each horizon's live setup (once per session)
//   10:00+   open the top conviction pick per horizon (intraday until 13:30, weekly/monthly until 15:00)
//   every 5m mark open positions with real (15-min delayed) chain mids; close on profit target / stop
//   16:05+   settle positions expiring today at the closing price
// State is saved to data/paper-account.json; the bot's learned memory to data/paper-brain.json.
import fs from 'node:fs';
import path from 'node:path';
import { buildMarket, nearestStrike } from './public/js/data.js';
import { expiryMs, yearsTo } from './public/js/math.js';
import { computeLevels, groupExps } from './public/js/levels.js';
import { intradayProfile, realizedVol, vixStats, ivProfile } from './public/js/indicators.js';
import { buildSignals, scoreTemplate, qualifies, entryPlan } from './public/js/confluence.js';
import * as Bot from './public/js/bot.js';
import { describeLegs } from './public/js/strategies.js';

export const CFG = {
  symbol: 'SPY',
  startCapital: 10000,
  startDate: '2026-11-13',
  riskPerTrade: 0.05, // max loss per trade as a share of equity
  maxOpenRisk: 0.35, // total max loss of open positions as a share of equity
  maxLots: 10,
  maxOpen: { daily: 1, weekly: 3, monthly: 2 },
  entryFrom: 10 * 60, // minutes after midnight ET
  entryUntil: { daily: 13 * 60 + 30, weekly: 15 * 60, monthly: 15 * 60 },
  rules: { minConf: 6, maxConflicts: 99, gammaVeto: true },
  flyPref: 0.3,
  exit: { tp: 0.5, flyTp: 0.2 },
  train: { episodes: 2000, rvPos: 0.8, rvNeg: 1.25, pin: 0.6, reliability: 0.7 },
  slipPerLeg: 0.02, // $ per share worse than mid on every leg, each side
  feePerContract: 0.65, // per contract per side
  checkEveryMs: 5 * 60e3,
};
const HZ = ['daily', 'weekly', 'monthly'];
const HL = { daily: 'Intraday', weekly: 'Weekly', monthly: 'Monthly' };

let ctx = null; // { getChain, getCandles, dir }
let state = null;
let busy = false;
let lastRun = 0;

// ---------- persistence ----------
const file = (n) => path.join(ctx.dir, n);
function load() {
  fs.mkdirSync(ctx.dir, { recursive: true });
  try { state = JSON.parse(fs.readFileSync(file('paper-account.json'), 'utf8')); } catch { state = null; }
  if (!state) {
    state = { created: Date.now(), startCapital: CFG.startCapital, realized: 0, positions: [], closed: [], equity: [], log: [], sessions: {}, trainedOn: {} };
    log(`Paper account opened with $${CFG.startCapital.toLocaleString()}. Trading starts ${CFG.startDate} at 10:00 ET.`);
  }
  try { Object.assign(Bot.brain.post, JSON.parse(fs.readFileSync(file('paper-brain.json'), 'utf8'))); } catch { /* fresh brain */ }
}
function save() {
  fs.writeFileSync(file('paper-account.json'), JSON.stringify(state));
  fs.writeFileSync(file('paper-brain.json'), JSON.stringify(Bot.brain.post));
}
function log(msg) {
  state.log.unshift({ t: Date.now(), msg });
  state.log.length = Math.min(state.log.length, 400);
  console.log(`[paper] ${msg}`);
}

// ---------- time ----------
const fmtET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
function et(ms = Date.now()) {
  const p = Object.fromEntries(fmtET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: (+p.hour % 24) * 60 + +p.minute, dow: p.weekday };
}

// ---------- pricing ----------
function legMid(mkt, l) {
  if (l.type === 'S') return mkt.spot;
  const x = mkt.byExp.get(l.exp);
  const o = x && (l.type === 'C' ? x.calls : x.puts).get(l.k);
  if (o && o.mid > 0) return o.mid;
  return l.type === 'C' ? Math.max(mkt.spot - l.k, 0) : Math.max(l.k - mkt.spot, 0); // expired / missing: intrinsic
}
const sgn = (l) => (l.action === 'buy' ? 1 : -1);
const mult = (l) => (l.type === 'S' ? 1 : 100);
const contractsPerLot = (legs) => legs.reduce((a, l) => a + (l.type === 'S' ? 0 : l.qty), 0);
const slipPerLot = (legs) => legs.reduce((a, l) => a + (l.type === 'S' ? 0 : CFG.slipPerLeg * 100 * l.qty), 0);
// value of one lot at mids (+ = you own value, - = you owe)
const valueLot = (mkt, legs) => legs.reduce((a, l) => a + sgn(l) * l.qty * mult(l) * legMid(mkt, l), 0);

function equityNow() {
  const unreal = state.positions.reduce((a, p) => a + (p.unrealized || 0), 0);
  return state.startCapital + state.realized + unreal;
}
const openRisk = () => state.positions.reduce((a, p) => a + p.riskLot * p.lots, 0);

// ---------- market context ----------
async function context() {
  const raw = await ctx.getChain(CFG.symbol);
  const mkt = buildMarket(raw);
  const soft = (p) => p.catch(() => null);
  const [i5, d1, vx] = await Promise.all([soft(ctx.getCandles(CFG.symbol, '5m')), soft(ctx.getCandles(CFG.symbol, '1d')), soft(ctx.getCandles('^VIX', '1d'))]);
  const results = {};
  for (const g of HZ) { const ex = groupExps(mkt, g, []); results[g] = ex.length ? computeLevels(mkt, ex) : null; }
  const ip = i5 ? intradayProfile(i5.candles, i5.gmtoffset) : null;
  const rv5 = d1 ? realizedVol(d1.candles, 5) : null, rv20 = d1 ? realizedVol(d1.candles, 20) : null;
  const vix = vx ? vixStats(vx.candles) : null;
  // index gamma: SPX (big-money hedging), /ES = SPX + basis, QQQ (tech)
  const [spx, es, qqq] = await Promise.all(['SPX', 'ES', 'QQQ'].map((s) => (ctx.getGamma ? soft(ctx.getGamma(s)) : null)));
  const idx = { spx, es, qqq, map: spx && CFG.symbol === 'SPY' ? mkt.spot / spx.spot : null };
  const env = (h) => {
    const lv = results[h];
    if (!lv) return null;
    const exp = Bot.horizonExp(mkt, h);
    const iv = ivProfile(mkt, exp);
    const rv = h === 'daily' ? (ip?.rvIntraday || rv5) : h === 'weekly' ? ((rv5 || 0) + (rv20 || 0)) / 2 || null : rv20;
    const sm = mkt.spot * iv.atm * Math.sqrt(Math.max(yearsTo(exp), 1 / 365));
    return { S: mkt.spot, horizon: h, lv, all: results, ip, iv, rv, vix, mem: null, sm, exp, idx, symbol: CFG.symbol };
  };
  return { raw, mkt, results, ip, d1, env, idx };
}

function pick(c, h) {
  const e = c.env(h);
  if (!e) return null;
  const signals = buildSignals(e);
  const key = Bot.marketContext(e.lv, h).key;
  const ranked = Bot.buildTemplates(c.mkt, e.lv, e.exp).map((x) => {
    const sc = scoreTemplate(x.t, signals);
    const plan = entryPlan(x.legs, x.t.bias, e);
    const cell = Bot.brain.post[key]?.[x.t.id];
    const learned = cell && cell.w ? cell.a / (cell.a + cell.b) : 0.5;
    const conviction = qualifies(sc, CFG.rules);
    const rank = (conviction ? 10 : 0) + learned * (1 + 0.15 * sc.net) + (plan.edge > 0 ? 0.05 : 0) + (Bot.FLY_FAMILY.has(x.t.id) ? CFG.flyPref : 0);
    return { ...x, sc, plan, learned, conviction, rank, key, exp: e.exp };
  }).sort((a, b) => b.rank - a.rank);
  const conviction = ranked.filter((x) => x.conviction);
  return conviction.length ? { list: conviction } : { none: true, best: ranked[0] };
}

// ---------- actions ----------
async function trainSession(c, date) {
  for (const h of HZ) {
    const lv = c.results[h];
    if (!lv) continue;
    await Bot.train(c.mkt, lv, h, CFG.train.episodes, { ...CFG.train, vwap: c.ip?.vwap }, 'managed', () => {});
  }
  state.trainedOn[date] = true;
  const r = (g) => (g ? (g.regime === 'positive' ? '+γ' : '−γ') : 'n/a');
  log(`Trained ${CFG.train.episodes.toLocaleString()} episodes per horizon on today's gamma setup. Index gamma (weekly): SPX ${r(c.idx.spx?.groups.weekly)} flip ${c.idx.spx?.groups.weekly?.flip?.toFixed(0) ?? '—'}${c.idx.es?.basis != null ? ` (ES basis ${c.idx.es.basis >= 0 ? '+' : ''}${c.idx.es.basis})` : ''}, QQQ ${r(c.idx.qqq?.groups.weekly)}.`);
}

function openTrades(c, date, hm) {
  for (const h of HZ) {
    const key = `${date}|${h}`;
    if (state.sessions[key] || hm > CFG.entryUntil[h]) continue;
    if (state.positions.filter((p) => p.horizon === h).length >= CFG.maxOpen[h]) { state.sessions[key] = 'max-open'; continue; }
    const picked = pick(c, h);
    if (!picked) continue;
    if (picked.none) {
      state.sessions[key] = 'stood-aside';
      log(`${HL[h]}: stood aside — best idea ${picked.best?.t.name ?? '—'} had ${picked.best?.sc.conf.length ?? 0} confluences (need ${CFG.rules.minConf}${CFG.rules.gammaVeto ? ', gamma veto on' : ''}).`);
      continue;
    }
    // take the highest-ranked conviction trade that fits the risk budget
    const eq = equityNow();
    const budget = Math.min(CFG.riskPerTrade * eq, CFG.maxOpenRisk * eq - openRisk());
    const sized = picked.list.map((x) => {
      const xl = x.legs.map(({ id, ...l }) => l);
      const xn = contractsPerLot(xl);
      const xr = Math.max(x.risk, 1) + xn * CFG.feePerContract * 2;
      return { choice: x, legs: xl, n: xn, riskLot: xr, lots: Math.min(CFG.maxLots, Math.floor(budget / xr)) };
    });
    const fit = sized.find((z) => z.lots >= 1);
    if (!fit) {
      state.sessions[key] = 'too-large';
      log(`${HL[h]}: skipped — none of ${sized.length} conviction trade(s) fit the $${budget.toFixed(0)} risk budget (smallest needs $${Math.min(...sized.map((z) => z.riskLot)).toFixed(0)} per lot).`);
      continue;
    }
    const { choice, legs, n, riskLot, lots } = fit;
    const costLot = valueLot(c.mkt, legs) + slipPerLot(legs); // + debit paid / - credit received, after slippage
    if (fit !== sized[0]) log(`${HL[h]}: top pick ${sized[0].choice.t.name} needs $${sized[0].riskLot.toFixed(0)} per lot (over the $${budget.toFixed(0)} budget); taking the next conviction trade that fits.`);
    const fees = lots * n * CFG.feePerContract;
    const pos = {
      id: `${date}-${h}`, horizon: h, strat: choice.t.id, name: choice.t.name, bias: choice.t.bias, legs, lots,
      openedAt: Date.now(), openSpot: c.mkt.spot, chainTs: c.raw.timestamp, exp: choice.exp, expMs: Math.min(...legs.filter((l) => l.type !== 'S').map((l) => expiryMs(l.exp))),
      costLot, riskLot, maxProfitLot: choice.st.maxProfit, unlimitedUp: choice.st.unlimitedUp, entryFees: fees, ctxKey: choice.key,
      conf: choice.sc.conf.map((s) => s.name), conflicts: choice.sc.conflict.map((s) => s.name), learned: choice.learned,
      targetLot: Bot.targetProfit({ t: choice.t, cost: costLot, st: choice.st }), unrealized: -fees,
    };
    state.positions.push(pos);
    state.sessions[key] = 'traded';
    log(`${HL[h]}: OPEN ${lots}× ${pos.name} ${describeLegs(legs)} @ ${costLot >= 0 ? 'debit' : 'credit'} $${Math.abs(costLot / 100).toFixed(2)}/sh · max loss $${(riskLot * lots).toFixed(0)} · target +$${(pos.targetLot * lots).toFixed(0)} · ${pos.conf.length} confluences.`);
  }
}

function closePos(p, valueExit, reason, extraFees) {
  const exitFees = extraFees ?? p.lots * contractsPerLot(p.legs) * CFG.feePerContract;
  const pl = p.lots * (valueExit - p.costLot) - p.entryFees - exitFees;
  state.realized += pl;
  state.positions = state.positions.filter((x) => x !== p);
  const rec = { ...p, closedAt: Date.now(), valueExit, reason, pl, ror: pl / (p.riskLot * p.lots) };
  delete rec.unrealized;
  state.closed.unshift(rec);
  // real outcome feeds the bot's memory (per lot, higher weight than simulations)
  Bot.learnFrom(p.ctxKey, p.strat, pl / p.lots, p.riskLot, 2);
  log(`${HL[p.horizon]}: CLOSE ${p.lots}× ${p.name} — ${reason} — ${pl >= 0 ? '+' : '-'}$${Math.abs(pl).toFixed(0)} (${(rec.ror * 100).toFixed(0)}% of risk).`);
}

function manage(c) {
  for (const p of [...state.positions]) {
    const val = valueLot(c.mkt, p.legs);
    const plLot = val - p.costLot;
    const feesLot = contractsPerLot(p.legs) * CFG.feePerContract * 2;
    p.markLot = val;
    p.unrealized = p.lots * plLot - p.entryFees - p.lots * contractsPerLot(p.legs) * CFG.feePerContract;
    p.markedAt = Date.now();
    p.markSpot = c.mkt.spot;
    const probe = { t: { id: p.strat }, cost: p.costLot, st: { maxProfit: p.maxProfitLot, unlimitedUp: p.unlimitedUp }, risk: p.riskLot };
    if (Bot.exitHit(probe, plLot, feesLot)) closePos(p, val - slipPerLot(p.legs), plLot > 0 ? 'profit target' : 'stop');
  }
}

async function settle(c, date) {
  const due = state.positions.filter((p) => p.expMs <= Date.now());
  if (!due.length) return;
  const closes = new Map((c.d1?.candles || []).map((k) => [new Date((k.time + (c.d1.gmtoffset || 0)) * 1000).toISOString().slice(0, 10), k.close]));
  for (const p of due) {
    const d = new Date(p.expMs).toISOString().slice(0, 10);
    const px = d === date ? c.mkt.spot : closes.get(d);
    if (px == null) continue;
    // expiring legs settle at intrinsic; any later-dated legs (diagonals) are closed at mids
    let val = 0, closingContracts = 0;
    for (const l of p.legs) {
      if (l.type !== 'S' && expiryMs(l.exp) <= p.expMs) val += sgn(l) * l.qty * 100 * (l.type === 'C' ? Math.max(px - l.k, 0) : Math.max(l.k - px, 0));
      else { val += sgn(l) * l.qty * mult(l) * legMid(c.mkt, l) - (l.type === 'S' ? 0 : CFG.slipPerLeg * 100 * l.qty); closingContracts += l.type === 'S' ? 0 : l.qty; }
    }
    closePos(p, val, `expiration @ ${px.toFixed(2)}`, p.lots * closingContracts * CFG.feePerContract);
  }
}

// ---------- loop ----------
export async function tick(force = false) {
  if (busy) return;
  const now = Date.now();
  // real-time data (Schwab) allows tighter management than 15-min delayed quotes
  const every = state.lastCheck?.source === 'schwab' ? 2 * 60e3 : CFG.checkEveryMs;
  if (!force && now - lastRun < every) return;
  const t = et(now);
  if (!force && (t.date < CFG.startDate || ['Sat', 'Sun'].includes(t.dow) || t.hm < 9 * 60 + 35 || t.hm > 17 * 60)) return;
  busy = true;
  lastRun = now;
  try {
    const c = await context();
    const tradingToday = String(c.mkt.quote.last_trade_time || '').startsWith(t.date);
    state.lastCheck = { t: now, spot: c.mkt.spot, chainTs: c.raw.timestamp, tradingToday, source: c.raw.source || 'cboe', delayed: c.raw.delayed !== false };
    if (tradingToday || force) {
      if (t.hm < 16 * 60 || force) {
        if (!state.trainedOn[t.date]) await trainSession(c, t.date);
        manage(c);
        if (t.hm >= CFG.entryFrom || force) openTrades(c, t.date, force ? CFG.entryFrom : t.hm);
      }
      if (t.hm >= 16 * 60 + 5) manage(c); // final marks at the close
    }
    await settle(c, t.date);
    state.equity.push({ t: now, equity: equityNow(), realized: state.realized });
    if (state.equity.length > 5000) state.equity.splice(0, state.equity.length - 5000);
    save();
  } catch (e) {
    log(`Check failed: ${e.message}`);
  } finally { busy = false; }
}

export function snapshot() {
  return { cfg: CFG, state, equity: equityNow(), openRisk: openRisk(), now: Date.now(), et: et() };
}

export function start({ getChain, getCandles, getGamma, dir }) {
  ctx = { getChain, getCandles, getGamma, dir };
  Object.assign(Bot.EXIT, CFG.exit);
  load();
  save();
  setInterval(() => tick(), 60e3);
  tick();
  return { snapshot, tick };
}
