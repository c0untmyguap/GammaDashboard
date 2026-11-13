// App shell: data loading, Gamma Levels tab, and AI bot tab wiring.
/* global LightweightCharts */
import { loadMarket, loadCandles } from './data.js';
import { computeLevels, groupExps, LEVEL_DEFS, GROUP_DEFS } from './levels.js';
import { fmt, fmtExp, dte, yearsTo } from './math.js';
import { vwapSeries, intradayProfile, realizedVol, vixStats, ivProfile } from './indicators.js';
import { buildSignals, scoreTemplate, horizonLean, entryPlan, qualifies } from './confluence.js';
import * as Memory from './memory.js';
import { runBacktest, summarize, fitSkew } from './backtest.js';
import { C, upsertChart } from './chartutil.js';
import { initBuilder, setBuilderMarket, setBuilderLevels, loadStrategy } from './builder.js';
import * as Bot from './bot.js';

const $ = (id) => document.getElementById(id);
const PREFS_KEY = 'gammadesk.prefs.v1';

const defaults = {
  symbol: 'SPY', tf: '5m', customDays: 14, customExps: null,
  groupsOn: { daily: true, weekly: true, monthly: false, custom: true },
  levelsOn: { P1: true, N1: true, CW: true, PW: true, FLIP: true },
  gexGroup: 'custom', gexMode: 'net', strikeWin: 25,
  ind: { vwap: true, bands: false, avwap: true },
};
const P = (() => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch { return { ...defaults }; } })();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(P)); } catch { /* ignore */ } };

const A = { mkt: null, candles: null, results: {}, custom: new Set(), charts: {}, price: null, series: null, lines: [], timer: null,
  intraday: null, daily: null, vixDaily: null, ip: null, vix: null, rv5: null, rv20: null, memStats: null, ind: {} };

// ---------------- data ----------------
async function loadAll(showBanner = true) {
  $('refreshBtn').disabled = true;
  try {
    const soft = (p) => p.catch(() => null);
    const [mkt, candles, intraday, daily, vixDaily] = await Promise.all([
      loadMarket(P.symbol),
      loadCandles(P.symbol, P.tf).catch((e) => ({ error: e.message, candles: [] })),
      soft(loadCandles(P.symbol, '5m')),
      soft(loadCandles(P.symbol, '1d')),
      soft(loadCandles('^VIX', '1d')),
    ]);
    A.mkt = mkt;
    A.candles = candles;
    A.intraday = intraday; A.daily = daily; A.vixDaily = vixDaily;
    A.ip = intraday ? intradayProfile(intraday.candles, intraday.gmtoffset) : null;
    A.vix = vixDaily ? vixStats(vixDaily.candles) : null;
    A.rv5 = daily ? realizedVol(daily.candles, 5) : null;
    A.rv20 = daily ? realizedVol(daily.candles, 20) : null;
    // keep the user's custom selection when it is still valid
    const keep = P.customExps ? P.customExps.filter((e) => mkt.byExp.has(e)) : [];
    A.custom = new Set(keep.length ? keep : mkt.exps.filter((e) => dte(e) <= P.customDays));
    if (!A.custom.size) A.custom.add(mkt.exps[0]);
    hideBanner();
    if (candles.error) banner(`Price candles unavailable (${candles.error}). Levels and options data still loaded.`, 'info');
    computeAll();
    Memory.snapshot(mkt, A.results);
    A.memStats = daily ? Memory.levelStats(mkt.symbol, daily.candles, daily.gmtoffset) : null;
    await loadIndexGamma();
    if (P.groupsOn.spx === undefined) P.groupsOn.spx = true;
    renderToggles();
    renderQuote();
    renderExpChips();
    renderPriceChart(true);
    setBuilderMarket(mkt, A.results);
    autoForward();
    renderBot();
    renderForward();
    Bot.scoreJournal(mkt.symbol).then((r) => { if (r.scored) { renderBot(); renderForward(); } }).catch(() => {});
  } catch (e) {
    if (showBanner) banner(`Could not load ${P.symbol}: ${e.message}. Is the local server running (node server.js)?`);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

// SPX / ES / QQQ gamma summaries (server-computed), used as confluence and on every tab.
async function loadIndexGamma() {
  const get = (s) => fetch(`/api/gamma?symbol=${s}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [spx, es, qqq] = await Promise.all(['SPX', 'ES', 'QQQ'].map(get));
  A.idx = { spx, es, qqq };
}

function computeAll() {
  for (const g of GROUP_DEFS) {
    const exps = groupExps(A.mkt, g.id, [...A.custom].sort());
    A.results[g.id] = exps.length ? computeLevels(A.mkt, exps) : null;
  }
}

function banner(msg, kind = '') { const b = $('banner'); b.textContent = msg; b.className = `banner ${kind}`; }
function hideBanner() { $('banner').className = 'banner hidden'; }

// ---------------- header ----------------
function renderQuote() {
  const q = A.mkt.quote;
  $('qPrice').textContent = fmt.num(A.mkt.spot);
  const chg = q.price_change ?? 0, pc = q.price_change_percent ?? 0;
  $('qChg').textContent = `${fmt.signed(chg)} (${fmt.signed(pc)}%)`;
  $('qChg').className = `q-chg ${chg >= 0 ? 'up' : 'down'}`;
  const ts = new Date(`${String(A.mkt.timestamp).replace(' ', 'T')}Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const esNote = q.basis != null ? ` · SPX ${q.spx_price.toFixed(2)} + basis ${q.basis >= 0 ? '+' : ''}${q.basis}` : '';
  $('qMeta').title = $('qMeta').textContent = `IV30 ${q.iv30 ? q.iv30.toFixed(1) + '%' : '—'} · chain ${ts} ET (delayed)${esNote}`;
  $('qPrice').title = `IV30 ${q.iv30 ? q.iv30.toFixed(1) + '%' : '—'} · options chain as of ${ts} ET (15-min delayed CBOE data)${q.basis != null ? `. /ES levels = SPX gamma levels + ES–SPX basis (${q.basis}); CME ES options data isn't free.` : ''}`;
  document.querySelectorAll('[data-sym]').forEach((b) => b.classList.toggle('active', b.dataset.sym === A.mkt.symbol));
  document.title = `${A.mkt.symbol} ${fmt.num(A.mkt.spot)} · GammaDesk`;
}

// ---------------- expirations ----------------
function renderExpChips() {
  $('expChips').innerHTML = A.mkt.exps.map((e) => {
    const d = dte(e);
    return `<span class="chip ${A.custom.has(e) ? 'on' : ''}" data-exp="${e}" role="checkbox" aria-checked="${A.custom.has(e)}">${fmtExp(e)}<small>${d < 1 ? d.toFixed(1) : Math.round(d)}d</small></span>`;
  }).join('');
}
function customChanged() {
  P.customExps = [...A.custom];
  savePrefs();
  A.results.custom = A.custom.size ? computeLevels(A.mkt, [...A.custom].sort()) : null;
  renderExpChips();
  renderLevelsTab();
  setBuilderLevels(A.results);
}

// ---------------- levels tab ----------------
function renderLevelsTab() {
  drawLevelLines();
  renderSummary();
  renderGex();
  renderLevelsTable();
  renderProfile();
  renderStrikeTable();
}

function focus() { return A.results[P.gexGroup] || A.results.custom || A.results.weekly; }

function renderSummary() {
  const r = focus();
  if (!r) { $('summary').innerHTML = ''; return; }
  const g = GROUP_DEFS.find((x) => x.id === P.gexGroup);
  const L = r.levels, s = r.spot;
  const d = (v) => (v == null ? '' : `${fmt.signed((v / s - 1) * 100, 2)}% from spot`);
  const tiles = [
    ['Net GEX', `${fmt.bigUsd(r.total)}`, `per 1% move · ${g.label}`, r.total >= 0 ? 'pos' : 'neg'],
    ['Regime', r.regime === 'positive' ? 'Positive γ' : 'Negative γ', r.regime === 'positive' ? 'vol dampened, mean-reverting' : 'vol amplified, trending', r.regime === 'positive' ? 'pos' : 'neg'],
    ['Gamma flip', r.flip ? r.flip.toFixed(2) : '—', d(r.flip)],
    ['P1', L.P1 ? L.P1.price : '—', d(L.P1?.price), 'pos'],
    ['N1', L.N1 ? L.N1.price : '—', d(L.N1?.price), 'neg'],
    ['Call / Put wall', `${L.CW?.price ?? '—'} / ${L.PW?.price ?? '—'}`, 'resistance / support'],
    ['Expected move', r.em ? `±${r.em.toFixed(2)}` : '—', r.em ? `${fmt.pct(r.em / s, 2)} · ${fmtExp([...r.exps].sort()[0], false)}` : ''],
  ];
  $('summary').innerHTML = tiles.map(([k, v, sub, c]) => `<div class="tile"><div class="k">${k}</div><div class="v ${c || ''}">${v}</div><div class="s">${sub}</div></div>`).join('');
}

function renderToggles() {
  $('groupToggles').innerHTML = GROUP_DEFS.map((g) => {
    const dash = ['solid', 'dotted', 'dashed', 'dashed'][g.style];
    return `<span class="tog ${P.groupsOn[g.id] ? 'on' : ''}" data-group="${g.id}" data-tip="${g.desc}"><i style="border-top-style:${dash}"></i>${g.label}</span>`;
  }).join('');
  if (A.mkt?.symbol === 'SPY') $('groupToggles').innerHTML += `<span class="tog ${P.groupsOn.spx ? 'on' : ''}" data-group="spx" data-tip="SPX gamma levels translated to SPY prices (follows the GEX panel's expiration set; weekly when 'Selected')"><i style="border-top-style:dotted;border-top-width:3px"></i>SPX</span>`;
  $('levelToggles').innerHTML = LEVEL_DEFS.map((d) => `<span class="tog ${P.levelsOn[d.id] ? 'on' : ''}" data-level="${d.id}" data-tip="${d.desc}"><span class="dot" style="background:${d.color}"></span>${d.label}</span>`).join('')
    + '<span class="tog" data-level="__all">All</span><span class="tog" data-level="__none">None</span>';
  const IND = [['vwap', 'VWAP', '#fbbf24', 'Session VWAP (resets each day)'], ['bands', 'VWAP ±1σ', '#fbbf24', 'Volume-weighted standard deviation bands around session VWAP'], ['avwap', '2D AVWAP', '#c084fc', 'VWAP anchored at the open of the previous session']];
  $('indToggles').innerHTML = '<span class="hint">Indicators</span>' + IND.map(([id, name, col, tip]) => `<span class="tog ${P.ind[id] ? 'on' : ''}" data-ind="${id}" data-tip="${tip}"><span class="dot" style="background:${col}"></span>${name}</span>`).join('');
  $('gexGroup').innerHTML = GROUP_DEFS.map((g) => `<option value="${g.id}">${g.label} levels</option>`).join('');
  $('gexGroup').value = P.gexGroup;
  $('gexMode').value = P.gexMode;
}

function renderPriceChart(reset) {
  const el = $('priceChart');
  if (!A.price) {
    A.price = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: C.muted, fontFamily: 'Inter, sans-serif' },
      grid: { vertLines: { color: 'rgba(148,163,184,0.06)' }, horzLines: { color: 'rgba(148,163,184,0.06)' } },
      rightPriceScale: { borderColor: '#1f2a3d' },
      timeScale: { borderColor: '#1f2a3d', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    A.series = A.price.addCandlestickSeries({ upColor: C.green, downColor: C.red, borderVisible: false, wickUpColor: C.green, wickDownColor: C.red });
  }
  document.querySelectorAll('#tfRow .seg').forEach((b) => b.classList.toggle('active', b.dataset.tf === P.tf));
  const off = A.candles.gmtoffset || 0;
  const data = (A.candles.candles || []).map((c) => ({ time: c.time + off, open: c.open, high: c.high, low: c.low, close: c.close }));
  A.series.setData(data);
  drawIndicators(off);
  if (reset && data.length) {
    const n = data.length;
    const show = P.tf === '1d' ? 120 : P.tf === '1h' ? 140 : 160;
    A.price.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - show), to: n + 8 });
  }
  renderLevelsTab();
}

