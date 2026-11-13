// Backtester: replays the bot's decision process over past sessions.
//
// Real historical data: 15-minute SPY bars (VWAP, 2-day AVWAP, intraday character), daily closes
// (realized vol, 20-day average), VIX daily closes (IV level and rank).
// Not available for free: historical options open interest, so past gamma levels cannot be rebuilt.
// They are replaced by a clearly labeled GAMMA PROXY:
//   regime  = positive when price >= its 20-day average and VIX <= its 20-day average (negative when both fail;
//             ties broken by price vs average)
//   flip    = 20-day average price
//   P1 / P2 = nearest round $5 strikes (where SPY open interest usually clusters)
//   walls   = first $5 strike beyond ±0.5 expected move; N1 one strike below the put wall
// Option prices come from Black-Scholes with ATM IV = prior VIX close x (today's ATM-IV / VIX ratio per horizon)
// and a skew shape fitted to today's chain.
import { bs, expiryMs, withClock } from './math.js';
import { positionAt, strategyStats, netCost } from './strategies.js';
import { TEMPLATES, FLY_FAMILY, marketContext, brain, exitHit } from './bot.js';
import { sessions, intradayProfile, realizedVol, vixStats } from './indicators.js';
import { buildSignals, scoreTemplate, qualifies } from './confluence.js';

const HOLD = { daily: 0, weekly: 5, monthly: 21 }; // sessions until expiration
const CHECK = { daily: 1, weekly: 2, monthly: 13 }; // check management every N 15-min bars
const DAYS = { daily: 0.25, weekly: 7, monthly: 30 };
const FEES_PER_CONTRACT = 1.5;
const YEAR_MS = 365 * 864e5;

