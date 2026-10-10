// GST screens: returns (GSTR-1, GSTR-3B), receivables, the home-screen compliance card, the e-way bill tool and the
// GST part of Settings. The maths is all in gst.js / returns.js; this file only shows it.
import { h, download, modal, toast, debounce } from '../../js/ui/dom.js';
import { t } from '../../js/i18n.js';
import { pageHeader, emptyState, labeled, tabs, pill } from '../../js/ui/bits.js';
import { hooksFor, fmtMoney, fmtDate } from '../../js/schema.js';
import { toCsv } from '../../js/csv.js';
import { todayStr, daysBetween, toNum, addDays } from '../../js/formula.js';
import { gstr1, gstr1Json, gstr1Tables, gstr3b, outstanding, ewayBillJson, EWAY_LIMIT, AGE_BUCKETS } from './returns.js';
import { filingDeadlines, validateGstin, gstinProblem, stateLabel, stateCodeOf, STATE_LABELS, docOf } from './gst.js';
import './hooks.js';
import { icon } from '../../js/ui/icons.js';

export const gstTables = (store) => ({
  sales: store.app?.tables.find((x) => x.hooks === 'gst_invoice') || null,
  purchases: store.app?.tables.find((x) => x.hooks === 'gst_purchase') || null,
});
export const usesGst = (store) => !!gstTables(store).sales;