function drawIndicators(off) {
  if (!A.ind.vwap) {
    const mk = (color, style, title) => A.price.addLineSeries({ color, lineWidth: style ? 1 : 2, lineStyle: style, priceLineVisible: false, lastValueVisible: !!title, title, crosshairMarkerVisible: false });
    A.ind = { vwap: mk('#fbbf24', 0, 'VWAP'), up: mk('rgba(251,191,36,0.55)', 2, ''), dn: mk('rgba(251,191,36,0.55)', 2, ''), avwap: mk('#c084fc', 0, '2D AVWAP') };
  }
  const cs = A.candles.candles || [];
  const intradayTf = P.tf !== '1d' && cs.length;
  const v = intradayTf ? vwapSeries(cs, off) : { vwap: [], avwap: [] };
  const t = (x) => x.time + off;
  A.ind.vwap.setData(v.vwap.map((x) => ({ time: t(x), value: x.vwap })));
  A.ind.up.setData(v.vwap.map((x) => ({ time: t(x), value: x.vwap + x.sd })));
  A.ind.dn.setData(v.vwap.map((x) => ({ time: t(x), value: x.vwap - x.sd })));
  A.ind.avwap.setData(v.avwap.map((x) => ({ time: t(x), value: x.vwap })));
  A.ind.vwap.applyOptions({ visible: P.ind.vwap });
  A.ind.up.applyOptions({ visible: P.ind.bands });
  A.ind.dn.applyOptions({ visible: P.ind.bands });
  A.ind.avwap.applyOptions({ visible: P.ind.avwap });
}

function drawLevelLines() {
  if (!A.series) return;
  A.lines.forEach((l) => A.series.removePriceLine(l));
  A.lines = [];
  // One line per (level, price): sets that agree are merged into a single line tagged e.g. "P1 D·W"
  const tag = { daily: 'D', weekly: 'W', monthly: 'M', custom: 'S' };
  const merged = new Map();
  for (const g of GROUP_DEFS) {
    const r = A.results[g.id];
    if (!P.groupsOn[g.id] || !r) continue;
    for (const d of LEVEL_DEFS) {
      const lv = r.levels[d.id];
      if (!P.levelsOn[d.id] || !lv) continue;
      const key = `${d.id}|${lv.price.toFixed(2)}`;
      if (merged.has(key)) merged.get(key).tags.push(tag[g.id]);
      else merged.set(key, { d, g, price: lv.price, tags: [tag[g.id]] });
    }
  }
  for (const { d, g, price, tags } of merged.values()) {
    A.lines.push(A.series.createPriceLine({
      price, color: d.color, lineWidth: tags.length > 1 || g.id === 'daily' ? 2 : 1, lineStyle: g.style,
      axisLabelVisible: true, title: `${d.label} ${tags.join('·')}`,
    }));
  }
  // SPX gamma levels translated into SPY prices (sparse dots), following the GEX panel's expiration set
  const spx = A.idx?.spx, set = ['daily', 'weekly', 'monthly'].includes(P.gexGroup) ? P.gexGroup : 'weekly';
  if (P.groupsOn.spx && spx && A.mkt.symbol === 'SPY' && spx.groups[set]) {
    const k = A.mkt.spot / spx.spot;
    for (const d of LEVEL_DEFS) {
      const v = spx.groups[set].levels[d.id];
      if (!P.levelsOn[d.id] || v == null) continue;
      A.lines.push(A.series.createPriceLine({ price: v * k, color: d.color, lineWidth: 1, lineStyle: 4, axisLabelVisible: true, title: `${d.label} SPX ${v.toFixed(0)}` }));
    }
  }
}

function renderGex() {
  const r = A.results[P.gexGroup];
  if (!r) { if (A.charts.gex) { A.charts.gex.destroy(); A.charts.gex = null; } return; }
  const s = r.spot;
  const rows = r.rows.filter((x) => Math.abs(x.k / s - 1) < 0.035 && (x.cOI + x.pOI + x.cVol + x.pVol) > 0);
  // keep whole-dollar strikes when the chain is very dense
  const step = Math.ceil(rows.length / 70);
  const list = (step > 1 ? rows.filter((_, i) => i % step === 0) : rows).slice().reverse();
  const labels = list.map((x) => x.k);
  const mode = P.gexMode;
  const pair = (cLabel, pLabel, cf, pf) => [
    { label: cLabel, data: list.map(cf), backgroundColor: C.green, stack: 's' },
    { label: pLabel, data: list.map(pf), backgroundColor: C.red, stack: 's' },
  ];
  const datasets = {
    net: () => [{ label: 'Net GEX', data: list.map((x) => x.net), backgroundColor: list.map((x) => (x.net >= 0 ? C.green : C.red)) }],
    cp: () => pair('Call GEX', 'Put GEX', (x) => x.cG, (x) => x.pG),
    abs: () => [{ label: 'Absolute GEX', data: list.map((x) => x.abs), backgroundColor: C.violet }],
    vol: () => pair('Call volume', 'Put volume', (x) => x.cVol, (x) => -x.pVol),
    oi: () => pair('Call OI', 'Put OI', (x) => x.cOI, (x) => -x.pOI),
  }[mode]();
  const isGex = ['net', 'cp', 'abs'].includes(mode);
  $('gexTitle').textContent = { net: 'Net GEX by strike', cp: 'Call / put GEX by strike', abs: 'Absolute GEX by strike', vol: "Today's volume by strike", oi: 'Open interest by strike' }[mode];
  // fractional index of spot for the reference line (labels are descending)
  let idx = null;
  for (let i = 0; i < labels.length - 1; i++) {
    if (labels[i] >= s && labels[i + 1] <= s) { idx = i + (labels[i] - s) / (labels[i] - labels[i + 1] || 1); break; }
  }
  const yl = idx != null ? [{ index: idx, color: C.white, label: `Spot ${s.toFixed(2)}`, dash: [4, 3] }] : [];
  if (r.flip) {
    for (let i = 0; i < labels.length - 1; i++) {
      if (labels[i] >= r.flip && labels[i + 1] <= r.flip) { yl.push({ index: i + (labels[i] - r.flip) / (labels[i] - labels[i + 1] || 1), color: C.pink, label: `Flip ${r.flip.toFixed(1)}`, dash: [2, 3] }); break; }
    }
  }
  upsertChart(A.charts, 'gex', $('gexChart'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      indexAxis: 'y',
      datasets: { bar: { barPercentage: 0.9, categoryPercentage: 0.95 } },
      scales: {
        x: { stacked: true, ticks: { callback: (v) => fmt.big(isGex ? v : Math.abs(v)) }, grid: { color: C.grid } },
        y: { stacked: true, ticks: { autoSkip: true, font: { family: 'JetBrains Mono', size: 10 } }, grid: { display: false } },
      },
      plugins: {
        legend: { display: !['net', 'abs'].includes(mode), labels: { boxWidth: 10, color: C.text } },
        tooltip: { callbacks: { label: (i) => (isGex ? `${i.dataset.label}: ${fmt.bigUsd(i.parsed.x)} / 1%` : `${i.dataset.label}: ${Math.abs(i.parsed.x).toLocaleString()} contracts`) } },
        refLines: { y: yl },
      },
    },
  });
}

function renderLevelsTable() {
  const s = A.mkt.spot;
  const groups = GROUP_DEFS.filter((g) => A.results[g.id]);
  const head = `<tr><th>Level</th>${groups.map((g) => `<th title="${g.desc}">${g.label}${g.id === 'custom' ? ` (${A.custom.size})` : ''}</th>`).join('')}</tr>`;
  const body = LEVEL_DEFS.map((d) => `<tr><td><span class="lvl-name" data-tip="${d.desc}"><span class="dot" style="background:${d.color}"></span>${d.label}</span></td>${
    groups.map((g) => {
      const lv = A.results[g.id].levels[d.id];
      if (!lv) return '<td class="n">—</td>';
      const p = d.id === 'FLIP' || d.id.startsWith('EM') ? lv.price.toFixed(2) : lv.price;
      return `<td class="n">${p}<span class="dist">${fmt.signed((lv.price / s - 1) * 100, 2)}%</span></td>`;
    }).join('')}</tr>`).join('');
  const net = `<tr><td><b>Net GEX</b></td>${groups.map((g) => { const t = A.results[g.id].total; return `<td class="n ${t >= 0 ? 'pos' : 'neg'}">${fmt.bigUsd(t)}</td>`; }).join('')}</tr>`;
  $('levelsTable').innerHTML = `<thead>${head}</thead><tbody>${body}${net}</tbody>`;
}