const dkey = (t, off) => new Date((t + off) * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// Skew shape from today's chain: iv(m) = atm * (1 - a*m + b*m^2), m = moneyness in sigmas.
export function fitSkew(ivp) {
  if (!ivp) return { a: 0.12, b: 0.04 };
  const p = ivp.putIv / ivp.atm, c = ivp.callIv / ivp.atm;
  return { a: (p - c) / 2, b: (p + c) / 2 - 1 };
}

function synthExpiry(S, e, atm, skew, atMs) {
  const T = Math.max((expiryMs(e) - atMs) / YEAR_MS, 1 / (365 * 24 * 4));
  const ivAt = (k) => {
    const m = Math.max(-3, Math.min(3, Math.log(k / S) / (atm * Math.sqrt(T))));
    return Math.min(atm * 2.5, Math.max(atm * 0.5, atm * (1 - skew.a * m + skew.b * m * m)));
  };
  const strikes = [];
  for (let k = Math.round(S * 0.85); k <= Math.round(S * 1.15); k++) strikes.push(k);
  const calls = new Map(), puts = new Map();
  for (const k of strikes) {
    const iv = ivAt(k);
    calls.set(k, { k, type: 'C', ivUsed: iv, mid: bs(S, k, T, iv, 'C').price, oi: 0 });
    puts.set(k, { k, type: 'P', ivUsed: iv, mid: bs(S, k, T, iv, 'P').price, oi: 0 });
  }
  return { exp: e, strikes, calls, puts, ivAt, atmIv: atm, smile: [] };
}

function proxyLevels(S, sm, regime, flip, e) {
  const up5 = (x) => Math.ceil(x / 5) * 5, dn5 = (x) => Math.floor(x / 5) * 5, r5 = (x) => Math.round(x / 5) * 5;
  const P1 = r5(S), P2 = P1 >= S ? P1 - 5 : P1 + 5;
  const CW = up5(S + 0.5 * sm), PW = dn5(S - 0.5 * sm);
  const lv = { P1, P2, CW, PW, N1: PW - 5, FLIP: flip, MP: P1, EMU: S + sm, EML: S - sm };
  return {
    levels: Object.fromEntries(Object.entries(lv).map(([k, p]) => [k, { price: p }])),
    regime, total: regime === 'positive' ? 1e9 : -1e9, flip, em: sm, spot: S, exps: [e], rows: [], proxy: true,
  };
}

// Take-profit targets are measured after round-trip fees so a "win" is a win in the account.
const managedHit = (c, pl) => exitHit(c, pl, c.contracts * FEES_PER_CONTRACT);

/**
 * opts: { bars (15m, ~60d), daily (1d, 1y), vix (1d, 1y), symbol, skew, scale: {daily, weekly, monthly},
 *         mgmt: 'hold'|'managed', minConf, requireConv, onProgress }
 * Returns { trades, window, entries } where trades holds every template on every entry (baseline) and
 * `picked` marks the one the bot would have taken.
 */
export async function runBacktest(opts) {
  const { bars, daily, vix, symbol, skew, scale, mgmt, minConf, requireConv, onProgress, maxConflicts = 99, gammaVeto = false, flyBoost = 0 } = opts;
  const rules = { minConf, maxConflicts, gammaVeto };
  const off = bars.gmtoffset || 0;
  const cs = bars.candles;
  const ss = sessions(cs, off).filter((s) => Date.now() > expiryMs(s.date) && s.end - s.start >= 10);
  const n = ss.length;
  const dOff = daily.gmtoffset || 0;
  const dIdx = new Map(daily.candles.map((c, i) => [dkey(c.time, dOff), i]));
  const vIdx = new Map(vix.candles.map((c, i) => [dkey(c.time, vix.gmtoffset || 0), i]));
  const vixClose = (date) => { const i = vIdx.get(date); return i == null ? null : vix.candles[i].close; };

  // window = trades that EXPIRED in the last 21 complete sessions
  const W = Math.min(21, n);
  const jobs = [];
  for (const h of ['daily', 'weekly', 'monthly']) {
    for (let x = n - W; x < n; x++) { const i = x - HOLD[h]; if (i >= 6) jobs.push([h, i, x]); }
  }
  const trades = [];
  const entries = { daily: 0, weekly: 0, monthly: 0 }, skipped = { daily: 0, weekly: 0, monthly: 0 };

  for (let jn = 0; jn < jobs.length; jn++) {
    const [h, i, xi] = jobs[jn];
    const sess = ss[i], exS = ss[xi];
    const date = sess.date, e = exS.date;
    const di = dIdx.get(date);
    if (di == null || di < 21) continue;
    const prevDate = dkey(daily.candles[di - 1].time, dOff);
    const closesPrev = daily.candles.slice(0, di).map((c) => c.close);
    const sma20 = mean(closesPrev.slice(-20));
    const vixUpTo = vix.candles.filter((c) => dkey(c.time, vix.gmtoffset || 0) <= prevDate);
    if (vixUpTo.length < 21) continue;
    const vixPrev = vixUpTo[vixUpTo.length - 1].close;
    const vixSma = mean(vixUpTo.slice(-20).map((c) => c.close));
    const score = (closesPrev[closesPrev.length - 1] >= sma20 ? 1 : -1) + (vixPrev <= vixSma ? 1 : -1);
    const regime = score > 0 ? 'positive' : score < 0 ? 'negative' : closesPrev[closesPrev.length - 1] >= sma20 ? 'positive' : 'negative';

    const eb = sess.start + 1; // bar 9:45–10:00 ET; enter at its close
    const S = cs[eb].close;
    const entryMs = (cs[eb].time + 900) * 1000;
    const atmOf = (hh) => (vixPrev / 100) * scale[hh];
    const atm = atmOf(h);
    const smOf = (hh, T) => S * atmOf(hh) * Math.sqrt(T);
    const T_h = Math.max((expiryMs(e) - entryMs) / YEAR_MS, 1 / (365 * 24));
    const sm = smOf(h, T_h);
    const all = Object.fromEntries(['daily', 'weekly', 'monthly'].map((hh) => [hh, proxyLevels(S, hh === h ? sm : smOf(hh, DAYS[hh] / 365), regime, sma20, e)]));
    const lv = all[h];

    const later = [addDays(e, 7), addDays(e, 30)];
    const byExp = new Map([e, ...later].map((x) => [x, synthExpiry(S, x, atm, skew, entryMs)]));
    const mkt = { symbol, spot: S, exps: [e, ...later], byExp, timestamp: date };

    const ip = intradayProfile(cs.slice(ss[Math.max(0, i - 5)].start, eb + 1), off);
    const rv5 = realizedVol(daily.candles.slice(0, di), 5), rv20 = realizedVol(daily.candles.slice(0, di), 20);
    const rv = h === 'daily' ? (ip?.rvIntraday || rv5) : h === 'weekly' ? (rv5 + rv20) / 2 : rv20;
    const x0 = byExp.get(e);
    const ivp = { atm, putIv: x0.ivAt(S - sm), callIv: x0.ivAt(S + sm), skew: x0.ivAt(S - sm) - x0.ivAt(S + sm), term: 1, frontIv: null };
    const env = { S, horizon: h, lv, all, ip, iv: ivp, rv, vix: vixStats(vixUpTo), mem: null, sm };

    const cands = withClock(entryMs, () => {
      const signals = buildSignals(env);
      const ctx = marketContext(lv, h);
      return TEMPLATES.map((t) => {
        try {
          const legs = t.build(mkt, lv, e);
          const st = strategyStats(legs, S, atm);
          const cost = netCost(legs);
          const risk = st.unlimitedDown ? Math.abs(cost) * 3 : Math.max(-st.maxLoss, 1);
          const sc = scoreTemplate(t, signals);
          const cell = brain.post[ctx.key]?.[t.id];
          const learned = cell && cell.w ? cell.a / (cell.a + cell.b) : 0.5;
          const conviction = qualifies(sc, rules);
          return { t, legs, st, cost, risk, sc, conviction, ctxKey: ctx.key, rank: (conviction ? 10 : 0) + learned * (1 + 0.15 * sc.net) + (FLY_FAMILY.has(t.id) ? flyBoost : 0), contracts: legs.reduce((a, l) => a + (l.type === 'S' ? 0 : l.qty), 0) };
        } catch { return null; }
      }).filter(Boolean);
    });
    if (!cands.length) continue;

    // walk the 15-min bars to expiration
    const open = cands.map(() => true), out = cands.map(() => null);
    const step = CHECK[h];
    for (let j = eb + 1, k = 1; j <= exS.end; j++, k++) {
      if (mgmt !== 'managed' || k % step || j === exS.end) continue;
      const tMs = (cs[j].time + 900) * 1000;
      const vNow = h === 'daily' ? null : vixClose(dkey(cs[j].time, off));
      const ivMult = vNow ? vNow / vixPrev : 1;
      cands.forEach((c, q) => {
        if (!open[q]) return;
        const pl = positionAt(c.legs, cs[j].close, tMs, ivMult).pl;
        if (managedHit(c, pl)) { open[q] = false; out[q] = { pl, exitSpot: cs[j].close, exitMs: tMs, reason: pl > 0 ? 'take profit' : 'stop' }; }
      });
    }
    const Sx = cs[exS.end].close, vx = vixClose(e);
    cands.forEach((c, q) => {
      if (open[q]) out[q] = { pl: positionAt(c.legs, Sx, expiryMs(e), vx ? vx / vixPrev : 1).pl, exitSpot: Sx, exitMs: expiryMs(e), reason: 'expiration' };
    });

    const ranked = cands.map((c, q) => [c, q]).sort((a, b) => b[0].rank - a[0].rank);
    const top = ranked[0];
    const takes = !requireConv || top[0].conviction;
    entries[h]++;
    if (!takes) skipped[h]++;
    for (const [c, q] of ranked) {
      const pl = out[q].pl - c.contracts * FEES_PER_CONTRACT;
      trades.push({
        horizon: h, date, exp: e, strat: c.t.id, name: c.t.name, bias: c.t.bias, picked: takes && c === top[0],
        conviction: c.conviction, conf: c.sc.conf.map((s) => s.name), conflicts: c.sc.conflict.map((s) => s.name),
        legs: c.legs, entrySpot: S, cost: c.cost, risk: c.risk, regime, ctxKey: c.ctxKey,
        exitSpot: out[q].exitSpot, exitMs: out[q].exitMs, reason: out[q].reason, pl, ror: pl / c.risk,
      });
    }
    if (jn % 5 === 0) { onProgress?.((jn + 1) / jobs.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  onProgress?.(1);
  return { trades, entries, skipped, window: { from: ss[n - W]?.date, to: ss[n - 1]?.date, sessions: W } };
}

// Aggregate stats for a list of trades.
export function summarize(list) {
  const wins = list.filter((t) => t.pl > 0);
  const gross = wins.reduce((a, t) => a + t.pl, 0);
  const loss = list.filter((t) => t.pl <= 0).reduce((a, t) => a + t.pl, 0);
  let eq = 0, peak = 0, dd = 0;
  [...list].sort((a, b) => a.exitMs - b.exitMs).forEach((t) => { eq += t.pl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); });
  const nLoss = list.length - wins.length;
  const avgWin = wins.length ? gross / wins.length : null, avgLoss = nLoss ? loss / nLoss : null;
  return {
    // win rate needed to break even given the average win and loss sizes (the honest bar for "80% win rate")
    avgWin, avgLoss, breakevenWR: avgWin && avgLoss ? -avgLoss / (avgWin - avgLoss) : null,
    n: list.length, wins: wins.length, winRate: list.length ? wins.length / list.length : null,
    net: gross + loss, avg: list.length ? (gross + loss) / list.length : null,
    avgRor: list.length ? mean(list.map((t) => t.ror)) : null,
    pf: loss ? gross / -loss : gross > 0 ? Infinity : null, maxDD: dd,
    best: list.length ? Math.max(...list.map((t) => t.pl)) : null, worst: list.length ? Math.min(...list.map((t) => t.pl)) : null,
  };
}
