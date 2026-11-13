// Shared Chart.js setup: theme defaults + vertical/horizontal reference line plugin.
/* global Chart */
export const C = {
  text: '#cbd5e1', muted: '#7c8aa5', grid: 'rgba(148,163,184,0.10)', green: '#22c55e', red: '#ef4444',
  blue: '#38bdf8', amber: '#f59e0b', violet: '#a78bfa', pink: '#e879f9', white: '#e2e8f0',
};

Chart.defaults.color = C.muted;
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.borderColor = C.grid;
Chart.defaults.animation = false;
Chart.defaults.maintainAspectRatio = false;

// options.plugins.refLines = { x: [{v, color, label, dash}], y: [...] }
Chart.register({
  id: 'refLines',
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: a, scales } = chart;
    ctx.save();
    ctx.font = '600 10px Inter, sans-serif';
    let row = 0;
    for (const l of opts.x || []) {
      const px = scales.x.getPixelForValue(l.v);
      if (!(px >= a.left && px <= a.right)) continue;
      ctx.strokeStyle = l.color; ctx.setLineDash(l.dash || []); ctx.lineWidth = l.width || 1;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      if (l.label) {
        ctx.fillStyle = l.color;
        const w = ctx.measureText(l.label).width;
        const tx = px + 3 + w > a.right ? px - w - 3 : px + 3;
        ctx.fillText(l.label, tx, a.top + 10 + (row++ % 4) * 11);
      }
    }
    for (const l of opts.y || []) {
      const scale = scales.y;
      const py = l.index != null ? scale.getPixelForValue(l.index) : scale.getPixelForValue(l.v);
      if (!(py >= a.top && py <= a.bottom)) continue;
      ctx.strokeStyle = l.color; ctx.setLineDash(l.dash || []); ctx.lineWidth = l.width || 1;
      ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
      if (l.label) { ctx.fillStyle = l.color; ctx.fillText(l.label, a.left + 4, py - 3); }
    }
    ctx.restore();
  },
});

export function upsertChart(holder, key, canvas, config) {
  if (holder[key]) {
    holder[key].data = config.data;
    holder[key].options = config.options;
    holder[key].update('none');
    return holder[key];
  }
  holder[key] = new Chart(canvas, config);
  return holder[key];
}
