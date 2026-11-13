// Strategy builder: legs editor, payoff/greeks chart, scenario sliders, P/L grid, saved trades.
import { fmt, fmtExp, dte, bs, yearsTo } from './math.js';
import { PRESETS, buildPreset, makeLeg, positionAt, strategyStats, firstExpiryMs, netCost, describeLegs } from './strategies.js';
import { nearestStrike } from './data.js';
import { LEVEL_DEFS, GROUP_DEFS } from './levels.js';
import { C, upsertChart } from './chartutil.js';

const $ = (id) => document.getElementById(id);
const PREFS_KEY = 'gammadesk.builder.v1';
const SAVED_KEY = 'gammadesk.saved.v1';
const B = { mkt: null, legs: [], name: 'Custom', dateFrac: 0, priceOff: 0, ivShift: 0, range: 5, results: {}, charts: {}, openSaved: null };

const prefs = (() => {
  const d = { levelSet: 'custom', levelTypes: ['P1', 'N1', 'CW', 'PW', 'FLIP'] };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch { return d; }
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

let saved = (() => { try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch { return []; } })();
const persistSaved = () => { try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); } catch { /* ignore */ } };

// Spread price: net value of the position per share for one "lot" (smallest option quantity).
// Positive = debit (you own it), negative = credit (you'd pay that to close).
const lotSize = (legs) => { const q = legs.filter((l) => l.type !== 'S').map((l) => l.qty); return q.length ? Math.max(1, Math.min(...q)) : 1; };
const spreadPx = (legs, value) => value / (100 * lotSize(legs));
const fmtPx = (v) => `${fmt.usd(Math.abs(v), 2)} ${v >= 0 ? 'db' : 'cr'}`;

export function initBuilder() {
  $('presetSel').innerHTML = Object.keys(PRESETS).map((n) => `<option>${n}</option>`).join('');
  $('presetSel').value = 'Iron Condor';
  $('applyPreset').onclick = () => {
    const name = $('presetSel').value;
    loadStrategy(buildPreset(B.mkt, name, $('presetExp').value), name);
  };
  document.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => {
    const t = b.dataset.add;
    const exp = $('presetExp').value;
    const k = t === 'S' ? null : nearestStrike(B.mkt.byExp.get(exp), B.mkt.spot);
    B.legs.push(makeLeg(B.mkt, exp, t, k, 'buy', t === 'S' ? 100 : 1));
    B.name = 'Custom';
    render();
  }));
  $('clearLegs').onclick = () => { B.legs = []; B.name = 'Custom'; render(); };
  $('repriceLegs').onclick = () => { B.legs = B.legs.map((l) => ({ ...makeLeg(B.mkt, l.exp, l.type, l.k, l.action, l.qty), id: l.id })); render(); };
  const sl = (id, key, f = Number) => ($(id).oninput = (e) => { B[key] = f(e.target.value); renderAnalysis(); });
  sl('dateSlider', 'dateFrac', (v) => v / 1000);
  sl('priceSlider', 'priceOff', (v) => v / 100);
  sl('ivSlider', 'ivShift');
  sl('rangeSlider', 'range');
  ['showExpiry', 'greekLine', 'gridMode'].forEach((id) => ($(id).onchange = renderAnalysis));

  // level set + level type pickers
  $('levelSet').value = prefs.levelSet;
  $('levelSet').onchange = (e) => { prefs.levelSet = e.target.value; savePrefs(); renderAnalysis(); };
  $('levelPickMenu').innerHTML = LEVEL_DEFS.map((d) => `<label data-tip="${d.desc}"><input type="checkbox" value="${d.id}" ${prefs.levelTypes.includes(d.id) ? 'checked' : ''} /><span class="dot" style="background:${d.color}"></span>${d.label}</label>`).join('');
  $('levelPickMenu').onchange = () => {
    prefs.levelTypes = [...$('levelPickMenu').querySelectorAll('input:checked')].map((i) => i.value);
    savePrefs(); renderAnalysis();
  };
  document.addEventListener('click', (e) => { if (!$('levelPick').contains(e.target)) $('levelPick').open = false; });

  $('resetScenario').onclick = () => {
    Object.assign(B, { dateFrac: 0, priceOff: 0, ivShift: 0 });
    $('dateSlider').value = 0; $('priceSlider').value = 0; $('ivSlider').value = 0;
    renderAnalysis();
  };
  $('legsTable').addEventListener('input', onLegEdit);
  $('legsTable').addEventListener('change', onLegEdit);
  $('legsTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const leg = B.legs.find((l) => l.id === +tr.dataset.id);
    if (e.target.classList.contains('act-btn')) { leg.action = leg.action === 'buy' ? 'sell' : 'buy'; B.name = 'Custom'; render(); }
    if (e.target.classList.contains('x-btn')) { B.legs = B.legs.filter((l) => l !== leg); B.name = 'Custom'; render(); }
  });
  initSaved();
}

