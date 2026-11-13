// Price-action and volatility indicators: session VWAP (+bands), 2-day anchored VWAP,
// realized volatility, intraday behavior profile, and implied-volatility analytics.
import { yearsTo, dte } from './math.js';

const dayKey = (t, off) => new Date((t + off) * 1000).toISOString().slice(0, 10);

// Split candles into sessions (ET calendar days). Returns [{date, start, end}] index ranges.
export function sessions(candles, off = 0) {
  const out = [];
  candles.forEach((c, i) => {
    const d = dayKey(c.time, off);
    if (!out.length || out[out.length - 1].date !== d) out.push({ date: d, start: i, end: i });
    else out[out.length - 1].end = i;
  });
  return out;
}

// Cumulative volume-weighted average price from index i0 to i1 with a volume-weighted std band.
function vwapRun(candles, i0, i1) {
  let pv = 0, v = 0, pv2 = 0;
  const out = [];
  for (let i = i0; i <= i1; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume > 0 ? c.volume : 1;
    pv += tp * vol; v += vol; pv2 += tp * tp * vol;
    const m = pv / v;
    out.push({ time: c.time, vwap: m, sd: Math.sqrt(Math.max(pv2 / v - m * m, 0)) });
  }
  return out;
}

// Series for charting: session VWAP resetting each day, plus VWAP anchored at the prior session's open.
export function vwapSeries(candles, off = 0) {
  const ss = sessions(candles, off);
  const vwap = ss.flatMap((s) => vwapRun(candles, s.start, s.end));
  const anchor = ss.length >= 2 ? ss[ss.length - 2].start : 0;
  const avwap = candles.length ? vwapRun(candles, anchor, candles.length - 1) : [];
  return { vwap, avwap, anchorTime: candles[anchor]?.time };
}

const logRets = (xs) => xs.slice(1).map((x, i) => Math.log(x / xs[i]));
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

// Close-to-close realized vol (annualized) over the last n daily bars.
export function realizedVol(daily, n = 20) {
  const closes = daily.slice(-(n + 1)).map((c) => c.close);
  return stdev(logRets(closes)) * Math.sqrt(252);
}

// Intraday profile from 5m candles: VWAP / 2D AVWAP now, intraday RV, mean-reversion stats.
export function intradayProfile(candles, off = 0) {
  if (!candles || candles.length < 20) return null;
  const ss = sessions(candles, off);
  const barMin = Math.round((candles[1].time - candles[0].time) / 60) || 5;
  const barsPerDay = Math.round(390 / barMin);
  const rets = [];
  let crosses = 0, rangeSum = 0;
  for (const s of ss) {
    const run = vwapRun(candles, s.start, s.end);
    let prev = null, hi = -Infinity, lo = Infinity;
    for (let i = s.start; i <= s.end; i++) {
      if (i > s.start) rets.push(Math.log(candles[i].close / candles[i - 1].close));
      hi = Math.max(hi, candles[i].high); lo = Math.min(lo, candles[i].low);
      const side = Math.sign(candles[i].close - run[i - s.start].vwap);
      if (prev && side && side !== prev) crosses++;
      if (side) prev = side;
    }
    rangeSum += (hi - lo) / candles[s.start].open;
  }
  // lag-1 autocorrelation: negative = choppy / mean-reverting, positive = trending
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  let num = 0, den = 0;
  for (let i = 0; i < rets.length; i++) {
    den += (rets[i] - m) ** 2;
    if (i) num += (rets[i] - m) * (rets[i - 1] - m);
  }
  const last = ss[ss.length - 1];
  const sess = vwapRun(candles, last.start, last.end);
  const cur = sess[sess.length - 1];
  const anchor = ss.length >= 2 ? ss[ss.length - 2] : last;
  const av = vwapRun(candles, anchor.start, candles.length - 1);
  const prevS = ss.length >= 2 ? ss[ss.length - 2] : null;
  const hiLo = (s) => s && { high: Math.max(...candles.slice(s.start, s.end + 1).map((c) => c.high)), low: Math.min(...candles.slice(s.start, s.end + 1).map((c) => c.low)) };
  return {
    sessionDate: last.date,
    close: candles[candles.length - 1].close,
    vwap: cur.vwap, vwapUp: cur.vwap + cur.sd, vwapDn: cur.vwap - cur.sd, vwapSd: cur.sd,
    avwap2: av[av.length - 1].vwap,
    today: hiLo(last), prev: hiLo(prevS),
    rvIntraday: stdev(rets) * Math.sqrt(barsPerDay * 252),
    autocorr: den ? num / den : 0,
    vwapCrosses: crosses / ss.length,
    avgRange: rangeSum / ss.length,
    days: ss.length,
  };
}

// Percentile rank of the latest close within the series (e.g. VIX over 1 year).
export function vixStats(daily) {
  if (!daily || daily.length < 30) return null;
  const closes = daily.map((c) => c.close);
  const cur = closes[closes.length - 1];
  const lo = Math.min(...closes), hi = Math.max(...closes);
  return { value: cur, rank: (cur - lo) / (hi - lo || 1), pct: closes.filter((c) => c < cur).length / closes.length, lo, hi };
}

// Implied-vol picture for one expiration: ATM IV, 1-sigma put/call skew, and term structure.
export function ivProfile(mkt, exp) {
  const x = mkt.byExp.get(exp);
  if (!x) return null;
  const S = mkt.spot, T = Math.max(yearsTo(exp), 1 / 365);
  const sm = S * x.atmIv * Math.sqrt(T);
  const live = mkt.exps.filter((e) => dte(e) > 0.5);
  const near = live[0], m30 = live.reduce((b, e) => (Math.abs(dte(e) - 30) < Math.abs(dte(b) - 30) ? e : b), live[0]);
  const front = mkt.byExp.get(near)?.atmIv, back = mkt.byExp.get(m30)?.atmIv;
  return {
    exp, atm: x.atmIv, putIv: x.ivAt(S - sm), callIv: x.ivAt(S + sm),
    skew: x.ivAt(S - sm) - x.ivAt(S + sm),
    term: front && back ? front / back : 1, frontIv: front, backIv: back,
  };
}
