// "Use" screens: home, record lists, create/edit forms, record detail, print.
import { h, toast, confirmDialog, debounce, $ } from '../ui/dom.js';
import { t } from '../i18n.js';
import { buildForm } from '../ui/form.js';
import { pageHeader, pill, emptyState, sendCard, remindButton } from '../ui/bits.js';
import { buildDocument, paymentQr } from '../print.js';
import { formatValue, fieldOf, recordTitle, isBlank, makeScope, newRow, fmtDate, defaultsFor, repeatData, hooksFor } from '../schema.js';
import { tryEvaluate, isTruthy, toNum, todayStr } from '../formula.js';
import { widgetCard } from './reports.js';
import { openImport, exportCsv } from './importer.js';
import { gstHomeCard } from '../../gst/js/ui.js';
import { icon, iconFor } from '../ui/icons.js';
import { posTable } from './pos.js';
import { collectOn } from '../collect.js';
import { paymentsAttention } from './payments.js';

// ---- who may do what: owner always; staff per table (`staff: 'full' | 'view' | 'none'`) ------------------------
export const canSee = (ctx, table) => ctx.role === 'owner' || (table?.staff || 'full') !== 'none';
export const canEdit = (ctx, table) => ctx.role === 'owner' || (table?.staff || 'full') === 'full';
const ownerOnlyPage = () => emptyState('🔒', t('Only the owner can open this'), '', h('a.btn', { href: '#/' }, t('Home')));

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
    const quick = store.app.tables.filter((x) => x.quick && canEdit(ctx, x));
    const pendingMsgs = store.listOutbox((o) => o.status === 'pending' && o.channel !== 'webhook' && o.channel !== 'inapp').length;
    const alerts = store.listOutbox((o) => o.status === 'pending' && o.channel === 'inapp').length;
    const approvals = store.pendingApprovals().length;
    const today = todayStr();
    const tasksTbl = store.table('tasks');
    const tasksDue = tasksTbl ? store.records('tasks').filter((r) => !r.data.done && r.data.due && r.data.due <= today).length : 0;
    const dash = store.app.dashboards?.find((d) => !d.ownerOnly || ctx.role === 'owner');
    const kpis = dash?.widgets.filter((w) => w.type === 'kpi') || [];

    const chart = dash?.widgets.find((w) => w.type === 'bar' && w.group?.by === 'day');
    const [main, ...others] = quick;
    const pos = posTable(store);

    el.append(
      // header: what this screen is, and THE action of the screen (N opens it from anywhere)
      h('div.page-head.home-head',
        h('div.page-title', h('h1', t('Dashboard')), h('div.page-sub', `${store.business.name || store.app.name} · ${fmtDate(today)}`)),
        h('div.page-actions',
          (pos ? quick : others).map((q) => h('a.btn', { href: `#/t/${q.id}/new` }, icon('plus', { size: 16 }), q.newLabel || q.name)),
          pos ? h('a.big-btn.primary', { href: '#/pos' }, icon('scan', { size: 18 }), h('span', t('Open billing counter')), h('kbd', { title: t('Press N from anywhere') }, 'N'))
            : main ? h('a.big-btn.primary', { href: `#/t/${main.id}/new` }, icon('plus', { size: 18 }), h('span', `${t('New')}: ${main.newLabel || main.name}`),
              h('kbd', { title: t('Press N from anywhere') }, 'N')) : null)),
      kpis.length ? h('section.kpi-strip', { 'aria-label': t('Today') }, kpis.map((w) => widgetCard(store, w, { compact: true }))) : null,
      h('div.home-grid',
        h('div.home-main',
          main ? receivables(store, main) : null,
          quick.length ? recent(store, quick) : null,
          chart ? widgetCard(store, chart) : null),
        h('aside.home-side',
          h('section.card.attention', h('div.card-head', h('h3', t('Needs attention'))),
            attn('message', t('Messages to send'), pendingMsgs, '#/outbox', 'messages'),
            attn('alert', t('Alerts'), alerts, '#/outbox/alerts', 'alerts'),
            attn('pen', t('Waiting for your approval'), approvals, '#/outbox/approvals', 'approvals'),
            tasksTbl ? attn('tasks', t('Tasks due'), tasksDue, '#/t/tasks', 'tasks') : null,
            collectOn(store) ? attn('wallet', t('Payments to check'), paymentsAttention(store), '#/outbox/payments', 'payments') : null,
            conflictsAttn(store)),
          ctx.role === 'owner' ? gstHomeCard(store) : null)),
      !store.app.tables.length ? emptyState('🧱', t('Nothing here yet'), t('Open the App builder to create your first table.'), h('a.btn.primary', { href: '#/build' }, t('App builder'))) : null,
    );
  };
  paint();
  ctx.watch(debounce(paint, 60));
  return el;
}
/** Records changed on two devices at once that the owner has not checked yet (the first one opens). */
function conflictsAttn(store) {
  const list = store.conflicted();
  if (!list.length) return null;
  return attn('alert', t('Changed on two devices'), list.length, `#/t/${list[0].table}/${list[0].id}`, 'conflicts');
}
const attn = (ic, label, n, href, key) => h('a.attn-card', { href, class: n ? 'has' : '', dataset: { key } }, icon(ic), h('span.l', label), h('span.n', String(n)), icon('chevron', { size: 16 }));

