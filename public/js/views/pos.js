// Billing counter: one screen per sale, nothing to navigate. Scan on the left; total, payment and Save on the right.
// Enter saves (and prints the receipt in place), and the screen is clean for the next customer straight away.
//
//   scan / type code + Enter  add item            F1 / F2 / F3  paid by Cash / UPI / Card (first three payment modes)
//   Enter on the empty scan bar  save (+ print)   F9            on credit (needs a customer)
//   F4  discount   F8  customer   Esc  clear the bill
//
// With Smart Collect on, the UPI QR carries this bill's own reference, and the bank's confirmation shows up here within
// seconds (no screenshots to trust). The bill's id is fixed when the bill starts so its reference is known before saving.
import { h, toast, confirmDialog } from '../ui/dom.js';
import { t } from '../i18n.js';
import { linesEditor } from '../ui/lines.js';
import { makeControl } from '../ui/controls.js';
import { openRecordModal } from '../ui/form.js';
import { computeRecord, newRecordData, defaultsFor, newRow, rowIsBlank, isBlank, isComputed, fieldOf, formatValue, recordTitle, parseQuickCreate, uid } from '../schema.js';
import { collectOn, COLLECT_TABLE } from '../collect.js';
import { toNum } from '../formula.js';
import { buildDocument, paymentQr } from '../print.js';
import { icon } from '../ui/icons.js';
import { emptyState } from '../ui/bits.js';

/** The table the counter bills into: a "＋ New" shortcut table with scannable item lines and a payments list. */
export function posSetup(store, table) {
  if (!table?.quick) return null;
  const items = table.fields.find((f) => f.type === 'lines' && f.quickEntry && f.columns?.some((c) => c.type === 'lookup'));
  const pay = table.fields.find((f) => f.type === 'lines' && !f.columns?.some((c) => c.type === 'lookup')
    && f.columns?.some((c) => c.type === 'money') && f.columns?.some((c) => c.type === 'select'));
  const party = table.fields.find((f) => f.type === 'lookup');
  if (!items || !pay) return null;
  const amountCol = pay.columns.find((c) => c.type === 'money' && !isComputed(c));
  const modeCol = pay.columns.find((c) => c.type === 'select');
  const discount = table.fields.find((f) => f.id === 'discount' && f.type === 'money' && !isComputed(f));
  return { table, items, pay, party, amountCol, modeCol, discount, modes: (modeCol.options || []).slice(0, 3) };
}
export const posTable = (store) => store.app?.tables.find((tb) => store.canAddTo(tb.id) && posSetup(store, tb))?.id || null;

const PRINT_KEY = 'pos-print', DRAFT_KEY = (id) => `pos-draft-${id}`;
const read = (k, dflt) => { try { const v = localStorage.getItem(k); return v === null ? dflt : v; } catch { return dflt; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } };

