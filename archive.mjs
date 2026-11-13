// Market data archive: saves real option chains and intraday bars every trading day so that, after a few
// weeks, GammaDesk can run a genuine gamma backtest (real open interest, real quotes) instead of a stand-in.
//
//   DATA_DIR/archive/YYYY-MM-DD/<SYM>-<HHMM>.json.gz   full compact chain (+ gamma summary) at each snapshot time
//   DATA_DIR/archive/YYYY-MM-DD/bars.json.gz           that day's 1-minute and 5-minute bars (SPY, SPX, QQQ, VIX, ES)
//
// Snapshots run at 10:00, 12:30 and 15:45 ET (taken late if the server was down, within 90 minutes).
// About 3–5 MB per trading day.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const ARCHIVE_CFG = {
  chains: ['SPY', 'SPX', 'QQQ'],
  bars: ['SPY', 'SPX', 'QQQ', '^VIX', 'ES'],
  slots: [10 * 60, 12 * 60 + 30, 15 * 60 + 45], // minutes after midnight ET
  barsAt: 16 * 60 + 20,
  graceMin: 90,
};

const fmtET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
function et(ms = Date.now()) {
  const p = Object.fromEntries(fmtET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: (+p.hour % 24) * 60 + +p.minute, dow: p.weekday };
}
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;

export function startArchive({ dir, getChain, getCandles, getGamma }) {
  const root = path.join(dir, 'archive');
  let busy = false;
  let last = { t: null, msg: 'Waiting for the first snapshot time (10:00 ET on trading days).' };

  const dayDir = (d) => path.join(root, d);
  const write = (file, obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(obj)));
    fs.renameSync(tmp, file);
  };

  async function isTradingDay(date) {
    const raw = await getChain('SPY');
    return String(raw.quote?.last_trade_time || '').startsWith(date);
  }

  async function snapChains(date, slot) {
    const saved = [];
    for (const sym of ARCHIVE_CFG.chains) {
      const file = path.join(dayDir(date), `${sym}-${hhmm(slot)}.json.gz`);
      if (fs.existsSync(file)) continue;
      try {
        const [raw, gamma] = await Promise.all([getChain(sym), getGamma(sym).catch(() => null)]);
        write(file, { savedAt: Date.now(), slot: hhmm(slot), chain: raw, gamma });
        saved.push(`${sym} (${raw.contracts.length.toLocaleString()} contracts, ${raw.source || 'cboe'})`);
      } catch (e) { saved.push(`${sym} failed: ${e.message}`); }
    }
    return saved;
  }

  async function snapBars(date) {
    const file = path.join(dayDir(date), 'bars.json.gz');
    if (fs.existsSync(file)) return null;
    const out = { savedAt: Date.now(), date, bars: {} };
    for (const sym of ARCHIVE_CFG.bars) {
      out.bars[sym] = {};
      for (const tf of ['1m', '5m']) {
        try {
          const c = await getCandles(sym, tf);
          // keep only this session's bars (ET date)
          out.bars[sym][tf] = { gmtoffset: c.gmtoffset, candles: c.candles.filter((k) => et(k.time * 1000).date === date) };
        } catch (e) { out.bars[sym][tf] = { error: e.message }; }
      }
    }
    write(file, out);
    return Object.keys(out.bars).length;
  }

  async function tick() {
    if (busy) return;
    const t = et();
    if (['Sat', 'Sun'].includes(t.dow) || t.hm < ARCHIVE_CFG.slots[0]) return;
    const due = ARCHIVE_CFG.slots.filter((s) => t.hm >= s && t.hm <= s + ARCHIVE_CFG.graceMin
      && ARCHIVE_CFG.chains.some((sym) => !fs.existsSync(path.join(dayDir(t.date), `${sym}-${hhmm(s)}.json.gz`))));
    const barsDue = t.hm >= ARCHIVE_CFG.barsAt && t.hm <= 23 * 60 && !fs.existsSync(path.join(dayDir(t.date), 'bars.json.gz'));
    if (!due.length && !barsDue) return;
    busy = true;
    try {
      if (!(await isTradingDay(t.date))) return;
      for (const s of due) {
        const saved = await snapChains(t.date, s);
        if (saved.length) { last = { t: Date.now(), msg: `Saved ${hhmm(s)} ET chains: ${saved.join(', ')}.` }; console.log(`[archive] ${last.msg}`); }
      }
      if (barsDue) {
        const n = await snapBars(t.date);
        if (n) { last = { t: Date.now(), msg: `Saved ${t.date} 1m/5m bars for ${n} symbols.` }; console.log(`[archive] ${last.msg}`); }
      }
    } catch (e) {
      last = { t: Date.now(), msg: `Archive failed: ${e.message}` };
      console.error(`[archive] ${last.msg}`);
    } finally { busy = false; }
  }

  function status() {
    let days = [];
    try { days = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch { /* none yet */ }
    let bytes = 0, snapshots = 0, barDays = 0;
    for (const d of days) {
      for (const f of fs.readdirSync(dayDir(d))) {
        bytes += fs.statSync(path.join(dayDir(d), f)).size;
        if (f === 'bars.json.gz') barDays++; else if (f.endsWith('.json.gz')) snapshots++;
      }
    }
    return { days: days.length, first: days[0] ?? null, lastDay: days.at(-1) ?? null, snapshots, barDays, mb: +(bytes / 1e6).toFixed(1), last, cfg: ARCHIVE_CFG };
  }

  setInterval(tick, 60e3);
  tick();
  return { status, tick };
}

// Reads one archived file (used by the future real-gamma backtest).
export function readArchive(dir, date, name) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'archive', date, name))).toString());
}