/** Receivables at a glance (unpaid money, current vs overdue), for a table that keeps a balance. */
function receivables(store, tb) {
  if (!tb.fields.some((f) => f.id === 'balance')) return null;
  const today = todayStr();
  const money = fieldOf(tb, 'balance');
  const open = store.records(tb.id).filter((r) => toNum(r.data.balance) > 0);
  const total = open.reduce((s, r) => s + toNum(r.data.balance), 0);
  const overdue = open.filter((r) => r.data.due_date && r.data.due_date < today).reduce((s, r) => s + toNum(r.data.balance), 0);
  const fmt = (v) => formatValue(money, v, store.ctx());
  const pct = total ? Math.round((overdue / total) * 100) : 0;
  return h('section.card.recv',
    h('div.card-head', h('h3', t('Receivables')), h('a.link.tiny', { href: `#/t/${tb.id}` }, t('View all'))),
    h('div.recv-total', h('span.recv-lbl', t('Total unpaid')), h('b', fmt(total)), h('span.muted', t('{n} unpaid bills, all dates', { n: open.length }))),
    h('div.recv-bar', { role: 'img', 'aria-label': `${t('Current')} ${fmt(total - overdue)}, ${t('Overdue')} ${fmt(overdue)}` },
      h('span.recv-cur', { style: `width:${100 - pct}%` }), h('span.recv-over', { style: `width:${pct}%` })),
    h('div.recv-legend',
      h('span', h('i.dot.cur'), `${t('Current')} `, h('b', fmt(total - overdue))),
      h('span', h('i.dot.over'), `${t('Overdue')} `, h('b', fmt(overdue)))));
}

const partyName = (store, f, d) => { const r = f && d[f.id] ? store.getRecord(f.ref, d[f.id]) : null; const pt = r && store.table(f.ref); return r && pt ? String(r.data[pt.titleField] ?? '') : ''; };

/** The latest bills as a proper table: date, number, party, status, amount. */
function recent(store, tables) {
  const rows = tables.flatMap((tb) => store.records(tb.id).map((r) => ({ tb, r })))
    .sort((a, b) => (a.r.updated < b.r.updated ? 1 : -1)).slice(0, 6);
  if (!rows.length) return null;
  const c = store.ctx();
  return h('section.card.recent-card',
    h('div.card-head', h('h3', t('Recent transactions')), tables.length === 1 ? h('a.link.tiny', { href: `#/t/${tables[0].id}` }, t('View all')) : null),
    h('table.data.compact',
      h('thead', h('tr', h('th', t('Date')), h('th', t('Number')), h('th', t('Customer')), h('th', t('Status')), h('th.num', t('Amount')))),
      h('tbody', rows.map(({ tb, r }) => {
        const dateF = tb.fields.find((f) => f.type === 'date');
        const party = tb.fields.find((f) => f.type === 'lookup');
        const total = tb.fields.find((f) => f.id === 'total');
        const go = () => { location.hash = `#/t/${tb.id}/${r.id}`; };
        return h('tr.row', { tabindex: 0, onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } },
          h('td.muted', dateF ? fmtDate(r.data[dateF.id]) : ''),
          h('td', h('a', { href: `#/t/${tb.id}/${r.id}` }, recordTitle(tb, r))),
          h('td', partyName(store, party, r.data) || h('span.muted', t('Walk-in customer'))),
          h('td', tb.statusField ? valueNode(store, fieldOf(tb, tb.statusField), r.data[tb.statusField]) : ''),
          h('td.num', total ? formatValue(total, r.data.total, c) : ''));
      }))));
}