export function setBuilderMarket(mkt, results) {
  const first = !B.mkt;
  B.mkt = mkt;
  B.results = results;
  const sel = $('presetExp');
  const prev = sel.value;
  sel.innerHTML = mkt.exps.slice(0, 40).map((e) => `<option value="${e}">${fmtExp(e)} · ${Math.max(dte(e), 0).toFixed(1)}d</option>`).join('');
  sel.value = mkt.exps.includes(prev) ? prev : mkt.exps.find((e) => dte(e) >= 4) || mkt.exps[0];
  // Drop legs whose expiration has passed
  B.legs = B.legs.filter((l) => l.type === 'S' || mkt.byExp.has(l.exp));
  if (first && !B.legs.length) { B.name = 'Iron Condor'; B.legs = buildPreset(mkt, 'Iron Condor', sel.value); }
  render();
  renderSaved();
}

export function setBuilderLevels(results) { B.results = results; renderAnalysis(); }

export function loadStrategy(legs, name) {
  B.legs = legs.map((l) => ({ ...l }));
  B.name = name || 'Custom';
  Object.assign(B, { dateFrac: 0, priceOff: 0, ivShift: 0 });
  $('dateSlider').value = 0; $('priceSlider').value = 0; $('ivSlider').value = 0;
  if (PRESETS[name]) $('presetSel').value = name;
  render();
}

function onLegEdit(e) {
  const tr = e.target.closest('tr[data-id]');
  const f = e.target.dataset.f;
  if (!tr || !f) return;
  const leg = B.legs.find((l) => l.id === +tr.dataset.id);
  const v = e.target.value;
  if (f === 'qty') leg.qty = Math.max(1, Math.round(+v) || 1);
  if (f === 'entry') leg.entry = Math.max(0, +v || 0);
  if (f === 'iv') leg.iv = Math.max(0.01, (+v || 1) / 100);
  if (['type', 'exp', 'k'].includes(f) && e.type === 'change') {
    if (f === 'type') leg.type = v;
    if (f === 'exp') leg.exp = v;
    if (f === 'k') leg.k = +v;
    if (leg.type === 'S') Object.assign(leg, { exp: null, k: null, entry: B.mkt.spot, iv: 0, qty: 100 });
    else {
      if (!leg.exp) leg.exp = $('presetExp').value;
      const x = B.mkt.byExp.get(leg.exp);
      leg.k = nearestStrike(x, leg.k ?? B.mkt.spot);
      const fresh = makeLeg(B.mkt, leg.exp, leg.type, leg.k, leg.action, leg.qty);
      leg.iv = fresh.iv; leg.entry = fresh.entry;
    }
    B.name = 'Custom';
    renderLegs();
  }
  if (e.type === 'change' && ['qty', 'entry', 'iv'].includes(f)) B.name = 'Custom';
  renderAnalysis();
}

function render() { renderLegs(); renderAnalysis(); }

