// App builder: tables and forms designed visually (drag & drop), no code.
import { h, toast, confirmDialog, promptDialog, debounce } from '../ui/dom.js';
import { t } from '../i18n.js';
import { pageHeader, tabs, emptyState, labeled, pill } from '../ui/bits.js';
import { buildForm } from '../ui/form.js';
import { FIELD_TYPES, COLUMN_TYPES, uniqueId, fieldOf } from '../schema.js';
import { check } from '../formula.js';
import { rulesList } from './workflows.js';
import { dashList } from './dashbuild.js';

const TONES = ['', 'good', 'warn', 'bad', 'info'];
const toneLabel = (x) => ({ '': t('no colour'), good: t('green'), warn: t('amber'), bad: t('red'), info: t('blue') })[x];

// ---- landing ---------------------------------------------------------------------------------------------
export function buildHome(ctx, tab = 'tables') {
  const { store } = ctx;
  const body = h('div');
  const paint = () => {
    body.replaceChildren();
    if (tab === 'rules') { body.append(rulesList(ctx)); return; }
    if (tab === 'dashboards') { body.append(dashList(ctx)); return; }
    const list = h('div.cards-grid');
    for (const tb of store.app.tables) {
      list.append(h('a.card.tile', { href: `#/build/t/${tb.id}` }, h('div.tile-ic', tb.icon || '📄'), h('h3', tb.name),
        h('p.muted', `${tb.fields.length} ${t('fields')} · ${store.count(tb.id)} ${t('records')}`),
        h('span.link', `✎ ${t('Design')}`)));
    }
    list.append(h('button.card.tile.add', { onclick: async () => {
      const name = await promptDialog(t('Name of the new table (e.g. Orders, Suppliers)'), '');
      if (!name?.trim()) return;
      const id = uniqueId(name, store.app.tables.map((x) => x.id));
      store.app.tables.push({
        id, name: name.trim(), icon: '📄', titleField: 'name', labelFields: ['name'], searchFields: ['name'], listColumns: ['name'],
        fields: [{ id: 'name', label: t('Name'), type: 'text', required: true }],
      });
      store.touchApp();
      location.hash = `#/build/t/${id}`;
    } }, h('div.tile-ic', '＋'), h('h3', t('New table'))));
    body.append(h('p.hint', t('A table is a list of things you keep track of: customers, items, orders, service jobs…')), list);
  };
  paint();
  return h('div.build',
    pageHeader(t('App builder'), h('a.btn.ghost', { href: '#/' }, `← ${t('Back to app')}`)),
    tabs([{ id: 'tables', label: t('Tables & forms') }, { id: 'rules', label: t('Workflows') }, { id: 'dashboards', label: t('Dashboards') }], tab,
      (id) => { location.hash = id === 'tables' ? '#/build' : `#/build/${id}`; }),
    body);
}

