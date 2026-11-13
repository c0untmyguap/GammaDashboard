// Level memory: snapshots the gamma levels for each upcoming session, then scores what price
// actually did in that session (pin toward P1, wall holds, range vs expected move by regime).
// This is real-data learning; it grows by one session every trading day the app is opened.
const KEY = 'gammadesk.levelmem.v1';
const KEEP = 250;

let mem = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* ignore */ } };

// The session the current chain describes: after the 16:00 ET close it is the next weekday.
// CBOE chain timestamps are UTC ("YYYY-MM-DD HH:MM:SS").
export function targetSession(chainTs) {
  const utc = new Date(`${String(chainTs).replace(' ', 'T')}Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(utc).map((x) => [x.type, x.value]));
  const dt = new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
  if (+p.hour % 24 >= 16) dt.setUTCDate(dt.getUTCDate() + 1);
  while ([0, 6].includes(dt.getUTCDay())) dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

const pick = (r) => r && {
  regime: r.regime, total: r.total, em: r.em, flip: r.flip,
  ...Object.fromEntries(['P1', 'P2', 'N1', 'CW', 'PW'].filter((k) => r.levels[k]).map((k) => [k, r.levels[k].price])),
};

// Keep the earliest snapshot per session so levels are never peeked from later in the day.
export function snapshot(mkt, results) {
  const date = targetSession(mkt.timestamp);
  if (mem[date] || !results.daily) return;
  mem[date] = { date, symbol: mkt.symbol, takenAt: mkt.timestamp, spot: mkt.spot, daily: pick(results.daily), weekly: pick(results.weekly) };
  const keys = Object.keys(mem).sort();
  while (keys.length > KEEP) delete mem[keys.shift()];
  persist();
}

// Score completed sessions against daily OHLC candles.
export function levelStats(symbol, daily, off = 0) {
  if (!daily?.length) return null;
  const bars = new Map(daily.map((c) => [new Date((c.time + off) * 1000).toISOString().slice(0, 10), c]));
  const today = new Date(Date.now() + off * 1000).toISOString().slice(0, 10);
  const s = { n: 0, toward: 0, pinned: 0, cwTests: 0, cwHolds: 0, pwTests: 0, pwHolds: 0, pos: [], neg: [], sessions: [] };
  for (const snap of Object.values(mem)) {
    if (snap.symbol !== symbol || !snap.daily) continue;
    const c = bars.get(snap.date);
    if (!c || (snap.date === today && new Date().getUTCHours() < 21)) continue; // session not finished
    const L = snap.daily;
    const row = { date: snap.date, regime: L.regime, open: c.open, high: c.high, low: c.low, close: c.close };
    s.n++;
    if (L.P1) {
      row.toward = Math.abs(c.close - L.P1) < Math.abs(c.open - L.P1);
      row.pinned = Math.abs(c.close / L.P1 - 1) < 0.003;
      s.toward += row.toward; s.pinned += row.pinned;
    }
    if (L.CW && c.high >= L.CW * 0.999) { s.cwTests++; row.cw = c.close < L.CW ? 'held' : 'broke'; s.cwHolds += c.close < L.CW; }
    if (L.PW && c.low <= L.PW * 1.001) { s.pwTests++; row.pw = c.close > L.PW ? 'held' : 'broke'; s.pwHolds += c.close > L.PW; }
    if (L.em) { row.rangeVsEm = (c.high - c.low) / (2 * L.em); (L.regime === 'positive' ? s.pos : s.neg).push(row.rangeVsEm); }
    s.sessions.push(row);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  s.sessions.sort((a, b) => (a.date < b.date ? 1 : -1));
  return {
    ...s,
    towardRate: s.n ? s.toward / s.n : null,
    pinRate: s.n ? s.pinned / s.n : null,
    cwHoldRate: s.cwTests ? s.cwHolds / s.cwTests : null,
    pwHoldRate: s.pwTests ? s.pwHolds / s.pwTests : null,
    rangePos: avg(s.pos), rangeNeg: avg(s.neg),
    snapshots: Object.values(mem).filter((x) => x.symbol === symbol).length,
  };
}
