// Generic record form, generated from a table definition. Works for any table the user builds.
import { h, modal, toast, confirmDialog } from './dom.js';
import { makeControl } from './controls.js';
import { linesEditor } from './lines.js';
import { t } from '../i18n.js';
import { computeRecord, newRecordData, recordLabel, isComputed } from '../schema.js';

const ERR = {
  required: () => t('This is required'),
  bad_email: () => t('Enter a valid email address'),
  bad_phone: () => t('Enter a valid phone number'),
  bad_number: () => t('Enter a number'),
  too_small: () => t('The value is too small'),
  duplicate: () => t('Another record already uses this value'),
};

/**
 * @param {object} o { store, table, record?, initial?, onSaved(record, after), onCancel?, modal? }
 */
export function buildForm({ store, table, record, initial = {}, onSaved, onCancel, inModal = false, preview = false }) {
  const ctx = store.ctx();
  let data = computeRecord(table, { ...newRecordData(table), ...(record?.data || {}), ...initial }, ctx);
  let dirty = false;
  const controls = new Map();   // field id -> control
  const editors = new Map();    // lines field id -> editor
  const errEls = new Map();
  const order = [];             // keyboard order: [{id, focus()}]

  const banner = h('div.banner.error', { role: 'alert', hidden: true });

  const refresh = () => {
    data = computeRecord(table, data, ctx);
    for (const c of controls.values()) c.sync();
    for (const e of editors.values()) e.sync();
  };
  const focusAfter = (fid) => {
    const i = order.findIndex((o) => o.id === fid);
    if (i >= 0 && order[i + 1]) order[i + 1].focus(); else saveBtn.focus();
  };

  const grid = h('div.form-grid');
  for (const f of table.fields) {
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
        set: (v) => { data[f.id] = v; dirty = true; refresh(); },
        onPick: () => focusAfter(f.id),
        onCreate: (q, done) => openRecordModal(store, f.ref, q ? { [store.table(f.ref).titleField]: q } : {}, (rec) => {
          data[f.id] = rec.id; dirty = true; refresh(); done(rec.id); focusAfter(f.id);
        }),
      });
      controls.set(f.id, ctl);
      body = ctl.el;
      if (f.type === 'lookup' && f.canCreate) {
        body = h('div.with-btn', ctl.el, h('button.btn.small', { type: 'button', tabindex: '-1', title: t('Add new'), onclick: () => openRecordModal(store, f.ref, {}, (rec) => { data[f.id] = rec.id; dirty = true; refresh(); }) }, '＋'));
      }
      if (!isComputed(f)) order.push({ id: f.id, focus: () => (ctl.focusEl || ctl.el).focus() });
    }
    const showHint = f.hint && f.type !== 'lines';
    grid.append(h('div.fld', { class: `w-${width}${f.type === 'checkbox' ? ' check' : ''}${isComputed(f) ? ' computed' : ''}`, dataset: { field: f.id } },
      h('span.lbl', f.label, f.required ? h('b.req', { 'aria-hidden': 'true' }, ' *') : null),
      body, showHint ? h('div.hint', f.hint) : null, err));
  }

  const saveBtn = h('button.btn.primary', { type: 'button', onclick: () => submit() }, t('Save'), h('kbd', 'Ctrl+S'));
  const printBtn = table.print && !inModal ? h('button.btn', { type: 'button', onclick: () => submit('print') }, t('Save & print / share'), h('kbd', 'Ctrl+↵')) : null;
  const cancelBtn = h('button.btn.ghost', { type: 'button', onclick: async () => {
    if (dirty && !(await confirmDialog(t('Discard your changes?'), { yes: t('Discard'), danger: true }))) return;
    onCancel?.();
  } }, t('Cancel'));
  const actions = h('div.form-actions', saveBtn, printBtn, cancelBtn);
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
      const res = await store.saveRecord(table.id, data, { id: record?.id, by: store.currentUser });
      if (!res.ok) { showErrors(res); return; }
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
      if (fid) { e.preventDefault(); focusAfter(fid); }
    }
  });

  refresh();
  const focusField = table.focusField ? order.find((o) => o.id === table.focusField) : order[0];
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
    store, table, initial, inModal: true,
    onSaved: (rec) => { m.close(); form.destroy(); done(rec); },
    onCancel: () => { m.close(); form.destroy(); },
  });
  m = modal({ title: `${t('New')}: ${table.name}`, body: form.el, wide: true });
  form.focus();
}
