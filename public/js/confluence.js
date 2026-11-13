// Confluence engine. Gamma levels are the backbone; VWAP / anchored VWAP, implied-vs-realized
// volatility, skew, term structure, VIX rank and learned level behavior confirm or reject a trade.
//
// Every signal votes on four directional theses (bull, bear, range, move) and two volatility
// stances (short = sell premium, long = buy premium), each in [-1, 1]. A strategy template has a
// bias + vol stance; a signal is a confluence for it when its combined vote is >= 0.5 and a
// conflict when <= -0.5. A trade needs >= minConfluence confluences (default 3) for conviction.
import { positionAt, netCost } from './strategies.js';
import { yearsTo, clock } from './math.js';
import { LEVEL_DEFS } from './levels.js';

const H = { daily: 'Intraday', weekly: 'Weekly', monthly: 'Monthly' };
const lbl = (id) => LEVEL_DEFS.find((d) => d.id === id)?.label || id;
const pct = (v, d = 2) => `${(v * 100).toFixed(d)}%`;
const $p = (v) => (+v).toFixed(2);

function sig(id, name, horizons) { return { id, name, horizons, dir: {}, vol: {}, detail: '', na: false }; }

// Multi-timeframe level clusters: levels from 2+ of daily/weekly/monthly within 0.25% of each other.
export function stackedLevels(all, S) {
  const pts = [];
  for (const [g, tag] of [['daily', 'D'], ['weekly', 'W'], ['monthly', 'M']]) {
    const r = all[g];
    if (!r) continue;
    for (const id of ['P1', 'P2', 'CW', 'PW', 'N1', 'FLIP']) if (r.levels[id]) pts.push({ p: r.levels[id].price, id, tag });
  }
  pts.sort((a, b) => a.p - b.p);
  const clusters = [];
  for (const pt of pts) {
    const c = clusters[clusters.length - 1];
    if (c && pt.p / c.lo - 1 < 0.0025) { c.items.push(pt); c.hi = pt.p; } else clusters.push({ lo: pt.p, hi: pt.p, items: [pt] });
  }
  return clusters
    .map((c) => ({ ...c, price: c.items.reduce((a, b) => a + b.p, 0) / c.items.length, tfs: new Set(c.items.map((i) => i.tag)) }))
    .filter((c) => c.tfs.size >= 2)
    .map((c) => ({ ...c, label: [...new Set(c.items.map((i) => `${lbl(i.id)} ${i.tag}`))].join(' + '), side: c.price < S ? 'support' : 'resistance', dist: (c.price - S) / S }));
}

