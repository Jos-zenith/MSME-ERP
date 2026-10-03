// Import from / export to CSV, Excel-pasted text, Zoho Books and Google Sheets exports.
import { h, modal, toast, download } from '../ui/dom.js';
import { t } from '../i18n.js';
import { parseCsv, toCsv, autoMap, parseDate, parseNumber, ZOHO_EXPORT, normHeader } from '../csv.js';
import { fieldOf, recordLabel, isBlank, formatValue, findDuplicates, isComputed, searchRecords } from '../schema.js';
import { toNum } from '../formula.js';

const importable = (table) => table.fields.filter((f) => f.type !== 'lines' && !isComputed(f));

function coerce(store, f, raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { v: f.type === 'checkbox' ? false : '' };
  switch (f.type) {
    case 'number': case 'money': { const n = parseNumber(s); return n === null ? { err: `${f.label}: "${s}" ${t('is not a number')}` } : { v: n }; }
    case 'date': { const d = parseDate(s); return d ? { v: d } : { err: `${f.label}: "${s}" ${t('is not a date')}` }; }
    case 'checkbox': return { v: /^(y|yes|true|1|✓|done)$/i.test(s) };
    case 'select': return { v: (f.options || []).find((o) => o.toLowerCase() === s.toLowerCase()) || s };
    case 'lookup': {
      const rt = store.table(f.ref);
      const hit = rt ? searchRecords(rt, store.records(rt.id), s, 1)[0] : null;
      return hit ? { v: hit.id } : { v: '', warn: `${f.label}: "${s}" ${t('was not found')}` };
    }
    default: return { v: s };
  }
}

export function openImport(store, table, done) {
  if (table.fields.some((f) => f.type === 'lines' && f.required)) {
    toast(t('Import is available for simple tables (customers, items…). Bills with line items are entered in the app.'), { kind: 'warn', ms: 7000 });
    return;
  }
  const fields = importable(table);
  let rows = [], headers = [], map = [];
  const step = h('div');
  const m = modal({ title: `${t('Import into')} ${table.name}`, body: step, wide: true });

  const ta = h('textarea', { rows: 6, placeholder: t('…or paste rows copied from Excel / Google Sheets here') });
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv', 'aria-label': t('Choose a CSV file') });
  const load = (text) => {
    const all = parseCsv(text);
    if (all.length < 2) { toast(t('The file needs a header row and at least one data row.'), { kind: 'warn' }); return; }
    headers = all[0]; rows = all.slice(1); map = autoMap(headers, fields);
    stepMap();
  };
  file.addEventListener('change', async () => { if (file.files[0]) load(await file.files[0].text()); });

  function stepPick() {
    step.replaceChildren(
      h('p', t('Bring in your existing list from Zoho Books, Vyapar, Tally or any spreadsheet. Export it as CSV, then choose the file.')),
      h('label.field', h('span.lbl', t('CSV file')), file), ta,
      h('div.row', h('button.btn.primary', { onclick: () => ta.value.trim() ? load(ta.value) : toast(t('Choose a file or paste some rows first.'), { kind: 'warn' }) }, t('Continue')),
        h('button.btn.ghost', { onclick: () => download(`${table.id}-template.csv`, toCsv([fields.map((f) => f.label)]), 'text/csv') }, t('Download a blank template'))));
  }

  function stepMap() {
    const keyCandidates = fields.filter((f) => f.unique || f.id === table.titleField);
    const keySel = h('select', { 'aria-label': t('Match existing records by') }, h('option', { value: '' }, t('Always add new records')),
      keyCandidates.map((f) => h('option', { value: f.id }, `${t('Match on')} ${f.label}`)));
    keySel.value = fields.find((f) => f.unique)?.id || '';
    const mode = h('select', { 'aria-label': t('When a match is found') }, h('option', { value: 'update' }, t('Update the existing record')), h('option', { value: 'skip' }, t('Skip it')));
    const rules = h('input', { type: 'checkbox', id: 'imp-rules' });
    const selects = headers.map((hd, i) => {
      const s = h('select', { 'aria-label': hd, onchange: () => { map[i] = s.value; preview(); } }, h('option', { value: '' }, t('— ignore —')), fields.map((f) => h('option', { value: f.id }, f.label)));
      s.value = map[i] || '';
      return s;
    });
    const prev = h('div.preview');
    const preview = () => {
      const used = map.map((fid, i) => [fid, i]).filter(([fid]) => fid);
      prev.replaceChildren(h('div.table-wrap', h('table.data',
        h('thead', h('tr', used.map(([fid]) => h('th', fieldOf(table, fid).label)))),
        h('tbody', rows.slice(0, 4).map((r) => h('tr', used.map(([, i]) => h('td', r[i] ?? ''))))))),
      h('p.muted', `${rows.length} ${t('rows found')}`));
    };
    step.replaceChildren(
      h('p', t('Check that each column of your file goes to the right field.')),
      h('div.map-grid', headers.map((hd, i) => h('div.map-row', h('span.lbl', hd), h('span', '→'), selects[i]))),
      h('div.opts', h('label.field.inline', keySel), h('label.field.inline', mode),
        h('label.check', rules, ` ${t('Also run my workflows (messages, stock updates) for these rows')}`)),
      prev,
      h('div.row', h('button.btn.ghost', { onclick: stepPick }, t('Back')),
        h('button.btn.primary', { onclick: () => run(keySel.value, mode.value, rules.checked) }, `${t('Import')} ${rows.length}`)));
    preview();
  }

  async function run(keyId, mode, withRules) {
    const res = { added: 0, updated: 0, skipped: 0, problems: [] };
    const used = map.map((fid, i) => [fieldOf(table, fid), i]).filter(([f]) => f);
    if (!used.length) { toast(t('Map at least one column first.'), { kind: 'warn' }); return; }
    for (let n = 0; n < rows.length; n++) {
      const data = {}; const issues = [];
      for (const [f, i] of used) {
        const c = coerce(store, f, rows[n][i]);
        if (c.err) issues.push(c.err); else data[f.id] = c.v;
        if (c.warn) res.problems.push(`${t('Row')} ${n + 2}: ${c.warn}`);
      }
      if (issues.length) { res.skipped++; res.problems.push(`${t('Row')} ${n + 2}: ${issues.join('; ')}`); continue; }
      let existing = null;
      if (keyId && !isBlank(data[keyId])) existing = findDuplicates(table, keyId, data, store.records(table.id))[0];
      if (existing && mode === 'skip') { res.skipped++; continue; }
      const r = await store.saveRecord(table.id, existing ? { ...existing.data, ...pruneBlank(data) } : data, { id: existing?.id, noRules: !withRules });
      if (r.ok) existing ? res.updated++ : res.added++;
      else { res.skipped++; res.problems.push(`${t('Row')} ${n + 2}: ${r.blocked || Object.keys(r.errors || {}).map((k) => fieldOf(table, k)?.label).join(', ')} ${r.blocked ? '' : t('needs a valid value')}`); }
    }
    step.replaceChildren(
      h('h3', `✓ ${t('Import finished')}`),
      h('p', `${res.added} ${t('added')}, ${res.updated} ${t('updated')}, ${res.skipped} ${t('skipped')}.`),
      res.problems.length ? h('details', h('summary', `${res.problems.length} ${t('notes')}`), h('ul.problems', res.problems.slice(0, 40).map((p) => h('li', p)))) : null,
      h('div.row', h('button.btn.primary', { onclick: () => { m.close(); done?.(); } }, t('Done'))));
  }
  stepPick();
}
const pruneBlank = (d) => Object.fromEntries(Object.entries(d).filter(([, v]) => !isBlank(v)));

