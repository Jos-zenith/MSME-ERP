// Workflow builder: "when this happens, if this is true, then do this" - no code.
import { h, toast, confirmDialog, debounce } from '../ui/dom.js';
import { t } from '../i18n.js';
import { icon } from '../ui/icons.js';
import { pageHeader, emptyState, labeled, CHANNEL_ICON, channelName } from '../ui/bits.js';
import { conditionsEditor, fieldChoices, opLabel } from '../ui/conditions.js';
import { renderTemplate } from '../logic.js';
import { fieldOf, uid, uniqueId, recordTitle } from '../schema.js';

const TRIGGER_LABEL = () => ({
  created: t('a record is added'), updated: t('a record is changed'), saved: t('a record is added or changed'),
  any: t('a record is added, changed or deleted'), field_changed: t('a field is changed'), deleted: t('a record is deleted'),
  approved: t('an approval is given'), rejected: t('an approval is refused'),
  before_save: t('someone is about to save (check before saving)'), schedule: t('every day (looks at all records)'),
});
const ACTION_LABEL = () => ({
  message: t('Send a message or alert'), set_field: t('Change a field'), create_record: t('Add a record (e.g. a task)'),
  approval: t('Ask the owner to approve'), adjust_stock: t('Add / remove stock'), webhook: t('Send to another app (webhook)'),
  block: t('Stop the save and show a message'),
});

export function describeRule(store, r) {
  const table = store.table(r.table);
  if (!table) return t('This workflow points to a table that no longer exists.');
  const ev = TRIGGER_LABEL()[r.trigger] || r.trigger;
  const fld = r.trigger === 'field_changed' && r.field ? ` (${fieldOf(table, r.field)?.label || r.field})` : '';
  const conds = (r.conditions || []).filter((c) => c.field).map((c) => `${fieldChoices(store, table).find((x) => x.path === c.field)?.label || c.field} ${opLabel(c.op)} ${c.value ?? ''}`.trim());
  const acts = (r.actions || []).map((a) => (a.type === 'message' ? `${channelName(a.channel)}` : ACTION_LABEL()[a.type]));
  return `${t('When')} ${ev}${fld} ${t('in')} “${table.name}”` +
    (conds.length ? `, ${t('if')} ${conds.join(r.match === 'any' ? ` ${t('or')} ` : ` ${t('and')} `)}` : '') +
    ` → ${acts.join(', ') || t('(no action yet)')}`;
}

// ---- recipes: one-click starting points -----------------------------------------------------------------------------
function recipes(store) {
  const tables = store.app.tables;
  const find = (pred) => { for (const tb of tables) { const f = tb.fields.find((x) => pred(x, tb)); if (f) return [tb, f]; } return []; };
  return [
    { icon: '📉', title: t('Alert me when a number gets low'), build() {
      const [tb, f] = find((x) => x.type === 'number' && !x.formula);
      if (!tb) return null;
      return { table: tb.id, trigger: 'field_changed', field: f.id, conditions: [{ field: f.id, op: '<=', value: '5', vt: 'value' }], actions: [{ type: 'message', channel: 'inapp', body: `${t('Low')}: {{${tb.titleField}}} — {{${f.id}}}` }] };
    } },
    { icon: '💬', title: t('Message the customer when a status changes'), build() {
      const [tb, f] = find((x) => x.type === 'select');
      if (!tb) return null;
      const ph = tb.fields.find((x) => x.type === 'phone');
      const lk = tb.fields.find((x) => x.type === 'lookup');
      return { table: tb.id, trigger: 'field_changed', field: f.id, conditions: [], actions: [{ type: 'message', channel: 'whatsapp', to: ph ? `{{${ph.id}}}` : lk ? `{{${lk.id}.phone}}` : '', body: `${t('Hello')}, {{${tb.titleField}}}: {{${f.id}}}. — {{business.name}}` }] };
    } },
    { icon: '⏰', title: t('Remind me when a date has passed'), build() {
      const [tb, f] = find((x) => x.type === 'date');
      if (!tb) return null;
      return { table: tb.id, trigger: 'schedule', conditions: [{ field: f.id, op: 'past', value: '' }], dedupeDays: 3, actions: [{ type: 'message', channel: 'inapp', body: `{{${tb.titleField}}}: ${f.label} ${t('has passed')}` }] };
    } },
    { icon: '🖊️', title: t('Ask the owner to approve big amounts'), build() {
      const [tb, f] = find((x) => x.type === 'money');
      if (!tb) return null;
      return { table: tb.id, trigger: 'created', conditions: [{ field: f.id, op: '>', value: '10000', vt: 'value' }], actions: [{ type: 'approval', note: `{{${tb.titleField}}}: {{${f.id}}}` }] };
    } },
    { icon: '⛔', title: t('Stop a save when something is wrong'), build() {
      const [tb, f] = find((x) => x.type === 'money' || x.type === 'number');
      if (!tb) return null;
      return { table: tb.id, trigger: 'before_save', conditions: [{ field: f.id, op: '<', value: '0', vt: 'value' }], actions: [{ type: 'block', text: `${f.label} ${t('cannot be negative.')}` }] };
    } },
  ];
}

