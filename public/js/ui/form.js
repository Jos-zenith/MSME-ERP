// Generic record form, generated from a table definition. Works for any table the user builds.
import { h, modal, toast, confirmDialog } from './dom.js';
import { makeControl } from './controls.js';
import { linesEditor } from './lines.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { computeRecord, newRecordData, newRow, rowIsBlank, fmtMoney, recordLabel, isComputed, isBlank, parseQuickCreate, makeScope, findDuplicates } from '../schema.js';
import { tryEvaluate, isTruthy, toNum } from '../formula.js';

const ERR = {
  required: () => t('This is required'),
  bad_email: () => t('Enter a valid email address'),
  bad_phone: () => t('Enter a valid phone number'),
  bad_number: () => t('Enter a number'),
  too_small: () => t('The value is too small'),
  duplicate: () => t('Another record already uses this value'),
};

/**
 * @param {object} o { store, table, record?, initial?, onSaved(record, after), onCancel?, inModal?, startAtEmpty? }
 */
export function buildForm({ store, table, record, initial = {}, onSaved, onCancel, inModal = false, preview = false, startAtEmpty = false }) {
  const ctx = store.ctx();
  let data = computeRecord(table, { ...newRecordData(table), ...(record?.data || {}), ...initial }, ctx);
  // what this form started from: a save can only take out payments the person editing actually saw (ledger.js)
  const base = record ? JSON.parse(JSON.stringify(record.data)) : null;
  let dirty = false;
  const controls = new Map();   // field id -> control
  const editors = new Map();    // lines field id -> editor
  const errEls = new Map();
  const order = [];             // keyboard order: [{id, focus()}]

  const banner = h('div.banner.error', { role: 'alert', hidden: true });
  const wraps = new Map();      // field id -> .fld element

  // A field can hide itself: `showIf: 'formula'` (e.g. only for credit notes) or `hideZero` (CGST on an inter-state bill).
  const visibility = () => {
    const scope = makeScope(table, data, ctx);
    for (const f of table.fields) {
      const w = wraps.get(f.id);
      if (!w) continue;
      let show = true;
      if (f.showIf) show = isTruthy(tryEvaluate(f.showIf, scope, true));
      if (show && f.hideZero) show = !isBlank(data[f.id]) && toNum(data[f.id]) !== 0;
      w.hidden = !show;
    }
  };
  const refresh = () => {
    data = computeRecord(table, data, ctx);
    for (const c of controls.values()) c.sync();
    for (const e of editors.values()) e.sync();
    visibility();
    paintWalkIn();
  };

  // Walk-in counter sale: a new bill with no customer and no payment typed in is paid in full, in Cash by default.
  // Nobody has to register the customer or tap "Cash received"; scan, Enter, Save. Paid by UPI? Tap "UPI received".
  const wi = table.walkIn && !record && !preview ? table.walkIn : null;
  const wiPay = wi && table.fields.find((f) => f.id === wi.payments && f.type === 'lines');
  const wiAmount = wiPay?.columns?.find((c) => c.type === 'money' && !isComputed(c));
  const wiMode = wiPay?.columns?.find((c) => c.type === 'select');
  const walkInNote = h('span.walkin-note', { role: 'status', hidden: true });
  function walkInDue() {
    if (!wiPay || !wiAmount || !isBlank(data[wi.party])) return 0;
    if ((data[wiPay.id] || []).some((r) => !rowIsBlank(wiPay, r))) return 0;
    if (wi.when && !isTruthy(tryEvaluate(wi.when, makeScope(table, data, ctx), false))) return 0;
    return Math.max(0, toNum(data.balance ?? data.total));
  }
  function paintWalkIn() {
    const due = walkInDue();
    walkInNote.hidden = !due;
    if (due) walkInNote.textContent = `${t('Walk-in: saves as paid {amount} in {mode}', { amount: fmtMoney(due), mode: wi.mode })}`;
  }
  function applyWalkIn() {
    const due = walkInDue();
    if (!due) return;
    const row = { ...newRow(wiPay, ctx), [wiAmount.id]: due };
    if (wiMode) row[wiMode.id] = wi.mode;
    data = computeRecord(table, { ...data, [wiPay.id]: [...(data[wiPay.id] || []).filter((r) => !rowIsBlank(wiPay, r)), row] }, ctx);
  }
  const focusAfter = (fid) => {
    const i = order.findIndex((o) => o.id === fid);
    for (let j = i + 1; i >= 0 && j < order.length; j++) {
      if (!wraps.get(order[j].id)?.hidden) { order[j].focus(); return; }
    }
    saveBtn.focus();
  };

  // "Customer phone" is filled from the customer; typing a known phone the other way round picks the customer.
  const reverse = new Map();    // target field -> { lookup field, source field in the linked table }
  for (const f of table.fields) {
    if (f.type !== 'lookup' || !f.fill) continue;
    for (const [target, src] of Object.entries(f.fill)) {
      const tf = table.fields.find((x) => x.id === target);
      if (tf?.type === 'phone' || (tf && store.table(f.ref)?.fields.find((x) => x.id === src)?.unique)) reverse.set(target, { lookup: f, src });
    }
  }
  function recognise(target) {
    const r = reverse.get(target);
    if (!r || !isBlank(data[r.lookup.id])) return;
    const v = data[target];
    const ref = store.table(r.lookup.ref);
    const srcField = ref?.fields.find((x) => x.id === r.src);
    if (!ref || isBlank(v) || (srcField?.type === 'phone' && String(v).replace(/\D/g, '').length < 10)) return;
    const hits = findDuplicates(ref, r.src, { [r.src]: v }, store.records(ref.id));
    if (hits.length !== 1) return;
    data[r.lookup.id] = hits[0].id;
    refresh();
    toast(`✓ ${t('Recognised')}: ${recordLabel(ref, hits[0])}`);
  }

  async function quickCreate(f, q, done) {
    const ref = store.table(f.ref);
    const initial = parseQuickCreate(ref, q);
    const pick = (rec) => { data[f.id] = rec.id; dirty = true; refresh(); done?.(rec.id); focusAfter(f.id); };
    // enough to save right away (e.g. "Ravi 98765 43210")? Then do it: no popup, one Undo away.
    const phone = ref.fields.find((x) => x.type === 'phone');
    const ready = !isBlank(initial[ref.titleField]) && (!phone || !isBlank(initial[phone.id]))
      && ref.fields.every((x) => !x.required || isComputed(x) || !isBlank(initial[x.id]) || x.default !== undefined || x.autoCode);
    if (ready && !store.softDuplicates(ref.id, initial).length) {
      const res = await store.saveRecord(ref.id, initial, { by: store.currentUser });
      if (res.ok) {
        pick(res.record);
        toast(`＋ ${t('Added')} ${recordLabel(ref, res.record)}`, { action: { label: t('Undo'), fn: async () => { await store.deleteRecord(ref.id, res.record.id); if (data[f.id] === res.record.id) { data[f.id] = ''; refresh(); } } }, ms: 7000 });
        return;
      }
    }
    openRecordModal(store, f.ref, initial, pick);
  }

  const grid = h('div.form-grid');
  for (const f of table.fields) {
    if (f.hidden) continue;
    const width = f.type === 'lines' ? 'full' : f.width || 'full';
    const err = h('div.err', { hidden: true });
    errEls.set(f.id, err);
    let body;
    if (f.type === 'lines') {
      const ed = linesEditor({
        store, table, field: f,
        getRows: () => data[f.id], changed: () => { dirty = true; refresh(); }, getData: () => data,
        onExit: () => focusAfter(f.id),
      });
      editors.set(f.id, ed);
      body = ed.el;
      order.push({ id: f.id, focus: () => ed.focusFirst() });
    } else {
      const ctl = makeControl(store, f, {
        get: () => data[f.id],
        set: (v) => { data[f.id] = v; dirty = true; refresh(); if (reverse.has(f.id)) recognise(f.id); },
        onPick: () => focusAfter(f.id),
        onCreate: f.type === 'lookup' && store.canAddTo(f.ref) ? (q, done) => quickCreate(f, q, done) : undefined,
        tableId: f.id !== table.titleField ? table.id : undefined,
        placeholder: f.autoCode ? () => (isBlank(data[f.autoCode]) ? t('Made from the name') : store.suggestCode(table, f, data))
          : f.id === table.walkIn?.party ? () => `${t('Walk-in customer')} · ${t('type a name or phone')}` : undefined,
      });
      controls.set(f.id, ctl);
      body = ctl.el;
      if (f.type === 'lookup' && f.canCreate && store.canAddTo(f.ref)) {
        body = h('div.with-btn', ctl.el, h('button.btn.small', { type: 'button', tabindex: '-1', title: t('Add new'), onclick: () => openRecordModal(store, f.ref, {}, (rec) => { data[f.id] = rec.id; dirty = true; refresh(); }) }, icon('plus', { size: 16 })));
      }
      if (!isComputed(f)) order.push({ id: f.id, focus: () => (ctl.focusEl || ctl.el).focus() });
    }
    const showHint = f.hint && f.type !== 'lines';
    const wrap = h('div.fld', { class: `w-${width}${f.type === 'checkbox' ? ' check' : ''}${isComputed(f) ? ' computed' : ''}${f.note ? ' note' : ''}`, dataset: { field: f.id } },
      h('span.lbl', f.label, f.required ? h('b.req', { 'aria-hidden': 'true' }, ' *') : null),
      body, showHint ? h('div.hint', f.hint) : null, err);
    wraps.set(f.id, wrap);
    grid.append(wrap);
  }

  const saveBtn = h('button.btn.primary', { type: 'button', onclick: () => submit() }, t('Save'), h('kbd', 'Ctrl+S'));
  const printBtn = table.print && !inModal ? h('button.btn', { type: 'button', onclick: () => submit('print') }, t('Save & print / share'), h('kbd', 'Ctrl+↵')) : null;
  const cancelBtn = h('button.btn.ghost', { type: 'button', onclick: async () => {
    if (dirty && !(await confirmDialog(t('Discard your changes?'), { yes: t('Discard'), danger: true }))) return;
    onCancel?.();
  } }, t('Cancel'));
  const actions = h('div.form-actions', saveBtn, printBtn, cancelBtn, walkInNote);
  const el = h('div.form', banner, grid, actions);

  function clearErrors() {
    banner.hidden = true;
    for (const e of errEls.values()) { e.hidden = true; e.textContent = ''; }
    el.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
  }
  function showErrors(res) {
    let first = null;
    if (res.blocked) { banner.textContent = res.blocked; banner.hidden = false; banner.scrollIntoView({ block: 'nearest' }); return; }
    const general = Object.entries(res.errors || {}).filter(([k]) => k.startsWith('_')).map(([, m]) => m);
    if (general.length) { banner.textContent = general.join('\n'); banner.hidden = false; banner.scrollIntoView({ block: 'nearest' }); }
    for (const [fid, code] of Object.entries(res.errors || {})) {
      const e = errEls.get(fid);
      if (!e) continue;
      e.textContent = ERR[code] ? ERR[code]() : code; e.hidden = false;
      const wrap = e.closest('.fld'); wrap.classList.add('invalid');
      first ||= wrap;
    }
    first?.scrollIntoView({ block: 'center' });
    first?.querySelector('input, select, textarea')?.focus();
    toast(t('Please fix the highlighted fields.'), { kind: 'warn' });
  }

  let saving = false;
  async function submit(after) {
    if (saving) return;
    if (preview) { toast(t('This is only a preview. Nothing is saved.')); return; }
    saving = true;
    try {
      clearErrors();
      // same phone number as someone else? Ask, but never block: two people can share a name, and a family can share a phone.
      const soft = store.softDuplicates(table.id, data, record?.id);
      if (soft.length) {
        const lines = soft.flatMap((s) => {
          const f = table.fields.find((x) => x.id === s.field);
          return s.matches.slice(0, 3).map((m) => `• ${f.label}: ${recordLabel(table, m)}`);
        });
        const ok = await confirmDialog(`${t('Someone with the same details already exists:')}\n${lines.join('\n')}\n\n${t('Save anyway?')}`, { yes: t('Save anyway'), no: t('Go back') });
        if (!ok) return;
      }
      const before = data;
      applyWalkIn();
      const res = await store.saveRecord(table.id, data, { id: record?.id, by: store.currentUser, base });
      if (!res.ok) { data = before; refresh(); showErrors(res); return; }
      dirty = false;
      onSaved?.(res.record, after);
    } finally { saving = false; }
  }

  el.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); submit(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(table.print ? 'print' : undefined); return; }
    // Enter = "next field" on plain inputs (like Tab), the way billing software behaves
    if (e.key === 'Enter' && !e.defaultPrevented && !e.altKey && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      const fid = e.target.closest('[data-field]')?.dataset.field;
      if (!fid) return;
      e.preventDefault();
      // counter flow: scan, scan, Enter on the empty scan bar -> straight to Save (Enter again saves)
      const lf = e.target.closest('.quick') && !e.target.value.trim() ? table.fields.find((f) => f.id === fid) : null;
      if (lf && (data[fid] || []).some((r) => !rowIsBlank(lf, r))) saveBtn.focus();
      else focusAfter(fid);
    }
  });

  refresh();
  // opened with something already filled in (e.g. the name typed in a picker)? Start at the first empty field.
  const firstEmpty = startAtEmpty && !record ? order.find((o) => !isComputed(table.fields.find((f) => f.id === o.id) || {}) && isBlank(data[o.id])) : null;
  const focusField = firstEmpty || (table.focusField ? order.find((o) => o.id === table.focusField) : order[0]);
  return {
    el,
    focus: () => (focusField || order[0])?.focus(),
    isDirty: () => dirty,
    destroy() { for (const c of controls.values()) c.destroy?.(); for (const e of editors.values()) e.destroy?.(); },
  };
}

/** Create a record from a small popup (used by "+ New customer" inside the invoice form). */
export function openRecordModal(store, tableId, initial, done) {
  const table = store.table(tableId);
  let m;
  const form = buildForm({
    store, table, initial, inModal: true, startAtEmpty: Object.keys(initial || {}).length > 0,
    onSaved: (rec) => { m.close(); form.destroy(); done(rec); },
    onCancel: () => { m.close(); form.destroy(); },
  });
  m = modal({ title: `${t('New')}: ${table.name}`, body: form.el, wide: true });
  form.focus();
}
