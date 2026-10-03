// "Use" screens: home, record lists, create/edit forms, record detail, print.
import { h, toast, confirmDialog, debounce, $ } from '../ui/dom.js';
import { t } from '../i18n.js';
import { buildForm } from '../ui/form.js';
import { pageHeader, pill, emptyState, sendCard } from '../ui/bits.js';
import { buildDocument, paymentQr } from '../print.js';
import { formatValue, fieldOf, recordTitle, isBlank, makeScope, newRow, fmtDate, defaultsFor } from '../schema.js';
import { tryEvaluate, isTruthy, toNum, todayStr } from '../formula.js';
import { widgetCard } from './reports.js';
import { openImport, exportCsv } from './importer.js';

// ---- shared cell renderer ----------------------------------------------------------------------
export function valueNode(store, f, v, { rec } = {}) {
  if (f.type === 'checkbox') return h('span', v ? '✓' : '—');
  if (isBlank(v)) return h('span.muted', '—');
  if (f.colors || (f.type === 'select' && f.colors)) return pill(String(v), f.colors[v] || 'muted');
  if (f.type === 'phone') return h('a', { href: `tel:${String(v).replace(/[^\d+]/g, '')}` }, String(v));
  return h('span', formatValue(f, v, store.ctx()));
}

// ---- home --------------------------------------------------------------------------------------
export function homeView(ctx) {
  const { store } = ctx;
  const el = h('div.home');
  const paint = () => {
    el.replaceChildren();
    const quick = store.app.tables.filter((x) => x.quick);
    const pendingMsgs = store.listOutbox((o) => o.status === 'pending' && o.channel !== 'webhook' && o.channel !== 'inapp').length;
    const alerts = store.listOutbox((o) => o.status === 'pending' && o.channel === 'inapp').length;
    const approvals = store.pendingApprovals().length;
    const today = todayStr();
    const tasksTbl = store.table('tasks');
    const tasksDue = tasksTbl ? store.records('tasks').filter((r) => !r.data.done && r.data.due && r.data.due <= today).length : 0;
    const dash = store.app.dashboards?.find((d) => !d.ownerOnly || ctx.role === 'owner');
    const kpis = dash?.widgets.filter((w) => w.type === 'kpi') || [];

    el.append(
      h('div.hello', h('h1', store.business.name || store.app.name), h('div.muted', fmtDate(today))),
      quick.length ? h('div.quick-actions', quick.map((q) => h('a.big-btn', { href: `#/t/${q.id}/new` }, h('span.ic', q.icon || '＋'), h('span', `＋ ${q.name}`)))) : null,
      kpis.length ? h('div.kpi-row', kpis.map((w) => widgetCard(store, w, { compact: true }))) : null,
      h('div.attention',
        attn('💬', t('Messages to send'), pendingMsgs, '#/outbox', 'messages'),
        attn('🔔', t('Alerts'), alerts, '#/outbox/alerts', 'alerts'),
        attn('🖊️', t('Waiting for your approval'), approvals, '#/outbox/approvals', 'approvals'),
        tasksTbl ? attn('✅', t('Tasks due'), tasksDue, '#/t/tasks', 'tasks') : null),
      quick.length ? recent(store, quick) : null,
      !store.app.tables.length ? emptyState('🧱', t('Nothing here yet'), t('Open the App builder to create your first table.'), h('a.btn.primary', { href: '#/build' }, t('App builder'))) : null,
    );
  };
  paint();
  ctx.watch(debounce(paint, 60));
  return el;
}
const attn = (icon, label, n, href, key) => h('a.attn-card', { href, class: n ? 'has' : '', dataset: { key } }, h('span.ic', icon), h('span.n', String(n)), h('span.l', label));

function recent(store, tables) {
  const rows = tables.flatMap((tb) => store.records(tb.id).map((r) => ({ tb, r })))
    .sort((a, b) => (a.r.updated < b.r.updated ? 1 : -1)).slice(0, 6);
  if (!rows.length) return null;
  return h('section.card', h('h3', t('Recent')),
    h('ul.recent', rows.map(({ tb, r }) => h('li', h('a', { href: `#/t/${tb.id}/${r.id}` },
      h('span.ic', tb.icon || ''), h('b', recordTitle(tb, r)),
      tb.statusField ? valueNode(store, fieldOf(tb, tb.statusField), r.data[tb.statusField]) : null,
      tb.fields.find((f) => f.id === 'total') ? h('span.amt', formatValue(fieldOf(tb, 'total'), r.data.total, store.ctx())) : null)))));
}

