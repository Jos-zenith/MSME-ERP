// Data model helpers: field types, record computation, formatting, validation, search.
import { tryEvaluate, round, toNum, todayStr, toDate } from './formula.js';

export const FIELD_TYPES = {
  text: { label: 'Text', icon: 'Aa' },
  longtext: { label: 'Long text', icon: '¶' },
  number: { label: 'Number', icon: '#' },
  money: { label: 'Money', icon: '₹' },
  date: { label: 'Date', icon: '📅' },
  select: { label: 'Choice list', icon: '☰' },
  checkbox: { label: 'Yes / No', icon: '☑' },
  phone: { label: 'Phone', icon: '☎' },
  email: { label: 'Email', icon: '✉' },
  lookup: { label: 'Link to another table', icon: '🔗' },
  lines: { label: 'Line items', icon: '▤' },
};
export const COLUMN_TYPES = ['text', 'number', 'money', 'date', 'select', 'lookup', 'checkbox'];

export const uid = () =>
  (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20)
    : Math.random().toString(36).slice(2) + Date.now().toString(36));

export const slug = (s) =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'field';

export function uniqueId(base, taken) {
  let id = slug(base), n = 2;
  while (taken.includes(id)) id = `${slug(base)}_${n++}`;
  return id;
}

export const isBlank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
export const fieldOf = (table, id) => table.fields.find((f) => f.id === id);
export const isComputed = (f) => !!f.formula || !!f.auto || !!f.computed;

// ---- table hooks ---------------------------------------------------------------------------------
// A table can name a set of hooks (`table.hooks = 'gst_invoice'`) for logic that is better written as real, tested
// code than as formula strings: { compute(data, ctx, table), validate(data, ctx, table), defaults(store),
// number: { field, next(store, table, data) } }. Fields marked `computed: true` are filled by `compute` and shown read-only.
const HOOKS = new Map();
export function registerHooks(name, hooks) { HOOKS.set(name, hooks); }
export const hooksFor = (table) => (table?.hooks ? HOOKS.get(table.hooks) : null) || null;
export const defaultsFor = (table, store) => hooksFor(table)?.defaults?.(store) || {};

// ---- locale / formatting ---------------------------------------------------
const L = { lang: 'en', locale: 'en-IN', symbol: '₹', currency: 'INR' };
export function setLocale(opts) { Object.assign(L, opts); nf.clear(); }
const nf = new Map();
function numFmt(min, max) {
  const k = `${L.locale}|${min}|${max}`;
  if (!nf.has(k)) nf.set(k, new Intl.NumberFormat(L.locale, { minimumFractionDigits: min, maximumFractionDigits: max }));
  return nf.get(k);
}
export const fmtNumber = (n, max = 3) => (n === null || n === undefined || n === '' ? '' : numFmt(0, max).format(toNum(n)));
export const fmtMoney = (n) => (n === null || n === undefined || n === '' ? '' : `${L.symbol}${numFmt(2, 2).format(toNum(n))}`);
export function fmtDate(s) {
  const d = toDate(s);
  if (!d) return s ?? '';
  try {
    return new Intl.DateTimeFormat(L.lang === 'en' ? 'en-IN' : L.lang, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
  } catch { return String(s); }
}
export const currencySymbol = () => L.symbol;

/** Human string for a stored value (used in lists, messages and print). */
export function formatValue(field, value, ctx) {
  if (isBlank(value) && field.type !== 'checkbox') return '';
  switch (field.type) {
    case 'money': return fmtMoney(value);
    case 'number': return fmtNumber(value, field.decimals ?? 3);
    case 'date': return fmtDate(value);
    case 'checkbox': return value ? '✓' : '';
    case 'lookup': {
      const t = ctx?.getTable?.(field.ref), r = ctx?.getRecord?.(field.ref, value);
      return t && r ? recordLabel(t, r) : '';
    }
    case 'lines': return `${(value || []).length}`;
    default: return String(value);
  }
}

export function recordTitle(table, rec) {
  const v = rec.data?.[table.titleField];
  if (!isBlank(v)) return String(v);
  const first = table.fields.find((f) => f.type === 'text' && !isBlank(rec.data?.[f.id]));
  return first ? String(rec.data[first.id]) : rec.id.slice(0, 6);
}
/** Label used by lookups: joined `labelFields` so two customers with the same name are told apart. */
export function recordLabel(table, rec) {
  const ids = table.labelFields?.length ? table.labelFields : [table.titleField];
  const parts = ids.map((id) => rec.data?.[id]).filter((v) => !isBlank(v)).map(String);
  return parts.length ? parts.join(' · ') : recordTitle(table, rec);
}

export function normPhone(raw, cc = '91') {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 && cc) return cc + d;
  if (d.length === 11 && d[0] === '0' && cc) return cc + d.slice(1);
  return d;
}