// env: { S, horizon, lv, all, ip (intraday profile), iv (ivProfile), rv, vix, mem (level stats), sm (1-sigma move $) }
export function buildSignals(env) {
  const { S, horizon, lv, all, ip, iv, rv, vix, mem, sm } = env;
  const L = (id) => lv?.levels[id]?.price;
  const out = [];

  // 1. Gamma regime — the main truth
  let s = sig('regime', 'Gamma regime', ['daily', 'weekly', 'monthly']);
  if (lv.regime === 'positive') { s.dir = { range: 1, move: -1 }; s.vol = { short: 0.5 }; s.detail = `Dealers long gamma (${H[horizon]} levels): hedging dampens moves, favors ranges/pins.`; }
  else { s.dir = { move: 1, range: -1 }; s.vol = { long: 0.5 }; s.detail = `Dealers short gamma (${H[horizon]} levels): hedging amplifies moves, favors directional/long-vol.`; }
  out.push(s);

  // 2. Spot vs gamma flip
  s = sig('flip', 'Spot vs gamma flip', ['daily', 'weekly', 'monthly']);
  if (lv.flip == null) { s.na = true; s.detail = 'No flip within ±8%.'; }
  else {
    const d = S / lv.flip - 1;
    if (Math.abs(d) < 0.0015) { s.dir = { move: 0.5 }; s.detail = `Sitting on the flip ${$p(lv.flip)}: regime can switch either way.`; }
    else if (d > 0) { s.dir = { bull: 0.75, bear: -0.75 }; s.detail = `${pct(d)} above flip ${$p(lv.flip)}: dealers buy dips into it.`; }
    else { s.dir = { bear: 0.75, bull: -0.75, move: 0.25 }; s.detail = `${pct(-d)} below flip ${$p(lv.flip)}: below it selling tends to accelerate.`; }
  }
  out.push(s);

  // 3. Location vs walls
  s = sig('walls', 'Location vs walls', ['daily', 'weekly', 'monthly']);
  const cw = L('CW'), pw = L('PW'), tol = 0.35 * sm;
  if (!cw || !pw) { s.na = true; s.detail = 'Walls unavailable.'; }
  else if (S < pw) { s.dir = { bear: 1, move: 0.5, range: -1 }; s.detail = `Below put wall ${pw}: support broken.`; }
  else if (S > cw) { s.dir = { bull: 1, move: 0.5, range: -1 }; s.detail = `Above call wall ${cw}: resistance broken.`; }
  else if (S - pw <= tol) { s.dir = { bull: 1, bear: -0.5 }; s.detail = `Within ${$p(S - pw)} of put wall ${pw} (support).`; }
  else if (cw - S <= tol) { s.dir = { bear: 1, bull: -0.5 }; s.detail = `Within ${$p(cw - S)} of call wall ${cw} (resistance).`; }
  else { s.dir = { range: 0.75 }; s.detail = `Inside the ${pw}–${cw} wall range.`; }
  out.push(s);

  // 4. Multi-timeframe stacked levels
  s = sig('stack', 'Stacked levels (D/W/M)', ['daily', 'weekly', 'monthly']);
  const st = stackedLevels(all, S).filter((c) => Math.abs(c.price - S) <= sm);
  const sup = st.filter((c) => c.side === 'support').sort((a, b) => b.price - a.price)[0];
  const res = st.filter((c) => c.side === 'resistance').sort((a, b) => a.price - b.price)[0];
  const pin = st.find((c) => Math.abs(c.dist) < 0.0015 && c.items.some((i) => i.id === 'P1'));
  if (pin) { s.dir = { range: 1 }; s.detail = `Spot on a stacked magnet: ${pin.label} @ ${$p(pin.price)}.`; }
  else if (sup && res) { s.dir = { range: 1 }; s.detail = `Boxed in: support ${sup.label} @ ${$p(sup.price)}, resistance ${res.label} @ ${$p(res.price)}.`; }
  else if (sup) { s.dir = { bull: 1 }; s.detail = `Stacked support below: ${sup.label} @ ${$p(sup.price)}.`; }
  else if (res) { s.dir = { bear: 1 }; s.detail = `Stacked resistance above: ${res.label} @ ${$p(res.price)}.`; }
  else { s.na = true; s.detail = 'No multi-timeframe level within 1σ.'; }
  out.push(s);

  // 5. Session VWAP
  s = sig('vwap', 'Session VWAP', ['daily', 'weekly']);
  if (!ip) { s.na = true; s.detail = 'Intraday candles unavailable.'; }
  else {
    const z = (S - ip.vwap) / (ip.vwapSd || 1);
    if (Math.abs(z) < 0.15) { s.dir = { range: 0.5 }; s.detail = `At VWAP ${$p(ip.vwap)}: balanced.`; }
    else if (z > 0) { s.dir = { bull: 1, bear: -1, ...(z > 1 ? { range: 0.5 } : {}) }; s.detail = `Above VWAP ${$p(ip.vwap)}${z > 1 ? ' and beyond +1σ band (stretched)' : ''}: buyers in control.`; }
    else { s.dir = { bear: 1, bull: -1, ...(z < -1 ? { range: 0.5 } : {}) }; s.detail = `Below VWAP ${$p(ip.vwap)}${z < -1 ? ' and beyond −1σ band (stretched)' : ''}: sellers in control.`; }
  }
  out.push(s);

  // 6. 2-day anchored VWAP
  s = sig('avwap', '2-day anchored VWAP', ['daily', 'weekly', 'monthly']);
  if (!ip) { s.na = true; s.detail = 'Intraday candles unavailable.'; }
  else if (S >= ip.avwap2) { s.dir = { bull: 1, bear: -0.5 }; s.detail = `Above 2D AVWAP ${$p(ip.avwap2)}: 2-day buyers are in profit.`; }
  else { s.dir = { bear: 1, bull: -0.5 }; s.detail = `Below 2D AVWAP ${$p(ip.avwap2)}: 2-day buyers are trapped.`; }
  out.push(s);

  // 7. VWAP trend: session VWAP vs 2D anchored VWAP
  s = sig('vtrend', 'VWAP vs 2D AVWAP', ['daily', 'weekly']);
  if (!ip) { s.na = true; s.detail = 'Intraday candles unavailable.'; }
  else if (ip.vwap > ip.avwap2) { s.dir = { bull: 0.75 }; s.detail = `Session VWAP ${$p(ip.vwap)} above 2D AVWAP ${$p(ip.avwap2)}: value rising.`; }
  else { s.dir = { bear: 0.75 }; s.detail = `Session VWAP ${$p(ip.vwap)} below 2D AVWAP ${$p(ip.avwap2)}: value falling.`; }
  out.push(s);

  // 8. VWAP x gamma-level confluence zones
  s = sig('zone', 'VWAP ≈ gamma level', ['daily', 'weekly']);
  const zones = vwapZones(env);
  const zSup = zones.filter((z) => z.p < S && S - z.p <= 0.5 * sm).sort((a, b) => b.p - a.p)[0];
  const zRes = zones.filter((z) => z.p > S && z.p - S <= 0.5 * sm).sort((a, b) => a.p - b.p)[0];
  if (!ip) { s.na = true; s.detail = 'Intraday candles unavailable.'; }
  else if (zSup && !zRes) { s.dir = { bull: 1 }; s.detail = `Support zone ${$p(zSup.p)}: ${zSup.label}.`; }
  else if (zRes && !zSup) { s.dir = { bear: 1 }; s.detail = `Resistance zone ${$p(zRes.p)}: ${zRes.label}.`; }
  else if (zSup && zRes) { s.dir = { range: 1 }; s.detail = `Between zones ${$p(zSup.p)} and ${$p(zRes.p)}.`; }
  else { s.na = true; s.detail = 'No VWAP lines up with a gamma level nearby.'; }
  out.push(s);

  // 9. Implied vs realized volatility
  s = sig('ivrv', 'IV vs realized', ['daily', 'weekly', 'monthly']);
  if (!iv || !rv) { s.na = true; s.detail = 'Need IV and realized vol.'; }
  else {
    const r = iv.atm / rv;
    if (r > 1.15) { s.vol = { short: 1, long: -1 }; s.detail = `ATM IV ${pct(iv.atm, 1)} vs realized ${pct(rv, 1)} (${r.toFixed(2)}×): options rich, sell premium.`; }
    else if (r < 0.9) { s.vol = { long: 1, short: -1 }; s.detail = `ATM IV ${pct(iv.atm, 1)} vs realized ${pct(rv, 1)} (${r.toFixed(2)}×): options cheap, buy premium.`; }
    else { s.detail = `ATM IV ${pct(iv.atm, 1)} vs realized ${pct(rv, 1)} (${r.toFixed(2)}×): fairly priced.`; }
  }
  out.push(s);

  // 10. VIX rank
  s = sig('vix', 'VIX rank (1y)', ['daily', 'weekly', 'monthly']);
  if (!vix) { s.na = true; s.detail = 'VIX history unavailable.'; }
  else if (vix.rank > 0.5) { s.vol = { short: 1 }; s.detail = `VIX ${vix.value.toFixed(2)} at ${pct(vix.rank, 0)} of its 1y range: premium elevated.`; }
  else if (vix.rank < 0.2) { s.vol = { long: 0.75, short: -0.5 }; s.detail = `VIX ${vix.value.toFixed(2)} at ${pct(vix.rank, 0)} of its 1y range: premium cheap.`; }
  else { s.detail = `VIX ${vix.value.toFixed(2)} at ${pct(vix.rank, 0)} of its 1y range: neutral.`; }
  out.push(s);

  // 11. Put skew
  s = sig('skew', 'Put skew (1σ)', ['daily', 'weekly', 'monthly']);
  if (!iv) s.na = true;
  else if (iv.skew > 0.02) { s.dir = { bull: 0.75 }; s.detail = `1σ puts ${pct(iv.putIv, 1)} vs calls ${pct(iv.callIv, 1)}: downside protection is rich, selling put spreads gets paid.`; }
  else if (iv.skew < 0) { s.dir = { bear: 0.5 }; s.detail = `Calls priced over puts (${pct(iv.callIv, 1)} vs ${pct(iv.putIv, 1)}): unusual upside demand.`; }
  else s.detail = `1σ puts ${pct(iv.putIv, 1)} vs calls ${pct(iv.callIv, 1)}: normal skew.`;
  out.push(s);

  // 12. Term structure
  s = sig('term', 'Term structure', ['daily', 'weekly', 'monthly']);
  if (!iv?.frontIv) s.na = true;
  else if (iv.term > 1.03) { s.dir = { move: 1, range: -0.5 }; s.vol = { long: 0.5 }; s.detail = `Front IV ${pct(iv.frontIv, 1)} above 30d ${pct(iv.backIv, 1)} (inverted): near-term stress.`; }
  else if (iv.term < 0.92) { s.dir = { range: 0.5 }; s.vol = { short: 0.5 }; s.detail = `Front IV ${pct(iv.frontIv, 1)} below 30d ${pct(iv.backIv, 1)} (contango): calm near term.`; }
  else s.detail = `Front IV ${pct(iv.frontIv, 1)} vs 30d ${pct(iv.backIv, 1)}: flat.`;
  out.push(s);

  // 13. Intraday character from recent 5m bars
  s = sig('character', 'Intraday character', ['daily']);
  if (!ip) s.na = true;
  else if (ip.autocorr < -0.05 || ip.vwapCrosses >= 4) { s.dir = { range: 0.75 }; s.detail = `Choppy: ${ip.vwapCrosses.toFixed(1)} VWAP crosses/session, autocorrelation ${ip.autocorr.toFixed(2)}.`; }
  else if (ip.autocorr > 0.05 && ip.vwapCrosses < 3) { s.dir = { move: 0.75 }; s.detail = `Trending: ${ip.vwapCrosses.toFixed(1)} VWAP crosses/session, autocorrelation ${ip.autocorr.toFixed(2)}.`; }
  else s.detail = `Mixed: ${ip.vwapCrosses.toFixed(1)} VWAP crosses/session, autocorrelation ${ip.autocorr.toFixed(2)}.`;
  out.push(s);

  // 14. Learned level behavior from real sessions
  s = sig('memory', 'Level memory (real sessions)', ['daily', 'weekly']);
  if (!mem || mem.n < 5) { s.na = true; s.detail = `Collecting sessions (${mem?.n ?? 0}/5). Open the app each trading day.`; }
  else {
    const parts = [];
    if (lv.regime === 'positive' && mem.towardRate >= 0.6) { s.dir.range = 1; parts.push(`price closed nearer P1 in ${pct(mem.towardRate, 0)} of ${mem.n} sessions`); }
    if (pw && S - pw <= tol && mem.pwHoldRate != null && mem.pwHoldRate >= 0.65) { s.dir.bull = 1; parts.push(`put wall held ${pct(mem.pwHoldRate, 0)} of ${mem.pwTests} tests`); }
    if (cw && cw - S <= tol && mem.cwHoldRate != null && mem.cwHoldRate >= 0.65) { s.dir.bear = 1; parts.push(`call wall held ${pct(mem.cwHoldRate, 0)} of ${mem.cwTests} tests`); }
    s.detail = parts.length ? `${parts.join('; ')}.` : `No strong edge yet across ${mem.n} sessions.`;
  }
  out.push(s);

  return out.filter((x) => x.horizons.includes(horizon));
}