// ---- list --------------------------------------------------------------------------------------
export function listView(ctx, tableId) {
  const { store } = ctx;
  const table = store.table(tableId);
  if (!table) return emptyState('❓', t('Not found'), '', h('a.btn', { href: '#/' }, t('Home')));
  if (!canSee(ctx, table)) return ownerOnlyPage();
  const editable = canEdit(ctx, table);
  const cols = (table.listColumns?.length ? table.listColumns : table.fields.slice(0, 4).map((f) => f.id)).map((id) => fieldOf(table, id)).filter(Boolean);
  const st = { q: '', status: '', sort: table.sort?.field || '', dir: table.sort?.dir || 'desc', limit: 50 };
  const sf = table.statusField ? fieldOf(table, table.statusField) : null;
  const ctx2 = store.ctx();
  const canRemind = table.fields.some((f) => f.id === 'balance') && table.fields.some((f) => f.type === 'phone');

  const search = h('input.search', { type: 'search', placeholder: t('Search…'), 'aria-label': t('Search'), oninput: debounce((e) => { st.q = e.target.value; st.limit = 50; paintBody(); }, 120) });
  const chips = h('div.chips.seg');
  const body = h('div.list-body');
  const countLine = h('span');
  const el = h('div.list',
    pageHeader({ title: table.name, icon: iconFor(table.icon, { size: 20 }), sub: countLine },
      ctx.role === 'owner' ? h('button.btn', { onclick: () => openImport(store, table, () => paintBody()) }, icon('upload', { size: 16 }), t('Import')) : null,
      ctx.role === 'owner' ? h('button.btn', { onclick: () => exportCsv(store, table) }, icon('download', { size: 16 }), t('Export')) : null,
      editable ? h('a.btn.primary', { href: `#/t/${tableId}/new` }, icon('plus', { size: 16 }), t('New')) : pill(t('View only'), 'muted')),
    h('div.toolbar', h('div.search-box', icon('search', { size: 16 }), search), chips), body);

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
    countLine.textContent = t('{n} records', { n: store.count(tableId) });
    if (!store.count(tableId)) {
      body.append(emptyState(table.icon || '📄', t('No records yet'), t('Add your first one to get started.'), h('a.btn.primary', { href: `#/t/${tableId}/new` }, `＋ ${t('New')}`)));
      return;
    }
    if (!rows.length) { body.append(h('p.muted.center', t('Nothing matches your search.'))); return; }
    const head = h('tr', cols.map((c) => h('th', { class: c.type === 'money' || c.type === 'number' ? 'num' : '', 'aria-sort': st.sort === c.id ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h('button.th-btn', { onclick: () => { st.dir = st.sort === c.id && st.dir === 'asc' ? 'desc' : 'asc'; st.sort = c.id; paintBody(); } }, c.label, st.sort === c.id ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''))), canRemind ? h('th.act', h('span.sr', t('Remind'))) : null);
    const tb = h('tbody', rows.slice(0, st.limit).map((r) => {
      const go = () => { location.hash = `#/t/${tableId}/${r.id}`; };
      return h('tr.row', { tabindex: 0, onclick: (e) => { if (!e.target.closest('a,input,button')) go(); }, onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) go(); } },
        cols.map((c) => h('td', { class: c.type === 'money' || c.type === 'number' ? 'num' : '', dataset: { label: c.label } },
          c.type === 'checkbox'
            ? h('input', { type: 'checkbox', checked: !!r.data[c.id], 'aria-label': c.label, onchange: (e) => store.patchRecord(tableId, r.id, { [c.id]: e.target.checked }) })
            : valueNode(store, c, r.data[c.id]))),
        canRemind ? h('td.act', remindButton(store, tableId, r.id, { small: true })) : null);
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
  if (!canEdit(ctx, table)) return ownerOnlyPage();
  const back = id ? `#/t/${tableId}/${id}` : `#/t/${tableId}`;
  // "Repeat": a new record that starts as a copy of an earlier one (same customer and items, fresh number and date)
  const from = !id && ctx.query?.from ? store.getRecord(tableId, ctx.query.from) : null;
  // "Full form" from the billing counter: carry on with the bill already scanned there
  const draftKey = `pos-draft-${tableId}`;
  let draft = null;
  if (!id && ctx.query?.draft) { try { draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null')?.data || null; } catch { draft = null; } }
  let form;
  const el = h('div.form-page',
    pageHeader({ title: id ? `${t('Edit')} ${recordTitle(table, rec)}` : `${t('New')}: ${table.newLabel || table.name}`, icon: iconFor(table.icon, { size: 20 }), crumb: { href: `#/t/${tableId}`, label: table.name } },
      from ? pill(`↻ ${t('Copy of')} ${recordTitle(table, from)}`, 'info') : null,
      h('a.btn.ghost', { href: back }, icon('back', { size: 16 }), t('Back'))));
  form = buildForm({
    store, table, record: rec, initial: rec ? {} : { ...defaultsFor(table, store), ...(from ? repeatData(table, from.data) : {}), ...(draft || {}) },
    onSaved: (saved, after) => {
      if (draft) { try { sessionStorage.removeItem(draftKey); } catch { /* ignore */ } }
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
    if (!canSee(ctx, table)) { el.append(ownerOnlyPage()); return; }
    const editable = canEdit(ctx, table);
    const d = rec.data;
    const scope = makeScope(table, d, store.ctx());
    const sf = table.statusField ? fieldOf(table, table.statusField) : null;
    const actions = (table.recordActions || []).filter((a) => !a.showIf || isTruthy(tryEvaluate(a.showIf, scope, false)));
    const msgs = store.pendingFor(tableId, id);
    const qr = paymentQr(store, table, rec, 168);

    el.append(pageHeader({ title: recordTitle(table, rec), icon: iconFor(table.icon, { size: 20 }), crumb: { href: `#/t/${tableId}`, label: table.name }, after: sf ? valueNode(store, sf, d[sf.id]) : null },
      h('a.btn.ghost', { href: `#/t/${tableId}` }, icon('back', { size: 16 }), t('Back')),
      remindButton(store, tableId, id),
      editable ? h('a.btn', { href: `#/t/${tableId}/${id}/edit` }, icon('pen', { size: 15 }), t('Edit')) : null,
      editable ? h('a.btn', { href: `#/t/${tableId}/new?from=${id}`, title: t('Start a new one with the same details') }, icon('repeat', { size: 15 }), t('Repeat')) : null,
      hooksFor(table)?.tools?.(store, table, rec, ctx) || null,
      table.print ? h('a.btn', { href: `#/t/${tableId}/${id}/print` }, icon('printer', { size: 15 }), t('Print / share')) : null,
      ctx.role === 'owner' ? h('button.btn.danger', { onclick: async () => {
        if (!(await confirmDialog(t('Delete this record?'), { yes: t('Delete'), danger: true }))) return;
        await store.deleteRecord(tableId, id);
        location.hash = `#/t/${tableId}`;
        toast(t('Deleted.'), { action: { label: t('Undo'), fn: () => store.restoreRecord(tableId, id) }, ms: 9000 });
      }, title: t('Delete'), 'aria-label': t('Delete') }, icon('trash', { size: 15 })) : null));

    if (rec.approval) {
      const a = rec.approval;
      el.append(h('div.banner', { class: a.status === 'pending' ? 'warn' : a.status === 'approved' ? 'ok' : 'error' },
        h('b', a.status === 'pending' ? t('Waiting for approval') : a.status === 'approved' ? `✓ ${t('Approved')}` : `✕ ${t('Rejected')}`), ` — ${a.note || a.ruleName || ''}`,
        a.status === 'pending' && ctx.role === 'owner' ? h('span.banner-actions',
          h('button.btn.small.primary', { onclick: () => store.decideApproval(tableId, id, 'approved', ctx.userName) }, t('Approve')),
          h('button.btn.small', { onclick: () => store.decideApproval(tableId, id, 'rejected', ctx.userName) }, t('Reject'))) : null));
    }

    // changed on two devices at the same time: say what was kept, never resolve it silently (ledger.js)
    const open = (d.__conflicts || []).filter((c) => !c.resolved);
    if (open.length) {
      el.append(h('div.banner.warn.conflict-banner', { role: 'alert' },
        h('div', h('b', t('Changed on two devices at the same time')), h('ul', open.map((c) => h('li', conflictText(store, table, c))))),
        ctx.role === 'owner' ? h('span.banner-actions', h('button.btn.small', { onclick: () => store.resolveConflicts(tableId, id) }, icon('check', { size: 14 }), t('Checked'))) : null));
    }

    // what to do next: collect money, send the message, print
    if (query.done || msgs.length || actions.length) {
      const nextBtns = h('div.next-actions',
        table.print ? h('a.btn', { href: `#/t/${tableId}/${id}/print` }, icon('printer', { size: 15 }), t('Print / share')) : null,
        h('a.btn', { href: `#/t/${tableId}/new` }, icon('plus', { size: 15 }), t('New')));
      el.append(h('section.card.next',
        query.done ? h('h3.saved', icon('check', { size: 18 }), t('Saved')) : h('h3', t('Next steps')),
        h('div.next-grid',
          h('div',
            actions.length ? h('div.next-actions', h('div.hint', t('Record what the customer gave you:')), actions.map((a) => h('button.btn', { onclick: async () => {
              const r = await runAction(store, table, rec, a);
              if (r && r.blocked) toast(r.blocked, { kind: 'warn' });
            } }, a.label))) : null,
            msgs.length ? h('div.next-msgs', msgs.map((m) => sendCard(store, m, {}))) : null, nextBtns),
          qr ? h('div.qr-card', h('div.qr', qr.svg), h('b', `${t('Scan to pay')} ${formatValue({ type: 'money' }, qr.amount)}`), h('div.muted', qr.vpa),
            qr.ref ? h('div.hint.good', t('Marked paid by itself when the bank confirms')) : null) : null)));
    }

    const plain = table.fields.filter((f) => f.type !== 'lines' && !f.hidden && !(f.hideZero && !toNum(d[f.id]))
      && !(f.showIf && !isTruthy(tryEvaluate(f.showIf, scope, true))));
    el.append(h('section.card', h('dl.details', plain.map((f) => h('div', h('dt', f.label), h('dd', valueNode(store, f, d[f.id], { rec })))))));
    for (const f of table.fields.filter((x) => x.type === 'lines' && !x.hidden)) {
      const cols = f.columns.filter((c) => !c.hidden);
      if (!(d[f.id] || []).length) continue;
      el.append(h('section.card', h('h3', f.label), h('div.table-wrap', h('table.data',
        h('thead', h('tr', h('th', '#'), cols.map((c) => h('th', { class: c.type === 'money' || c.type === 'number' ? 'num' : '' }, c.label)))),
        h('tbody', d[f.id].map((r, i) => h('tr', h('td', String(i + 1)), cols.map((c) => h('td', { class: c.type === 'money' || c.type === 'number' ? 'num' : '', dataset: { label: c.label } }, valueNode(store, c, r[c.id]))))))))));
    }
    // payments are never deleted: corrected and removed ones stay visible as reversals
    for (const f of store.ledgerFields(table).filter((x) => !x.hidden)) {
      const voids = d[`${f.id}__void`] || [];
      if (!voids.length) continue;
      const cols = f.columns.filter((c) => !c.hidden);
      const num = (c) => (c.type === 'money' || c.type === 'number' ? 'num' : '');
      el.append(h('section.card.reversals', h('h3', `${t('Reversed')}: ${f.label}`),
        h('p.hint', t('Payments are never deleted. A corrected or removed payment stays here, and does not count.')),
        h('div.table-wrap', h('table.data.compact',
          h('thead', h('tr', cols.map((c) => h('th', { class: num(c) }, c.label)), h('th', t('Why')), h('th', t('When')))),
          h('tbody', voids.map((v) => h('tr', cols.map((c) => h('td', { class: num(c), dataset: { label: c.label } }, valueNode(store, c, v[c.id]))),
            h('td', { dataset: { label: t('Why') } }, reversalReason(v._void)),
            h('td.muted', { dataset: { label: t('When') } }, v._void?.at ? new Date(v._void.at).toLocaleString() : '—'))))))));
    }
    // stock is a ledger of movements: show where it went, newest first (sales on every device are here)
    for (const f of store.stockFields(table)) {
      const rows = [...(d[f.moves] || [])].sort((x, y) => String(y._at || '').localeCompare(String(x._at || ''))).slice(0, 30);
      if (!rows.length) continue;
      el.append(h('section.card.stock-history', h('h3', fieldOf(table, f.moves)?.label || t('Stock history')),
        h('div.table-wrap', h('table.data.compact',
          h('thead', h('tr', h('th', t('When')), h('th', t('Why')), h('th.num', t('Change')))),
          h('tbody', rows.map((r) => h('tr',
            h('td.muted', { dataset: { label: t('When') } }, r._at ? new Date(r._at).toLocaleString() : '—'),
            h('td', { dataset: { label: t('Why') } }, moveReason(store, r)),
            h('td.num', { dataset: { label: t('Change') } }, `${toNum(r.qty) > 0 ? '+' : ''}${formatValue({ type: 'number' }, r.qty)}`))))))));
    }
  };
  paint();
  ctx.watch((e) => { if (e.type === 'record' && e.id !== id && e.table !== tableId) return; paint(); });
  return el;
}

/** One stock movement in words: the bill it came from (a link), a correction by hand, or the opening stock. */
function moveReason(store, r) {
  if (r.kind === 'opening') return t('Opening stock');
  if (r.kind === 'adjust') return `${t('Corrected by hand')}${r._by ? ` · ${who(r._by)}` : ''}`;
  const tb = store.table(r.src_table), src = tb && store.byTable.get(tb.id)?.get(r.src);
  if (!src) return tb?.name || '—';
  return h('a', { href: `#/t/${tb.id}/${src.id}` }, `${tb.name}: ${recordTitle(tb, src)}${src.deleted ? ` (${t('deleted')})` : ''}`);
}

const REASONS = () => ({
  edited: t('Corrected'), removed: t('Removed'),
  'same bank payment recorded twice': t('Same bank payment recorded twice'), 'same payment as a counter entry': t('Same payment as the counter entry'),
});
const who = (by) => (by === 'staff' ? t('Staff') : by === 'owner' ? t('Owner') : by);
const reversalReason = (v) => `${REASONS()[v?.reason] || v?.reason || ''}${v?.by && !v.auto ? ` · ${who(v.by)}` : ''}`;
/** One conflict note in words: what happened, and what was kept. */
function conflictText(store, table, c) {
  const show = (fid, v) => { const f = fieldOf(table, fid); return v === null || v === undefined || v === '' ? '—' : f ? formatValue(f, v, store.ctx()) : String(v); };
  switch (c.kind) {
    case 'edit': return Object.entries(c.fields || {}).map(([fid, x]) => t('{field}: kept “{kept}”; the other device had “{lost}”', { field: fieldOf(table, fid)?.label || fid, kept: show(fid, x.kept), lost: show(fid, x.lost) })).join(' · ');
    case 'restored': return t('It was deleted on one device while a payment was recorded on another. It was kept, so the payment is not lost.');
    case 'delete-undone': return t('It was deleted on one device but changed on another, so it was kept.');
    case 'corrected-twice': return t('One payment was corrected differently on two devices. Both corrections count for now: check the payments and remove the wrong one.');
    case 'edited-after-reversal': return t('A payment was changed here after another device had removed it. The new amount was kept as a new payment: check it.');
    case 'row': if (table.fields.some((f) => f.moves === c.field)) return t('A bill with this item was changed differently on two devices at once, so this stock may be off by the difference. Count it and correct the number.');
      return t('Two devices disagree about a payment. Check the payments below.');
    default: return t('Two devices disagree about a payment. Check the payments below.');
  }
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
      h('a.btn.ghost', { href: `#/t/${tableId}/${id}` }, icon('back', { size: 16 }), t('Back')),
      h('button.btn.primary', { onclick: () => window.print() }, icon('printer', { size: 15 }), t('Print')), sel,
      h('span.hint', t('Tip: choose “Save as PDF” in the print window to share a PDF.'))),
    msgHost, docHost);
  paintDoc(); paintMsgs();
  ctx.watch(() => { paintDoc(); paintMsgs(); });
  if (query.auto) setTimeout(() => $('.doc') && window.print(), 350);
  return el;
}