// ---- list --------------------------------------------------------------------------------------
export function listView(ctx, tableId) {
  const { store } = ctx;
  const table = store.table(tableId);
  if (!table) return emptyState('❓', t('Not found'), '', h('a.btn', { href: '#/' }, t('Home')));
  const cols = (table.listColumns?.length ? table.listColumns : table.fields.slice(0, 4).map((f) => f.id)).map((id) => fieldOf(table, id)).filter(Boolean);
  const st = { q: '', status: '', sort: table.sort?.field || '', dir: table.sort?.dir || 'desc', limit: 50 };
  const sf = table.statusField ? fieldOf(table, table.statusField) : null;
  const ctx2 = store.ctx();

  const search = h('input.search', { type: 'search', placeholder: t('Search…'), 'aria-label': t('Search'), oninput: debounce((e) => { st.q = e.target.value; st.limit = 50; paintBody(); }, 120) });
  const chips = h('div.chips');
  const body = h('div.list-body');
  const el = h('div.list',
    pageHeader(`${table.icon || ''} ${table.name}`,
      h('a.btn.primary', { href: `#/t/${tableId}/new` }, `＋ ${t('New')}`),
      ctx.role === 'owner' ? h('button.btn', { onclick: () => openImport(store, table, () => paintBody()) }, t('Import')) : null,
      ctx.role === 'owner' ? h('button.btn', { onclick: () => exportCsv(store, table) }, t('Export')) : null),
    h('div.toolbar', search, chips), body);

  const sortVal = (r, fid) => {
    if (!fid) return r.created;
    const f = fieldOf(table, fid); const v = r.data[fid];
    if (f?.type === 'number' || f?.type === 'money') return toNum(v);
    if (f?.type === 'lookup') return formatValue(f, v, ctx2);
    return String(v ?? '');
  };
  function filtered() {
    const q = st.q.trim().toLowerCase();
    let rows = store.records(tableId);
    if (st.status) rows = rows.filter((r) => r.data[sf.id] === st.status);
    if (q) {
      rows = rows.filter((r) => [...new Set([...(table.searchFields || []), ...cols.map((c) => c.id)])]
        .some((fid) => { const f = fieldOf(table, fid); return f && formatValue(f, r.data[fid], ctx2).toLowerCase().includes(q); }));
    }
    rows.sort((a, b) => {
      const x = sortVal(a, st.sort), y = sortVal(b, st.sort);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return (st.dir === 'asc' ? c : -c) || (a.created < b.created ? 1 : -1);
    });
    return rows;
  }
  function paintChips() {
    chips.replaceChildren();
    if (!sf?.options?.length) return;
    const all = store.records(tableId);
    const mk = (val, label) => h('button', { class: `chip${st.status === val ? ' on' : ''}`, onclick: () => { st.status = val; paintChips(); paintBody(); } },
      label, h('span.count', String(val ? all.filter((r) => r.data[sf.id] === val).length : all.length)));
    chips.append(mk('', t('All')), sf.options.map((o) => mk(o, o)));
  }
  function paintBody() {
    const rows = filtered();
    body.replaceChildren();
    if (!store.count(tableId)) {
      body.append(emptyState(table.icon || '📄', t('No records yet'), t('Add your first one to get started.'), h('a.btn.primary', { href: `#/t/${tableId}/new` }, `＋ ${t('New')}`)));
      return;
    }
    if (!rows.length) { body.append(h('p.muted.center', t('Nothing matches your search.'))); return; }
    const head = h('tr', cols.map((c) => h('th', { class: c.type === 'money' || c.type === 'number' ? 'num' : '', 'aria-sort': st.sort === c.id ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h('button.th-btn', { onclick: () => { st.dir = st.sort === c.id && st.dir === 'asc' ? 'desc' : 'asc'; st.sort = c.id; paintBody(); } }, c.label, st.sort === c.id ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''))));
    const tb = h('tbody', rows.slice(0, st.limit).map((r) => {
      const go = () => { location.hash = `#/t/${tableId}/${r.id}`; };
      return h('tr.row', { tabindex: 0, onclick: (e) => { if (!e.target.closest('a,input,button')) go(); }, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) go(); } },
        cols.map((c) => h('td', { class: c.type === 'money' || c.type === 'number' ? 'num' : '', dataset: { label: c.label } },
          c.type === 'checkbox'
            ? h('input', { type: 'checkbox', checked: !!r.data[c.id], 'aria-label': c.label, onchange: (e) => store.patchRecord(tableId, r.id, { [c.id]: e.target.checked }) })
            : valueNode(store, c, r.data[c.id]))));
    }));
    body.append(h('div.table-wrap', h('table.data', h('thead', head), tb)),
      h('div.list-foot', h('span.muted', t('{n} records', { n: rows.length })),
        rows.length > st.limit ? h('button.btn.small', { onclick: () => { st.limit += 100; paintBody(); } }, t('Show more')) : null));
  }
  paintChips(); paintBody();
  ctx.watch((e) => { if (e.type === 'record' && e.table !== tableId) return; paintChips(); paintBody(); });
  return el;
}