// ---- export ------------------------------------------------------------------------------------------------
export function exportCsv(store, table) {
  const ctx = store.ctx();
  const zoho = ZOHO_EXPORT[table.id];
  const plain = () => {
    const fields = table.fields.filter((f) => f.type !== 'lines');
    const rows = [fields.map((f) => f.label)];
    for (const r of store.records(table.id)) rows.push(fields.map((f) => (f.type === 'lookup' ? formatValue(f, r.data[f.id], ctx) : f.type === 'checkbox' ? (r.data[f.id] ? 'Yes' : 'No') : r.data[f.id] ?? '')));
    return rows;
  };
  // one row per line item (what accountants and Zoho expect for bills)
  const flattened = (lf) => {
    const head = table.fields.filter((f) => f.type !== 'lines');
    const cols = lf.columns.filter((c) => !c.hidden);
    const rows = [[...head.map((f) => f.label), ...cols.map((c) => `${lf.label}: ${c.label}`)]];
    for (const r of store.records(table.id)) {
      const base = head.map((f) => (f.type === 'lookup' ? formatValue(f, r.data[f.id], ctx) : r.data[f.id] ?? ''));
      const lines = r.data[lf.id] || [];
      for (const l of lines.length ? lines : [{}]) rows.push([...base, ...cols.map((c) => (c.type === 'lookup' ? formatValue(c, l[c.id], ctx) : l[c.id] ?? ''))]);
    }
    return rows;
  };
  const zohoInvoices = () => {
    const rows = [['Invoice Date', 'Invoice Number', 'Invoice Status', 'Customer Name', 'Due Date', 'Item Name', 'Quantity', 'Item Price', 'Item Tax %', 'Discount(%)', 'Notes']];
    const custT = store.table(fieldOf(table, 'customer')?.ref);
    for (const r of store.records(table.id)) {
      const c = custT ? ctx.getRecord(custT.id, r.data.customer) : null;
      const status = toNum(r.data.balance) <= 0 ? 'Paid' : 'Sent';
      for (const l of r.data.items || []) rows.push([r.data.date, r.data.number, status, c ? c.data[custT.titleField] : 'Walk-in customer', r.data.due_date || '', l.desc, l.qty, l.rate, l.tax, l.disc, r.data.notes || '']);
    }
    return rows;
  };
  const opts = [{ title: t('Standard spreadsheet (CSV)'), build: () => (table.fields.some((f) => f.type === 'lines') ? flattened(table.fields.find((f) => f.type === 'lines')) : plain()) }];
  if (zoho) opts.push({ title: zoho.title, build: () => [zoho.columns.map((c) => c[0]), ...store.records(table.id).map((r) => zoho.columns.map(([, src]) => (typeof src === 'function' ? src(r) : r.data[src] ?? '')))] });
  if (table.id === 'invoices' && fieldOf(table, 'items')) opts.push({ title: 'Zoho Books — Invoices', build: zohoInvoices });
  const body = h('div', h('p', t('Choose a format:')), h('div.choices', opts.map((o) => h('button.btn.block', { onclick: () => {
    download(`${table.id}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(o.build()), 'text/csv');
    mm.close();
  } }, o.title))), opts.length > 1 ? h('p.hint', t('Zoho column names are matched as closely as possible; Zoho’s import wizard lets you re-map any column.')) : null);
  const mm = modal({ title: `${t('Export')} ${table.name}`, body });
}
export { normHeader, recordLabel };