function vwapZones(env) {
  const { ip, lv, all } = env;
  if (!ip) return [];
  const lines = [['VWAP', ip.vwap], ['2D AVWAP', ip.avwap2]];
  const levels = [];
  for (const [r, tag] of [[lv, ''], ...(all.daily !== lv ? [[all.daily, ' D']] : [])]) {
    if (!r) continue;
    for (const id of ['P1', 'P2', 'CW', 'PW', 'N1', 'FLIP']) if (r.levels[id]) levels.push([`${lbl(id)}${tag}`, r.levels[id].price]);
  }
  const zones = [];
  for (const [vn, vp] of lines) {
    const hits = levels.filter(([, p]) => Math.abs(p / vp - 1) < 0.0015);
    if (hits.length) zones.push({ p: (vp + hits[0][1]) / 2, label: `${vn} ${$p(vp)} ≈ ${[...new Set(hits.map((h) => h[0]))].join(', ')}` });
  }
  return zones;
}

// Score one strategy template against the signals.
export function scoreTemplate(t, signals) {
  const conf = [], conflict = [], neutral = [];
  for (const s of signals) {
    if (s.na) continue;
    const v = (s.dir[t.bias] || 0) + (t.vol !== 'flat' ? s.vol[t.vol] || 0 : 0);
    (v >= 0.5 ? conf : v <= -0.5 ? conflict : neutral).push({ ...s, v });
  }
  return { conf, conflict, neutral, net: conf.length - conflict.length };
}

