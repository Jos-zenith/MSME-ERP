// Dashboards: KPI tiles, charts and short lists that refresh as records change.
import { h, debounce } from '../ui/dom.js';
import { t } from '../i18n.js';
import { widgetData } from '../analytics.js';
import { chartWithTable, fmtByType } from '../ui/charts.js';
import { pageHeader, emptyState, tabs } from '../ui/bits.js';
import { fieldOf, recordTitle } from '../schema.js';
import { valueNode } from './data.js';

export function widgetCard(store, w, { compact = false } = {}) {
  const data = widgetData(w, store);
  if (data.error) return h('section.card.widget.err', h('h3', w.title), h('p.muted', t('This widget points to a table that no longer exists.')));
  const span = w.span === 2 && !compact ? ' span-2' : '';
  if (data.kind === 'kpi') {
    return h('section.card.kpi', { class: span.trim(), 'aria-label': w.title },
      h('div.kpi-label', w.title), h('div.kpi-value', fmtByType(data.fmt, data.value)));
  }
  if (data.kind === 'series') {
    return h('section.card.widget', { class: span.trim() }, h('h3', w.title),
      data.series.length && data.series.some((s) => s.value) ? chartWithTable(data, w.title) : h('p.muted', t('No data for this period yet.')));
  }
  const table = data.table;
  const cols = (w.fields?.length ? w.fields : (table.listColumns || []).slice(0, 3)).map((id) => fieldOf(table, id)).filter(Boolean);
  return h('section.card.widget', { class: span.trim() }, h('h3', w.title),
    data.rows.length ? h('ul.mini-list', data.rows.map((r) => h('li', h('a', { href: `#/t/${table.id}/${r.id}` },
      cols.map((c, i) => h(i === 0 ? 'b' : 'span', valueNode(store, c, r.data[c.id])))))))
      : h('p.muted', t('Nothing to show — all good.')),
    data.total > data.rows.length ? h('a.link.tiny', { href: `#/t/${table.id}` }, t('See all {n}', { n: data.total })) : null);
}

export function dashboardsView(ctx, id) {
  const { store } = ctx;
  const boards = (store.app.dashboards || []).filter((d) => !d.ownerOnly || ctx.role === 'owner');
  if (!boards.length) {
    return emptyState('📊', t('No reports yet'), t('Create a dashboard to see sales, pending payments and more at a glance.'),
      ctx.role === 'owner' ? h('a.btn.primary', { href: '#/build' }, t('App builder')) : null);
  }
  const board = boards.find((b) => b.id === id) || boards[0];
  const grid = h('div.widgets');
  const paint = () => { grid.replaceChildren(...board.widgets.map((w) => widgetCard(store, w))); };
  paint();
  ctx.watch(debounce(paint, 80));
  return h('div.reports',
    pageHeader(board.name, ctx.role === 'owner' ? h('a.btn', { href: `#/build/d/${board.id}` }, `✎ ${t('Edit dashboard')}`) : null),
    boards.length > 1 ? tabs(boards.map((b) => ({ id: b.id, label: b.name })), board.id, (bid) => { location.hash = `#/reports/${bid}`; }) : null,
    grid);
}
export { recordTitle };
