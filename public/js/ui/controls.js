// Input controls for every field type. The same code powers record forms and line-item cells.
import { h } from './dom.js';
import { combobox } from './combobox.js';
import { t } from '../i18n.js';
import { searchRecords, recordLabel, formatValue, fmtMoney, fmtNumber, fmtDate, isBlank, isComputed } from '../schema.js';

const active = (el) => document.activeElement === el;

/** Second line shown under a lookup match (price + stock, city, ...). */
export function subText(store, table, rec) {
  const ids = table.subFields || [];
  const ctx = store.ctx();
  return ids.map((id) => {
    const f = table.fields.find((x) => x.id === id);
    const v = rec.data[id];
    if (!f || isBlank(v)) return '';
    const s = formatValue(f, v, ctx);
    return f.type === 'number' ? `${f.label}: ${s}` : s;
  }).filter(Boolean).join(' · ');
}

export function lookupOptions(store, refTable, query, limit = 8) {
  return searchRecords(refTable, store.records(refTable.id), query, limit).map((r) => ({
    id: r.id, label: recordLabel(refTable, r), sub: subText(store, refTable, r),
  }));
}

function parseNum(s) {
  const n = parseFloat(String(s).replace(/,/g, '').trim());
  return Number.isNaN(n) ? null : n;
}
const plain = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

/**
 * def: field or column definition. get()/set(v) read and write the draft value.
 * returns { el, sync(), focusEl, isCombo }
 */
export function makeControl(store, def, { get, set, onPick, onCreate, aria, compact = false }) {
  const ctx = store.ctx();
  const label = aria || def.label;

  // calculated / automatic values are read-only outputs
  if (isComputed(def)) {
    const out = h('output.out', { class: def.big ? 'big' : '', 'aria-label': label });
    const fmt = () => {
      const v = get();
      if (def.auto && isBlank(v)) return t('(automatic)');
      const s = formatValue(def, v, ctx);
      return s === '' ? '—' : s;
    };
    const pill = def.colors ? true : false;
    return {
      el: out, computed: true,
      sync() {
        const v = get();
        out.textContent = fmt();
        if (pill && v) out.dataset.tone = def.colors[v] || 'muted';
      },
    };
  }

  switch (def.type) {
    case 'lookup': {
      const refTable = store.table(def.ref);
      const cb = combobox({
        value: get(), placeholder: compact ? '' : t('Type to search…'), ariaLabel: label, className: 'cb-fill',
        getOptions: (q) => (refTable ? lookupOptions(store, refTable, q) : []),
        labelOf: (id) => { const r = ctx.getRecord(def.ref, id); return r && refTable ? recordLabel(refTable, r) : ''; },
        onChange: (id) => set(id),
        onPick,
        onCreate: def.canCreate && onCreate ? (q, done) => onCreate(q, done) : null,
        createLabel: (q) => t('Add "{q}" as new', { q }),
      });
      return { el: cb.el, focusEl: cb.input, isCombo: true, sync() { if (!active(cb.input)) cb.set(get()); }, destroy: cb.destroy };
    }
    case 'select': {
      const sel = h('select', { 'aria-label': label });
      sel.append(h('option', { value: '' }, '—'));
      for (const o of def.options || []) sel.append(h('option', { value: o }, o));
      sel.addEventListener('change', () => set(sel.value));
      return { el: sel, focusEl: sel, sync() { const v = get() ?? ''; if (sel.value !== v) sel.value = v; if (v && ![...sel.options].some((o) => o.value === v)) { sel.append(h('option', { value: v }, v)); sel.value = v; } } };
    }
    case 'checkbox': {
      const cb = h('input', { type: 'checkbox', 'aria-label': label });
      cb.addEventListener('change', () => set(cb.checked));
      return { el: cb, focusEl: cb, sync() { cb.checked = !!get(); } };
    }
    case 'longtext': {
      const ta = h('textarea', { rows: 2, 'aria-label': label });
      ta.addEventListener('input', () => set(ta.value));
      return { el: ta, focusEl: ta, sync() { if (!active(ta) && ta.value !== plain(get())) ta.value = plain(get()); } };
    }
    case 'number': case 'money': {
      const inp = h('input.num', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': label });
      inp.addEventListener('input', () => set(parseNum(inp.value)));
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('blur', () => { inp.value = plain(get()); });
      return { el: inp, focusEl: inp, sync() { if (!active(inp)) inp.value = plain(get()); } };
    }
    case 'date': {
      const inp = h('input', { type: 'date', 'aria-label': label });
      inp.addEventListener('input', () => set(inp.value));
      return { el: inp, focusEl: inp, sync() { if (!active(inp)) inp.value = plain(get()); } };
    }
    default: { // text, phone, email
      const inp = h('input', {
        type: def.type === 'email' ? 'email' : def.type === 'phone' ? 'tel' : 'text',
        inputmode: def.type === 'phone' ? 'tel' : undefined, autocomplete: 'off', 'aria-label': label,
      });
      inp.addEventListener('input', () => set(inp.value));
      return { el: inp, focusEl: inp, sync() { if (!active(inp) && inp.value !== plain(get())) inp.value = plain(get()); } };
    }
  }
}

/** Read-only text for a value (lists, record view). */
export function displayValue(store, def, v) {
  return formatValue(def, v, store.ctx());
}
export { fmtMoney, fmtNumber, fmtDate };