// ---- defaults ---------------------------------------------------------------
export function defaultValue(f) {
  if (f.type === 'lines') return [];
  if (f.type === 'checkbox') return !!f.default;
  if (f.default === undefined || f.default === '') return f.type === 'number' || f.type === 'money' ? null : '';
  if (f.type === 'date' && f.default === 'today') return todayStr();
  return f.default;
}
export function newRow(f, ctx) {
  const row = {};
  for (const c of f.columns || []) row[c.id] = defaultValue(c);
  return row;
}
export function newRecordData(table) {
  const d = {};
  for (const f of table.fields) d[f.id] = defaultValue(f);
  return d;
}
/** A line row is blank when its 'key' column (first column without a default, e.g. the item) is empty. */
export function rowKeyColumn(f) {
  const cols = (f.columns || []).filter((c) => !isComputed(c));
  return cols.find((c) => c.id === f.rowKey) || cols.find((c) => c.default === undefined || c.default === '') || cols[0];
}
export function rowIsBlank(f, row) {
  const key = rowKeyColumn(f);
  return !key || isBlank(row[key.id]);
}

// ---- formula scope -------------------------------------------------------------
function walk(cur, def, rest, ctx) {
  if (!rest.length) return cur;
  const [next, ...more] = rest;
  if (def?.type === 'lookup') {
    const rec = ctx.getRecord?.(def.ref, cur);
    const t = ctx.getTable?.(def.ref);
    if (!rec || !t) return null;
    return walk(rec.data[next], fieldOf(t, next), more, ctx);
  }
  if (def?.type === 'lines' && Array.isArray(cur)) {
    const col = (def.columns || []).find((c) => c.id === next);
    return cur.map((r) => walk(r[next], col, more, ctx));
  }
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) return walk(cur[next], undefined, more, ctx);
  return null;
}

/** Build a resolver for formulas / templates over one record (optionally inside a line row). */
export function makeScope(table, data, ctx, row = null, columns = null) {
  const resolve = (parts, wantDef) => {
    const [head, ...rest] = parts;
    let cur, def;
    if (row && columns && columns.some((c) => c.id === head)) { cur = row[head]; def = columns.find((c) => c.id === head); }
    else if (table && fieldOf(table, head)) { cur = data[head]; def = fieldOf(table, head); }
    else if (head === 'business') { cur = ctx.business || {}; def = undefined; }
    else if (head === 'today') { cur = todayStr(); def = { type: 'date' }; }
    else return wantDef ? { value: null, def: undefined } : null;
    const value = walk(cur, def, rest, ctx);
    if (!wantDef) return value;
    // find the definition of what the path finally points at (for formatting)
    let d = def, r = [...rest];
    while (r.length && d) {
      const n = r.shift();
      if (d.type === 'lookup') d = fieldOf(ctx.getTable?.(d.ref) || { fields: [] }, n);
      else if (d.type === 'lines') d = (d.columns || []).find((c) => c.id === n);
      else d = undefined;
    }
    return { value, def: r.length ? undefined : d };
  };
  const scope = (parts) => resolve(parts, false);
  scope.withDef = (parts) => resolve(parts, true);
  return scope;
}

// ---- computing a record --------------------------------------------------------
function applyFill(def, holder, ctx) {
  if (!def.fill || def.type !== 'lookup') return;
  const id = holder[def.id];
  const marker = `_f_${def.id}`;
  if (holder[marker] === id) return;
  holder[marker] = id;
  if (isBlank(id)) return;
  const rec = ctx.getRecord?.(def.ref, id);
  if (!rec) return;
  for (const [target, src] of Object.entries(def.fill)) {
    if (rec.data[src] !== undefined) holder[target] = rec.data[src];
  }
}

function coerceComputed(f, v) {
  if (v === null || v === undefined) return f.type === 'number' || f.type === 'money' ? null : '';
  if (f.type === 'money') return round(toNum(v), 2);
  if (f.type === 'number') return round(toNum(v), f.decimals ?? 4);
  if (f.type === 'checkbox') return !!v;
  return typeof v === 'object' ? String(v) : v;
}