function renderProfile() {
  const r = focus();
  if (!r) return;
  const { prices, values } = r.profile;
  const data = prices.map((p, i) => ({ x: p, y: values[i] }));
  const xl = [{ v: r.spot, color: C.white, label: `Spot ${r.spot.toFixed(2)}`, width: 1.5 }];
  if (r.flip) xl.push({ v: r.flip, color: C.pink, label: `Flip ${r.flip.toFixed(2)}`, dash: [4, 3] });
  if (r.levels.CW) xl.push({ v: r.levels.CW.price, color: C.blue, label: 'CW', dash: [2, 3] });
  if (r.levels.PW) xl.push({ v: r.levels.PW.price, color: C.amber, label: 'PW', dash: [2, 3] });
  $('profileHint').textContent = `total dealer gamma if spot moved · ${GROUP_DEFS.find((g) => g.id === P.gexGroup).label} expirations`;
  upsertChart(A.charts, 'profile', $('profileChart'), {
    type: 'line',
    data: { datasets: [{ data, borderColor: C.violet, borderWidth: 2, pointRadius: 0, fill: { target: { value: 0 }, above: 'rgba(34,197,94,0.15)', below: 'rgba(239,68,68,0.15)' } }] },
    options: {
      parsing: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'linear', min: prices[0], max: prices[prices.length - 1], ticks: { callback: (v) => v.toFixed(0) } },
        y: { ticks: { callback: (v) => fmt.big(v) }, grid: { color: (c) => (c.tick.value === 0 ? 'rgba(226,232,240,0.3)' : C.grid) } },
      },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => `Spot ${i[0].parsed.x.toFixed(2)}`, label: (i) => `Net GEX ${fmt.bigUsd(i.parsed.y)} / 1%` } }, refLines: { x: xl } },
    },
  });
}

function renderStrikeTable() {
  const r = focus();
  if (!r) { $('strikeTable').innerHTML = ''; return; }
  const s = r.spot, win = P.strikeWin;
  const all = r.rows.filter((x) => x.cOI + x.pOI + x.cVol + x.pVol > 0);
  let ci = 0; all.forEach((x, i) => { if (Math.abs(x.k - s) < Math.abs(all[ci].k - s)) ci = i; });
  const rows = all.slice(Math.max(0, ci - win), ci + win + 1).reverse();
  const maxG = Math.max(1, ...rows.map((x) => Math.max(x.cG, -x.pG, Math.abs(x.net))));
  const maxOI = Math.max(1, ...rows.map((x) => Math.max(x.cOI, x.pOI)));
  const maxV = Math.max(1, ...rows.map((x) => Math.max(x.cVol, x.pVol)));
  const bar = (v, max, color) => `<div class="bar" style="left:0;width:${(Math.abs(v) / max) * 100}%;background:${color}"></div>`;
  const tag = (k) => Object.entries(r.levels).filter(([id, l]) => l.price === k && !id.startsWith('EM') && id !== 'FLIP').map(([id]) => LEVEL_DEFS.find((d) => d.id === id).label).join(' ');
  $('strikeHint').textContent = `· ${GROUP_DEFS.find((g) => g.id === P.gexGroup).label} expirations`;
  $('strikeTable').innerHTML = `<thead><tr><th>Strike</th><th>Tags</th><th>Call OI</th><th>Put OI</th><th>Call vol</th><th>Put vol</th><th>Call GEX</th><th>Put GEX</th><th>Net GEX</th><th>P/C OI</th></tr></thead><tbody>${
    rows.map((x) => `<tr class="${x === all[ci] ? 'spot-row' : ''}"><td><b>${x.k}</b>${x === all[ci] ? ' <span class="dist">◀ spot</span>' : ''}</td><td class="hint">${tag(x.k)}</td>
      <td class="bar-cell">${bar(x.cOI, maxOI, C.green)}<span>${x.cOI.toLocaleString()}</span></td>
      <td class="bar-cell">${bar(x.pOI, maxOI, C.red)}<span>${x.pOI.toLocaleString()}</span></td>
      <td class="bar-cell">${bar(x.cVol, maxV, C.green)}<span>${x.cVol.toLocaleString()}</span></td>
      <td class="bar-cell">${bar(x.pVol, maxV, C.red)}<span>${x.pVol.toLocaleString()}</span></td>
      <td class="bar-cell">${bar(x.cG, maxG, C.green)}<span>${fmt.big(x.cG)}</span></td>
      <td class="bar-cell">${bar(x.pG, maxG, C.red)}<span>${fmt.big(x.pG)}</span></td>
      <td class="bar-cell ${x.net >= 0 ? 'pos' : 'neg'}">${bar(x.net, maxG, x.net >= 0 ? C.green : C.red)}<span>${fmt.big(x.net)}</span></td>
      <td>${x.cOI ? (x.pOI / x.cOI).toFixed(2) : '—'}</td></tr>`).join('')}</tbody>`;
}

// ---------------- bot tab ----------------
const botParams = () => ({ rvPos: +$('rvPos').value, rvNeg: +$('rvNeg').value, pin: +$('pinStr').value, reliability: +$('regRel').value, vwap: A.ip?.vwap });
const botLevels = () => A.results[$('botHorizon').value] || A.results.weekly;
const minConf = () => +$('minConf').value;
const flyPref = () => +$('flyPref').value;
const convRules = (need = minConf()) => ({ minConf: need, maxConflicts: +$('maxConfl').value, gammaVeto: $('gammaVeto').checked });