function renderLegs() {
  const m = B.mkt;
  const expOpts = (sel) => m.exps.slice(0, 40).map((e) => `<option value="${e}" ${e === sel ? 'selected' : ''}>${fmtExp(e, false)}</option>`).join('');
  const strikeOpts = (l) => {
    const x = m.byExp.get(l.exp);
    return x.strikes.filter((k) => Math.abs(k / m.spot - 1) < 0.25 || k === l.k)
      .map((k) => `<option value="${k}" ${k === l.k ? 'selected' : ''}>${k}</option>`).join('');
  };
  const rows = B.legs.map((l) => {
    const isS = l.type === 'S';
    const mid = isS ? m.spot : (l.type === 'C' ? m.byExp.get(l.exp).calls : m.byExp.get(l.exp).puts).get(l.k)?.mid;
    return `<tr data-id="${l.id}">
      <td><button class="act-btn ${l.action}">${l.action.toUpperCase()}</button></td>
      <td><input data-f="qty" type="number" min="1" value="${l.qty}" /></td>
      <td><select data-f="type"><option value="C" ${l.type === 'C' ? 'selected' : ''}>Call</option><option value="P" ${l.type === 'P' ? 'selected' : ''}>Put</option><option value="S" ${isS ? 'selected' : ''}>Stock</option></select></td>
      <td>${isS ? '—' : `<select data-f="exp">${expOpts(l.exp)}</select>`}</td>
      <td>${isS ? '—' : `<select data-f="k">${strikeOpts(l)}</select>`}</td>
      <td>${isS ? '—' : `<input data-f="iv" type="number" step="0.1" value="${(l.iv * 100).toFixed(1)}" />`}</td>
      <td><input data-f="entry" type="number" step="0.01" value="${l.entry.toFixed(2)}" /></td>
      <td class="n">${mid != null && !isNaN(mid) ? mid.toFixed(2) : '—'}</td>
      <td class="n" data-theo="${l.id}">—</td>
      <td class="n">${isS ? '—' : Math.max(dte(l.exp), 0).toFixed(1)}</td>
      <td><button class="x-btn" title="Remove leg">×</button></td></tr>`;
  }).join('');
  $('legsTable').innerHTML = `<thead><tr><th>Side</th><th>Qty</th><th>Type</th><th>Expiration</th><th>Strike</th><th>IV %</th><th>Entry</th><th>Mkt mid</th><th title="Theoretical contract price at the scenario date, price and IV">Price @ scenario</th><th>DTE</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="11" class="hint">No legs yet. Pick a strategy above and press Build, or add legs.</td></tr>'}</tbody>`;
}

function scenario() {
  const now = Date.now();
  const tEnd = firstExpiryMs(B.legs);
  const atMs = now + B.dateFrac * Math.max(tEnd - now, 0);
  const spot = B.mkt.spot;
  const S0 = spot * (1 + B.priceOff * B.range / 100);
  const ivMult = 1 + B.ivShift / 100;
  return { now, tEnd, atMs, spot, S0, ivMult };
}