// ---- create / edit -------------------------------------------------------------------------------
export function formView(ctx, tableId, id) {
  const { store } = ctx;
  const table = store.table(tableId);
  const rec = id ? store.getRecord(tableId, id) : null;
  if (!table || (id && !rec)) return emptyState('❓', t('Not found'), '', h('a.btn', { href: '#/' }, t('Home')));
  const back = id ? `#/t/${tableId}/${id}` : `#/t/${tableId}`;
  let form;
  const el = h('div.form-page',
    pageHeader(id ? `${t('Edit')} ${recordTitle(table, rec)}` : `${t('New')}: ${table.name}`, h('a.btn.ghost', { href: back }, t('Back'))));
  form = buildForm({
    store, table, record: rec, initial: rec ? {} : defaultsFor(table, store),
    onSaved: (saved, after) => {
      location.hash = after === 'print' ? `#/t/${tableId}/${saved.id}/print?auto=1` : `#/t/${tableId}/${saved.id}?done=1`;
    },
    onCancel: () => { location.hash = back; },
  });
  el.append(form.el);
  queueMicrotask(() => form.focus());   // runs right after the router attaches the page; a timer could steal focus from someone already typing
  return { el, destroy: () => form.destroy() };
}

// ---- record detail ----------------------------------------------------------------------------------
function runAction(store, table, rec, a) {
  if (a.type === 'add_line') {
    const lf = fieldOf(table, a.field);
    const scope = makeScope(table, rec.data, store.ctx());
    const row = newRow(lf);
    for (const [k, v] of Object.entries(a.values || {})) row[k] = typeof v === 'string' && v.startsWith('=') ? tryEvaluate(v.slice(1), scope, null) : v;
    return store.patchRecord(table.id, rec.id, { [a.field]: [...(rec.data[a.field] || []), row] });
  }
  if (a.type === 'set_field') return store.patchRecord(table.id, rec.id, { [a.field]: a.value });
  return Promise.resolve({ ok: false });
}