/** Returns a new data object with lookup auto-fill applied and every calculated field refreshed. */
export function computeRecord(table, data, ctx) {
  const d = JSON.parse(JSON.stringify(data || {}));
  for (const f of table.fields) applyFill(f, d, ctx);
  for (const f of table.fields.filter((x) => x.type === 'lines')) {
    d[f.id] = Array.isArray(d[f.id]) ? d[f.id] : [];
    for (const row of d[f.id]) {
      for (const c of f.columns || []) if (row[c.id] === undefined) row[c.id] = defaultValue(c);
      for (const c of f.columns || []) applyFill(c, row, ctx);
      for (let pass = 0; pass < 2; pass++) {
        for (const c of f.columns || []) {
          if (!c.formula) continue;
          const sc = makeScope(table, d, ctx, row, f.columns);
          row[c.id] = coerceComputed(c, tryEvaluate(c.formula, sc, null));
        }
      }
    }
  }
  const computed = table.fields.filter((f) => f.formula);
  for (let pass = 0; pass < 3; pass++) {
    for (const f of computed) {
      d[f.id] = coerceComputed(f, tryEvaluate(f.formula, makeScope(table, d, ctx), null));
    }
  }
  const hooks = hooksFor(table);
  return hooks?.compute ? hooks.compute(d, ctx, table) || d : d;
}

/** Drops blank line rows. */
export function cleanRecord(table, data) {
  const d = { ...data };
  for (const f of table.fields.filter((x) => x.type === 'lines')) {
    d[f.id] = (d[f.id] || []).filter((r) => !rowIsBlank(f, r));
  }
  return d;
}

// ---- validation ------------------------------------------------------------------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateRecord(table, data, ctx) {
  const errors = {};
  for (const f of table.fields) {
    const v = data[f.id];
    if (f.auto || f.computed) continue;
    if (f.required && (f.type === 'lines' ? !(v || []).some((r) => !rowIsBlank(f, r)) : isBlank(v) && v !== false)) {
      errors[f.id] = 'required'; continue;
    }
    if (isBlank(v)) continue;
    if (f.type === 'email' && !EMAIL.test(String(v).trim())) errors[f.id] = 'bad_email';
    else if (f.type === 'phone' && String(v).replace(/\D/g, '').length < 7) errors[f.id] = 'bad_phone';
    else if ((f.type === 'number' || f.type === 'money') && !Number.isFinite(Number(v))) errors[f.id] = 'bad_number';
    else if (f.min !== undefined && f.min !== '' && toNum(v) < toNum(f.min)) errors[f.id] = 'too_small';
  }
  // table-specific rules (e.g. GSTIN checksum). Values that are not a known error code are shown as the message itself;
  // keys starting with "_" are shown in the banner at the top of the form instead of under a field.
  const extra = hooksFor(table)?.validate?.(data, ctx, table);
  if (extra) for (const [k, v] of Object.entries(extra)) if (!errors[k]) errors[k] = v;
  return errors;
}

/** Records sharing a value with `data[fieldId]` (used for soft duplicate warnings and hard `unique`). */
export function findDuplicates(table, fieldId, data, records, selfId) {
  const v = data[fieldId];
  if (isBlank(v)) return [];
  const f = fieldOf(table, fieldId);
  const key = (x) => (f?.type === 'phone' ? String(x).replace(/\D/g, '').slice(-10) : String(x).trim().toLowerCase());
  const k = key(v);
  return records.filter((r) => r.id !== selfId && !r.deleted && !isBlank(r.data[fieldId]) && key(r.data[fieldId]) === k);
}

// ---- search (drives lookup dropdowns) ----------------------------------------------
/**
 * Rank records for a typed query. An exact match on the first search field (the item code / barcode)
 * always ranks first, so typing a code and pressing Enter picks that exact item.
 */
export function searchRecords(table, records, query, limit = 8, rank = null) {
  const q = String(query || '').trim().toLowerCase();
  const fields = table.searchFields?.length ? table.searchFields : table.labelFields?.length ? table.labelFields : [table.titleField];
  const live = records.filter((r) => !r.deleted);
  if (!q) return rank ? [...live].sort((a, b) => (rank.get(b.id) || 0) - (rank.get(a.id) || 0)).slice(0, limit) : live.slice(0, limit);
  const words = q.split(/\s+/);
  // "98765 43210", "9876543210" and "+91 98765-43210" are the same phone number
  const qDigits = /^[\d\s+()-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  const isPhone = fields.map((id) => fieldOf(table, id)?.type === 'phone');
  const scored = [];
  for (const r of live) {
    const vals = fields.map((id) => String(r.data[id] ?? '').toLowerCase());
    let best = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!v) continue;
      const bonus = Math.max(0, 5 - i);
      if (isPhone[i] && qDigits.length >= 3) {
        const d = v.replace(/\D/g, '');
        if (d.slice(-10) === qDigits.slice(-10) && qDigits.length >= 10) best = Math.max(best, 100 + bonus);
        else if (d.startsWith(qDigits) || d.slice(-10).startsWith(qDigits)) best = Math.max(best, 60 + bonus);
        else if (d.includes(qDigits)) best = Math.max(best, 20 + bonus);
        continue;
      }
      if (v === q) best = Math.max(best, 100 + bonus);
      else if (v.startsWith(q)) best = Math.max(best, 60 + bonus);
      else if (v.split(/[\s\-_/.]+/).some((w) => w.startsWith(q))) best = Math.max(best, 40 + bonus);
      else if (v.includes(q)) best = Math.max(best, 20 + bonus);
    }
    // among equally good matches, the ones this shop uses most come first
    if (best && rank) best += Math.min(9, rank.get(r.id) || 0) / 10;
    if (!best && words.length > 1) {
      const hay = vals.join(' ');
      if (words.every((w) => hay.includes(w))) best = 15;
    }
    if (best) scored.push([best, r]);
  }
  // nothing matched as typed: allow a slip of the finger ("suagr", "biscut"). A second pass, so it costs nothing on
  // normal searches and a near match can never push out a real one.
  if (!scored.length && !qDigits && q.length >= 4) {
    for (const r of live) {
      const hayWords = fields.map((id) => String(r.data[id] ?? '').toLowerCase()).join(' ').split(/[\s\-_/.,]+/).filter((w) => w.length >= 3);
      if (words.every((w) => w.length < 4 || hayWords.some((hw) => nearWord(w, hw)))) scored.push([8 + (rank ? Math.min(9, rank.get(r.id) || 0) / 10 : 0), r]);
    }
  }
  scored.sort((a, b) => b[0] - a[0] || recordLabel(table, a[1]).localeCompare(recordLabel(table, b[1])));
  return scored.slice(0, limit).map((x) => x[1]);
}

