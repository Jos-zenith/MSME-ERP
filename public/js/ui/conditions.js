// Visual editor for "if" conditions. Used by workflows and by dashboard filters.
import { h } from './dom.js';
import { t } from '../i18n.js';
import { OPS_LABEL, NO_VALUE_OPS, opsForType } from '../logic.js';
import { fieldOf } from '../schema.js';

export const opLabel = (op) => t(OPS_LABEL[op] || op);

/** Every field a condition can look at: own fields, one level of linked-record fields, and line-item columns. */
export function fieldChoices(store, table) {
  const out = [];
  for (const f of table.fields) {
    out.push({ path: f.id, label: f.label, def: f });
    if (f.type === 'lookup') {
      const rt = store.table(f.ref);
      for (const rf of rt?.fields || []) if (rf.type !== 'lines' && rf.type !== 'lookup') out.push({ path: `${f.id}.${rf.id}`, label: `${f.label} › ${rf.label}`, def: rf });
    }
    if (f.type === 'lines') for (const c of f.columns || []) out.push({ path: `${f.id}.${c.id}`, label: `${f.label} › ${c.label}`, def: c });
  }
  return out;
}

export function conditionsEditor(store, table, spec, onChange) {
  spec.conditions ||= [];
  spec.match ||= 'all';
  const choices = fieldChoices(store, table);
  const host = h('div.conds');

  const row = (c, i) => {
    const ch = choices.find((x) => x.path === c.field);
    const def = ch?.def;
    const fieldSel = h('select', { 'aria-label': t('Field'), onchange: (e) => { c.field = e.target.value; c.op = opsForType(choices.find((x) => x.path === c.field)?.def?.type)[0]; c.value = ''; c.vt = 'value'; changed(true); } },
      h('option', { value: '' }, t('Choose a field…')), choices.map((x) => h('option', { value: x.path }, x.label)));
    fieldSel.value = c.field || '';
    const ops = opsForType(def?.type);
    const opSel = h('select', { 'aria-label': t('Condition'), onchange: (e) => { c.op = e.target.value; changed(true); } }, ops.map((o) => h('option', { value: o }, opLabel(o))));
    if (c.op && !ops.includes(c.op)) opSel.append(h('option', { value: c.op }, opLabel(c.op)));
    opSel.value = c.op || ops[0];
    if (!c.op) c.op = ops[0];

    let valueEl = null;
    if (c.field && !NO_VALUE_OPS.includes(c.op) && c.op !== 'empty' && c.op !== 'notempty') {
      const modeSel = (def?.type === 'number' || def?.type === 'money' || def?.type === 'date')
        ? h('select.narrow', { 'aria-label': t('Compare with'), onchange: (e) => { c.vt = e.target.value; c.value = ''; changed(true); } },
          h('option', { value: 'value' }, t('a value')), h('option', { value: 'field' }, t('another field')))
        : null;
      if (modeSel) modeSel.value = c.vt || 'value';
      let input;
      if (c.vt === 'field') {
        input = h('select', { 'aria-label': t('Other field'), onchange: (e) => { c.value = e.target.value; changed(); } },
          h('option', { value: '' }, t('Choose a field…')), choices.filter((x) => !x.path.includes('.') && x.def.type === def.type).map((x) => h('option', { value: x.path }, x.label)));
      } else if (def?.type === 'select') {
        input = h('select', { onchange: (e) => { c.value = e.target.value; changed(); } }, h('option', { value: '' }, '—'), (def.options || []).map((o) => h('option', { value: o }, o)));
      } else if (def?.type === 'checkbox') {
        input = h('select', { onchange: (e) => { c.value = e.target.value; changed(); } }, h('option', { value: 'true' }, t('Yes')), h('option', { value: 'false' }, t('No')));
        if (!c.value) c.value = 'true';
      } else if (def?.type === 'lookup') {
        const rt = store.table(def.ref);
        input = h('select', { onchange: (e) => { c.value = e.target.value; changed(); } }, h('option', { value: '' }, '—'),
          store.records(def.ref).slice(0, 200).map((r) => h('option', { value: r.id }, rt.labelFields?.map((id) => r.data[id]).filter(Boolean).join(' · ') || r.id)));
      } else {
        input = h('input', { type: def?.type === 'date' && ['=', '>', '<'].includes(c.op) ? 'date' : (def?.type === 'number' || def?.type === 'money' || ['next_days', 'older_days'].includes(c.op)) ? 'number' : 'text', 'aria-label': t('Value'), oninput: (e) => { c.value = e.target.value; changed(); } });
      }
      input.value = c.value ?? '';
      valueEl = [modeSel, input];
    }
    return h('div.cond', fieldSel, opSel, valueEl,
      h('button.icon-btn', { type: 'button', 'aria-label': t('Remove'), onclick: () => { spec.conditions.splice(i, 1); changed(true); } }, '✕'));
  };

  const paint = () => {
    host.replaceChildren();
    if (spec.conditions.length > 1) {
      host.append(h('div.match', t('Match'), ' ', h('select', { 'aria-label': t('Match'), onchange: (e) => { spec.match = e.target.value; changed(); } },
        h('option', { value: 'all' }, t('ALL of these')), h('option', { value: 'any' }, t('ANY of these')))));
      host.querySelector('select').value = spec.match;
    }
    spec.conditions.forEach((c, i) => host.append(row(c, i)));
    host.append(h('button.btn.small', { type: 'button', onclick: () => { spec.conditions.push({ field: '', op: '=', value: '', vt: 'value' }); changed(true); } }, `＋ ${t('Add condition')}`));
  };
  function changed(repaint) { if (repaint) paint(); onChange?.(); }
  paint();
  return host;
}
export { fieldOf };
