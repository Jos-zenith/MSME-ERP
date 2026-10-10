// Dashboard builder: pick a table, a measure and a chart; see it update live.
import { h, toast, confirmDialog, promptDialog, debounce } from '../ui/dom.js';
import { t } from '../i18n.js';
import { icon } from '../ui/icons.js';
import { pageHeader, emptyState, labeled, pill } from '../ui/bits.js';
import { conditionsEditor } from '../ui/conditions.js';
import { widgetCard } from './reports.js';
import { PERIODS, MEASURES } from '../analytics.js';
import { uid, fieldOf } from '../schema.js';

const TYPE_LABEL = () => ({ kpi: t('Number'), bar: t('Chart'), list: t('List') });
const PERIOD_LABEL = () => ({ today: t('Today'), '7d': t('Last 7 days'), '30d': t('Last 30 days'), month: t('This month'), year: t('This year'), all: t('All time') });
const MEASURE_LABEL = () => ({ count: t('Count of records'), sum: t('Total (sum)'), avg: t('Average'), min: t('Smallest'), max: t('Largest') });

export function dashList(ctx) {
  const { store } = ctx;
  const host = h('div');
  const paint = () => {
    host.replaceChildren();
    const boards = store.app.dashboards ||= [];
    host.append(h('div.row', h('button.btn.primary', { onclick: async () => {
      const name = await promptDialog(t('Name of the new dashboard'), t('Overview'));
      if (!name?.trim()) return;
      const d = { id: uid(), name: name.trim(), ownerOnly: true, widgets: [] };
      boards.push(d); store.touchApp(); location.hash = `#/build/d/${d.id}`;
    } }, `＋ ${t('New dashboard')}`)));
    if (!boards.length) host.append(emptyState('📊', t('No dashboards yet'), t('A dashboard shows the numbers you care about: sales today, pending payments, low stock…')));
    boards.forEach((d) => host.append(h('div.card.rule',
      h('div.rule-head', h('b', d.name), d.ownerOnly ? pill(t('owner only'), 'muted') : null, h('span.spacer'),
        h('a.btn.small', { href: `#/reports/${d.id}` }, t('View')), h('a.btn.small', { href: `#/build/d/${d.id}` }, t('Edit')),
        h('button.btn.small.danger', { onclick: async () => { if (await confirmDialog(t('Delete this dashboard?'), { yes: t('Delete'), danger: true })) { boards.splice(boards.indexOf(d), 1); store.touchApp(); paint(); } } }, t('Delete'))),
      h('p.muted', `${d.widgets.length} ${t('widgets')}`))));
  };
  paint();
  return host;
}

