// Dashboard widgets: turn records into numbers, series and lists. Pure functions (no DOM).
import { matchConditions } from './logic.js';
import { fieldOf, recordLabel, isBlank, fmtDate } from './schema.js';
import { toNum, todayStr, addDays, toDate, dateStr } from './formula.js';

export const PERIODS = ['today', '7d', '30d', 'month', 'year', 'all'];
export const MEASURES = ['count', 'sum', 'avg', 'min', 'max'];

export function periodRange(period, now = new Date()) {
  const to = todayStr(now);
  switch (period) {
    case 'today': return [to, to];
    case '7d': return [addDays(to, -6), to];
    case '30d': return [addDays(to, -29), to];
    case 'month': return [to.slice(0, 8) + '01', to];
    case 'year': return [to.slice(0, 5) + '01-01', to];
    default: return [null, null];
  }
}

const localDate = (iso) => (iso ? todayStr(new Date(iso)) : null);

function rowsFor(w, table, store) {
  const recs = store.records(w.table);
  if (!w.lines) return { rows: recs.map((r) => ({ rec: r, data: r.data })), t: table };
  const lf = fieldOf(table, w.lines);
  const t = { ...table, fields: [...table.fields, ...(lf?.columns || [])] };
  const rows = [];
  for (const r of recs) for (const row of r.data[w.lines] || []) rows.push({ rec: r, data: { ...r.data, ...row } });
  return { rows, t };
}

function bucketKey(v, by) {
  if (by === 'month') return String(v).slice(0, 7);
  if (by === 'day') return String(v).slice(0, 10);
  return String(v);
}

function measureOf(op, values) {
  if (op === 'count') return values.length;
  const n = values.map(toNum);
  if (!n.length) return 0;
  if (op === 'sum') return n.reduce((a, b) => a + b, 0);
  if (op === 'avg') return n.reduce((a, b) => a + b, 0) / n.length;
  if (op === 'min') return Math.min(...n);
  return Math.max(...n);
}

export function widgetData(w, store, now = new Date()) {
  const table = store.table(w.table);
  if (!table) return { error: 'missing_table' };
  const ctx = store.ctx();
  const { rows, t } = rowsFor(w, table, store);
  const [from, to] = periodRange(w.period || 'all', now);
  const dateField = w.dateField || t.fields.find((f) => f.type === 'date')?.id || '_created';
  const dateOf = (x) => (dateField === '_created' ? localDate(x.rec.created) : x.data[dateField]);

  const kept = rows.filter((x) => {
    if (from) { const d = dateOf(x); if (!d || String(d).slice(0, 10) < from || String(d).slice(0, 10) > to) return false; }
    return matchConditions(w, t, x.data, ctx);
  });

  const mField = w.measure?.field ? fieldOf(t, w.measure.field) : null;
  const op = w.measure?.op || 'count';
  const valuesOf = (list) => (op === 'count' ? list : list.map((x) => x.data[w.measure.field]));
  const fmtType = op === 'count' ? 'number' : (mField?.type === 'money' ? 'money' : 'number');

  if (w.type === 'kpi') {
    return { kind: 'kpi', value: measureOf(op, valuesOf(kept)), fmt: fmtType, count: kept.length };
  }

  if (w.type === 'list') {
    let list = [...new Map(kept.map((x) => [x.rec.id, x.rec])).values()];
    const sf = w.sortField;
    list.sort((a, b) => {
      if (!sf) return a.created < b.created ? 1 : -1;
      const av = a.data[sf], bv = b.data[sf];
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
      return w.sort === 'desc' ? -cmp : cmp;
    });
    return { kind: 'list', rows: list.slice(0, w.limit || 6), total: list.length, table };
  }

  // grouped series (bar / line / donut-like)
  const g = w.group || {};
  const gField = fieldOf(t, g.field);
  const by = g.by || (gField?.type === 'date' ? 'day' : 'value');
  const buckets = new Map();
  for (const x of kept) {
    const raw = g.field === '_created' ? localDate(x.rec.created) : x.data[g.field];
    if (isBlank(raw)) continue;
    const k = gField?.type === 'date' || g.field === '_created' ? bucketKey(raw, by) : String(raw);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(x);
  }
  let series = [...buckets].map(([k, list]) => ({ key: k, value: measureOf(op, valuesOf(list)) }));
  const isDate = gField?.type === 'date' || g.field === '_created';
  if (isDate && by === 'day' && from) {
    // show every day in the range, including zero days
    const map = new Map(series.map((s) => [s.key, s.value]));
    series = [];
    for (let d = from; d <= to; d = addDays(d, 1)) series.push({ key: d, value: map.get(d) || 0 });
  } else if (isDate) series.sort((a, b) => (a.key < b.key ? -1 : 1));
  else {
    series.sort((a, b) => (w.sort === 'asc' ? a.value - b.value : b.value - a.value));
    if (w.limit) series = series.slice(0, w.limit);
  }
  for (const s of series) {
    if (isDate) s.label = by === 'month' ? s.key : fmtDate(s.key);
    else if (gField?.type === 'lookup') { const r = store.getRecord(gField.ref, s.key); const rt = store.table(gField.ref); s.label = r && rt ? recordLabel(rt, r) : '—'; }
    else s.label = s.key;
  }
  return { kind: 'series', series, fmt: fmtType, isDate, total: series.reduce((a, s) => a + s.value, 0) };
}

export function shortDayLabel(key) {
  const d = toDate(key);
  return d ? `${d.getUTCDate()}/${d.getUTCMonth() + 1}` : key;
}
export { dateStr };