// Everything the confluence engine needs for one horizon.
function botEnv(h) {
  const lv = A.results[h];
  if (!lv || !A.mkt) return null;
  const exp = Bot.horizonExp(A.mkt, h);
  const iv = ivProfile(A.mkt, exp);
  const avg = (...xs) => { const v = xs.filter((x) => x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const rv = h === 'daily' ? (A.ip?.rvIntraday || A.rv5) : h === 'weekly' ? avg(A.rv5, A.rv20) : A.rv20;
  const sm = A.mkt.spot * iv.atm * Math.sqrt(Math.max(yearsTo(exp), 1 / 365));
  const idx = { ...(A.idx || {}), map: A.idx?.spx && A.mkt.symbol === 'SPY' ? A.mkt.spot / A.idx.spx.spot : null };
  return { S: A.mkt.spot, horizon: h, lv, all: A.results, ip: A.ip, iv, rv, vix: A.vix, mem: A.memStats, sm, exp, idx, symbol: A.mkt.symbol };
}

function renderBotLabels() {
  $('epLbl').textContent = (+$('botEpisodes').value).toLocaleString();
  $('rvPosLbl').textContent = `${(+$('rvPos').value).toFixed(2)}×`;
  $('rvNegLbl').textContent = `${(+$('rvNeg').value).toFixed(2)}×`;
  $('pinLbl').textContent = (+$('pinStr').value).toFixed(1);
  $('relLbl').textContent = fmt.pct(+$('regRel').value, 0);
  $('minConfLbl').textContent = minConf();
  $('flyPrefLbl').textContent = flyPref().toFixed(2);
}

function renderBot() {
  if (!A.mkt) return;
  renderBotLabels();
  const lv = botLevels();
  if (!lv) return;
  const ctx = Bot.marketContext(lv, $('botHorizon').value);
  $('ctxKey').textContent = `context: ${ctx.key}`;
  $('leaderHint').textContent = `${Bot.HORIZONS.find((h) => h.id === ctx.horizon).label} horizon · current market context`;
  const L = lv.levels, s = lv.spot;
  const pos = lv.regime === 'positive';
  const pill = (t, c) => `<span class="pill ${c}">${t}</span>`;
  const where = { 'near-PW': 'near the put wall (support)', 'near-CW': 'near the call wall (resistance)', 'mid-range': 'mid-range between the walls', 'below-PW': 'below the put wall: support has broken', 'above-CW': 'above the call wall: resistance has broken' }[ctx.walls];
  const ip = A.ip;
  $('marketRead').innerHTML = `
    <p>${pill(pos ? 'Positive gamma' : 'Negative gamma', pos ? 'pos' : 'neg')}${pill(ctx.flip, 'neu')}${pill(ctx.walls, 'neu')}</p>
    <p>Dealers are net <b>${pos ? 'long' : 'short'}</b> gamma (<b class="${pos ? 'pos' : 'neg'}">${fmt.bigUsd(lv.total)}</b> per 1% move).
    ${pos ? `Their hedging sells rallies and buys dips, which tends to dampen volatility and pull price toward <b>P1 ${L.P1?.price ?? '—'}</b>.`
    : `Their hedging chases price, so moves tend to extend; watch <b>N1 ${L.N1?.price ?? '—'}</b> and the put wall <b>${L.PW?.price ?? '—'}</b>.`}</p>
    <p>Spot <b>${s.toFixed(2)}</b> is ${where}. Gamma flip ${lv.flip ? `<b>${lv.flip.toFixed(2)}</b> (${fmt.signed((s / lv.flip - 1) * 100, 2)}%)` : 'not found in ±8% range'}.
    Expected move to ${fmtExp([...lv.exps].sort()[0], false)}: <b>±${lv.em ? lv.em.toFixed(2) : '—'}</b>.
    ${ip ? `Price is <b>${s >= ip.vwap ? 'above' : 'below'}</b> VWAP ${ip.vwap.toFixed(2)} and <b>${s >= ip.avwap2 ? 'above' : 'below'}</b> the 2-day AVWAP ${ip.avwap2.toFixed(2)}.` : ''}</p>`;
  $('signals').innerHTML = Bot.SIGNALS.map((g) => `<span class="signal ${g.planned ? 'planned' : Bot.brain.signals[g.id] ? 'on' : ''}" data-signal="${g.id}" data-tip="${g.desc}">
    ${g.planned ? '' : `<input type="checkbox" ${Bot.brain.signals[g.id] ? 'checked' : ''} />`} ${g.name}${g.planned ? '<em>planned</em>' : ''}</span>`).join('');
  renderConfluence();
  renderIndexGamma();
  renderIv();
  renderIntraday();
  renderLeaderboard(ctx);
  renderMemory();
  renderJournal();
}

const CHIP = { bull: '▲ Bull', bear: '▼ Bear', range: '◆ Range', move: '⚡ Move', short: 'Sell prem', long: 'Buy prem' };
const attr = (s) => String(s).replace(/"/g, '&quot;');
function voteChips(s) {
  if (s.na) return '<span class="chipv na">n/a</span>';
  const chips = [...Object.entries(s.dir), ...Object.entries(s.vol)].filter(([, v]) => v >= 0.5).map(([k]) => `<span class="chipv ${k}">${CHIP[k]}</span>`);
  return chips.join('') || '<span class="chipv">neutral</span>';
}

function renderConfluence() {
  const hs = Bot.HORIZONS.filter((h) => A.results[h.id]);
  const sigs = Object.fromEntries(hs.map((h) => [h.id, buildSignals(botEnv(h.id))]));
  const order = [];
  hs.forEach((h) => sigs[h.id].forEach((x) => { if (!order.find((o) => o.id === x.id)) order.push(x); }));
  const body = order.map((o) => `<tr><td class="sig">${o.name}</td>${hs.map((h) => {
    const x = sigs[h.id].find((y) => y.id === o.id);
    return x ? `<td><span class="vote" data-tip="${attr(x.detail)}">${voteChips(x)}</span></td>` : '<td class="hint">—</td>';
  }).join('')}</tr>`).join('');
  const lean = `<tr class="lean"><td>Lean</td>${hs.map((h) => {
    const l = horizonLean(sigs[h.id]);
    return `<td><span class="chipv ${l.dir}">${CHIP[l.dir]}</span> <span class="chipv ${l.vol.startsWith('sell') ? 'short' : l.vol.startsWith('buy') ? 'long' : ''}">${l.vol}</span></td>`;
  }).join('')}</tr>`;
  $('confTable').innerHTML = `<thead><tr><th>Signal</th>${hs.map((h) => `<th>${h.label} · ${fmtExp(Bot.horizonExp(A.mkt, h.id), false)}</th>`).join('')}</tr></thead><tbody>${body}${lean}</tbody>`;
  $('leanHint').textContent = 'chips show which trade theses each signal supports';
}

function renderIndexGamma() {
  const I = A.idx || {};
  const rows = [['SPX', I.spx], ['/ES', I.es], ['QQQ', I.qqq]].filter(([, g]) => g);
  if (!rows.length) { $('idxTable').innerHTML = '<tbody><tr><td class="hint">Index gamma unavailable. If the server has not been restarted since this update, restart it (Ctrl+C, then node server.js).</td></tr></tbody>'; return; }
  const k = A.idx?.spx && A.mkt.symbol === 'SPY' ? A.mkt.spot / A.idx.spx.spot : null;
  const n = (v, d = 0) => (v == null ? '—' : (+v).toFixed(d));
  const dist = (v, x) => (v == null ? '' : `<span class="dist">${fmt.signed((v / x - 1) * 100, 2)}%</span>`);
  const body = rows.map(([name, g]) => ['daily', 'weekly', 'monthly'].filter((h) => g.groups[h]).map((h, i) => {
    const x = g.groups[h], L = x.levels, d = name === 'QQQ' ? 2 : 0;
    return `<tr>${i === 0 ? `<td rowspan="3" class="left"><b>${name}</b><br><span class="hint">${n(g.spot, d)}${g.basis != null ? ` · basis ${g.basis >= 0 ? '+' : ''}${g.basis}` : ''}</span></td>` : ''}
      <td class="left">${Bot.HORIZONS.find((z) => z.id === h).label}</td>
      <td class="${x.regime === 'positive' ? 'pos' : 'neg'}">${x.regime === 'positive' ? '+γ' : '−γ'} ${fmt.bigUsd(x.total)}</td>
      <td>${n(x.flip, d)}${dist(x.flip, g.spot)}</td><td class="pos">${n(L.P1, d)}</td><td class="neg">${n(L.N1, d)}</td>
      <td>${n(L.CW, d)}${dist(L.CW, g.spot)}</td><td>${n(L.PW, d)}${dist(L.PW, g.spot)}</td>
      ${name === 'SPX' && k ? `<td class="hint">flip ${n(x.flip * k, 2)} · CW ${n(L.CW * k, 2)} · PW ${n(L.PW * k, 2)}</td>` : '<td></td>'}</tr>`;
  }).join('')).join('');
  $('idxTable').innerHTML = `<thead><tr><th>Index</th><th>Horizon</th><th>Regime · net GEX</th><th>Gamma flip</th><th>P1</th><th>N1</th><th>Call wall</th><th>Put wall</th><th>${k ? 'In SPY terms' : ''}</th></tr></thead><tbody>${body}</tbody>`;
  $('idxHint').textContent = I.spx ? `chains as of ${new Date(`${String(I.spx.timestamp).replace(' ', 'T')}Z`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET` : '';
}

function renderIv() {
  const hs = Bot.HORIZONS.filter((h) => A.results[h.id]).map((h) => [h, botEnv(h.id)]);
  const p = (v, d = 1) => (v == null ? '—' : fmt.pct(v, d));
  $('ivTable').innerHTML = `<thead><tr><th></th>${hs.map(([h]) => `<th>${h.label}</th>`).join('')}</tr></thead><tbody>
    <tr><td>Expiration</td>${hs.map(([, e]) => `<td>${fmtExp(e.exp, false)}</td>`).join('')}</tr>
    <tr><td>ATM IV</td>${hs.map(([, e]) => `<td>${p(e.iv.atm)}</td>`).join('')}</tr>
    <tr><td title="Intraday: 5m bars over 5 sessions. Weekly: average of 5-day and 20-day close-to-close. Monthly: 20-day.">Realized vol</td>${hs.map(([, e]) => `<td>${p(e.rv)}</td>`).join('')}</tr>
    <tr><td>IV / RV</td>${hs.map(([, e]) => { const r = e.rv ? e.iv.atm / e.rv : null; return `<td class="${r > 1.15 ? 'pos' : r && r < 0.9 ? 'neg' : ''}">${r ? `${r.toFixed(2)}×` : '—'}</td>`; }).join('')}</tr>
    <tr><td>1σ put / call IV</td>${hs.map(([, e]) => `<td>${p(e.iv.putIv)} / ${p(e.iv.callIv)}</td>`).join('')}</tr>
    <tr><td>Expected move (1σ)</td>${hs.map(([, e]) => `<td>±${e.sm.toFixed(2)}</td>`).join('')}</tr>
  </tbody>`;
  const e = hs[0]?.[1];
  const v = A.vix;
  $('ivVerdict').innerHTML = `${v ? `VIX <b>${v.value.toFixed(2)}</b> · 1y rank <b>${fmt.pct(v.rank, 0)}</b> (range ${v.lo.toFixed(1)}–${v.hi.toFixed(1)}). ` : 'VIX history unavailable. '}
    ${e?.iv.frontIv ? `Term structure: front ${fmt.pct(e.iv.frontIv, 1)} vs 30-day ${fmt.pct(e.iv.backIv, 1)} (${e.iv.term > 1.03 ? '<b class="neg">inverted, stress</b>' : e.iv.term < 0.92 ? '<b class="pos">contango, calm</b>' : 'flat'}). ` : ''}
    Selling premium has the edge when IV/RV is above ~1.15×; buying has it below ~0.9×.`;
}

function renderIntraday() {
  const ip = A.ip, s = A.mkt.spot;
  if (!ip) { $('ipGrid').innerHTML = '<p class="hint">Intraday candles unavailable.</p>'; return; }
  $('ipHint').textContent = `5-minute bars · ${ip.days} sessions · latest ${ip.sessionDate}`;
  const d = (v) => `<span class="${s >= v ? 'pos' : 'neg'}">spot ${fmt.signed((s / v - 1) * 100, 2)}%</span>`;
  const items = [
    ['Session VWAP', ip.vwap.toFixed(2), d(ip.vwap)],
    ['VWAP ±1σ', `${ip.vwapDn.toFixed(2)} – ${ip.vwapUp.toFixed(2)}`, ''],
    ['2-day AVWAP', ip.avwap2.toFixed(2), d(ip.avwap2)],
    ['Session H / L', ip.today ? `${ip.today.high.toFixed(2)} / ${ip.today.low.toFixed(2)}` : '—', ''],
    ['Prior H / L', ip.prev ? `${ip.prev.high.toFixed(2)} / ${ip.prev.low.toFixed(2)}` : '—', ''],
    ['Intraday RV', fmt.pct(ip.rvIntraday, 1), 'annualized'],
    ['Avg session range', fmt.pct(ip.avgRange, 2), ''],
    ['VWAP crosses / day', ip.vwapCrosses.toFixed(1), ip.vwapCrosses >= 4 ? 'choppy' : ip.vwapCrosses < 2 ? 'trending' : 'mixed'],
    ['5m autocorrelation', ip.autocorr.toFixed(3), ip.autocorr < -0.05 ? 'mean-reverting' : ip.autocorr > 0.05 ? 'trending' : 'random-ish'],
  ];
  $('ipGrid').innerHTML = items.map(([k, v, sub]) => `<div>${k}<b>${v}</b>${sub}</div>`).join('');
}

function renderLeaderboard(ctx) {
  const rows = Bot.leaderboard(ctx.key, $('botRank').value);
  const trained = rows.some((r) => r.c);
  $('leaderTable').innerHTML = `<thead><tr><th>#</th><th>Strategy</th><th>Thesis</th><th>Win rate</th><th>90% range</th><th>Avg P/L</th><th>Return on risk</th><th>Sim episodes</th><th>Real trades</th></tr></thead><tbody>${
    trained ? rows.map((r, i) => (r.c ? `<tr><td>${i + 1}</td><td style="font-family:Inter">${r.t.name}</td><td><span class="chipv ${r.t.bias}">${CHIP[r.t.bias]}</span></td>
      <td>${fmt.pct(r.win, 1)}<span class="winbar"><div style="width:${r.win * 100}%"></div></span></td>
      <td class="ci">${fmt.pct(r.lo, 0)} – ${fmt.pct(r.hi, 0)}</td>
      <td class="${r.avgPl >= 0 ? 'pos' : 'neg'}">${fmt.usd(r.avgPl)}</td>
      <td class="${r.evR >= 0 ? 'pos' : 'neg'}">${fmt.pct(r.evR, 1)}</td><td>${r.c.n.toLocaleString()}</td><td>${r.c.real}</td></tr>`
      : `<tr><td>—</td><td style="font-family:Inter">${r.t.name}</td><td><span class="chipv ${r.t.bias}">${CHIP[r.t.bias]}</span></td><td colspan="6" class="hint">not trained in this context</td></tr>`)).join('')
      : '<tr><td colspan="9" class="hint">No training data for this market context yet. Press <b>Train all horizons</b>.</td></tr>'}</tbody>`;
}

function renderMemory() {
  const m = A.memStats;
  const p = (v) => (v == null ? '—' : fmt.pct(v, 0));
  if (!m) { $('memTiles').innerHTML = ''; $('memTable').innerHTML = '<tbody><tr><td class="hint">Daily candles unavailable.</td></tr></tbody>'; return; }
  const tiles = [
    ['Sessions scored', m.n, `${m.snapshots} snapshot${m.snapshots === 1 ? '' : 's'} saved`],
    ['Closed nearer P1', p(m.towardRate), 'than it opened'],
    ['Pinned at P1', p(m.pinRate), 'close within 0.3%'],
    ['Call wall held', p(m.cwHoldRate), `${m.cwTests} tests`],
    ['Put wall held', p(m.pwHoldRate), `${m.pwTests} tests`],
    ['Range / EM in +γ', m.rangePos == null ? '—' : `${m.rangePos.toFixed(2)}×`, `${m.pos.length} sessions`],
    ['Range / EM in −γ', m.rangeNeg == null ? '—' : `${m.rangeNeg.toFixed(2)}×`, `${m.neg.length} sessions`],
  ];
  $('memTiles').innerHTML = tiles.map(([k, v, sub]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');
  $('memTable').innerHTML = m.sessions.length ? `<thead><tr><th>Session</th><th>Regime</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Toward P1</th><th>Call wall</th><th>Put wall</th><th>Range / EM</th></tr></thead><tbody>${
    m.sessions.slice(0, 20).map((r) => `<tr><td>${r.date}</td><td class="${r.regime === 'positive' ? 'pos' : 'neg'}">${r.regime === 'positive' ? '+γ' : '−γ'}</td><td>${r.open.toFixed(2)}</td><td>${r.high.toFixed(2)}</td><td>${r.low.toFixed(2)}</td><td>${r.close.toFixed(2)}</td>
      <td>${r.toward == null ? '—' : r.toward ? '✓' : '✗'}</td><td>${r.cw || '—'}</td><td>${r.pw || '—'}</td><td>${r.rangeVsEm ? `${r.rangeVsEm.toFixed(2)}×` : '—'}</td></tr>`).join('')}</tbody>`
    : `<tbody><tr><td class="hint">Levels for the next session are saved (${m.snapshots} snapshot${m.snapshots === 1 ? '' : 's'} so far). Each one is scored after that session closes, so stats start filling in after the next close. From 5 sessions on, the bot uses them as a confluence and to calibrate its simulation.</td></tr></tbody>`;
}

let lastTrades = []; // flat list; each idea carries its horizon, confluence score and entry plan
const pxFmt = (v) => `${fmt.usd(Math.abs(v), 2)} ${v >= 0 ? 'db' : 'cr'}`;
function tradeCard(tr, i) {
  const st = tr.st, sc = tr.sc, pl = tr.plan;
  const short = (d) => (d.length > 110 ? `${d.slice(0, 107)}…` : d);
  const edge = pl.edgePerShare;
  const edgeTxt = edge == null ? '' : edge > 0
    ? (tr.cost < 0 ? 'selling above fair value' : 'buying below fair value')
    : (tr.cost < 0 ? 'credit is thin vs realized vol' : 'paying above fair value');
  return `<div class="trade ${tr.conviction ? '' : 'dim'}">
      <div class="t-head"><span class="t-name">${tr.t.name}</span><span class="t-win ${tr.win == null ? '' : tr.win >= 0.5 ? 'pos' : 'neg'}" title="Learned win rate (train the bot to fill in)">${tr.win == null ? '—' : fmt.pct(tr.win, 0)}</span></div>
      <div><span class="conv ${tr.conviction ? 'yes' : 'no'}">${tr.conviction ? `Conviction · ${sc.conf.length} confluences` : `Watchlist · ${sc.conf.length}/${minConf()}`}</span> <span class="chipv ${tr.t.bias}">${CHIP[tr.t.bias]}</span>${tr.t.vol !== 'flat' ? ` <span class="chipv ${tr.t.vol}">${CHIP[tr.t.vol]}</span>` : ''}</div>
      <div class="t-legs">${Bot.describeLegs(tr.legs)}</div>
      <div class="t-thesis">${tr.t.thesis(A.results[tr.horizon], tr.legs)}</div>
      <div class="checks">${sc.conf.map((x) => `<div class="ok" data-tip="${attr(x.detail)}"><b>${x.name}</b>: ${short(x.detail)}</div>`).join('')}${
        sc.conflict.map((x) => `<div class="bad" data-tip="${attr(x.detail)}"><b>${x.name}</b>: ${short(x.detail)}</div>`).join('')}</div>
      <div class="entry">
        <div>Market mid: <b>${pxFmt(pl.entryPx)}</b>${pl.fairPx != null ? ` · fair at realized vol ${fmt.pct(pl.fairIv, 1)}: <b>${pxFmt(pl.fairPx)}</b>` : ''}</div>
        <div>Profit target: <b class="pos">+${fmt.usd(Bot.targetProfit(tr), 0)}</b> after fees (${Math.round((Bot.FLY_FAMILY.has(tr.t.id) ? Bot.EXIT.flyTp : Bot.EXIT.tp) * 100)}% of ${tr.cost < 0 ? 'credit' : tr.st.unlimitedUp ? 'debit' : 'max profit'}), then close</div>
        ${edge != null ? `<div>IV edge: <b class="${edge > 0 ? 'pos' : 'neg'}">${fmt.signed(edge, 2)}/sh</b> (${edgeTxt})</div>` : ''}
        ${pl.trigger ? `<div>Better entry: ${tr.t.bias === 'bull' ? 'dip' : 'pop'} to <b>${pl.trigger.price.toFixed(2)}</b> (${pl.trigger.label}) → limit <b>${pxFmt(pl.triggerPx)}</b></div>`
        : `<div class="hint">${tr.t.bias === 'range' ? 'Range trade: enter while price holds between the levels.' : tr.t.bias === 'move' ? 'Long-vol trade: enter before the move; no pullback trigger.' : 'No confluence level within 1σ for a better fill.'}</div>`}
      </div>
      <div class="t-kv">
        <div>${tr.cost >= 0 ? 'Debit' : 'Credit'}<b>${fmt.usd(Math.abs(tr.cost))}</b></div>
        <div>Max profit<b class="pos">${st.unlimitedUp ? '∞' : fmt.usd(st.maxProfit)}</b></div>
        <div>Max loss<b class="neg">${st.unlimitedDown ? '∞' : fmt.usd(st.maxLoss)}</b></div>
        <div>Return on risk<b>${tr.evR == null ? '—' : fmt.pct(tr.evR, 1)}</b></div>
        <div>Breakevens<b>${st.breakevens.map((b) => b.toFixed(0)).join(' / ') || '—'}</b></div>
        <div>Expires<b>${fmtExp(tr.exp, false)}</b></div>
      </div>
      <div class="btn-row"><button class="btn sm primary" data-open="${i}">Open in builder</button><button class="btn sm" data-paper="${i}">Paper trade</button></div>
    </div>`;
}

// Rank the bot's ideas for one horizon: conviction first, then learned score x net confluence.
function ideasFor(h, need = minConf(), convOnly = $('convOnly').checked, n = 3) {
  const env = botEnv(h);
  if (!env) return [];
  const signals = buildSignals(env);
  return Bot.sampleTrades(A.mkt, env.lv, h, $('botRank').value, 99)
    .map((c) => {
      const sc = scoreTemplate(c.t, signals);
      const plan = entryPlan(c.legs, c.t.bias, env);
      const conviction = qualifies(sc, convRules(need));
      const rank = (conviction ? 10 : 0) + c.pick * (1 + 0.15 * sc.net) + (plan.edge > 0 ? 0.05 : 0) + (Bot.FLY_FAMILY.has(c.t.id) ? flyPref() : 0);
      return { ...c, sc, plan, conviction, rank };
    })
    .filter((c) => !convOnly || c.conviction)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, n);
}

function generateIdeas() {
  lastTrades = Bot.HORIZONS.filter((h) => A.results[h.id]).flatMap((h) => ideasFor(h.id));
  renderTrades();
}

function renderTrades() {
  $('tradeCards').innerHTML = Bot.HORIZONS.map((h) => {
    const lv = A.results[h.id];
    if (!lv) return '';
    const ideas = lastTrades.map((tr, i) => [tr, i]).filter(([tr]) => tr.horizon === h.id);
    const sub = `${fmtExp(Bot.horizonExp(A.mkt, h.id), false)} · ${lv.regime === 'positive' ? '+γ' : '−γ'}`;
    const empty = $('convOnly').checked ? `Nothing reaches ${minConf()} confluences right now. Standing aside is a position too.` : 'No ideas yet.';
    return `<div class="idea-col"><h3>${h.label}<span>${sub}</span></h3>${ideas.length ? ideas.map(([tr, i]) => tradeCard(tr, i)).join('') : `<p class="hint">${empty}</p>`}</div>`;
  }).join('');
}

function renderJournal() {
  const rows = Bot.markJournal(A.mkt);
  const done = rows.filter((r) => r.status !== 'open');
  const wins = done.filter((r) => r.status === 'win').length;
  $('journalTable').innerHTML = `<thead><tr><th>Opened</th><th>Horizon</th><th>Strategy</th><th>Legs</th><th>Expires</th><th>Entry spot</th><th>Debit / credit</th><th>P/L</th><th>Status</th></tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr><td>${new Date(r.created).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
      <td style="font-family:Inter">${r.horizon || '—'}${r.auto ? '<span class="tag">auto</span>' : ''}</td><td style="font-family:Inter">${r.name}</td><td>${Bot.describeLegs(r.legs)}</td><td>${fmtExp(r.expDate, false)}</td>
      <td>${r.spot ? r.spot.toFixed(2) : '—'}</td><td>${fmt.usd(r.cost)}</td>
      <td class="${(r.mark ?? 0) >= 0 ? 'pos' : 'neg'}">${r.mark == null ? '—' : fmt.usd(r.mark)}${r.status === 'open' ? ' <span class="dist">mark</span>' : ''}</td>
      <td>${r.status === 'open' ? 'open' : `<b class="${r.status === 'win' ? 'pos' : 'neg'}">${r.status}</b> @ ${r.closePx.toFixed(2)}`}</td></tr>`).join('')
      : '<tr><td colspan="9" class="hint">No paper trades yet. Generate trade ideas and press <b>Paper trade</b>.</td></tr>'}
    ${done.length ? `<tr><td colspan="9"><b>Scored: ${done.length} · win rate ${fmt.pct(wins / done.length, 0)}</b></td></tr>` : ''}</tbody>`;
}


// ---------------- backtest tab ----------------
const BT = { res: null };
const HLABEL = { daily: 'Intraday', weekly: 'Weekly', monthly: 'Monthly' };

async function runBt() {
  const btn = $('btRun');
  btn.disabled = true; $('btTeach').disabled = true;
  $('btBar').style.width = '0%';
  $('btMsg').textContent = 'Loading 60 days of 15-minute bars, daily closes and VIX history…';
  try {
    const [bars, daily, vix] = await Promise.all([
      loadCandles(P.symbol, '15m60'),
      A.daily || loadCandles(P.symbol, '1d'),
      A.vixDaily || loadCandles('^VIX', '1d'),
    ]);
    const cs = bars.candles;
    if (cs.length < 500 || cs[1].time - cs[0].time !== 900) throw new Error('60-day 15-minute bars not available');
    const vixNow = vix.candles[vix.candles.length - 1].close;
    const scale = Object.fromEntries(Bot.HORIZONS.map((h) => [h.id, (botEnv(h.id)?.iv.atm || vixNow / 100) / (vixNow / 100)]));
    const skew = fitSkew(botEnv('weekly')?.iv);
    const t0 = performance.now();
    BT.res = await runBacktest({
      bars, daily, vix, symbol: P.symbol, skew, scale, mgmt: $('btMgmt').value,
      minConf: Math.max(1, +$('btMinConf').value || 6), requireConv: $('btConv').checked,
      maxConflicts: +$('btMaxConfl').value, gammaVeto: $('btVeto').checked, flyBoost: +$('btFlyPref').value || 0,
      onProgress: (f) => ($('btBar').style.width = `${Math.round(f * 100)}%`),
    });
    BT.taught = false;
    const picks = BT.res.trades.filter((t) => t.picked).length;
    $('btMsg').textContent = `Replayed ${BT.res.trades.length.toLocaleString()} strategy outcomes (${picks} bot picks) in ${((performance.now() - t0) / 1000).toFixed(1)}s. IV scaled from VIX with today's ratios (${Object.entries(scale).map(([k, v]) => `${HLABEL[k]} ${v.toFixed(2)}×`).join(', ')}); skew fitted to today's chain.`;
    $('btTeach').disabled = false;
    renderBt();
  } catch (e) {
    $('btMsg').innerHTML = `<b class="neg">Backtest needs data the server isn't providing yet (${e.message}).</b> If you haven't restarted the server since the last update, press Ctrl+C in its terminal and run <code>node server.js</code> again.`;
  } finally { btn.disabled = false; }
}

function renderBt() {
  const res = BT.res;
  if (!res) return;
  const p = (v, d = 0) => (v == null ? '—' : fmt.pct(v, d));
  const usd = (v) => (v == null ? '—' : fmt.usd(v));
  const pf = (v) => (v == null ? '—' : v === Infinity ? '∞' : v.toFixed(2));
  $('btWindow').textContent = `· trades expiring ${res.window.from} → ${res.window.to} (${res.window.sessions} sessions)`;
  const hs = ['daily', 'weekly', 'monthly'];
  const picks = res.trades.filter((t) => t.picked);

  // summary by horizon
  const row = (label, list, entries, skipped, cls = '') => {
    const s = summarize(list);
    return `<tr class="${cls}"><td class="left"><b>${label}</b></td><td>${entries ?? '—'}</td><td>${s.n}</td><td>${skipped ?? '—'}</td><td>${p(s.winRate)}</td>
      <td class="${s.net >= 0 ? 'pos' : 'neg'}">${usd(s.net)}</td><td>${usd(s.avg)}</td><td class="${s.avgRor >= 0 ? 'pos' : 'neg'}">${p(s.avgRor, 1)}</td><td>${pf(s.pf)}</td><td class="neg">${usd(s.maxDD)}</td><td>${usd(s.best)}</td><td>${usd(s.worst)}</td></tr>`;
  };
  const totEntries = hs.reduce((a, h) => a + res.entries[h], 0), totSkip = hs.reduce((a, h) => a + res.skipped[h], 0);
  $('btSummary').innerHTML = `<thead><tr><th>Horizon</th><th>Entries</th><th>Trades</th><th>Stood aside</th><th>Win rate</th><th>Net P/L</th><th>Avg P/L</th><th>Avg return on risk</th><th>Profit factor</th><th>Max drawdown</th><th>Best</th><th>Worst</th></tr></thead><tbody>
    ${hs.map((h) => row(HLABEL[h], picks.filter((t) => t.horizon === h), res.entries[h], res.skipped[h])).join('')}
    ${row('All bot picks', picks, totEntries, totSkip, 'lean')}
    ${row('Baseline: every strategy, every entry', res.trades, null, null)}</tbody>`;

  // equity curve
  const dates = [...new Set(picks.map((t) => new Date(t.exitMs).toISOString().slice(0, 10)))].sort();
  const col = { daily: C.blue, weekly: C.violet, monthly: C.amber };
  const datasets = hs.map((h) => {
    let eq = 0;
    const byDate = new Map();
    picks.filter((t) => t.horizon === h).sort((a, b) => a.exitMs - b.exitMs).forEach((t) => { eq += t.pl; byDate.set(new Date(t.exitMs).toISOString().slice(0, 10), eq); });
    let last = 0;
    return { label: HLABEL[h], data: dates.map((d) => (byDate.has(d) ? (last = byDate.get(d)) : last)), borderColor: col[h], borderWidth: 2, pointRadius: 0, tension: 0.15 };
  });
  upsertChart(A.charts, 'btEquity', $('btEquity'), {
    type: 'line',
    data: { labels: dates.map((d) => d.slice(5)), datasets },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { y: { ticks: { callback: (v) => fmt.usd(v) }, grid: { color: (c) => (c.tick.value === 0 ? 'rgba(226,232,240,0.35)' : C.grid) } } },
      plugins: { legend: { labels: { boxWidth: 12, color: C.text } }, tooltip: { callbacks: { label: (i) => `${i.dataset.label}: ${fmt.usd(i.parsed.y)}` } } },
    },
  });

  // breakdown by strategy within each horizon
  const CH = { bull: '▲ Bull', bear: '▼ Bear', range: '◆ Range', move: '⚡ Move' };
  const body = hs.map((h) => {
    const ids = [...new Set(res.trades.filter((t) => t.horizon === h).map((t) => t.strat))];
    const rows = ids.map((id) => {
      const allT = res.trades.filter((t) => t.horizon === h && t.strat === id);
      const pk = allT.filter((t) => t.picked);
      return { id, name: allT[0].name, bias: allT[0].bias, s: summarize(pk), b: summarize(allT) };
    }).sort((a, b) => b.s.n - a.s.n || b.b.net - a.b.net);
    return `<tr class="group"><td colspan="11">${HLABEL[h]} · ${res.entries[h]} entries · ${res.skipped[h]} stood aside</td></tr>${rows.map((r) => `<tr class="${r.s.n ? '' : 'dim-row'}">
      <td class="left">${r.name}</td><td><span class="chipv ${r.bias}">${CH[r.bias]}</span></td>
      <td>${r.s.n || '—'}</td><td>${r.s.n ? p(r.s.winRate) : '—'}</td><td class="${r.s.net >= 0 ? 'pos' : 'neg'}">${r.s.n ? usd(r.s.net) : '—'}</td><td>${r.s.n ? usd(r.s.avg) : '—'}</td><td>${r.s.n ? p(r.s.avgRor, 1) : '—'}</td>
      <td>${r.s.n ? `${usd(r.s.best)} / ${usd(r.s.worst)}` : '—'}</td>
      <td>${p(r.b.winRate)}</td><td class="${r.b.net >= 0 ? 'pos' : 'neg'}">${usd(r.b.net)}</td><td>${p(r.b.avgRor, 1)}</td></tr>`).join('')}`;
  }).join('');
  $('btBreakdown').innerHTML = `<thead><tr><th>Strategy</th><th>Thesis</th><th>Bot picks</th><th>Win rate</th><th>Net P/L</th><th>Avg P/L</th><th>Avg RoR</th><th>Best / worst</th><th>Every-entry win rate</th><th>Every-entry net</th><th>Every-entry RoR</th></tr></thead><tbody>${body}</tbody>`;
  renderBtLog();
}

function renderBtLog() {
  const res = BT.res;
  if (!res) return;
  const fh = $('btFilterH').value, fp = $('btFilterP').value;
  const list = res.trades.filter((t) => (!fh || t.horizon === fh) && (!fp || t.picked)).sort((a, b) => b.exitMs - a.exitMs).slice(0, 400);
  $('btLog').innerHTML = `<thead><tr><th>Entry</th><th>Horizon</th><th>Strategy</th><th>Legs</th><th>Regime*</th><th>Confluences</th><th>Spot in → out</th><th>Exit</th><th>Debit / credit</th><th>P/L</th><th>RoR</th></tr></thead><tbody>${
    list.map((t) => `<tr><td>${t.date}</td><td class="left">${HLABEL[t.horizon]}</td><td class="left">${t.name}${t.picked ? '<span class="tag">pick</span>' : ''}</td>
      <td>${Bot.describeLegs(t.legs)}</td><td class="${t.regime === 'positive' ? 'pos' : 'neg'}">${t.regime === 'positive' ? '+γ' : '−γ'}</td>
      <td class="left" title="✓ ${t.conf.join(', ')}${t.conflicts.length ? ` | ✗ ${t.conflicts.join(', ')}` : ''}">${t.conf.length}${t.conflicts.length ? ` / ✗${t.conflicts.length}` : ''}</td>
      <td>${t.entrySpot.toFixed(2)} → ${t.exitSpot.toFixed(2)}</td><td class="left">${t.reason} ${new Date(t.exitMs).toISOString().slice(5, 10)}</td>
      <td>${fmt.usd(t.cost)}</td><td class="${t.pl >= 0 ? 'pos' : 'neg'}">${fmt.usd(t.pl)}</td><td>${fmt.pct(t.ror, 0)}</td></tr>`).join('')
    || '<tr><td colspan="11" class="hint">No trades for this filter.</td></tr>'}</tbody><tfoot><tr><td colspan="11" class="hint">* Regime in the backtest is the gamma stand-in, not real dealer positioning.</td></tr></tfoot>`;
}

// ---------------- forward test (real gamma) ----------------
function autoForward() {
  if (!A.mkt) return;
  const session = Memory.targetSession(A.mkt.timestamp);
  const fwd = (Bot.brain.fwd ||= {});
  let changed = false;
  for (const h of Bot.HORIZONS) {
    const key = `${A.mkt.symbol}|${session}|${h.id}`;
    if (fwd[key] || !A.results[h.id]) continue;
    const idea = ideasFor(h.id, minConf(), true, 1)[0];
    if (idea) {
      Bot.addPaperTrade({ ...idea, spotAtEntry: A.mkt.spot, extra: { auto: true, session, symbol: A.mkt.symbol, confCount: idea.sc.conf.length } });
      fwd[key] = 'trade';
    } else fwd[key] = 'skip';
    changed = true;
  }
  if (changed) Bot.save();
}

function renderForward() {
  const sym = A.mkt?.symbol;
  const auto = Bot.markJournal(A.mkt).filter((j) => j.auto && (!j.symbol || j.symbol === sym));
  const fwd = Bot.brain.fwd || {};
  const keys = Object.keys(fwd).filter((k) => k.startsWith(`${sym}|`));
  const sessionsTracked = new Set(keys.map((k) => k.split('|')[1])).size;
  const body = ['daily', 'weekly', 'monthly'].map((h) => {
    const list = auto.filter((j) => j.horizon === h);
    const skips = keys.filter((k) => k.endsWith(`|${h}`) && fwd[k] === 'skip').length;
    const names = [...new Set(list.map((j) => j.name))];
    const rows = names.map((nm) => {
      const l = list.filter((j) => j.name === nm), done = l.filter((j) => j.status !== 'open');
      const wins = done.filter((j) => j.status === 'win').length, net = done.reduce((a, j) => a + j.pl, 0);
      const openMark = l.filter((j) => j.status === 'open').reduce((a, j) => a + (j.mark || 0), 0);
      return `<tr><td class="left">${nm}</td><td>${l.length}</td><td>${l.length - done.length}</td><td>${done.length}</td><td>${done.length ? fmt.pct(wins / done.length, 0) : '—'}</td>
        <td class="${net >= 0 ? 'pos' : 'neg'}">${done.length ? fmt.usd(net) : '—'}</td><td class="${openMark >= 0 ? 'pos' : 'neg'}">${l.length > done.length ? fmt.usd(openMark) : '—'}</td></tr>`;
    }).join('');
    return `<tr class="group"><td colspan="7">${HLABEL[h]} · ${list.length} trade${list.length === 1 ? '' : 's'} · ${skips} session${skips === 1 ? '' : 's'} stood aside</td></tr>${rows || '<tr><td colspan="7" class="hint">No conviction trade logged yet.</td></tr>'}`;
  }).join('');
  $('fwdTable').innerHTML = `<thead><tr><th>Strategy</th><th>Trades</th><th>Open</th><th>Scored</th><th>Win rate</th><th>Net P/L (scored)</th><th>Open P/L (mark)</th></tr></thead><tbody>${body}</tbody>
    <tfoot><tr><td colspan="7" class="hint">${sessionsTracked} session${sessionsTracked === 1 ? '' : 's'} tracked. Opening the app on a trading day logs that session's picks (once per horizon) at the current chain mids; expired trades are scored on the actual close and fed back into the bot.</td></tr></tfoot>`;
}


// ---------------- paper account (server-side bot) ----------------
const PA = { timer: null, data: null };
const HL2 = { daily: 'Intraday', weekly: 'Weekly', monthly: 'Monthly' };

async function loadPaper() {
  try {
    const r = await fetch('/api/paper', { cache: 'no-store' });
    if (r.status === 404) throw new Error('restart');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    PA.data = await r.json();
    renderPaper();
  } catch (e) {
    $('paperStatus').className = 'banner';
    $('paperStatus').innerHTML = e.message === 'restart'
      ? '<b>The paper trader isn\'t running yet.</b> Restart the server: press Ctrl+C in its terminal, then run <code>node server.js</code>.'
      : `Paper account unavailable: ${e.message}`;
  }
}

function renderPaper() {
  const { cfg, state: st, equity, openRisk, et } = PA.data;
  const t = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const pl = equity - st.startCapital;
  const unreal = st.positions.reduce((a, p) => a + (p.unrealized || 0), 0);
  const wins = st.closed.filter((c) => c.pl > 0).length;
  const started = et.date >= cfg.startDate;
  const lc = st.lastCheck;
  $('paperStatus').className = 'banner info';
  $('paperStatus').innerHTML = !started
    ? `<b>Armed.</b> The bot starts trading <b>${cfg.startDate}</b> at 10:00 ET with $${cfg.startCapital.toLocaleString()} of paper money. Keep the server running (and the computer awake) during market hours, 9:30–4:15 ET.`
    : `<b>Running.</b> ${lc ? `Last check ${t(lc.t)} ET · SPY ${lc.spot.toFixed(2)} · chain ${lc.chainTs} (15-min delayed)${lc.tradingToday ? '' : ' · market closed'}` : 'Waiting for the first check (every 5 minutes, 9:35–5:00 ET on trading days).'} The server must stay running for the bot to trade.`;

  const tiles = [
    ['Equity', fmt.usd(equity, 0), `started ${fmt.usd(st.startCapital, 0)}`, pl >= 0 ? 'pos' : 'neg'],
    ['Total P/L', `${pl >= 0 ? '+' : ''}${fmt.usd(pl, 0)}`, `${fmt.signed((pl / st.startCapital) * 100, 2)}%`, pl >= 0 ? 'pos' : 'neg'],
    ['Realized', fmt.usd(st.realized, 0), `${st.closed.length} closed`],
    ['Unrealized', fmt.usd(unreal, 0), `${st.positions.length} open`],
    ['Risk in use', fmt.usd(openRisk, 0), `${fmt.pct(openRisk / equity, 0)} of equity (cap ${fmt.pct(cfg.maxOpenRisk, 0)})`],
    ['Win rate', st.closed.length ? fmt.pct(wins / st.closed.length, 0) : '—', `${wins} of ${st.closed.length}`],
  ];
  $('paperTiles').innerHTML = tiles.map(([k, v, s, c]) => `<div class="tile"><div class="k">${k}</div><div class="v ${c || ''}">${v}</div><div class="s">${s}</div></div>`).join('');

  // equity curve
  const pts = st.equity.length ? st.equity : [{ t: Date.now(), equity }];
  upsertChart(A.charts, 'paperEquity', $('paperEquity'), {
    type: 'line',
    data: { labels: pts.map((p) => t(p.t)), datasets: [{ data: pts.map((p) => p.equity), borderColor: C.blue, borderWidth: 2, pointRadius: 0, fill: { target: { value: st.startCapital }, above: 'rgba(34,197,94,0.12)', below: 'rgba(239,68,68,0.12)' } }] },
    options: { scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { ticks: { callback: (v) => fmt.usd(v, 0) } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => fmt.usd(i.parsed.y, 2) } } } },
  });

  // breakdown
  const groups = ['daily', 'weekly', 'monthly'].map((h) => {
    const cl = st.closed.filter((c) => c.horizon === h), op = st.positions.filter((p) => p.horizon === h);
    const aside = Object.entries(st.sessions).filter(([k, v]) => k.endsWith(`|${h}`) && v === 'stood-aside').length;
    const names = [...new Set([...cl, ...op].map((x) => x.name))];
    const rows = names.map((n) => {
      const c = cl.filter((x) => x.name === n), o = op.filter((x) => x.name === n), w = c.filter((x) => x.pl > 0).length;
      const net = c.reduce((a, x) => a + x.pl, 0);
      return `<tr><td class="left">${n}</td><td>${c.length}</td><td>${o.length}</td><td>${c.length ? fmt.pct(w / c.length, 0) : '—'}</td><td class="${net >= 0 ? 'pos' : 'neg'}">${c.length ? fmt.usd(net) : '—'}</td></tr>`;
    }).join('');
    const net = cl.reduce((a, x) => a + x.pl, 0), w = cl.filter((x) => x.pl > 0).length;
    return `<tr class="group"><td colspan="5">${HL2[h]} · ${cl.length} closed · ${cl.length ? fmt.pct(w / cl.length, 0) : '—'} wins · ${fmt.usd(net)} · ${aside} session${aside === 1 ? '' : 's'} stood aside</td></tr>${rows}`;
  }).join('');
  $('paperBreakdown').innerHTML = `<thead><tr><th>Strategy</th><th>Closed</th><th>Open</th><th>Win rate</th><th>Net P/L</th></tr></thead><tbody>${groups}</tbody>`;

  const legs = (p) => Bot.describeLegs(p.legs);
  $('paperOpen').innerHTML = `<thead><tr><th>Opened (ET)</th><th>Horizon</th><th>Strategy</th><th>Lots</th><th>Legs</th><th>Entry /sh</th><th>Mark /sh</th><th>Unrealized</th><th>Target</th><th>Max loss</th><th>Expires</th><th>Confluences</th></tr></thead><tbody>${
    st.positions.map((p) => `<tr><td>${t(p.openedAt)}</td><td class="left">${HL2[p.horizon]}</td><td class="left">${p.name}</td><td>${p.lots}</td><td>${legs(p)}</td>
      <td>${fmt.usd(Math.abs(p.costLot / 100), 2)} ${p.costLot >= 0 ? 'db' : 'cr'}</td><td>${p.markLot != null ? `${fmt.usd(Math.abs(p.markLot / 100), 2)} ${p.markLot >= 0 ? 'db' : 'cr'}` : '—'}</td>
      <td class="${(p.unrealized || 0) >= 0 ? 'pos' : 'neg'}">${fmt.usd(p.unrealized || 0)}</td><td class="pos">+${fmt.usd(p.targetLot * p.lots, 0)}</td><td class="neg">${fmt.usd(-p.riskLot * p.lots, 0)}</td>
      <td>${new Date(p.expMs).toISOString().slice(5, 10)}</td><td title="✓ ${p.conf.join(', ')}${p.conflicts.length ? ` | ✗ ${p.conflicts.join(', ')}` : ''}">${p.conf.length}</td></tr>`).join('')
    || '<tr><td colspan="12" class="hint">No open positions.</td></tr>'}</tbody>`;

  $('paperClosed').innerHTML = `<thead><tr><th>Closed (ET)</th><th>Horizon</th><th>Strategy</th><th>Lots</th><th>Legs</th><th>Entry /sh</th><th>Exit</th><th>P/L</th><th>% of risk</th></tr></thead><tbody>${
    st.closed.map((c) => `<tr><td>${t(c.closedAt)}</td><td class="left">${HL2[c.horizon]}</td><td class="left">${c.name}</td><td>${c.lots}</td><td>${legs(c)}</td>
      <td>${fmt.usd(Math.abs(c.costLot / 100), 2)} ${c.costLot >= 0 ? 'db' : 'cr'}</td><td class="left">${c.reason}</td>
      <td class="${c.pl >= 0 ? 'pos' : 'neg'}">${fmt.usd(c.pl)}</td><td>${fmt.pct(c.ror, 0)}</td></tr>`).join('')
    || '<tr><td colspan="9" class="hint">No closed trades yet.</td></tr>'}</tbody>`;

  $('paperLog').innerHTML = `<tbody>${st.log.slice(0, 120).map((l) => `<tr><td class="n" style="white-space:nowrap">${t(l.t)}</td><td style="white-space:normal">${l.msg}</td></tr>`).join('')}</tbody>`;

  const r = cfg.rules;
  $('paperRules').innerHTML = `<p>Starting capital <b>${fmt.usd(cfg.startCapital, 0)}</b> · trading from <b>${cfg.startDate}</b> · SPY options.</p>
    <p>Each trading day: train at the open, then from <b>10:00 ET</b> open the top conviction pick per horizon (intraday until 1:30 PM, weekly/monthly until 3:00 PM).
    Conviction = <b>${r.minConf}+ confluences</b>${r.gammaVeto ? ', <b>gamma veto</b> on' : ''}${r.maxConflicts < 99 ? `, ≤${r.maxConflicts} conflicts` : ''}; butterfly preference ${cfg.flyPref}.</p>
    <p>Sizing: max loss per trade ≤ <b>${fmt.pct(cfg.riskPerTrade, 0)}</b> of equity, all open risk ≤ <b>${fmt.pct(cfg.maxOpenRisk, 0)}</b>, at most ${cfg.maxOpen.daily} intraday / ${cfg.maxOpen.weekly} weekly / ${cfg.maxOpen.monthly} monthly open.</p>
    <p>Exits: profit target <b>${fmt.pct(cfg.exit.tp, 0)}</b> for spreads, <b>${fmt.pct(cfg.exit.flyTp, 0)}</b> for butterflies/flyagonals (after fees); stops at 2× credit or 50–60% of debit; otherwise settle at expiration.</p>
    <p>Fills at chain mid ± $${cfg.slipPerLeg.toFixed(2)}/leg, $${cfg.feePerContract} per contract per side. Prices are 15-minute delayed, so real fills and stops would differ.</p>`;
}