/** Edits to turn a into b, counting a swap of two neighbouring letters ("suagr") as one. */
function editDistance(a, b, max) {
  let pp = [], prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    pp = prev; prev = cur;
  }
  return prev[b.length];
}
/** True when `typed` is a typo or two away from `word` or from its start: 1 edit up to 6 letters, 2 beyond. */
export function nearWord(typed, word) {
  const max = typed.length <= 6 ? 1 : 2;
  for (const len of [typed.length, typed.length - 1, typed.length + 1]) {
    if (len < 3 || len > word.length) continue;
    if (editDistance(typed, word.slice(0, len), max) <= max) return true;
  }
  return false;
}

export function linesFieldsOf(table) { return table.fields.filter((f) => f.type === 'lines'); }

// ---- less typing ----------------------------------------------------------------------------------
const PHONE_RUN = /(\+?\d[\d\s-]{5,}\d)/;
/**
 * What the user typed into a picker, split into fields for a new record:
 *   "Ravi Kumar 98765 43210" -> { name: 'Ravi Kumar', phone: '98765 43210' }      "98765 43210" -> { phone: ... }
 */
export function parseQuickCreate(table, query) {
  const q = String(query || '').trim().replace(/\s+/g, ' ');
  const out = {};
  if (!q) return out;
  const phoneField = table.fields.find((f) => f.type === 'phone');
  const m = phoneField ? PHONE_RUN.exec(q) : null;
  let rest = q;
  if (m && m[1].replace(/\D/g, '').length >= 7) {
    out[phoneField.id] = m[1].trim();
    rest = (q.slice(0, m.index) + ' ' + q.slice(m.index + m[1].length)).replace(/[\s,·-]+/g, ' ').trim();
  }
  if (rest) out[table.titleField] = rest;
  return out;
}

/** A short unique code made from a name: "Sunflower Oil 1L" -> "SUN1", then "SUN2" if that is taken. */
export function suggestCode(name, taken) {
  const words = String(name || '').toUpperCase().normalize('NFKD').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const letters = words.find((w) => /[A-Z]/.test(w)) || words[0];
  const stem = (letters.replace(/[^A-Z]/g, '') + (words[1] || '').replace(/[^A-Z]/g, '')).slice(0, 3) || letters.slice(0, 3);
  const digit = /\d+/.exec(words.join(' '))?.[0] || '1';
  const has = (c) => (taken instanceof Set ? taken.has(c) : taken.includes(c));
  let n = Number(digit.slice(0, 3)), code = `${stem}${n}`;
  while (has(code)) code = `${stem}${++n}`;
  return code;
}

/** Data for "Repeat": the same customer and lines, but a fresh number, today's dates and no payments. */
export function repeatData(table, data) {
  const out = {};
  for (const f of table.fields) {
    if (isComputed(f) || f.type === 'date' || f.noRepeat) continue;
    if (f.type === 'lines') {
      if (!f.quickEntry) continue;
      const keep = (f.columns || []).filter((c) => !isComputed(c));
      out[f.id] = (data[f.id] || []).filter((r) => !rowIsBlank(f, r)).map((r) => Object.fromEntries(keep.map((c) => [c.id, r[c.id]])));
    } else if (!isBlank(data[f.id])) out[f.id] = data[f.id];
  }
  return out;
}