export function rulesList(ctx) {
  const { store } = ctx;
  const save = debounce(() => store.touchApp(), 200);
  const host = h('div');
  const paint = () => {
    host.replaceChildren();
    const rules = store.app.rules ||= [];
    host.append(h('div.row', h('button.btn.primary', { onclick: () => {
      const tb = store.app.tables[0];
      if (!tb) { toast(t('Create a table first.'), { kind: 'warn' }); return; }
      const r = { id: uid(), name: t('New workflow'), enabled: true, table: tb.id, trigger: 'created', match: 'all', conditions: [], actions: [] };
      rules.push(r); store.touchApp(); location.hash = `#/build/rules/${r.id}`;
    } }, `＋ ${t('New workflow')}`)),
    h('h3', t('Start from an idea')),
    h('div.cards-grid.small', recipes(store).map((rc) => h('button.card.tile', { onclick: () => {
      const spec = rc.build();
      if (!spec) { toast(t('This idea needs a table with a matching field.'), { kind: 'warn' }); return; }
      const r = { id: uid(), name: rc.title, enabled: true, match: 'all', ...spec };
      rules.push(r); store.touchApp(); location.hash = `#/build/rules/${r.id}`;
    } }, h('div.tile-ic', rc.icon), h('b', rc.title)))),
    h('h3', t('Your workflows')));
    if (!rules.length) host.append(emptyState('⚙️', t('No workflows yet'), t('Workflows send messages, ask for approval and update stock automatically.')));
    rules.forEach((r) => {
      host.append(h('div.card.rule', { class: r.enabled === false ? 'off' : '' },
        h('div.rule-head', h('label.switch', h('input', { type: 'checkbox', checked: r.enabled !== false, 'aria-label': t('On / off'), onchange: (e) => { r.enabled = e.target.checked; save(); paint(); } }), h('span.slider')),
          h('b', r.name), h('span.spacer'),
          h('a.btn.small', { href: `#/build/rules/${r.id}` }, t('Edit')),
          h('button.btn.small', { onclick: () => { const c = JSON.parse(JSON.stringify(r)); c.id = uid(); c.name = `${r.name} (${t('copy')})`; rules.push(c); store.touchApp(); paint(); } }, t('Copy')),
          h('button.btn.small.danger', { onclick: async () => { if (await confirmDialog(t('Delete this workflow?'), { yes: t('Delete'), danger: true })) { rules.splice(rules.indexOf(r), 1); store.touchApp(); paint(); } } }, t('Delete'))),
        h('p.muted', describeRule(store, r))));
    });
  };
  paint();
  return host;
}