// ---------------- events ----------------
function wire() {
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
    if (t.dataset.tab === 'bot') renderBot();
    if (t.dataset.tab === 'backtest') { renderForward(); renderBt(); }
    clearInterval(PA.timer);
    if (t.dataset.tab === 'paper') { loadPaper(); PA.timer = setInterval(loadPaper, 60_000); }
    window.dispatchEvent(new Event('resize'));
  }));
  $('symRow').onclick = (e) => {
    const b = e.target.closest('[data-sym]');
    if (!b || b.dataset.sym === P.symbol) return;
    P.symbol = b.dataset.sym; P.customExps = null; savePrefs();
    $('tickerInput').value = P.symbol;
    loadAll();
  };
  $('tickerForm').onsubmit = (e) => {
    e.preventDefault();
    const s = $('tickerInput').value.trim().toUpperCase();
    if (!s) return;
    P.symbol = s; P.customExps = null; savePrefs();
    loadAll();
  };
  $('refreshBtn').onclick = () => loadAll();
  $('autoRefresh').onchange = (e) => {
    clearInterval(A.timer);
    if (e.target.checked) A.timer = setInterval(() => loadAll(false), 60_000);
  };
  $('expChips').onclick = (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const x = c.dataset.exp;
    if (A.custom.has(x)) { if (A.custom.size > 1) A.custom.delete(x); } else A.custom.add(x);
    customChanged();
  };
  document.querySelectorAll('[data-quick]').forEach((b) => (b.onclick = () => {
    const q = b.dataset.quick, ex = A.mkt.exps;
    const sel = q === 'next' ? ex.slice(0, 1) : q === 'all' ? ex : q === 'none' ? ex.slice(0, 1) : ex.filter((e) => dte(e) <= +q);
    A.custom = new Set(sel.length ? sel : ex.slice(0, 1));
    if (q !== 'none' && q !== 'next' && q !== 'all') P.customDays = +q;
    customChanged();
  }));
  $('tfRow').onclick = async (e) => {
    const b = e.target.closest('[data-tf]');
    if (!b || b.dataset.tf === P.tf) return;
    P.tf = b.dataset.tf; savePrefs();
    try { A.candles = await loadCandles(P.symbol, P.tf); } catch (err) { A.candles = { candles: [] }; banner(`Candles unavailable: ${err.message}`, 'info'); }
    renderPriceChart(true);
  };
  $('groupToggles').onclick = (e) => {
    const t = e.target.closest('[data-group]');
    if (!t) return;
    P.groupsOn[t.dataset.group] = !P.groupsOn[t.dataset.group];
    savePrefs(); renderToggles(); drawLevelLines();
  };
  $('levelToggles').onclick = (e) => {
    const t = e.target.closest('[data-level]');
    if (!t) return;
    const id = t.dataset.level;
    if (id === '__all' || id === '__none') LEVEL_DEFS.forEach((d) => (P.levelsOn[d.id] = id === '__all'));
    else P.levelsOn[id] = !P.levelsOn[id];
    savePrefs(); renderToggles(); drawLevelLines();
  };
  $('indToggles').onclick = (e) => {
    const t = e.target.closest('[data-ind]');
    if (!t) return;
    P.ind[t.dataset.ind] = !P.ind[t.dataset.ind];
    savePrefs(); renderToggles(); drawIndicators(A.candles.gmtoffset || 0);
  };
  $('gexGroup').onchange = (e) => { P.gexGroup = e.target.value; savePrefs(); renderLevelsTab(); };
  $('gexMode').onchange = (e) => { P.gexMode = e.target.value; savePrefs(); renderGex(); };
  $('strikeWin').value = P.strikeWin;
  $('strikeWin').oninput = (e) => { P.strikeWin = +e.target.value; savePrefs(); renderStrikeTable(); };

  // tooltips
  const tip = $('tooltip');
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.classList.add('hidden'); return; }
    tip.textContent = t.dataset.tip;
    tip.classList.remove('hidden');
    const r = t.getBoundingClientRect();
    tip.style.left = `${Math.min(r.left, innerWidth - 300)}px`;
    tip.style.top = `${r.bottom + 6}px`;
  });

  // bot
  ['botEpisodes', 'rvPos', 'rvNeg', 'pinStr', 'regRel'].forEach((id) => ($(id).oninput = renderBotLabels));
  $('botHorizon').onchange = renderBot;
  $('botRank').onchange = () => { renderBot(); if (lastTrades.length) $('genBtn').click(); };
  $('signals').onchange = (e) => {
    const s = e.target.closest('[data-signal]');
    Bot.brain.signals[s.dataset.signal] = e.target.checked;
    Bot.save(); renderBot();
  };
  $('trainBtn').onclick = async () => {
    $('trainBtn').disabled = true;
    const t0 = performance.now();
    const eps = +$('botEpisodes').value;
    const hs = Bot.HORIZONS.filter((h) => A.results[h.id]);
    const done = [];
    for (const [i, h] of hs.entries()) {
      $('trainMsg').textContent = `Training ${h.label.toLowerCase()} setups…`;
      const res = await Bot.train(A.mkt, A.results[h.id], h.id, eps, botParams(), $('botMgmt').value,
        (f) => ($('trainBar').style.width = `${Math.min(100, ((i + Math.min(f, 1)) / hs.length) * 100)}%`));
      done.push(`${h.label}: ${fmtExp(res.exp, false)}`);
      if (i === hs.length - 1) $('trainMsg').textContent = `Trained ${eps.toLocaleString()} episodes × ${res.cands.length} strategies per horizon (${done.join(' · ')}) in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    }
    $('trainBtn').disabled = false;
    renderBot();
    $('genBtn').click();
  };
  $('genBtn').onclick = generateIdeas;
  $('btRun').onclick = runBt;
  $('btFilterH').onchange = renderBtLog;
  $('btFilterP').onchange = renderBtLog;
  $('btTeach').onclick = () => {
    if (!BT.res || BT.taught) return;
    BT.res.trades.forEach((t) => Bot.learnFrom(t.ctxKey, t.strat, t.pl, t.risk, 0.25));
    Bot.save();
    BT.taught = true;
    $('btTeach').disabled = true;
    $('btMsg').textContent = `Taught the bot ${BT.res.trades.length.toLocaleString()} backtest outcomes at 0.25 weight each (lower than real paper trades, since the gamma levels were a stand-in).`;
    renderBot();
  };
  $('fwdScore').onclick = async () => {
    try { const r = await Bot.scoreJournal(P.symbol); $('fwdScore').textContent = `Scored ${r.scored}`; } catch { /* ignore */ }
    renderForward(); renderBot();
  };
  $('minConf').oninput = () => { renderBotLabels(); if (lastTrades.length) generateIdeas(); };
  $('convOnly').onchange = generateIdeas;
  ['maxConfl', 'gammaVeto'].forEach((id) => ($(id).onchange = () => { if (lastTrades.length) generateIdeas(); }));
  $('flyPref').oninput = () => { renderBotLabels(); $('btFlyPref').value = flyPref(); if (lastTrades.length) generateIdeas(); };
  $('btFlyPref').onchange = () => { $('flyPref').value = $('btFlyPref').value; renderBotLabels(); };
  // profit targets: one setting shared by training, idea cards and the backtest (selects kept in sync)
  const syncTp = (cls, key) => document.querySelectorAll(`.${cls}`).forEach((el) => (el.onchange = () => {
    Bot.EXIT[key] = +el.value;
    document.querySelectorAll(`.${cls}`).forEach((o) => (o.value = el.value));
    if (lastTrades.length) renderTrades();
  }));
  syncTp('tp-spread', 'tp');
  syncTp('tp-fly', 'flyTp');
  $('calibrateBtn').onclick = () => {
    const env = botEnv('daily');
    const msgs = [];
    const set = (id, v) => { const el = $(id); el.value = Math.min(+el.max, Math.max(+el.min, v)).toFixed(2); };
    const m = A.memStats;
    // A day's high-low range is ~0.8x of 2 sigma for a normal walk, so range/EM / 0.8 ~ realized/implied.
    if (m && m.pos.length >= 3) { set('rvPos', m.rangePos / 0.8); msgs.push(`+γ ${(m.rangePos / 0.8).toFixed(2)}× from ${m.pos.length} recorded sessions`); }
    if (m && m.neg.length >= 3) { set('rvNeg', m.rangeNeg / 0.8); msgs.push(`−γ ${(m.rangeNeg / 0.8).toFixed(2)}× from ${m.neg.length} recorded sessions`); }
    if (A.ip && env) {
      const id = env.lv.regime === 'positive' ? 'rvPos' : 'rvNeg';
      const have = m && (id === 'rvPos' ? m.pos : m.neg).length >= 3;
      if (!have) {
        const ratio = A.ip.rvIntraday / env.iv.atm;
        set(id, ratio);
        msgs.push(`${id === 'rvPos' ? '+γ' : '−γ'} ${ratio.toFixed(2)}× (5-day intraday RV ${fmt.pct(A.ip.rvIntraday, 1)} ÷ 0DTE ATM IV ${fmt.pct(env.iv.atm, 1)})`);
      }
    }
    renderBotLabels();
    $('trainMsg').textContent = msgs.length ? `Calibrated realized/implied: ${msgs.join('; ')}. Retrain to apply.` : 'Not enough data to calibrate yet.';
  };
  $('tradeCards').onclick = (e) => {
    const o = e.target.closest('[data-open]'), p = e.target.closest('[data-paper]');
    if (o) {
      const tr = lastTrades[+o.dataset.open];
      loadStrategy(tr.legs, tr.t.name);
      document.querySelector('.tab[data-tab="builder"]').click();
    }
    if (p) {
      const tr = lastTrades[+p.dataset.paper];
      Bot.addPaperTrade({ ...tr, spotAtEntry: A.mkt.spot });
      p.textContent = '✓ Added'; p.disabled = true;
      renderJournal();
    }
  };
  $('resetBrain').onclick = () => {
    if (!confirm('Forget everything the bot has learned (journal is kept)?')) return;
    Bot.resetBrain(); lastTrades = []; renderTrades(); renderBot();
  };
  $('evalJournal').onclick = async () => {
    try {
      const r = await Bot.scoreJournal(P.symbol);
      $('trainMsg').textContent = `Scored ${r.scored} expired trade(s); ${r.pending} still open.`;
    } catch (err) { banner(`Scoring failed: ${err.message}`, 'info'); }
    renderBot();
  };
  $('clearJournal').onclick = () => {
    if (!confirm('Delete all paper trades from the journal?')) return;
    Bot.brain.journal = []; Bot.save(); renderJournal();
  };
}

initBuilder();
renderToggles();
wire();
$('tickerInput').value = P.symbol;
loadAll();