function fmtWhen(ms, spanMs) {
  const d = new Date(ms);
  if (spanMs < 3 * 864e5) return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

function atmIvFor(legs) {
  const m = B.mkt;
  const optLegs = legs.filter((l) => l.type !== 'S' && m.byExp.has(l.exp));
  const nearExp = optLegs.length ? optLegs.map((l) => l.exp).sort()[0] : m.exps[0];
  return m.byExp.get(nearExp)?.atmIv || 0.2;
}

function renderAnalysis() {
  const m = B.mkt;
  if (!m) return;
  const sc = scenario();
  const legs = B.legs;
  const atmIv = atmIvFor(legs);

  $('dateLbl').textContent = `${fmtWhen(sc.atMs, sc.tEnd - sc.now)} · ${((sc.tEnd - sc.atMs) / 864e5).toFixed(1)}d left`;
  $('priceLbl').textContent = `${fmt.num(sc.S0)} (${fmt.signed((sc.S0 / sc.spot - 1) * 100, 1)}%)`;
  $('ivLbl').textContent = `${B.ivShift >= 0 ? '+' : ''}${B.ivShift}% · ATM ${(atmIv * sc.ivMult * 100).toFixed(1)}%`;
  $('rangeLbl').textContent = `±${B.range}%`;
  $('stratName').textContent = legs.length ? `${B.name} · payoff` : 'Payoff';
  $('saveTradeBtn').disabled = !legs.length;

  if (!legs.length) {
    $('stratStats').innerHTML = '';
    $('greeks').innerHTML = '';
    $('heatTable').innerHTML = '';
    if (B.charts.payoff) { B.charts.payoff.destroy(); B.charts.payoff = null; }
    return;
  }

  // per-leg contract price at the scenario
  for (const l of legs) {
    const cell = document.querySelector(`[data-theo="${l.id}"]`);
    if (!cell) continue;
    const T = l.type === 'S' ? 0 : Math.max(yearsTo(l.exp, sc.atMs), 0);
    const px = bs(sc.S0, l.k, T, l.iv * sc.ivMult, l.type).price;
    cell.textContent = px.toFixed(2);
    cell.className = `n ${px >= l.entry ? 'pos' : 'neg'}`;
  }

  // ---- stats
  const st = strategyStats(legs, sc.spot, atmIv, sc.ivMult);
  const cost = netCost(legs);
  const g = positionAt(legs, sc.S0, sc.atMs, sc.ivMult);
  const maxP = st.unlimitedUp ? 'Unlimited' : fmt.usd(st.maxProfit);
  const maxL = st.unlimitedDown ? 'Unlimited' : fmt.usd(st.maxLoss);
  const rr = !st.unlimitedDown && !st.unlimitedUp && st.maxLoss < 0 ? (st.maxProfit / -st.maxLoss).toFixed(2) : '—';
  const tiles = [
    [cost >= 0 ? 'Net debit' : 'Net credit', fmt.usd(Math.abs(cost)), cost >= 0 ? 'paid' : 'received'],
    ['Spread price', fmtPx(spreadPx(legs, cost)), `entry · now ${fmtPx(spreadPx(legs, g.value))} at scenario`],
    ['Max profit', maxP, '', 'pos'],
    ['Max loss', maxL, '', 'neg'],
    ['Reward / risk', rr, ''],
    ['Prob. of profit', fmt.pct(st.pop, 0), 'lognormal at 1st expiry'],
    ['Breakevens', st.breakevens.length ? st.breakevens.map((b) => b.toFixed(2)).join(' · ') : '—', ''],
    ['1st expiration', fmtWhen(sc.tEnd, 1e12), `${((sc.tEnd - sc.now) / 864e5).toFixed(1)} days`],
  ];
  $('stratStats').innerHTML = tiles.map(([k, v, s, c]) => `<div class="tile"><div class="k">${k}</div><div class="v ${c || ''}">${v}</div><div class="s">${s}</div></div>`).join('');

  // ---- greeks at scenario
  const usd = (v) => fmt.usd(v, Math.abs(v) < 10 ? 2 : 0);
  const gt = [
    ['Delta', fmt.num(g.delta, 1), `${usd(g.delta)} per $1 move`],
    ['Gamma', fmt.num(g.gamma, 2), 'Δ change per $1'],
    ['Theta', usd(g.theta), 'per day'],
    ['Vega', usd(g.vega), 'per 1 vol point'],
    ['Rho', usd(g.rho), 'per 1% rate'],
    ['P/L at scenario', fmt.usd(g.pl, 0), `spread ${fmtPx(spreadPx(legs, g.value))}`],
  ];
  $('greeks').innerHTML = gt.map(([k, v, s]) => `<div class="g"><div class="k">${k}</div><div class="v ${k.startsWith('P/L') ? (g.pl >= 0 ? 'pos' : 'neg') : ''}">${v}</div><div class="s">${s}</div></div>`).join('');

  renderPayoff(sc, st);
  renderHeat(sc, st);
}

function renderPayoff(sc, st) {
  const legs = B.legs;
  const lo = sc.spot * (1 - B.range / 100), hi = sc.spot * (1 + B.range / 100);
  const N = 220;
  const now = [], exp = [], over = [], pxNow = [];
  const gk = $('greekLine').value;
  for (let i = 0; i <= N; i++) {
    const s = lo + ((hi - lo) * i) / N;
    const p = positionAt(legs, s, sc.atMs, sc.ivMult);
    now.push({ x: s, y: p.pl });
    pxNow.push(spreadPx(legs, p.value));
    if (gk) over.push({ x: s, y: gk === 'price' ? spreadPx(legs, p.value) : p[gk] });
    if ($('showExpiry').checked) exp.push({ x: s, y: positionAt(legs, s, sc.tEnd, sc.ivMult).pl });
  }
  const fill = { target: { value: 0 }, above: 'rgba(34,197,94,0.14)', below: 'rgba(239,68,68,0.14)' };
  const datasets = [
    { label: `P/L ${fmtWhen(sc.atMs, sc.tEnd - sc.now)}`, data: now, borderColor: C.blue, borderWidth: 2, pointRadius: 0, fill, yAxisID: 'y' },
  ];
  if (exp.length) datasets.push({ label: 'At expiration', data: exp, borderColor: C.white, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, fill: false, yAxisID: 'y' });
  const overLabel = gk === 'price' ? 'Spread price' : gk ? gk[0].toUpperCase() + gk.slice(1) : '';
  if (gk) datasets.push({ label: overLabel, data: over, borderColor: C.amber, borderWidth: 1.5, pointRadius: 0, fill: false, yAxisID: 'y2' });

  const xl = [{ v: sc.spot, color: C.white, label: `Spot ${sc.spot.toFixed(2)}`, width: 1.5 }];
  if (Math.abs(sc.S0 - sc.spot) > 0.01) xl.push({ v: sc.S0, color: C.blue, dash: [4, 3], label: `Scenario ${sc.S0.toFixed(2)}` });
  st.breakevens.forEach((b) => xl.push({ v: b, color: '#64748b', dash: [2, 3], label: `BE ${b.toFixed(1)}` }));
  const lvSet = B.results[prefs.levelSet];
  if (lvSet) {
    const tag = GROUP_DEFS.find((g) => g.id === prefs.levelSet).label[0];
    for (const def of LEVEL_DEFS) {
      const lv = lvSet.levels[def.id];
      if (lv && prefs.levelTypes.includes(def.id)) xl.push({ v: lv.price, color: def.color, dash: [6, 4], label: `${def.label} ${tag} ${lv.price.toFixed(Number.isInteger(lv.price) ? 0 : 1)}` });
    }
  }

  upsertChart(B.charts, 'payoff', $('payoffChart'), {
    type: 'line',
    data: { datasets },
    options: {
      parsing: false, normalized: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'linear', min: lo, max: hi, ticks: { callback: (v) => v.toFixed(0) }, grid: { color: C.grid } },
        y: { ticks: { callback: (v) => fmt.usd(v) }, grid: { color: (c) => (c.tick.value === 0 ? 'rgba(226,232,240,0.35)' : C.grid) } },
        y2: { display: !!gk, position: 'right', grid: { display: false }, ticks: { color: C.amber, callback: (v) => (gk === 'price' ? fmt.usd(v, 2) : v) } },
      },
      plugins: {
        legend: { labels: { boxWidth: 12, color: C.text } },
        tooltip: {
          callbacks: {
            title: (i) => `Price ${i[0].parsed.x.toFixed(2)}`,
            label: (i) => {
              if (i.dataset.yAxisID === 'y2') return `${i.dataset.label}: ${gk === 'price' ? fmtPx(i.parsed.y) : i.parsed.y.toFixed(2)}`;
              return `${i.dataset.label}: ${fmt.usd(i.parsed.y)}`;
            },
            afterBody: (items) => (gk === 'price' ? '' : `Spread price: ${fmtPx(pxNow[items[0].dataIndex])}`),
          },
        },
        refLines: { x: xl },
      },
    },
  });
}