export function dashEditor(ctx, id) {
  const { store } = ctx;
  const board = (store.app.dashboards || []).find((d) => d.id === id);
  if (!board) return emptyState('❓', t('Not found'), '', h('a.btn', { href: '#/build/dashboards' }, t('Back')));
  let sel = board.widgets[0]?.id || null;
  const save = debounce(() => store.touchApp(), 250);
  const listEl = h('div.wlist'), panel = h('aside.panel'), preview = h('div.wpreview');

  // the table as widgets see it: with a line-items source, the line columns become fields
  function rowTable(w) {
    const table = store.table(w.table);
    if (!table) return null;
    if (!w.lines) return table;
    const lf = fieldOf(table, w.lines);
    return { ...table, fields: [...table.fields.filter((f) => f.type !== 'lines'), ...(lf?.columns || [])] };
  }

  function addWidget(type) {
    const tb = store.app.tables[0];
    if (!tb) { toast(t('Create a table first.'), { kind: 'warn' }); return; }
    const w = { id: uid(), type, title: TYPE_LABEL()[type], table: tb.id, period: 'all', measure: { op: 'count' }, span: type === 'kpi' ? 1 : 2, conditions: [], match: 'all' };
    if (type === 'list') Object.assign(w, { limit: 6, fields: (tb.listColumns || []).slice(0, 3) });
    if (type === 'bar') w.group = { field: tb.fields.find((f) => ['select', 'lookup', 'date'].includes(f.type))?.id || tb.titleField };
    board.widgets.push(w); sel = w.id; save(); paint();
  }

  function paintList() {
    listEl.replaceChildren();
    board.widgets.forEach((w, i) => listEl.append(h('div.fcard', { class: w.id === sel ? 'sel' : '', tabindex: 0, onclick: () => { sel = w.id; paint(); }, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { sel = w.id; paint(); } } },
      h('div.fmain', h('b', w.title), h('span.muted', ` ${TYPE_LABEL()[w.type]} · ${store.table(w.table)?.name || '?'}`)),
      h('div.fbtns',
        h('button.icon-btn', { 'aria-label': t('Move up'), onclick: (e) => { e.stopPropagation(); if (i > 0) { board.widgets.splice(i - 1, 0, board.widgets.splice(i, 1)[0]); save(); paint(); } } }, '▲'),
        h('button.icon-btn', { 'aria-label': t('Move down'), onclick: (e) => { e.stopPropagation(); if (i < board.widgets.length - 1) { board.widgets.splice(i + 1, 0, board.widgets.splice(i, 1)[0]); save(); paint(); } } }, '▼'),
        h('button.icon-btn', { 'aria-label': t('Remove'), onclick: (e) => { e.stopPropagation(); board.widgets.splice(i, 1); if (sel === w.id) sel = board.widgets[0]?.id || null; save(); paint(); } }, '🗑')))));
    listEl.append(h('div.row', ['kpi', 'bar', 'list'].map((ty) => h('button.btn.small', { onclick: () => addWidget(ty) }, `＋ ${TYPE_LABEL()[ty]}`))));
  }

  function paintPreview() {
    preview.replaceChildren();
    const w = board.widgets.find((x) => x.id === sel);
    if (w) preview.append(h('div.hint', t('Preview')), widgetCard(store, w));
  }
  const refreshPreview = debounce(paintPreview, 120);
  const changed = () => { save(); refreshPreview(); paintList(); };

  function paintPanel() {
    panel.replaceChildren();
    const w = board.widgets.find((x) => x.id === sel);
    if (!w) { panel.append(h('p.muted', t('Add a widget to begin.'))); return; }
    const table = store.table(w.table);
    const rt = rowTable(w);
    const numeric = rt.fields.filter((f) => (f.type === 'number' || f.type === 'money'));
    const groupable = [...rt.fields.filter((f) => ['select', 'lookup', 'date', 'text'].includes(f.type)), { id: '_created', label: t('Date created'), type: 'date' }];
    const dateFields = [...rt.fields.filter((f) => f.type === 'date'), { id: '_created', label: t('Date created'), type: 'date' }];
    const sel_ = (opts, cur, on, label) => h('select', { 'aria-label': label, onchange: (e) => on(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));

    panel.append(
      labeled(t('Title'), h('input', { value: w.title, oninput: (e) => { w.title = e.target.value; changed(); } })),
      h('div.two',
        labeled(t('Show as'), sel_(Object.entries(TYPE_LABEL()), w.type, (v) => { w.type = v; if (v === 'bar' && !w.group) w.group = { field: groupable[0].id }; changed(); paintPanel(); }, t('Show as'))),
        labeled(t('Table'), sel_(store.app.tables.map((x) => [x.id, x.name]), w.table, (v) => { w.table = v; delete w.lines; w.measure = { op: 'count' }; w.conditions = []; w.group = undefined; w.fields = []; changed(); paintPanel(); }, t('Table')))));

    const lineFields = table.fields.filter((f) => f.type === 'lines');
    if (w.type !== 'list' && lineFields.length) {
      panel.append(labeled(t('Count'), sel_([['', t('whole records')], ...lineFields.map((f) => [f.id, `${t('line items')}: ${f.label}`])], w.lines || '', (v) => { if (v) w.lines = v; else delete w.lines; w.measure = { op: 'count' }; w.group = undefined; changed(); paintPanel(); }, t('Count'))));
    }
    if (w.type !== 'list') {
      panel.append(h('div.two',
        labeled(t('Calculate'), sel_(MEASURE_LABEL() && MEASURES.map((m) => [m, MEASURE_LABEL()[m]]), w.measure?.op || 'count', (v) => { w.measure = { op: v, field: v === 'count' ? undefined : (w.measure?.field || numeric[0]?.id) }; changed(); paintPanel(); }, t('Calculate'))),
        w.measure?.op && w.measure.op !== 'count' ? labeled(t('of'), sel_(numeric.map((f) => [f.id, f.label]), w.measure.field, (v) => { w.measure.field = v; changed(); }, t('of'))) : null));
    }
    if (w.type === 'bar') {
      w.group ||= { field: groupable[0].id };
      const gf = groupable.find((f) => f.id === w.group.field);
      panel.append(h('div.two',
        labeled(t('Group by'), sel_(groupable.map((f) => [f.id, f.label]), w.group.field, (v) => { w.group.field = v; changed(); paintPanel(); }, t('Group by'))),
        gf?.type === 'date' ? labeled(t('per'), sel_([['day', t('day')], ['month', t('month')]], w.group.by || 'day', (v) => { w.group.by = v; changed(); }, t('per'))) : labeled(t('Show top'), h('input', { type: 'number', min: 1, value: w.limit || 8, oninput: (e) => { w.limit = +e.target.value || 8; changed(); } }))));
    }
    if (w.type === 'list') {
      panel.append(
        h('div.two', labeled(t('Sort by'), sel_([['', t('Newest first')], ...rt.fields.filter((f) => f.type !== 'lines').map((f) => [f.id, f.label])], w.sortField || '', (v) => { w.sortField = v || undefined; changed(); }, t('Sort by'))),
          labeled(t('Order'), sel_([['asc', t('Low → high')], ['desc', t('High → low')]], w.sort || 'asc', (v) => { w.sort = v; changed(); }, t('Order')))),
        labeled(t('How many rows'), h('input', { type: 'number', min: 1, max: 20, value: w.limit || 6, oninput: (e) => { w.limit = +e.target.value || 6; changed(); } })),
        h('div.section', h('h4', t('Columns to show')), h('div.checklist', table.fields.filter((f) => f.type !== 'lines').map((f) => h('label.check', h('input', { type: 'checkbox', checked: (w.fields || []).includes(f.id), onchange: (e) => { const s = new Set(w.fields || []); e.target.checked ? s.add(f.id) : s.delete(f.id); w.fields = table.fields.map((x) => x.id).filter((x) => s.has(x)).slice(0, 4); changed(); } }), ` ${f.label}`)))));
    } else {
      panel.append(h('div.two',
        labeled(t('Time period'), sel_(PERIODS.map((p) => [p, PERIOD_LABEL()[p]]), w.period || 'all', (v) => { w.period = v; changed(); }, t('Time period'))),
        w.period && w.period !== 'all' ? labeled(t('Using the date in'), sel_(dateFields.map((f) => [f.id, f.label]), w.dateField || dateFields[0].id, (v) => { w.dateField = v; changed(); }, t('Using the date in'))) : null));
    }
    panel.append(h('div.section', h('h4', t('Only include (optional)')), conditionsEditor(store, rt, w, changed)));
    if (w.type !== 'kpi') panel.append(labeled(t('Width'), sel_([['1', t('Half')], ['2', t('Full')]], String(w.span || 1), (v) => { w.span = +v; changed(); }, t('Width'))));
  }

  function paint() { paintList(); paintPanel(); paintPreview(); }
  paint();
  return h('div.designer',
    pageHeader(board.name, h('a.btn.ghost', { href: '#/build/dashboards' }, icon('back', { size: 16 }), t('All dashboards')), h('a.btn', { href: `#/reports/${board.id}` }, t('View'))),
    h('div.row', labeled(t('Dashboard name'), h('input', { value: board.name, oninput: (e) => { board.name = e.target.value; save(); } })),
      h('label.check', h('input', { type: 'checkbox', checked: !!board.ownerOnly, onchange: (e) => { board.ownerOnly = e.target.checked; save(); } }), ` ${t('Only the owner can see this')}`)),
    h('div.layout-2', h('div.design', h('h3', t('Widgets')), listEl, preview), panel));
}