// ---- rule editor -------------------------------------------------------------------------------------------------------
export function ruleEditor(ctx, ruleId) {
  const { store } = ctx;
  const rule = (store.app.rules || []).find((r) => r.id === ruleId);
  if (!rule) return emptyState('❓', t('Not found'), '', h('a.btn', { href: '#/build/rules' }, t('Back')));
  const save = debounce(() => store.touchApp(), 250);
  const root = h('div.rule-editor');
  const summary = h('p.summary');
  const updateSummary = () => { summary.textContent = describeRule(store, rule); };

  function variables(table) {
    const out = [];
    for (const f of table.fields.filter((x) => x.type !== 'lines')) {
      out.push({ v: f.id, label: f.label });
      if (f.type === 'lookup') for (const rf of store.table(f.ref)?.fields.filter((x) => x.type !== 'lines' && x.type !== 'lookup') || []) out.push({ v: `${f.id}.${rf.id}`, label: `${f.label} › ${rf.label}` });
    }
    out.push({ v: 'business.name', label: t('My business name') }, { v: 'business.phone', label: t('My phone') }, { v: 'business.upi', label: t('My UPI ID') });
    return out;
  }
  function textWithChips(table, value, set, { rows = 1, placeholder = '' } = {}) {
    const el = rows > 1 ? h('textarea', { rows, placeholder }) : h('input', { placeholder });
    el.value = value || '';
    el.addEventListener('input', () => { set(el.value); save(); });
    const insert = (txt) => { const s = el.selectionStart ?? el.value.length; el.value = el.value.slice(0, s) + txt + el.value.slice(el.selectionEnd ?? s); el.focus(); el.selectionStart = el.selectionEnd = s + txt.length; set(el.value); save(); };
    const vars = variables(table);
    const lines = table.fields.filter((f) => f.type === 'lines');
    return h('div.tpl', el, h('div.chips.small', h('span.muted', t('Insert:')),
      vars.map((x) => h('button.chip', { type: 'button', onclick: () => insert(`{{${x.v}}}`) }, x.label)),
      lines.map((lf) => h('button.chip', { type: 'button', title: t('Repeats for every row'), onclick: () => insert(`{{#each ${lf.id}}}{{@n}}. ${(lf.columns[0] && lf.columns[0].id !== 'item') ? `{{${lf.columns[0].id}}}` : '{{desc}}'} × {{qty}}\n{{/each}}`) }, `↻ ${lf.label}`)),
      h('button.chip', { type: 'button', title: t('Show text only when something is true'), onclick: () => insert('{{#if balance > 0}}…{{else}}…{{/if}}') }, t('If … then …'))));
  }

  function actionEditor(a, i, table) {
    const box = h('div.action');
    const sel = h('select', { 'aria-label': t('Action'), onchange: (e) => {
      const type = e.target.value;
      for (const k of Object.keys(a)) delete a[k];
      a.type = type;
      if (type === 'message') { a.channel = 'whatsapp'; a.body = ''; a.to = ''; }
      if (type === 'adjust_stock') { const lf = table.fields.find((f) => f.type === 'lines'); a.linesField = lf?.id; a.itemColumn = lf?.columns.find((c) => c.type === 'lookup')?.id; a.qtyColumn = 'qty'; a.sign = -1; }
      if (type === 'create_record') { a.table = store.app.tables[0].id; a.values = {}; }
      save(); paint();
    } }, Object.entries(ACTION_LABEL()).filter(([k]) => k !== 'block' || rule.trigger === 'before_save').map(([k, l]) => h('option', { value: k, selected: k === a.type }, l)));
    box.append(h('div.action-head', h('span.step', `${t('Then')} ${i + 1}`), sel, h('button.icon-btn', { 'aria-label': t('Remove'), onclick: () => { rule.actions.splice(i, 1); save(); paint(); } }, '✕')));

    if (a.type === 'message') {
      const phoneFields = table.fields.filter((f) => f.type === 'phone' || f.type === 'email');
      const lookups = table.fields.filter((f) => f.type === 'lookup');
      const chLabel = () => ({ whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', inapp: t('Alert inside this app') });
      const toBox = h('div');
      const paintTo = () => {
        toBox.replaceChildren();
        if (a.channel === 'inapp') return;
        const toIn = h('input', { value: a.to || '', placeholder: t('Phone number, or pick a field below'), oninput: (e) => { a.to = e.target.value; save(); } });
        toBox.append(labeled(a.channel === 'email' ? t('Send to (email)') : t('Send to (phone)'), toIn),
          h('div.chips.small', h('span.muted', t('Use:')),
            phoneFields.map((f) => h('button.chip', { type: 'button', onclick: () => { a.to = `{{${f.id}}}`; toIn.value = a.to; save(); } }, f.label)),
            lookups.flatMap((lf) => (store.table(lf.ref)?.fields || []).filter((x) => x.type === 'phone' || x.type === 'email').map((x) => h('button.chip', { type: 'button', onclick: () => { a.to = `{{${lf.id}.${x.id}}}`; toIn.value = a.to; save(); } }, `${lf.label} › ${x.label}`))),
            h('button.chip', { type: 'button', onclick: () => { a.to = '{{business.phone}}'; toIn.value = a.to; save(); } }, t('My phone (owner)'))));
      };
      box.append(labeled(t('How'), h('select', { onchange: (e) => { a.channel = e.target.value; paintTo(); save(); updateSummary(); } }, Object.entries(chLabel()).map(([k, l]) => h('option', { value: k, selected: a.channel === k }, `${CHANNEL_ICON[k]} ${l}`)))), toBox);
      paintTo();
      if (a.channel === 'email') box.append(labeled(t('Subject'), h('input', { value: a.subject || '', oninput: (e) => { a.subject = e.target.value; save(); } })));
      const pv = h('pre.preview');
      const upd = () => {
        const sample = store.records(table.id).sort((x, y) => (x.updated < y.updated ? 1 : -1))[0];
        pv.textContent = sample ? renderTemplate(a.body || '', { table, data: sample.data, ctx: store.ctx() }) : t('Add a record to see a preview.');
      };
      box.append(labeled(t('Message'), textWithChips(table, a.body, (v) => { a.body = v; upd(); }, { rows: 5, placeholder: t('Write your message. Use the buttons to insert details.') })),
        h('div.hint', t('Preview using your latest record:')), pv);
      upd();
      box.append(h('p.hint', t('The message is written when you tap Send, from the latest record, so it is never out of date. Nothing is sent by itself.')));
    }

    if (a.type === 'set_field') {
      box.append(h('div.two', labeled(t('Field'), h('select', { onchange: (e) => { a.field = e.target.value; save(); } }, h('option', { value: '' }, '—'), table.fields.filter((f) => f.type !== 'lines' && !f.formula).map((f) => h('option', { value: f.id, selected: f.id === a.field }, f.label)))),
        labeled(t('New value (or a formula starting with =)'), h('input', { value: a.value ?? '', oninput: (e) => { a.value = e.target.value; save(); } }))));
    }
    if (a.type === 'approval') box.append(labeled(t('Note for the owner'), textWithChips(table, a.note, (v) => { a.note = v; }, { placeholder: t('e.g. Discount of {{discount}} on bill {{number}}') })));
    if (a.type === 'block') box.append(labeled(t('Message shown to the person'), textWithChips(table, a.text, (v) => { a.text = v; })));
    if (a.type === 'webhook') box.append(labeled(t('Address (URL) to send the record to'), h('input', { type: 'url', value: a.url || '', placeholder: 'https://flow.zoho.com/…', oninput: (e) => { a.url = e.target.value; save(); } })),
      h('p.hint', t('Works with Zoho Flow, Zapier, Make and your own server. Sent when you are online.')));

    if (a.type === 'create_record') {
      const target = store.table(a.table) || store.app.tables[0];
      a.values ||= {};
      const rowsBox = h('div');
      const paintRows = () => {
        rowsBox.replaceChildren();
        Object.entries(a.values).forEach(([fid, v]) => rowsBox.append(h('div.fill-row',
          h('select', { onchange: (e) => { delete a.values[fid]; a.values[e.target.value] = v; save(); paintRows(); } }, target.fields.filter((f) => f.type !== 'lines' && !f.formula && !f.auto).map((f) => h('option', { value: f.id, selected: f.id === fid }, f.label))),
          h('span', '='), h('input', { value: v, placeholder: t('text with {{fields}}, or =formula'), oninput: (e) => { a.values[fid] = e.target.value; save(); } }),
          h('button.icon-btn', { onclick: () => { delete a.values[fid]; save(); paintRows(); } }, '✕'))));
        const free = target.fields.find((f) => f.type !== 'lines' && !f.formula && !f.auto && !(f.id in a.values));
        if (free) rowsBox.append(h('button.btn.small', { onclick: () => { a.values[free.id] = ''; save(); paintRows(); } }, `＋ ${t('Fill a field')}`));
      };
      box.append(labeled(t('In table'), h('select', { onchange: (e) => { a.table = e.target.value; a.values = {}; save(); paint(); } }, store.app.tables.map((x) => h('option', { value: x.id, selected: x.id === a.table }, x.name)))), rowsBox,
        h('p.hint', t('Tip: for a due date type =due_date, or +3 for three days from now.')));
      paintRows();
    }

    if (a.type === 'adjust_stock') {
      const lf = fieldOf(table, a.linesField);
      const itemCol = lf?.columns.find((c) => c.id === a.itemColumn);
      const itemTable = itemCol ? store.table(itemCol.ref) : null;
      box.append(h('div.two',
        labeled(t('Line items'), h('select', { onchange: (e) => { a.linesField = e.target.value; a.itemColumn = fieldOf(table, a.linesField)?.columns.find((c) => c.type === 'lookup')?.id; save(); paint(); } }, table.fields.filter((f) => f.type === 'lines').map((f) => h('option', { value: f.id, selected: f.id === a.linesField }, f.label)))),
        labeled(t('Item column'), h('select', { onchange: (e) => { a.itemColumn = e.target.value; save(); paint(); } }, (lf?.columns || []).filter((c) => c.type === 'lookup').map((c) => h('option', { value: c.id, selected: c.id === a.itemColumn }, c.label))))),
        h('div.two',
          labeled(t('Quantity column'), h('select', { onchange: (e) => { a.qtyColumn = e.target.value; save(); } }, (lf?.columns || []).filter((c) => c.type === 'number').map((c) => h('option', { value: c.id, selected: c.id === a.qtyColumn }, c.label)))),
          labeled(t('Stock field on the item'), h('select', { onchange: (e) => { a.targetField = e.target.value; save(); } }, (itemTable?.fields || []).filter((f) => f.type === 'number' && !f.formula).map((f) => h('option', { value: f.id, selected: f.id === a.targetField }, f.label))))),
        labeled(t('Direction'), h('select', { onchange: (e) => { a.sign = +e.target.value; save(); } }, h('option', { value: -1, selected: a.sign !== 1 }, t('Take stock out (sales)')), h('option', { value: 1, selected: a.sign === 1 }, t('Put stock in (purchases)')))),
        h('p.hint', t('Edits and deletions are handled too: only the difference is applied.')));
    }
    return box;
  }

  function paint() {
    root.replaceChildren();
    const table = store.table(rule.table) || store.app.tables[0];
    const tSel = h('select', { 'aria-label': t('Table'), onchange: (e) => { rule.table = e.target.value; rule.conditions = []; rule.field = ''; save(); paint(); } }, store.app.tables.map((x) => h('option', { value: x.id, selected: x.id === rule.table }, x.name)));
    const trSel = h('select', { 'aria-label': t('Event'), onchange: (e) => { rule.trigger = e.target.value; save(); paint(); } }, Object.entries(TRIGGER_LABEL()).map(([k, l]) => h('option', { value: k, selected: k === rule.trigger }, l)));
    const fSel = rule.trigger === 'field_changed'
      ? h('select', { 'aria-label': t('Field'), onchange: (e) => { rule.field = e.target.value; save(); updateSummary(); } }, table.fields.filter((f) => f.type !== 'lines').map((f) => h('option', { value: f.id, selected: f.id === rule.field }, f.label))) : null;
    if (fSel && !rule.field) rule.field = fSel.value;

    root.append(
      pageHeader(t('Workflow'), h('a.btn.ghost', { href: '#/build/rules' }, icon('back', { size: 16 }), t('All workflows'))),
      labeled(t('Name'), h('input', { value: rule.name, oninput: (e) => { rule.name = e.target.value; save(); } })), summary,
      h('section.card.step-card', h('h3', `1 · ${t('When')}`), h('div.two', labeled(t('Table'), tSel), labeled(t('this happens'), trSel)), fSel ? labeled(t('Which field'), fSel) : null,
        rule.trigger === 'schedule' ? h('p.hint', t('Runs whenever the app is opened (and about once an hour while it stays open). Each record is only acted on once per interval below.')) : null,
        rule.trigger === 'before_save' ? h('p.hint', t('Use with “Stop the save” to check something before a record is saved.')) : null),
      h('section.card.step-card', h('h3', `2 · ${t('Only if')} ${t('(optional)')}`), conditionsEditor(store, table, rule, () => { save(); updateSummary(); })),
      h('section.card.step-card', h('h3', `3 · ${t('Do this')}`),
        (rule.actions ||= []).map((a, i) => actionEditor(a, i, table)),
        h('button.btn', { onclick: () => { rule.actions.push(rule.trigger === 'before_save' ? { type: 'block', text: '' } : { type: 'message', channel: 'inapp', body: '' }); save(); paint(); } }, `＋ ${t('Add an action')}`)),
      h('section.card.step-card', h('h3', t('Options')),
        labeled(t('Do not repeat for the same record within … days (0 = always)'), h('input', { type: 'number', min: 0, value: rule.dedupeDays || 0, oninput: (e) => { rule.dedupeDays = +e.target.value || 0; save(); } }))));
    updateSummary();
  }
  paint();
  return root;
}
export { uniqueId, recordTitle };