function renderHeat(sc, st) {
  const legs = B.legs;
  const rowsN = 17, colsN = Math.min(9, Math.max(3, Math.ceil((sc.tEnd - sc.now) / 864e5) + 1));
  const lo = sc.spot * (1 - B.range / 100), hi = sc.spot * (1 + B.range / 100);
  const times = Array.from({ length: colsN }, (_, i) => sc.now + ((sc.tEnd - sc.now) * i) / (colsN - 1));
  const prices = Array.from({ length: rowsN }, (_, i) => hi - ((hi - lo) * i) / (rowsN - 1));
  // snap the closest row to spot
  let ci = 0; prices.forEach((p, i) => { if (Math.abs(p - sc.spot) < Math.abs(prices[ci] - sc.spot)) ci = i; });
  prices[ci] = sc.spot;
  const cells = prices.map((p) => times.map((t) => positionAt(legs, p, t, sc.ivMult)));
  const maxAbs = Math.max(1, ...cells.flat().map((c) => Math.abs(c.pl)));
  const risk = !st.unlimitedDown && st.maxLoss < 0 ? -st.maxLoss : Math.abs(netCost(legs)) || 1;
  const mode = $('gridMode').value;
  const color = (v) => {
    const a = Math.min(1, Math.abs(v) / maxAbs) * 0.75 + 0.06;
    return v >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})`;
  };
  const text = (c) => {
    const px = spreadPx(legs, c.value);
    const pxs = `${Math.abs(px).toFixed(2)}${px >= 0 ? '' : ' cr'}`;
    if (mode === 'pct') return `${((c.pl / risk) * 100).toFixed(0)}%`;
    if (mode === 'price') return pxs;
    if (mode === 'both') return `${fmt.big(c.pl)}<span class="sub">${pxs}</span>`;
    return fmt.big(c.pl);
  };
  const head = `<tr><th>Price</th>${times.map((t) => `<th>${fmtWhen(t, sc.tEnd - sc.now)}</th>`).join('')}</tr>`;
  const body = prices.map((p, r) => `<tr class="${r === ci ? 'spot-row' : ''}"><td class="px">${p.toFixed(2)} <span class="dist">${fmt.signed((p / sc.spot - 1) * 100, 1)}%</span></td>${
    cells[r].map((c) => `<td style="background:${color(c.pl)}" title="P/L ${fmt.usd(c.pl)} · spread ${fmtPx(spreadPx(legs, c.value))}">${text(c)}</td>`).join('')}</tr>`).join('');
  $('heatTable').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
}

// ---------------- saved trades ----------------
function initSaved() {
  const dlg = $('saveDialog');
  $('saveTradeBtn').onclick = () => {
    if (!B.legs.length) return;
    const g = positionAt(B.legs, B.mkt.spot, Date.now(), 1);
    $('saveName').value = `${B.mkt.symbol} ${B.name} ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    $('saveNotes').value = '';
    $('saveSummary').innerHTML = `${describeLegs(B.legs)}<br>Spot ${B.mkt.spot.toFixed(2)} · spread ${fmtPx(spreadPx(B.legs, netCost(B.legs)))} · Δ ${g.delta.toFixed(1)} · Θ ${fmt.usd(g.theta, 2)}/day · V ${fmt.usd(g.vega, 2)}`;
    dlg.showModal();
    $('saveName').select();
  };
  $('saveForm').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'save') saveCurrent($('saveName').value.trim() || B.name, $('saveNotes').value);
  });

  $('savedTable').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    const row = e.target.closest('[data-sid]');
    if (!row) return;
    const t = saved.find((x) => x.id === +row.dataset.sid);
    if (act?.dataset.act === 'load') {
      e.stopPropagation();
      const expired = t.legs.some((l) => l.type !== 'S' && !B.mkt.byExp.has(l.exp));
      if (expired) { alert('This trade has expired legs, so it cannot be loaded into the builder. Its saved details are still shown below.'); return; }
      loadStrategy(t.legs.map((l, i) => ({ ...l, id: Date.now() + i })), t.strategy);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (act?.dataset.act === 'delete') {
      e.stopPropagation();
      if (!confirm(`Delete saved trade "${t.name}"?`)) return;
      saved = saved.filter((x) => x !== t); persistSaved(); renderSaved();
      return;
    }
    if (e.target.closest('textarea')) return;
    B.openSaved = B.openSaved === t.id ? null : t.id;
    renderSaved();
  });
  $('savedTable').addEventListener('change', (e) => {
    const ta = e.target.closest('textarea[data-notes]');
    if (!ta) return;
    const t = saved.find((x) => x.id === +ta.dataset.notes);
    t.notes = ta.value; t.updatedAt = Date.now(); persistSaved();
    const prev = document.querySelector(`[data-preview="${t.id}"]`);
    if (prev) prev.textContent = t.notes.split('\n')[0] || '—';
  });

  $('exportSaved').onclick = () => {
    const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `gammadesk-saved-trades-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('importSaved').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const list = JSON.parse(await f.text());
      if (!Array.isArray(list)) throw new Error('not a list of trades');
      const have = new Set(saved.map((x) => x.id));
      const add = list.filter((x) => x && x.id && Array.isArray(x.legs) && !have.has(x.id));
      saved = [...add, ...saved].sort((a, b) => b.savedAt - a.savedAt);
      persistSaved(); renderSaved();
      alert(`Imported ${add.length} trade(s).`);
    } catch (err) { alert(`Could not import: ${err.message}`); }
    e.target.value = '';
  };
}

function saveCurrent(name, notes) {
  const m = B.mkt, legs = B.legs.map(({ id, ...l }) => ({ ...l }));
  const now = Date.now();
  const g = positionAt(legs, m.spot, now, 1);
  const st = strategyStats(legs, m.spot, atmIvFor(legs), 1);
  const lv = B.results[prefs.levelSet] || B.results.custom;
  saved.unshift({
    id: now, savedAt: now, name, notes, strategy: B.name, symbol: m.symbol, spot: m.spot, legs,
    cost: netCost(legs), entryPx: spreadPx(legs, netCost(legs)),
    greeks: { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, rho: g.rho },
    stats: { maxProfit: st.maxProfit, maxLoss: st.maxLoss, unlimitedUp: st.unlimitedUp, unlimitedDown: st.unlimitedDown, breakevens: st.breakevens, pop: st.pop },
    firstExp: firstExpiryMs(legs),
    levels: lv ? Object.fromEntries(['P1', 'N1', 'CW', 'PW', 'FLIP'].filter((k) => lv.levels[k]).map((k) => [k, lv.levels[k].price])) : {},
    regime: lv?.regime,
  });
  persistSaved();
  B.openSaved = now;
  renderSaved();
  $('savedTable').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderSaved() {
  if (!B.mkt) return;
  const m = B.mkt;
  if (!saved.length) {
    $('savedTable').innerHTML = '<tbody><tr><td class="hint">No saved trades yet. Build a strategy and press <b>💾 Save trade</b>.</td></tr></tbody>';
    return;
  }
  const head = '<thead><tr><th>Saved</th><th>Name</th><th>Legs</th><th>Spot then</th><th>Entry</th><th>Δ</th><th>Γ</th><th>Θ/day</th><th>Vega</th><th>P/L now</th><th>Notes</th><th></th></tr></thead>';
  const rows = saved.map((t) => {
    const expired = Date.now() > t.firstExp;
    const sameSym = t.symbol === m.symbol;
    // mark to model with current spot; legs keep the IV they were saved with
    const pl = sameSym ? positionAt(t.legs, m.spot, Math.min(Date.now(), t.firstExp), 1).pl : null;
    const gk = t.greeks;
    const open = B.openSaved === t.id;
    const s = t.stats;
    const main = `<tr class="saved-row" data-sid="${t.id}">
      <td>${new Date(t.savedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
      <td style="font-family:Inter"><b>${esc(t.name)}</b>${t.symbol !== m.symbol ? ` <span class="dist">${t.symbol}</span>` : ''}</td>
      <td>${describeLegs(t.legs)}</td>
      <td>${t.spot.toFixed(2)}</td>
      <td>${fmtPx(t.entryPx)}</td>
      <td>${gk.delta.toFixed(1)}</td><td>${gk.gamma.toFixed(2)}</td><td>${fmt.usd(gk.theta, 2)}</td><td>${fmt.usd(gk.vega, 2)}</td>
      <td class="${pl == null ? '' : pl >= 0 ? 'pos' : 'neg'}">${pl == null ? '—' : fmt.usd(pl)}${expired ? ' <span class="dist">expired</span>' : ''}</td>
      <td class="notes-preview" data-preview="${t.id}">${esc((t.notes || '').split('\n')[0]) || '—'}</td>
      <td><div class="btn-row"><button class="btn sm" data-act="load">Load</button><button class="x-btn" data-act="delete" title="Delete">×</button></div></td></tr>`;
    if (!open) return main;
    const lv = Object.entries(t.levels || {}).map(([k, v]) => `${LEVEL_DEFS.find((d) => d.id === k)?.label || k}<b>${(+v).toFixed(k === 'FLIP' ? 2 : 0)}</b>`).join('');
    return `${main}<tr class="saved-detail" data-sid="${t.id}"><td colspan="12">
      <div class="kv">
        <span>Strategy<b>${esc(t.strategy)}</b></span>
        <span>${t.cost >= 0 ? 'Debit' : 'Credit'}<b>${fmt.usd(Math.abs(t.cost))}</b></span>
        <span>Max profit<b>${s.unlimitedUp ? 'Unlimited' : fmt.usd(s.maxProfit)}</b></span>
        <span>Max loss<b>${s.unlimitedDown ? 'Unlimited' : fmt.usd(s.maxLoss)}</b></span>
        <span>Breakevens<b>${s.breakevens.map((b) => b.toFixed(2)).join(' / ') || '—'}</b></span>
        <span>POP<b>${fmt.pct(s.pop, 0)}</b></span>
        <span>Rho<b>${fmt.usd(gk.rho, 2)}</b></span>
        <span>1st expiry<b>${new Date(t.firstExp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</b></span>
        ${t.regime ? `<span>Regime<b>${t.regime === 'positive' ? '+γ' : '−γ'}</b></span>` : ''}
      </div>
      ${lv ? `<div class="kv">Levels at save: ${lv}</div>` : ''}
      <textarea class="txt" rows="4" data-notes="${t.id}" placeholder="Notes: thesis, entry reason, exit plan, what happened…">${esc(t.notes || '')}</textarea>
      <div class="hint">Notes save automatically when you click away.</div>
    </td></tr>`;
  }).join('');
  $('savedTable').innerHTML = `${head}<tbody>${rows}</tbody>`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

export const builderExpiry = () => $('presetExp').value;