export function posView(ctx) {
  const { store } = ctx;
  const id = posTable(store);
  const cfg = id && posSetup(store, store.table(id));
  if (!cfg) return emptyState('🧾', t('No billing table yet'), t('Open the App builder to create your first table.'));
  const { table, items, pay, party, amountCol, modeCol, discount, modes } = cfg;
  const c = store.ctx();
  const money = (v) => formatValue({ type: 'money' }, v, c);

  // ---- the bill being made (kept in this tab, so a slip of the mouse never loses it) ----------------------------------
  const fresh = () => computeRecord(table, { ...newRecordData(table), ...defaultsFor(table, store) }, c);
  let data = fresh(), tender = 0, last = null, lastChange = 0, saving = false, rid = uid();
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY(table.id)) || 'null');
    if (saved?.data) { data = computeRecord(table, saved.data, c); tender = saved.tender ?? 0; if (saved.rid) rid = saved.rid; }
  } catch { /* nothing saved */ }
  const keep = () => { try { sessionStorage.setItem(DRAFT_KEY(table.id), JSON.stringify({ data, tender, rid })); } catch { /* ignore */ } };
  // bank confirmations that carry this bill's reference (they can arrive before the bill is saved)
  const refCol = pay.columns.find((col) => col.id === 'ref');
  const received = (ref) => (ref ? store.records(COLLECT_TABLE).filter((r) => r.data.ref === ref) : []);
  const hasItems = () => (data[items.id] || []).some((r) => !rowIsBlank(items, r));
  const hasParty = () => party && !isBlank(data[party.id]);

  const refresh = () => { data = computeRecord(table, data, c); editor.sync(); paintSide(); keep(); };

  // ---- left: scan + items -------------------------------------------------------------------------------------------
  const editor = linesEditor({
    store, table, field: items, getRows: () => data[items.id], getData: () => data,
    changed: () => refresh(), onExit: () => saveBtn.focus(),
  });
  const focusScan = () => editor.focusFirst();

  // ---- right: customer, totals, payment, save ------------------------------------------------------------------------
  const custCtl = party ? makeControl(store, party, {
    get: () => data[party.id], set: (v) => { data[party.id] = v; if (!v && tender === 'credit') tender = 0; refresh(); },
    onPick: () => focusScan(),
    onCreate: store.canAddTo(party.ref) ? (q, done) => openRecordModal(store, party.ref, parseQuickCreate(store.table(party.ref), q), (rec) => {
      data[party.id] = rec.id; refresh(); done?.(rec.id); focusScan();
    }) : undefined,
    placeholder: () => `${t('Walk-in customer')} · ${t('type a name or phone')}`,
  }) : null;

  const discIn = discount ? h('input.num', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': discount.label, placeholder: '0',
    oninput: (e) => { data[discount.id] = e.target.value === '' ? 0 : toNum(e.target.value); refresh(); } }) : null;
  const totalsBox = h('dl.pos-totals');
  const totalEl = h('div.pos-total-v');
  const tenderBox = h('div.pos-tender', { role: 'radiogroup', 'aria-label': t('Paid by') });
  const givenIn = h('input.num', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': t('Cash received'), placeholder: t('Exact amount'),
    oninput: () => paintChange(),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } } });
  const changeEl = h('div.pos-change', { role: 'status' });
  const cashBox = h('div.pos-cash', h('label.pos-row', h('span', t('Cash received')), givenIn), changeEl);
  const qrBox = h('div.pos-qr');
  const creditNote = h('div.pos-credit-note');
  let printOn = read(PRINT_KEY, '1') === '1';
  const printChk = h('input', { type: 'checkbox', checked: printOn, onchange: (e) => { printOn = e.target.checked; write(PRINT_KEY, printOn ? '1' : '0'); paintSave(); } });
  const paperSel = h('select.pos-paper', { 'aria-label': t('Paper size'), onchange: (e) => write('paper', e.target.value) },
    h('option', { value: 'thermal' }, t('Receipt (80 mm)')), h('option', { value: 'a4' }, 'A4'));
  paperSel.value = read('paper', 'thermal');
  const saveBtn = h('button.btn.primary.pos-save', { type: 'button', onclick: () => save() });
  const lastBox = h('div.pos-last', { 'aria-live': 'polite' });

  const isCash = () => tender === 0;
  const isUpi = () => typeof tender === 'number' && /upi/i.test(modes[tender] || '');
  function paintChange() {
    const total = toNum(data.total), given = givenIn.value.trim() === '' ? null : toNum(givenIn.value);
    if (given === null || !total) { changeEl.replaceChildren(); changeEl.dataset.tone = ''; return; }
    const diff = given - total;
    changeEl.dataset.tone = diff >= 0 ? 'good' : 'bad';
    changeEl.replaceChildren(h('span', diff >= 0 ? t('Change to return') : t('Short by')), h('b', money(Math.abs(diff))));
  }
  function paintSave() {
    saveBtn.replaceChildren(icon(printOn ? 'printer' : 'check', { size: 18 }), h('span', printOn ? t('Save & print') : t('Save bill')), h('kbd', 'Enter'));
  }
  function paintSide() {
    const shown = (table.print?.totals || ['total']).filter((fid) => !['paid', 'balance', 'total', discount?.id].includes(fid)).map((fid) => fieldOf(table, fid)).filter(Boolean);
    totalsBox.replaceChildren(
      shown.filter((f) => toNum(data[f.id]) !== 0 || ['subtotal', 'taxable', 'tax_total'].includes(f.id))
        .map((f) => h('div.pos-row', h('dt', f.label), h('dd', money(data[f.id])))),
      discIn ? h('div.pos-row', h('dt', h('label', discount.label, h('kbd', 'F4'))), h('dd', discIn)) : null);
    if (discIn && document.activeElement !== discIn) discIn.value = toNum(data[discount.id]) ? String(data[discount.id]) : '';
    totalEl.textContent = money(data.total);
    const credit = h('button', { type: 'button', role: 'radio', 'aria-checked': String(tender === 'credit'), class: `tender${tender === 'credit' ? ' on' : ''}`, disabled: !hasParty(),
      title: hasParty() ? '' : t('Pick a customer first (F8)'), onclick: () => setTender('credit') }, h('span', t('Credit')), h('kbd', 'F9'));
    tenderBox.replaceChildren(modes.map((m, i) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(tender === i), class: `tender${tender === i ? ' on' : ''}`, onclick: () => setTender(i) },
      h('span', m), h('kbd', `F${i + 1}`))), party ? credit : null);
    cashBox.hidden = !isCash();
    const qr = isUpi() && toNum(data.total) > 0 ? paymentQr(store, table, { id: rid, data }, 112) : null;
    qrBox.hidden = !isUpi();
    qrBox.replaceChildren(...(qr ? [h('div.qr', qr.svg), h('div', h('b', `${t('Scan to pay')} ${money(qr.amount)}`), h('div.muted', qr.vpa), upiStatus(qr))]
      : [h('p.hint', store.business.upi ? t('Scan an item to show the QR.') : t('Add your UPI ID in Settings to show a QR for the customer to scan.'))]));
    creditNote.hidden = tender !== 'credit';
    creditNote.textContent = tender === 'credit' && party ? t('{amount} goes on the customer\'s account.', { amount: money(data.total) }) : '';
    paintChange();
    paintSave();
  }
  /** Smart Collect: "waiting" until the bank confirms, then the amount and UTR. */
  function upiStatus(qr) {
    if (!qr.ref) return null;
    const got = received(qr.ref);
    const amt = got.reduce((s, r) => s + toNum(r.data.amount), 0);
    if (amt > 0) {
      const short = toNum(data.total) - amt;
      return h('div.pos-upi', { dataset: { tone: short > 0.004 ? 'warn' : 'good' }, role: 'status' }, icon('check', { size: 16 }),
        h('span', short > 0.004 ? t('{amount} received, {short} still to pay', { amount: money(amt), short: money(short) }) : t('{amount} received · confirmed by the bank', { amount: money(amt) })),
        h('small', `UTR ${got.map((r) => r.data.utr).join(', ')}`));
    }
    const sandbox = store.settings.collect?.sandbox && ctx.sync?.config?.enabled;
    return h('div.pos-upi', { dataset: { tone: 'wait' }, role: 'status' }, h('i.pos-pulse', { 'aria-hidden': 'true' }), h('span', t('Waiting for the payment… it is confirmed here by itself')),
      sandbox ? h('button.link.tiny', { type: 'button', onclick: async () => {
        try { await ctx.sync.simulatePayment({ amount: qr.amount, ref: qr.ref, name: t('Sandbox customer') }); } catch (e) { toast(e.message, { kind: 'warn' }); }
      } }, t('Simulate payment (sandbox)')) : null);
  }
  function setTender(x) {
    if (x === 'credit' && !hasParty()) { toast(t('Pick a customer first (F8)'), { kind: 'warn' }); custCtl?.focusEl?.focus(); return; }
    tender = x; paintSide(); keep();
    if (isCash()) { givenIn.focus(); givenIn.select(); } else focusScan();
  }

  // ---- save: one bill, then a clean counter ---------------------------------------------------------------------------
  function reset() {
    data = fresh(); tender = 0; givenIn.value = ''; rid = uid();
    try { sessionStorage.removeItem(DRAFT_KEY(table.id)); } catch { /* ignore */ }
    editor.sync(); custCtl?.sync(); paintSide(); paintLast(); focusScan();
  }
  async function save() {
    if (saving) return;
    if (!hasItems()) { toast(t('Scan or type an item first.'), { kind: 'warn' }); focusScan(); return; }
    const total = toNum(data.total);
    let draft = data;
    if (tender !== 'credit' && total > 0) {
      let amount = total;
      const given = givenIn.value.trim() === '' ? null : toNum(givenIn.value);
      if (isCash() && given !== null && given < total) {
        if (!hasParty()) { toast(t('Short by {amount}. Add a customer (F8) to keep the rest as credit.', { amount: money(total - given) }), { kind: 'warn', ms: 6000 }); givenIn.focus(); return; }
        amount = given;
      }
      const row = { ...newRow(pay, c), [amountCol.id]: amount, [modeCol.id]: modes[tender] };
      // the bank already confirmed it while the customer stood here: record its UTR with the payment
      const got = isUpi() && collectOn(store) && refCol ? received(paymentQr(store, table, { id: rid, data })?.ref) : [];
      if (got.length === 1 && Math.abs(toNum(got[0].data.amount) - amount) < 0.005) Object.assign(row, { [refCol.id]: got[0].data.utr, _src: 'bank' });
      draft = computeRecord(table, { ...data, [pay.id]: [row] }, c);
    }
    saving = true;
    try {
      const res = await store.saveRecord(table.id, draft, { by: store.currentUser, id: rid });
      if (!res.ok) {
        const msg = res.blocked || Object.entries(res.errors || {}).map(([fid, code]) => `${fieldOf(table, fid)?.label || ''}: ${code === 'required' ? t('This is required') : code}`).join(' · ');
        toast(msg, { kind: 'warn', ms: 7000 });
        return;
      }
      last = res.record;
      lastChange = isCash() && givenIn.value.trim() !== '' ? Math.max(0, toNum(givenIn.value) - total) : 0;
      if (printOn) printReceipt(res.record);
      reset();
    } finally { saving = false; }
  }
  function printReceipt(rec) {
    let host = document.getElementById('print-host');
    if (!host) { host = h('div#print-host'); document.body.append(host); }
    host.replaceChildren(buildDocument(store, table, rec, { paper: paperSel.value }));
    document.body.classList.add('print-host-on');
    setTimeout(() => window.print(), 30);
  }
  function paintLast() {
    const rec = last && store.getRecord(table.id, last.id);
    lastBox.hidden = !rec;
    if (!rec) return;
    const sf = table.statusField ? fieldOf(table, table.statusField) : null;
    lastBox.replaceChildren(
      h('div.pos-last-head', icon('check', { size: 16 }), h('b', `${t('Saved')} ${recordTitle(table, rec)}`), h('span', money(rec.data.total)),
        sf && rec.data[sf.id] ? h('span.muted', `· ${rec.data[sf.id]}`) : null),
      lastChange ? h('div.pos-last-change', `${t('Change to return')}: `, h('b', money(lastChange))) : null,
      h('div.pos-last-actions',
        h('button.btn.small', { type: 'button', onclick: () => printReceipt(rec) }, icon('printer', { size: 14 }), t('Print again')),
        h('a.btn.small', { href: `#/t/${table.id}/${rec.id}` }, t('Open'))));
  }

  // ---- keys ------------------------------------------------------------------------------------------------------------
  async function clearBill() {
    if (hasItems() && !(await confirmDialog(t('Clear this bill?'), { yes: t('Clear'), danger: true }))) return;
    reset();
  }
  const onKey = (e) => {
    if (document.querySelector('.overlay, .lock')) return;
    const k = e.key;
    if (/^F[1-3]$/.test(k) && modes[+k[1] - 1]) { e.preventDefault(); setTender(+k[1] - 1); }
    else if (k === 'F4') { e.preventDefault(); if (discIn) { discIn.focus(); discIn.select(); } }
    else if (k === 'F8') { e.preventDefault(); custCtl?.focusEl?.focus(); }
    else if (k === 'F9') { e.preventDefault(); setTender('credit'); }
    else if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) { e.preventDefault(); save(); }
    else if (k === 'Escape' && !e.defaultPrevented) { e.preventDefault(); clearBill(); }
    else if (k === 'Enter' && !e.altKey && e.target.closest?.('.pos .quick') && !e.target.value.trim()) { e.preventDefault(); save(); }
  };
  document.addEventListener('keydown', onKey);
  document.body.classList.add('pos-mode');

  const el = h('div.pos',
    h('section.pos-main',
      h('div.pos-head',
        h('div.page-title', h('span.page-ic', icon('scan', { size: 20 })), h('div', h('h1', t('Billing counter')), h('div.page-sub', `${table.name} · ${store.business.name || ''}`))),
        h('div.page-actions',
          h('a.btn.ghost', { href: `#/t/${table.id}/new?draft=1`, title: t('Due date, notes and every other field'), onclick: () => keep() }, t('Full form')),
          h('button.btn', { type: 'button', onclick: () => clearBill() }, icon('x', { size: 15 }), t('Clear'), h('kbd', 'Esc')))),
      editor.el,
      h('div.pos-keys',
        [['F1–F3', t('Paid by')], ['F4', discount ? discount.label : null], ['F8', party ? party.label : null], ['F9', t('Credit')], ['Enter', t('Save')], ['Esc', t('Clear')]]
          .filter(([, l]) => l).map(([k, l]) => h('span', h('kbd', k), l)))),
    h('aside.pos-side',
      party ? h('div.pos-cust', h('div.pos-lbl', party.label, h('kbd', 'F8')), custCtl.el) : null,
      totalsBox,
      h('div.pos-total', h('span', t('Total')), totalEl),
      h('div.pos-lbl', t('Paid by')), tenderBox, cashBox, qrBox, creditNote,
      h('div.pos-print', h('label.check', printChk, t('Print receipt')), paperSel),
      saveBtn, lastBox));

  paintSide(); paintLast();
  queueMicrotask(focusScan);
  ctx.watch((e) => { if (e.type === 'record' && e.table === COLLECT_TABLE && isUpi()) paintSide(); });
  return {
    el,
    destroy() { document.removeEventListener('keydown', onKey); document.body.classList.remove('pos-mode'); editor.destroy(); custCtl?.destroy?.(); },
  };
}
