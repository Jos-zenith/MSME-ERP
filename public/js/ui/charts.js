// Dashboard visuals with no chart library (about 4 KB, works on very low-end phones).
// Rules followed: thin marks, one baseline, rounded data ends, direct labels, text in ink colours (never the
// series colour), hover tooltip + keyboard focus on every mark, and a table view for accessibility.
import { h } from './dom.js';
import { t } from '../i18n.js';
import { fmtMoney, fmtNumber } from '../schema.js';
import { shortDayLabel } from '../analytics.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
};

export const fmtByType = (fmt, v) => (fmt === 'money' ? fmtMoney(v) : fmtNumber(v, 2));

function compact(fmt, v) {
  const n = Math.abs(v) >= 1e7 ? `${+(v / 1e7).toFixed(1)}Cr` : Math.abs(v) >= 1e5 ? `${+(v / 1e5).toFixed(1)}L` : Math.abs(v) >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(+v.toFixed(0));
  return fmt === 'money' ? `₹${n}` : n;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

let tip;
function showTip(e, text) {
  tip ||= document.body.appendChild(h('div.chart-tip', { role: 'tooltip' }));
  tip.textContent = text;
  tip.hidden = false;
  const r = e.currentTarget.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
}
const hideTip = () => { if (tip) tip.hidden = true; };

/** Vertical columns for a time series (sales per day). */
export function columnChart(data, title) {
  const { series, fmt } = data;
  const W = 560, H = 190, padL = 46, padR = 8, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceMax(Math.max(...series.map((s) => s.value), 0));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const slot = plotW / series.length;
  const bw = Math.max(4, Math.min(38, slot - 2 - slot * 0.3));
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title, class: 'chart-svg', preserveAspectRatio: 'xMidYMid meet' });
  for (const frac of [0, 0.5, 1]) {
    const v = max * frac, yy = y(v);
    root.append(
      svg('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: frac === 0 ? 'axis' : 'grid' }),
      (() => { const tx = svg('text', { x: padL - 6, y: yy + 4, 'text-anchor': 'end', class: 'tick' }); tx.textContent = compact(fmt, v); return tx; })(),
    );
  }
  const every = Math.ceil(series.length / 8);
  const top = series.reduce((m, s, i) => (s.value > (series[m]?.value ?? -1) ? i : m), 0);
  series.forEach((s, i) => {
    const cx = padL + slot * i + slot / 2;
    const hgt = Math.max(s.value > 0 ? 2 : 0, plotH - (y(s.value) - padT));
    const x = cx - bw / 2, yy = padT + plotH - hgt, r = Math.min(4, bw / 2, hgt);
    const g = svg('g', { tabindex: 0, class: 'mark', 'aria-label': `${s.label}: ${fmtByType(fmt, s.value)}` });
    // hit target is wider than the mark
    g.append(svg('rect', { x: cx - slot / 2, y: padT, width: slot, height: plotH, fill: 'transparent' }));
    if (hgt > 0) g.append(svg('path', { d: `M${x},${padT + plotH} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${padT + plotH} Z`, class: 'bar' }));
    if (i % every === 0 || i === series.length - 1) {
      const tx = svg('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'tick' });
      tx.textContent = s.key.length === 10 ? shortDayLabel(s.key) : s.label;
      root.append(tx);
    }
    if (i === top && s.value > 0) { // one direct label: the peak
      const tx = svg('text', { x: cx, y: yy - 5, 'text-anchor': 'middle', class: 'val' });
      tx.textContent = compact(fmt, s.value);
      root.append(tx);
    }
    g.addEventListener('mouseenter', (e) => showTip(e, `${s.label}: ${fmtByType(fmt, s.value)}`));
    g.addEventListener('focus', (e) => showTip(e, `${s.label}: ${fmtByType(fmt, s.value)}`));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('blur', hideTip);
    root.append(g);
  });
  return root;
}

/** Horizontal bars for categories (best-selling items, payment modes). */
export function barList(data) {
  const { series, fmt } = data;
  const max = Math.max(...series.map((s) => s.value), 1);
  return h('ul.bars', series.map((s) => h('li', { tabindex: 0, 'aria-label': `${s.label}: ${fmtByType(fmt, s.value)}` },
    h('span.bar-label', { title: s.label }, s.label),
    h('span.bar-track', h('span.bar-fill', { style: { width: `${Math.max(1.5, (s.value / max) * 100)}%` } })),
    h('span.bar-value', fmtByType(fmt, s.value)),
  )));
}

export function seriesTable(data) {
  return h('table.plain', h('tbody', data.series.map((s) => h('tr', h('td', s.label), h('td.num', fmtByType(data.fmt, s.value))))));
}

/** Chart + "table" toggle. */
export function chartWithTable(data, title) {
  const chart = data.isDate ? columnChart(data, title) : barList(data);
  const table = seriesTable(data);
  table.hidden = true;
  const btn = h('button.link.tiny', { type: 'button', onclick: () => {
    table.hidden = !table.hidden; chart.hidden = !table.hidden;
    btn.textContent = table.hidden ? t('Show as table') : t('Show as chart');
  } }, t('Show as table'));
  return h('div.chart-wrap', chart, table, h('div.chart-foot', btn));
}