// ---- dependencies (so deleting a field never silently breaks a workflow) -------------------------------------
function usagesOf(store, table, fieldId) {
  const out = [];
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${fieldId}([^\\p{L}\\p{N}_]|$)`, 'u');
  for (const f of table.fields) {
    if (f.formula && f.id !== fieldId && re.test(f.formula)) out.push(`${t('Formula of')} “${f.label}”`);
    for (const c of f.columns || []) if (c.formula && re.test(c.formula) && f.id === fieldId) out.push(`${t('Formula of')} “${f.label} › ${c.label}”`);
  }
  for (const r of store.app.rules || []) {
    if (r.table !== table.id) continue;
    const json = JSON.stringify(r);
    if (r.field === fieldId || (r.conditions || []).some((c) => c.field?.split('.')[0] === fieldId || c.value === fieldId) || json.includes(`{{${fieldId}`) || json.includes(`"${fieldId}"`)) out.push(`${t('Workflow')} “${r.name}”`);
  }
  for (const d of store.app.dashboards || []) for (const w of d.widgets) if (w.table === table.id && JSON.stringify(w).includes(`"${fieldId}"`)) out.push(`${t('Dashboard')} “${d.name}” › ${w.title}`);
  return out;
}

// ---- table designer ---------------------------------------------------------------------------------------------
export function tableDesigner(ctx, tableId) {
  const { store } = ctx;
  const table = store.table(tableId);
  if (!table) return emptyState('❓', t('Not found'), '', h('a.btn', { href: '#/build' }, t('Back')));
  let sel = null;          // { fid, cid? }
  let mode = 'design';     // design | preview
  const save = debounce(() => store.touchApp(), 250);

  const canvas = h('div.canvas');
  const panel = h('aside.panel');
  const palette = h('div.palette');
  const stage = h('div');

  // ---- add / move / delete
  function newField(type) {
    const label = t(FIELD_TYPES[type].label);
    const f = { id: uniqueId(label, table.fields.map((x) => x.id)), label, type };
    if (type === 'select') f.options = [t('Option 1'), t('Option 2')];
    if (type === 'lookup') f.ref = (store.app.tables.find((x) => x.id !== table.id) || table).id;
    if (type === 'lines') {
      f.columns = [
        { id: 'item', label: t('Item'), type: 'text' },
        { id: 'qty', label: t('Qty'), type: 'number', default: 1 },
        { id: 'price', label: t('Price'), type: 'money' },
        { id: 'amount', label: t('Amount'), type: 'money', formula: 'qty * price' },
      ];
    }
    return f;
  }
  function addField(type, at) {
    const f = newField(type);
    table.fields.splice(at ?? table.fields.length, 0, f);
    sel = { fid: f.id };
    save(); paintAll();
    panel.querySelector('input')?.select();
  }
  function move(i, to) {
    if (to < 0 || to >= table.fields.length || i === to) return;
    const [f] = table.fields.splice(i, 1);
    table.fields.splice(to, 0, f);
    save(); paintCanvas();
  }
  async function removeField(f) {
    const uses = usagesOf(store, table, f.id);
    const msg = uses.length
      ? `${t('Delete “{name}”?', { name: f.label })}\n\n${t('These use it and will stop working:')}\n• ${uses.join('\n• ')}`
      : t('Delete “{name}”? Values already saved in it will be hidden.', { name: f.label });
    if (!(await confirmDialog(msg, { yes: t('Delete'), danger: true }))) return;
    table.fields.splice(table.fields.indexOf(f), 1);
    for (const k of ['labelFields', 'searchFields', 'listColumns', 'subFields']) if (table[k]) table[k] = table[k].filter((x) => x !== f.id);
    if (table.titleField === f.id) table.titleField = table.fields.find((x) => x.type === 'text')?.id || table.fields[0]?.id;
    sel = null; save(); paintAll();
  }

  // ---- palette (click or drag onto the form)
  for (const [type, meta] of Object.entries(FIELD_TYPES)) {
    palette.append(h('button.pal', { type: 'button', draggable: 'true', title: t('Click to add, or drag onto the form'),
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', `new:${type}`); e.dataTransfer.effectAllowed = 'copy'; },
      onclick: () => addField(type) }, h('span.pal-ic', meta.icon), t(meta.label)));
  }

  // ---- canvas
  function paintCanvas() {
    canvas.replaceChildren();
    table.fields.forEach((f, i) => {
      const badges = [f.required ? pill(t('required'), 'info') : null, f.formula ? pill(t('calculated'), 'muted') : null, f.auto ? pill(t('auto number'), 'muted') : null, f.unique ? pill(t('unique'), 'muted') : null];
      const card = h('div.fcard', {
        draggable: 'true', class: sel?.fid === f.id ? 'sel' : '', tabindex: 0, dataset: { i },
        ondragstart: (e) => { e.dataTransfer.setData('text/plain', `move:${i}`); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); },
        ondragend: () => card.classList.remove('dragging'),
        ondragover: (e) => { e.preventDefault(); card.classList.add('over'); },
        ondragleave: () => card.classList.remove('over'),
        ondrop: (e) => { e.preventDefault(); card.classList.remove('over'); dropAt(e.dataTransfer.getData('text/plain'), i); },
        onclick: () => { sel = { fid: f.id }; paintCanvas(); paintPanel(); },
        onkeydown: (e) => { if (e.key === 'Enter' && e.target === card) { sel = { fid: f.id }; paintCanvas(); paintPanel(); } },
      },
      h('span.handle', { 'aria-hidden': 'true' }, '⠿'), h('span.fic', FIELD_TYPES[f.type]?.icon), h('div.fmain', h('b', f.label), h('span.muted', ` ${t(FIELD_TYPES[f.type]?.label || f.type)}${f.type === 'lookup' ? ` → ${store.table(f.ref)?.name || '?'}` : ''}`),
        f.type === 'lines' ? h('div.muted.small', (f.columns || []).map((c) => c.label).join(' · ')) : null, h('div.badges', badges)),
      h('div.fbtns', h('button.icon-btn', { 'aria-label': t('Move up'), onclick: (e) => { e.stopPropagation(); move(i, i - 1); } }, '▲'),
        h('button.icon-btn', { 'aria-label': t('Move down'), onclick: (e) => { e.stopPropagation(); move(i, i + 1); } }, '▼'),
        h('button.icon-btn', { 'aria-label': t('Delete field'), onclick: (e) => { e.stopPropagation(); removeField(f); } }, '🗑')));
      canvas.append(card);
    });
    canvas.append(h('div.dropzone', { ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); }, ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); dropAt(e.dataTransfer.getData('text/plain'), table.fields.length); } }, t('Drag a field type here to add it')));
  }
  function dropAt(payload, index) {
    if (payload.startsWith('new:')) addField(payload.slice(4), index);
    else if (payload.startsWith('move:')) { const from = +payload.slice(5); move(from, from < index ? index - 1 : index); }
  }

  // ---- settings panel
  const names = (list) => list.map((x) => ({ id: x.id, label: x.label }));
  function formulaEditor(def, scopeNames, onChange) {
    const ta = h('textarea', { rows: 2, spellcheck: 'false', placeholder: t('e.g. qty * price   or   IF(balance > 0, "Due", "Paid")'), 'aria-label': t('Formula') });
    ta.value = def.formula || '';
    const status = h('div.hint');
    const known = (n) => scopeNames.some((x) => x.id === n) || n === 'business' || n === 'today';
    const validate = () => {
      const p = check(ta.value, known);
      status.textContent = p ? `⚠ ${p}` : `✓ ${t('Formula looks good')}`;
      status.className = p ? 'hint bad' : 'hint good';
    };
    const insert = (txt) => { const s = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, s) + txt + ta.value.slice(ta.selectionEnd ?? s); ta.focus(); ta.selectionStart = ta.selectionEnd = s + txt.length; ta.dispatchEvent(new Event('input')); };
    ta.addEventListener('input', () => { def.formula = ta.value.trim(); validate(); onChange(); });
    validate();
    return h('div.formula', ta, status,
      h('div.chips.small', h('span.muted', t('Fields:')), scopeNames.map((n) => h('button.chip', { type: 'button', onclick: () => insert(n.id), title: n.id }, n.label))),
      h('div.chips.small', h('span.muted', t('Functions:')), ['SUM(', 'IF(', 'ROUND(', 'MIN(', 'MAX(', 'TODAY()', 'DAYS('].map((fn) => h('button.chip', { type: 'button', onclick: () => insert(fn) }, fn))));
  }

  function optionsEditor(def) {
    def.options ||= [];
    const host = h('div.opts-edit');
    const paint = () => {
      host.replaceChildren();
      def.options.forEach((o, i) => {
        const tone = def.colors?.[o] || '';
        host.append(h('div.opt-row',
          h('input', { value: o, 'aria-label': t('Choice'), onchange: (e) => {
            const nv = e.target.value.trim() || o;
            if (def.colors && def.colors[o]) { def.colors[nv] = def.colors[o]; delete def.colors[o]; }
            def.options[i] = nv; if (def.default === o) def.default = nv; save(); paintCanvas();
          } }),
          h('select', { 'aria-label': t('Colour'), onchange: (e) => { def.colors ||= {}; if (e.target.value) def.colors[def.options[i]] = e.target.value; else delete def.colors[def.options[i]]; save(); } },
            TONES.map((x) => h('option', { value: x, selected: x === tone }, toneLabel(x)))),
          h('button.icon-btn', { type: 'button', 'aria-label': t('Remove'), onclick: () => { def.options.splice(i, 1); save(); paint(); } }, '✕')));
      });
      host.append(h('button.btn.small', { type: 'button', onclick: () => { def.options.push(`${t('Option')} ${def.options.length + 1}`); save(); paint(); } }, `＋ ${t('Add choice')}`));
    };
    paint();
    return host;
  }

  function fillEditor(def, targets, refTable) {
    def.fill ||= {};
    const host = h('div');
    const paint = () => {
      host.replaceChildren();
      Object.entries(def.fill).forEach(([target, src]) => {
        host.append(h('div.fill-row',
          h('select', { 'aria-label': t('Fill this field'), onchange: (e) => { delete def.fill[target]; def.fill[e.target.value] = src; save(); paint(); } }, targets.map((x) => h('option', { value: x.id, selected: x.id === target }, x.label))),
          h('span', '←'),
          h('select', { 'aria-label': t('with'), onchange: (e) => { def.fill[target] = e.target.value; save(); } }, refTable.fields.filter((x) => x.type !== 'lines').map((x) => h('option', { value: x.id, selected: x.id === src }, x.label))),
          h('button.icon-btn', { type: 'button', 'aria-label': t('Remove'), onclick: () => { delete def.fill[target]; save(); paint(); } }, '✕')));
      });
      const free = targets.find((x) => !(x.id in def.fill));
      if (free) host.append(h('button.btn.small', { type: 'button', onclick: () => { def.fill[free.id] = refTable.fields.find((x) => x.type !== 'lines')?.id; save(); paint(); } }, `＋ ${t('Fill another field')}`));
    };
    paint();
    return host;
  }

  /** Settings for one field or one line-item column. */
  function settingsFor(def, { column = false, siblings, parentField } = {}) {
    const box = h('div.settings');
    const types = column ? COLUMN_TYPES : Object.keys(FIELD_TYPES);
    const scopeNames = column ? names([...table.fields.filter((x) => x.type !== 'lines'), ...siblings.filter((x) => x !== def)]) : names(table.fields.filter((x) => x !== def));
    const linesSums = column ? [] : table.fields.filter((x) => x.type === 'lines').flatMap((lf) => (lf.columns || []).map((c) => ({ id: `${lf.id}.${c.id}`, label: `${lf.label} › ${c.label}` })));
    const changed = () => { save(); paintCanvas(); };
    const typeSel = h('select', { 'aria-label': t('Type'), onchange: (e) => {
      def.type = e.target.value;
      if (def.type === 'select' && !def.options) def.options = [t('Option 1'), t('Option 2')];
      if (def.type === 'lookup' && !def.ref) def.ref = store.app.tables[0].id;
      if (def.type === 'lines' && !def.columns) def.columns = [{ id: 'item', label: t('Item'), type: 'text' }];
      changed(); paintPanel();
    } }, types.map((x) => h('option', { value: x, selected: x === def.type }, t(FIELD_TYPES[x]?.label || x))));
    if (!types.includes(def.type)) typeSel.append(h('option', { value: def.type, selected: true }, def.type));

    box.append(
      labeled(t('Label'), h('input', { value: def.label, oninput: (e) => { def.label = e.target.value; changed(); } })),
      labeled(t('Type'), typeSel));

    if (!column) {
      box.append(h('div.two',
        h('label.check', h('input', { type: 'checkbox', checked: !!def.required, onchange: (e) => { def.required = e.target.checked; changed(); } }), ` ${t('Required')}`),
        labeled(t('Width'), h('select', { onchange: (e) => { def.width = e.target.value; save(); } }, [['full', t('Full row')], ['half', t('Half')], ['third', t('One third')]].map(([v, l]) => h('option', { value: v, selected: (def.width || 'full') === v }, l))))));
      box.append(labeled(t('Help text (shown under the field)'), h('input', { value: def.hint || '', oninput: (e) => { def.hint = e.target.value; save(); } })));
    }

    if (def.type === 'select') box.append(h('div.section', h('h4', t('Choices')), optionsEditor(def)));

    if (def.type === 'lookup') {
      const refSel = h('select', { onchange: (e) => { def.ref = e.target.value; def.fill = {}; save(); paintPanel(); paintCanvas(); } }, store.app.tables.map((x) => h('option', { value: x.id, selected: x.id === def.ref }, x.name)));
      const rt = store.table(def.ref);
      box.append(h('div.section', h('h4', t('Linked table')), labeled(t('Pick from'), refSel),
        !column ? h('label.check', h('input', { type: 'checkbox', checked: !!def.canCreate, onchange: (e) => { def.canCreate = e.target.checked; save(); } }), ` ${t('Allow adding a new one from this form')}`) : null,
        rt ? [h('h4', t('Auto-fill from the chosen record')), h('p.hint', t('When someone picks a record here, copy its values into these fields.')),
          fillEditor(def, column ? siblings.filter((x) => x !== def && !x.formula) : table.fields.filter((x) => x !== def && x.type !== 'lines' && !x.formula), rt)] : null));
    }

    if (['text', 'phone', 'email'].includes(def.type) && !column) {
      box.append(h('div.section', h('h4', t('Duplicates')),
        h('label.check', h('input', { type: 'checkbox', checked: !!def.unique, onchange: (e) => { def.unique = e.target.checked; if (def.unique) def.warnDuplicate = false; changed(); paintPanel(); } }), ` ${t('Never allow two records with the same value (e.g. item code)')}`),
        !def.unique ? h('label.check', h('input', { type: 'checkbox', checked: !!def.warnDuplicate, onchange: (e) => { def.warnDuplicate = e.target.checked; save(); } }), ` ${t('Just warn me (e.g. same phone number). Never blocks saving.')}`) : null));
    }

    if (def.type === 'text' && !column) {
      box.append(h('div.section', h('label.check', h('input', { type: 'checkbox', checked: !!def.auto, onchange: (e) => { def.auto = e.target.checked ? { prefix: 'NO-', pad: 4 } : undefined; delete def.formula; changed(); paintPanel(); } }), ` ${t('Number automatically (INV-0001, INV-0002…)')}`),
        def.auto ? h('div.two', labeled(t('Starts with'), h('input', { value: def.auto.prefix, oninput: (e) => { def.auto.prefix = e.target.value; save(); } })), labeled(t('Digits'), h('input', { type: 'number', min: 1, max: 9, value: def.auto.pad, oninput: (e) => { def.auto.pad = +e.target.value || 4; save(); } }))) : null));
    }

    if (def.type === 'number' || def.type === 'money') {
      if (!def.formula) box.append(labeled(t('Smallest allowed value (optional)'), h('input', { type: 'number', value: def.min ?? '', oninput: (e) => { def.min = e.target.value === '' ? undefined : +e.target.value; save(); } })));
    }

    if (!def.auto && def.type !== 'lines' && def.type !== 'lookup') {
      const calc = h('input', { type: 'checkbox', checked: !!def.formula, onchange: (e) => { if (e.target.checked) def.formula = def.formula || (column ? 'qty * price' : ''); else delete def.formula; changed(); paintPanel(); } });
      box.append(h('div.section', h('label.check', calc, ` ${t('Calculated automatically from other fields')}`),
        def.formula !== undefined ? formulaEditor(def, [...scopeNames, ...linesSums], changed) : null));
    }

    if (!def.formula && !def.auto && def.type !== 'lines' && def.type !== 'lookup') {
      let dflt;
      if (def.type === 'checkbox') dflt = h('label.check', h('input', { type: 'checkbox', checked: !!def.default, onchange: (e) => { def.default = e.target.checked; save(); } }), ` ${t('Ticked by default')}`);
      else if (def.type === 'date') dflt = h('label.check', h('input', { type: 'checkbox', checked: def.default === 'today', onchange: (e) => { def.default = e.target.checked ? 'today' : ''; save(); } }), ` ${t('Start with today’s date')}`);
      else if (def.type === 'select') dflt = labeled(t('Default choice'), h('select', { onchange: (e) => { def.default = e.target.value; save(); } }, h('option', { value: '' }, '—'), (def.options || []).map((o) => h('option', { value: o, selected: o === def.default }, o))));
      else dflt = labeled(t('Default value'), h('input', { value: def.default ?? '', oninput: (e) => { def.default = def.type === 'number' || def.type === 'money' ? (e.target.value === '' ? '' : +e.target.value) : e.target.value; save(); } }));
      box.append(dflt);
    }

    if (def.type === 'lines') box.append(columnsEditor(def));
    return box;
  }

  function columnsEditor(f) {
    f.columns ||= [];
    const host = h('div.section', h('h4', t('Columns')));
    f.columns.forEach((c, i) => {
      host.append(h('div.colrow', { class: sel?.cid === c.id ? 'sel' : '', onclick: () => { sel = { fid: f.id, cid: c.id }; paintPanel(); } },
        h('span.fic', FIELD_TYPES[c.type]?.icon), h('b', c.label), h('span.muted', c.formula ? ` = ${c.formula}` : ''),
        h('span.spacer'),
        h('button.icon-btn', { 'aria-label': t('Move up'), onclick: (e) => { e.stopPropagation(); if (i > 0) { f.columns.splice(i - 1, 0, f.columns.splice(i, 1)[0]); save(); paintPanel(); paintCanvas(); } } }, '▲'),
        h('button.icon-btn', { 'aria-label': t('Move down'), onclick: (e) => { e.stopPropagation(); if (i < f.columns.length - 1) { f.columns.splice(i + 1, 0, f.columns.splice(i, 1)[0]); save(); paintPanel(); paintCanvas(); } } }, '▼'),
        h('button.icon-btn', { 'aria-label': t('Remove'), onclick: (e) => { e.stopPropagation(); f.columns.splice(i, 1); sel = { fid: f.id }; save(); paintPanel(); paintCanvas(); } }, '✕')));
    });
    host.append(h('button.btn.small', { type: 'button', onclick: () => {
      const label = t('Column');
      const c = { id: uniqueId(label, f.columns.map((x) => x.id)), label, type: 'text' };
      f.columns.push(c); sel = { fid: f.id, cid: c.id }; save(); paintPanel(); paintCanvas();
    } }, `＋ ${t('Add column')}`));
    if (f.columns.some((c) => c.type === 'lookup')) {
      host.append(h('label.check', h('input', { type: 'checkbox', checked: !!f.quickEntry, onchange: (e) => { f.quickEntry = e.target.checked; save(); } }), ` ${t('Show the quick-entry bar (scan a barcode or type a code, then Enter)')}`));
    }
    host.append(h('p.hint', t('Tip: Enter adds the next row automatically; Alt+N adds a row, Alt+D deletes one.')));
    return host;
  }

  function tableSettings() {
    const box = h('div.settings');
    const textish = table.fields.filter((f) => ['text', 'phone', 'email'].includes(f.type) || f.auto);
    const check = (key, label, hint) => {
      table[key] ||= [];
      return h('div.section', h('h4', label), hint ? h('p.hint', hint) : null,
        h('div.checklist', table.fields.filter((f) => f.type !== 'lines').map((f) => h('label.check', h('input', { type: 'checkbox', checked: table[key].includes(f.id), onchange: (e) => {
          const set = new Set(table[key]); if (e.target.checked) set.add(f.id); else set.delete(f.id);
          table[key] = table.fields.map((x) => x.id).filter((id) => set.has(id)); save();
        } }), ` ${f.label}`))));
    };
    box.append(
      labeled(t('Table name'), h('input', { value: table.name, oninput: (e) => { table.name = e.target.value; save(); } })),
      labeled(t('Icon (any emoji)'), h('input', { value: table.icon || '', maxlength: 4, oninput: (e) => { table.icon = e.target.value; save(); } })),
      labeled(t('Main heading of each record'), h('select', { onchange: (e) => { table.titleField = e.target.value; save(); } }, table.fields.filter((f) => f.type !== 'lines').map((f) => h('option', { value: f.id, selected: f.id === table.titleField }, f.label)))),
      h('label.check', h('input', { type: 'checkbox', checked: !!table.quick, onchange: (e) => { table.quick = e.target.checked; save(); } }), ` ${t('Show a “＋ New” shortcut on the home screen')}`),
      check('listColumns', t('Columns shown in the list')),
      check('labelFields', t('How a record is named when picked from another form'), t('Add a second detail (like phone) so two people with the same name can be told apart.')),
      check('searchFields', t('What you can type to find a record'), t('The first one ticked ranks first, so an exact item code always wins.')),
      labeled(t('Status field (shows filter buttons in the list)'), h('select', { onchange: (e) => { table.statusField = e.target.value || undefined; save(); } }, h('option', { value: '' }, '—'), table.fields.filter((f) => f.type === 'select').map((f) => h('option', { value: f.id, selected: f.id === table.statusField }, f.label)))),
      h('details', h('summary', t('Advanced: edit as JSON')), advancedJson(table, (obj) => { Object.keys(table).forEach((k) => delete table[k]); Object.assign(table, obj); save(); paintAll(); })),
      h('div.danger-zone', h('button.btn.danger', { onclick: async () => {
        const n = store.count(tableId);
        if (!(await confirmDialog(`${t('Delete the table “{name}”?', { name: table.name })}${n ? `\n${n} ${t('records will be hidden.')}` : ''}`, { yes: t('Delete table'), danger: true }))) return;
        store.app.tables.splice(store.app.tables.indexOf(table), 1);
        store.app.rules = (store.app.rules || []).filter((r) => r.table !== tableId);
        for (const d of store.app.dashboards || []) d.widgets = d.widgets.filter((w) => w.table !== tableId);
        store.touchApp(); location.hash = '#/build';
      } }, t('Delete this table'))));
    return box;
  }

  function advancedJson(obj, apply) {
    const ta = h('textarea', { rows: 12, spellcheck: 'false', class: 'mono' }); ta.value = JSON.stringify(obj, null, 2);
    return h('div', ta, h('button.btn.small', { onclick: () => {
      try { const o = JSON.parse(ta.value); if (!o.id) throw new Error('missing id'); apply(o); toast(t('Applied.')); } catch (e) { toast(`${t('Invalid JSON')}: ${e.message}`, { kind: 'warn' }); }
    } }, t('Apply')));
  }

  function paintPanel() {
    panel.replaceChildren();
    const f = sel && fieldOf(table, sel.fid);
    if (!f) { panel.append(h('h3', t('Table settings')), tableSettings()); return; }
    const back = h('button.link', { onclick: () => { sel = null; paintCanvas(); paintPanel(); } }, `← ${t('Table settings')}`);
    if (sel.cid) {
      const c = (f.columns || []).find((x) => x.id === sel.cid);
      if (!c) { sel = { fid: f.id }; paintPanel(); return; }
      panel.append(back, h('h3', `${f.label} › ${c.label}`), settingsFor(c, { column: true, siblings: f.columns, parentField: f }),
        h('button.link', { onclick: () => { sel = { fid: f.id }; paintPanel(); } }, `← ${f.label}`));
      return;
    }
    panel.append(back, h('h3', f.label), settingsFor(f),
      h('details', h('summary', t('Advanced: edit as JSON')), advancedJson(f, (obj) => { Object.keys(f).forEach((k) => delete f[k]); Object.assign(f, obj); save(); paintAll(); })));
  }

  function paintStage() {
    stage.replaceChildren();
    if (mode === 'preview') {
      const form = buildForm({ store, table, preview: true });
      stage.append(h('p.hint', t('This is how people will see the form. Try it: nothing you type here is saved.')), h('div.card', form.el));
      return;
    }
    stage.append(h('div.layout-2', h('div.design', h('h3', t('Fields')), palette, canvas), panel));
    paintCanvas(); paintPanel();
  }
  function paintAll() { paintStage(); }
  paintAll();

  const tabsHost = h('div');
  const paintTabs = () => tabsHost.replaceChildren(tabs([{ id: 'design', label: t('Design') }, { id: 'preview', label: t('Preview form') }], mode,
    (m) => { mode = m; if (m === 'preview') sel = null; paintTabs(); paintAll(); }));
  paintTabs();

  return h('div.designer',
    pageHeader(`${table.icon || ''} ${table.name}`, h('a.btn.ghost', { href: '#/build' }, `← ${t('All tables')}`),
      h('a.btn', { href: `#/t/${tableId}` }, t('Open list'))),
    tabsHost, stage);
}