const monthLabel = (ym) => { try { return new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`)); } catch { return ym; } };
/** Before the 20th you are usually filing last month; after it, watching this one. */
const defaultPeriod = (today = todayStr()) => (Number(today.slice(8, 10)) <= 20 ? addDays(`${today.slice(0, 8)}01`, -1).slice(0, 7) : today.slice(0, 7));
const docs = (store, table) => (table ? store.records(table.id).map((r) => r.data) : []);
const settingsOf = (store) => store.settings || {};

function deadlineChips(today) {
  return filingDeadlines(today).map((x) => {
    const days = daysBetween(x.due, today) ?? 0;
    const tone = days < 0 ? 'bad' : days <= 3 ? 'warn' : 'info';
    const when = days < 0 ? t('{n} days late', { n: -days }) : days === 0 ? t('due today') : t('in {n} days', { n: days });
    return h('span.deadline', { dataset: { tone } }, h('b', x.return), ` ${monthLabel(x.period)} · ${fmtDate(x.due)} · `, h('span', when));
  });
}

// ---- home card ----------------------------------------------------------------------------------------------
export function gstHomeCard(store) {
  const { sales, purchases } = gstTables(store);
  if (!sales) return null;
  const today = todayStr(), period = today.slice(0, 7);
  const b3 = gstr3b(docs(store, sales), docs(store, purchases), { business: store.business, period, settings: settingsOf(store) });
  const out = b3.out_taxable, L = b3.liability, itc = b3.itc;
  const tax = (o) => toNum(o.igst) + toNum(o.cgst) + toNum(o.sgst) + toNum(o.cess);
  const noGstin = !validateGstin(store.business.gstin).ok;
  return h('section.card.gst-card',
    h('div.gst-card-head', h('h3', t('GST this month')), h('span.muted', monthLabel(period)), h('span.spacer'), h('a.btn.small', { href: '#/gst' }, `${t('Returns')} →`)),
    noGstin ? h('div.banner.warn', t('Add your GSTIN in Settings so tax is split correctly.'), h('a.btn.small', { href: '#/settings' }, t('Settings'))) : null,
    h('div.gst-figs',
      fig(t('Taxable sales'), fmtMoney(out.taxable)),
      fig(t('GST on sales'), fmtMoney(tax(L))),
      fig(t('Input credit'), fmtMoney(tax(itc))),
      fig(t('To pay in cash'), fmtMoney(b3.cash_total), b3.cash_total > 0 ? 'warn' : 'good')),
    h('div.deadlines', deadlineChips(today)));
}
const fig = (label, value, tone) => h('div.gst-fig', { dataset: tone ? { tone } : {} }, h('div.l', label), h('div.v', value));

// ---- returns screen -------------------------------------------------------------------------------------------
export function gstReturnsView(ctx, tab = 'gstr1') {
  const { store } = ctx;
  const { sales, purchases } = gstTables(store);
  if (!sales) return emptyState('🧮', t('GST is not set up'), t('Start from the “Shop with GST invoices” template to get GST invoices and returns.'));
  const st = { period: ctx.query?.period || defaultPeriod(), tab };
  const body = h('div.gst-body');
  const monthIn = h('input', { type: 'month', value: st.period, 'aria-label': t('Return period'), onchange: (e) => { if (e.target.value) { st.period = e.target.value; paint(); } } });

  function paint() {
    const business = store.business, settings = settingsOf(store);
    const all = docs(store, sales);
    const g1 = gstr1(all, { business, period: st.period, settings });
    const g3 = gstr3b(all, docs(store, purchases), { business, period: st.period, settings });
    const T = g1.totals;
    const noGstin = !validateGstin(business.gstin).ok;
    body.replaceChildren(
      h('div.deadlines', deadlineChips(todayStr())),
      noGstin ? h('div.banner.warn', t('Your GSTIN is missing or not valid. Returns need it.'), h('a.btn.small', { href: '#/settings' }, t('Settings'))) : null,
      h('div.kpi-row',
        kpi(t('Documents'), String(g1.invoiceCount)), kpi(t('Taxable value'), fmtMoney(T.taxable)),
        kpi(t('Tax on sales'), fmtMoney(T.igst + T.cgst + T.sgst + T.cess), `IGST ${fmtMoney(T.igst)} · CGST ${fmtMoney(T.cgst)} · SGST ${fmtMoney(T.sgst)}`),
        kpi(t('To pay in cash'), fmtMoney(g3.cash_total), `${t('after input credit of')} ${fmtMoney(g3.itc.igst + g3.itc.cgst + g3.itc.sgst + g3.itc.cess)}`)),
      g1.warnings.length ? h('div.banner.warn.gst-warn', h('b', `⚠ ${t('Check before filing')}`), h('ul', g1.warnings.map((w) => h('li', w)))) : null,
      tabs([{ id: 'gstr1', label: 'GSTR-1' }, { id: 'gstr3b', label: 'GSTR-3B' }, { id: 'dues', label: t('Receivables') }], st.tab, (id) => { st.tab = id; paint(); }),
      st.tab === 'gstr1' ? gstr1Panel(store, g1) : st.tab === 'gstr3b' ? gstr3bPanel(g3) : duesPanel(all),
      h('p.hint', t('Indicative: prepare your return from this, then validate the JSON in the GST portal’s offline tool before filing.')));
  }
  paint();
  ctx.watch(debounce(paint, 120));
  return h('div.gst-page', pageHeader({ title: t('GST returns'), icon: icon('calculator', { size: 20 }) }, monthIn), body);
}
const kpi = (label, value, sub) => h('section.card.kpi', h('div.kpi-label', label), h('div.kpi-value', value), sub ? h('div.hint', sub) : null);

function gstr1Panel(store, g1) {
  const tables = gstr1Tables(g1);
  const stamp = g1.fp;
  return h('div',
    h('div.row',
      h('button.btn.primary', { onclick: () => {
        if (!validateGstin(store.business.gstin).ok) { toast(t('Add your GSTIN in Settings first.'), { kind: 'warn' }); return; }
        download(`GSTR1_${store.business.gstin}_${stamp}.json`, JSON.stringify(gstr1Json(g1)));
      } }, icon('download', { size: 15 }), t('GSTR-1 JSON (offline tool)')),
      h('button.btn', { onclick: () => download(`GSTR1_${stamp}.csv`, toCsv(tables.flatMap((x) => [[x.title], x.head, ...x.rows, []])), 'text/csv') }, icon('download', { size: 15 }), t('Download as CSV'))),
    tables.length ? tables.map((x) => h('section.card', h('h3', `${x.title} `, h('span.muted', `(${x.rows.length})`)), h('div.table-wrap', h('table.data.gst-table',
      h('thead', h('tr', x.head.map((c) => h('th', c)))),
      h('tbody', x.rows.map((r) => h('tr', r.map((c, i) => h('td', { class: typeof c === 'number' ? 'num' : '', dataset: { label: x.head[i] } }, typeof c === 'number' && !/Rate|Qty|Total|Cancelled|Net/.test(x.head[i]) ? fmtMoney(c) : String(c ?? ''))))))))))
      : emptyState('📭', t('No invoices in this month'), t('Pick another month above.')));
}

function gstr3bPanel(g3) {
  const row = (label, o) => h('tr', h('td', label), ['taxable', 'igst', 'cgst', 'sgst', 'cess'].map((k) => h('td.num', { dataset: { label: k.toUpperCase() } }, o[k] === undefined ? '' : fmtMoney(o[k]))));
  const head = () => h('tr', h('th', t('Section')), [t('Taxable'), 'IGST', 'CGST', 'SGST/UTGST', t('Cess')].map((x) => h('th.num', x)));
  return h('div',
    h('section.card', h('h3', `3.1 ${t('Tax on outward and reverse-charge inward supplies')}`), h('div.table-wrap', h('table.data', h('thead', head()), h('tbody',
      row(`(a) ${t('Outward taxable supplies')}`, g3.out_taxable),
      row(`(b) ${t('Zero-rated (exports, SEZ)')}`, g3.zero_rated),
      row(`(c) ${t('Nil rated / exempt')}`, { taxable: g3.nil_exempt }),
      row(`(d) ${t('Inward supplies under reverse charge')}`, g3.rcm_inward))))),
    h('section.card', h('h3', `4 ${t('Input tax credit')} `, h('span.muted', `(${t('{n} purchase bills', { n: g3.purchases })})`)), h('div.table-wrap', h('table.data', h('thead', head()), h('tbody',
      row(t('Available'), g3.itc), row(t('Used against tax'), sub(g3.itc, g3.itc_carry_forward)), row(t('Carried forward'), g3.itc_carry_forward))))),
    h('section.card.next', h('h3', `6.1 ${t('Payment of tax')}`), h('div.table-wrap', h('table.data', h('thead', head()), h('tbody',
      row(t('Tax payable'), g3.liability), row(t('Paid in cash'), g3.cash_payable)))),
    h('p.kpi-value', fmtMoney(g3.cash_total)), h('p.hint', t('Credit is set off in the legal order: IGST first, and CGST is never used against SGST.'))),
    g3.unregistered_inter.length ? h('section.card', h('h3', `3.2 ${t('Inter-state supplies to unregistered persons')}`), h('div.table-wrap', h('table.data',
      h('thead', h('tr', h('th', t('Place of supply')), h('th.num', t('Taxable')), h('th.num', 'IGST'))),
      h('tbody', g3.unregistered_inter.map((u) => h('tr', h('td', stateLabel(u.pos) || u.pos), h('td.num', fmtMoney(u.taxable)), h('td.num', fmtMoney(u.igst)))))))) : null);
}
const sub = (a, b) => Object.fromEntries(['igst', 'cgst', 'sgst', 'cess'].map((k) => [k, Math.round((toNum(a[k]) - toNum(b[k])) * 100) / 100]));

function duesPanel(all) {
  const o = outstanding(all);
  if (!o.rows.length) return emptyState('✅', t('Nobody owes you money'), '');
  return h('div',
    h('div.kpi-row', AGE_BUCKETS.map((b, i) => kpi(t(b), fmtMoney(o.buckets[i])))),
    h('section.card', h('h3', `${t('Outstanding')} · ${fmtMoney(o.total)}`), h('div.table-wrap', h('table.data',
      h('thead', h('tr', h('th', t('Customer')), h('th', 'GSTIN'), AGE_BUCKETS.map((b) => h('th.num', t(b))), h('th.num', t('Total')))),
      h('tbody', o.rows.map((p) => h('tr', h('td', { dataset: { label: t('Customer') } }, h('b', p.name)), h('td', { dataset: { label: 'GSTIN' } }, p.gstin || '—'),
        p.buckets.map((v, i) => h('td.num', { dataset: { label: t(AGE_BUCKETS[i]) } }, v ? fmtMoney(v) : '—')), h('td.num', { dataset: { label: t('Total') } }, h('b', fmtMoney(p.total))))))))));
}

// ---- e-way bill (record tool on a saved invoice) ------------------------------------------------------------------
function ewayButton(store, table, rec) {
  const d = rec.data;
  if (!docOf(d.doc_type).taxDoc && d.doc_type !== 'Delivery Challan') return null;
  const big = toNum(d.total) >= EWAY_LIMIT;
  return h('button.btn', { class: big ? 'eway-due' : '', title: big ? t('Goods worth over {n} usually need an e-way bill', { n: fmtMoney(EWAY_LIMIT) }) : '', onclick: () => openEway(store, rec) }, `🚚 ${t('E-way bill')}`);
}
function openEway(store, rec) {
  const d = rec.data;
  const f = { distance: '', vehicleNo: '', toPincode: (/\b(\d{6})\b/.exec(d.bill_address || '') || [])[1] || '', transporterName: '' };
  const inp = (k, label, extra = {}) => labeled(label, h('input', { value: f[k], ...extra, oninput: (e) => { f[k] = e.target.value; } }));
  const m = modal({
    title: `${t('E-way bill')} · ${d.number}`,
    body: h('div', h('p.hint', t('Makes the JSON file for the e-way bill portal’s bulk upload. Your PIN code comes from Settings.')),
      h('div.two', inp('distance', t('Distance (km)'), { inputmode: 'numeric' }), inp('vehicleNo', t('Vehicle number'), { placeholder: 'MH12AB1234' })),
      h('div.two', inp('toPincode', t('Customer PIN code'), { inputmode: 'numeric', maxlength: 6 }), inp('transporterName', t('Transporter (optional)')))),
    actions: [{ label: t('Cancel'), value: null }, { label: `⬇ ${t('Download JSON')}`, primary: true, fn: (close) => {
      try {
        const json = ewayBillJson(d, store.business, { distance: toNum(f.distance), vehicleNo: f.vehicleNo, toPincode: f.toPincode, transporterName: f.transporterName });
        download(`EWB_${String(d.number).replace(/\//g, '-')}.json`, JSON.stringify(json));
        close();
      } catch (e) { toast(e.message, { kind: 'warn', ms: 7000 }); }
    } }],
  });
  return m;
}
const invHooks = hooksFor({ hooks: 'gst_invoice' });
if (invHooks) invHooks.tools = (store, table, rec) => ewayButton(store, table, rec);