// Conviction rules. Gamma is the main truth: a trade the gamma regime argues against is vetoed.
// rules: { minConf, maxConflicts, gammaVeto }
export function qualifies(sc, rules) {
  if (rules.gammaVeto && sc.conflict.some((s) => s.id === 'regime')) return false;
  return sc.conf.length >= rules.minConf && sc.conflict.length <= rules.maxConflicts && sc.net > 0;
}

// Lean of the signals for one horizon: which thesis has the most support.
export function horizonLean(signals) {
  const tot = { bull: 0, bear: 0, range: 0, move: 0, short: 0, long: 0 };
  for (const s of signals) {
    if (s.na) continue;
    for (const [k, v] of Object.entries(s.dir)) tot[k] += v;
    for (const [k, v] of Object.entries(s.vol)) tot[k] += v;
  }
  const dir = ['bull', 'bear', 'range', 'move'].sort((a, b) => tot[b] - tot[a])[0];
  const vol = tot.short > tot.long + 0.5 ? 'sell premium' : tot.long > tot.short + 0.5 ? 'buy premium' : 'neutral IV';
  return { tot, dir, vol };
}

// Entry plan: price now, fair value from realized vol, and a better trigger at a nearby confluence level.
export function entryPlan(legs, bias, env) {
  const { S, ip, lv, all, iv, rv, sm } = env;
  const now = clock();
  const q = legs.filter((l) => l.type !== 'S').map((l) => l.qty);
  const lot = q.length ? Math.min(...q) : 1;
  const px = (s) => positionAt(legs, s, now).value / (100 * lot);
  const cost = netCost(legs);
  let edge = null, fairIv = null;
  if (iv && rv) {
    const k = rv / iv.atm; // scale the whole smile to realized-vol level
    fairIv = iv.atm * k;
    // compare model-to-model so the edge isolates volatility, not mid-vs-model noise
    const fair = positionAt(legs.map((l) => ({ ...l, iv: l.iv * k })), S, now).value;
    edge = fair - positionAt(legs, S, now).value; // > 0: sold above fair (credit) or bought below fair (debit)
  }
  // candidate trigger prices: VWAP lines + gamma levels within 1 sigma
  const cands = [];
  if (ip) cands.push(['VWAP', ip.vwap], ['VWAP −1σ', ip.vwapDn], ['VWAP +1σ', ip.vwapUp], ['2D AVWAP', ip.avwap2]);
  for (const [r, tag] of [[lv, ''], ...(all.daily !== lv ? [[all.daily, ' D']] : [])]) {
    if (!r) continue;
    for (const id of ['P1', 'P2', 'CW', 'PW', 'N1', 'FLIP']) if (r.levels[id]) cands.push([`${lbl(id)}${tag}`, r.levels[id].price]);
  }
  const near = cands.filter(([, p]) => Math.abs(p - S) <= sm && Math.abs(p / S - 1) > 0.001);
  const group = (side) => {
    const pts = near.filter(([, p]) => (side < 0 ? p < S : p > S)).sort((a, b) => (side < 0 ? b[1] - a[1] : a[1] - b[1]));
    if (!pts.length) return null;
    const first = pts[0][1];
    const same = pts.filter(([, p]) => Math.abs(p / first - 1) < 0.0015);
    return { price: same.reduce((a, b) => a + b[1], 0) / same.length, label: [...new Set(same.map((x) => x[0]))].join(' + '), count: same.length };
  };
  const trig = bias === 'bull' ? group(-1) : bias === 'bear' ? group(1) : null;
  const nowPx = px(S);
  const entryPx = cost / (100 * lot); // market mid
  const edgePerShare = edge == null ? null : edge / (100 * lot);
  const plan = { nowPx, entryPx, lot, edge, edgePerShare, fairPx: edgePerShare == null ? null : entryPx + edgePerShare, fairIv, rv, atm: iv?.atm };
  // limit at the trigger = market mid + model change in spread value (sticky-strike IV)
  if (trig) { plan.trigger = trig; plan.triggerPx = entryPx + (px(trig.price) - nowPx); }
  plan.T = Math.max(...legs.filter((l) => l.type !== 'S').map((l) => yearsTo(l.exp, now)));
  return plan;
}