export function recordView(ctx, tableId, id, query) {
  const { store } = ctx;
  const table = store.table(tableId);
  const el = h('div.record');
  const paint = () => {
    el.replaceChildren();
    const rec = store.getRecord(tableId, id);
    if (!table || !rec) { el.append(emptyState('🗑️', t('This record is not available'), '', h('a.btn', { href: `#/t/${tableId}` }, t('Back to list')))); return; }
    const d = rec.data;
    const scope = makeScope(table, d, store.ctx());
    const sf = table.statusField ? fieldOf(table, table.statusField) : null;
    const actions = (table.recordActions || []).filter((a) => !a.showIf || isTruthy(tryEvaluate(a.showIf, scope, false)));
    const msgs = store.pendingFor(tableId, id);
    const qr = paymentQr(store, table, rec, 168);

    el.append(pageHeader(`${table.icon || ''} ${recordTitle(table, rec)}`,
      sf ? valueNode(store, sf, d[sf.id]) : null,
      h('a.btn.ghost', { href: `#/t/${tableId}` }, t('Back')),
      h('a.btn', { href: `#/t/${tableId}/${id}/edit` }, t('Edit')),
      table.print ? h('a.btn', { href: `#/t/${tableId}/${id}/print` }, `🖨️ ${t('Print / share')}`) : null,
      ctx.role === 'owner' ? h('button.btn.danger', { onclick: async () => {
        if (!(await confirmDialog(t('Delete this record?'), { yes: t('Delete'), danger: true }))) return;
        await store.deleteRecord(tableId, id);
        location.hash = `#/t/${tableId}`;
        toast(t('Deleted.'), { action: { label: t('Undo'), fn: () => store.restoreRecord(tableId, id) }, ms: 9000 });
      } }, t('Delete')) : null));

    if (rec.approval) {
      const a = rec.approval;
      el.append(h('div.banner', { class: a.status === 'pending' ? 'warn' : a.status === 'approved' ? 'ok' : 'error' },
        h('b', a.status === 'pending' ? `🖊️ ${t('Waiting for approval')}` : a.status === 'approved' ? `✓ ${t('Approved')}` : `✕ ${t('Rejected')}`), ` — ${a.note || a.ruleName || ''}`,
        a.status === 'pending' && ctx.role === 'owner' ? h('span.banner-actions',
          h('button.btn.small.primary', { onclick: () => store.decideApproval(tableId, id, 'approved', ctx.userName) }, t('Approve')),
          h('button.btn.small', { onclick: () => store.decideApproval(tableId, id, 'rejected', ctx.userName) }, t('Reject'))) : null));
    }

    // what to do next: collect money, send the message, print
    if (query.done || msgs.length || actions.length) {
      const nextBtns = h('div.next-actions',
        table.print ? h('a.btn', { href: `#/t/${tableId}/${id}/print` }, `🖨️ ${t('Print / share')}`) : null,
        h('a.btn', { href: `#/t/${tableId}/new` }, `＋ ${t('New')}`));
      el.append(h('section.card.next',
        query.done ? h('h3', `✓ ${t('Saved')}`) : h('h3', t('Next steps')),
        h('div.next-grid',
          h('div',
            actions.length ? h('div.next-actions', h('div.hint', t('Record what the customer gave you:')), actions.map((a) => h('button.btn', { onclick: async () => {
              const r = await runAction(store, table, rec, a);
              if (r && r.blocked) toast(r.blocked, { kind: 'warn' });
            } }, a.label))) : null,
            msgs.length ? h('div.next-msgs', msgs.map((m) => sendCard(store, m, {}))) : null, nextBtns),
          qr ? h('div.qr-card', h('div.qr', qr.svg), h('b', `${t('Scan to pay')} ${formatValue({ type: 'money' }, qr.amount)}`), h('div.muted', qr.vpa)) : null)));
    }

    const plain = table.fields.filter((f) => f.type !== 'lines');
    el.append(h('section.card', h('dl.details', plain.map((f) => h('div', h('dt', f.label), h('dd', valueNode(store, f, d[f.id], { rec })))))));
    for (const f of table.fields.filter((x) => x.type === 'lines')) {
      const cols = f.columns.filter((c) => !c.hidden);
      if (!(d[f.id] || []).length) continue;
      el.append(h('section.card', h('h3', f.label), h('div.table-wrap', h('table.data',
        h('thead', h('tr', h('th', '#'), cols.map((c) => h('th', { class: c.type === 'money' || c.type === 'number' ? 'num' : '' }, c.label)))),
        h('tbody', d[f.id].map((r, i) => h('tr', h('td', String(i + 1)), cols.map((c) => h('td', { class: c.type === 'money' || c.type === 'number' ? 'num' : '', dataset: { label: c.label } }, valueNode(store, c, r[c.id]))))))))));
    }
  };
  paint();
  ctx.watch((e) => { if (e.type === 'record' && e.id !== id && e.table !== tableId) return; paint(); });
  return el;
}

// ---- print -----------------------------------------------------------------------------------------------
export function printView(ctx, tableId, id, query) {
  const { store } = ctx;
  const table = store.table(tableId);
  const rec = store.getRecord(tableId, id);
  if (!table || !rec) return emptyState('❓', t('Not found'), '');
  let paper = localStorage.getItem('paper') || 'a4';
  const docHost = h('div.doc-host');
  const paintDoc = () => { docHost.replaceChildren(buildDocument(store, table, store.getRecord(tableId, id) || rec, { paper })); };
  const sel = h('select', { 'aria-label': t('Paper size'), onchange: (e) => { paper = e.target.value; localStorage.setItem('paper', paper); paintDoc(); } },
    h('option', { value: 'a4' }, 'A4'), h('option', { value: 'thermal' }, t('Receipt (80 mm)')));
  sel.value = paper;
  const msgHost = h('div.no-print');
  const paintMsgs = () => {
    msgHost.replaceChildren();
    const msgs = store.pendingFor(tableId, id);
    if (msgs.length) msgHost.append(h('h3', t('Send to the customer')), msgs.map((m) => sendCard(store, m, {})));
  };
  const el = h('div.print-page',
    h('div.toolbar.no-print',
      h('a.btn.ghost', { href: `#/t/${tableId}/${id}` }, `← ${t('Back')}`),
      h('button.btn.primary', { onclick: () => window.print() }, `🖨️ ${t('Print')}`), sel,
      h('span.hint', t('Tip: choose “Save as PDF” in the print window to share a PDF.'))),
    msgHost, docHost);
  paintDoc(); paintMsgs();
  ctx.watch(() => { paintDoc(); paintMsgs(); });
  if (query.auto) setTimeout(() => $('.doc') && window.print(), 350);
  return el;
}