// ---- settings card ----------------------------------------------------------------------------------------------
export function gstSettingsCard(store) {
  const b = store.business;
  const s = store.settings;
  s.gst ||= { round_off: true, hsn_digits: 4, price_incl: false };
  const save = debounce(() => store.touchApp(), 300);
  const read = h('div.hint', { role: 'status' });
  const stateSel = h('select', { 'aria-label': t('State'), onchange: (e) => { b.state = e.target.value; save(); } },
    h('option', { value: '' }, '—'), STATE_LABELS.map((x) => h('option', { value: x, selected: x === b.state }, x)));
  const check = () => {
    const g = validateGstin(b.gstin);
    if (g.ok) {
      b.gstin = g.gstin; b.state = stateLabel(g.stateCode); stateSel.value = b.state; stateSel.disabled = true;
      read.className = 'hint good'; read.textContent = `✓ ${t('Valid')} · ${b.state.replace(/^\d+ - /, '')} · PAN ${g.pan}`;
    } else {
      stateSel.disabled = false;
      read.className = b.gstin ? 'hint bad' : 'hint';
      read.textContent = b.gstin ? gstinProblem(b.gstin) : t('Your state is read from the GSTIN, so tax is split correctly.');
    }
  };
  const gstin = h('input', { value: b.gstin || '', maxlength: 18, autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'GSTIN', oninput: (e) => { b.gstin = e.target.value.trim(); check(); save(); } });
  const box = (label, key, obj = s.gst) => h('label.check', h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; save(); } }), ` ${label}`);
  check();
  return h('section.card', h('h3', t('GST')),
    h('div.two', labeled('GSTIN', gstin, null), labeled(t('State'), stateSel)), read,
    h('div.two', labeled(t('PIN code (for e-way bills)'), h('input', { value: b.pincode || '', inputmode: 'numeric', maxlength: 6, oninput: (e) => { b.pincode = e.target.value; save(); } })),
      labeled(t('Legal name (if different)'), h('input', { value: b.legal_name || '', oninput: (e) => { b.legal_name = e.target.value; save(); } }))),
    box(t('My selling prices already include GST'), 'price_incl'),
    box(t('Round the bill total to the nearest rupee'), 'round_off'),
    box(t('I am a composition dealer (no GST is charged; use Bill of Supply)'), 'composition', b),
    pill(`${t('HSN digits required on B2B bills')}: ${s.gst.hsn_digits ?? 4}`, 'info'));
}
export { stateCodeOf };
