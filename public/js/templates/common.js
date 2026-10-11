// Shared helpers for sector templates. Templates are plain data, built with the chosen language's `t()`
// so a Hindi-speaking owner gets Hindi field names from the very first screen.
export const F = (id, label, type = 'text', extra = {}) => ({ id, label, type, ...extra });

/**
 * Stock kept as a ledger of movements (ledger.js): every sale, purchase, return and correction is a row with its own
 * id, so offline sales of one item on two devices both count after sync. The stock field (`moves: 'stock_moves'`) is
 * the sum of the rows; typing a new number adds a correction row. Hidden: the item page shows it as stock history.
 */
export const stockMovesField = (t) => F('stock_moves', t('Stock history'), 'lines', {
  ledger: true, hidden: true, rowKey: 'qty',
  columns: [F('qty', t('Change'), 'number'), F('kind', t('Why'), 'text', { hidden: true }), F('src', t('From'), 'text', { hidden: true }),
    F('src_table', 'src_table', 'text', { hidden: true }), F('rule', 'rule', 'text', { hidden: true })],
});

/**
 * Shops set up before stock had movements, and tables made in the App builder: every number field a stock workflow
 * (adjust_stock) writes to is kept as movements from now on. Its current number becomes the opening row the first time
 * each item is saved. Safe to run on every start; returns true if it changed the app.
 */
export function upgradeStock(app, t) {
  let changed = false;
  for (const rule of app?.rules || []) for (const a of rule.actions || []) {
    if (a.type !== 'adjust_stock' || !a.targetField) continue;
    const lines = app.tables.find((x) => x.id === rule.table)?.fields.find((f) => f.id === a.linesField);
    const items = app.tables.find((x) => x.id === lines?.columns?.find((c) => c.id === a.itemColumn)?.ref);
    const target = items?.fields.find((f) => f.id === a.targetField && f.type === 'number' && !f.formula);
    if (!target || target.moves) continue;
    const id = items.fields.some((f) => f.id === 'stock_moves') ? `${target.id}_moves` : 'stock_moves';
    if (items.fields.some((f) => f.id === id)) continue;
    items.fields.push({ ...stockMovesField(t), id });
    target.moves = id;
    changed = true;
  }
  return changed;
}

export function baseSettings(t, o = {}) {
  return {
    lang: o.lang || 'en',
    business: { name: o.businessName || '', phone: o.phone || '', address: '', gstin: o.gstin || '', state: o.state || '', pincode: '', upi: o.upi || '', email: '' },
    gst: { round_off: true, hsn_digits: 4, price_incl: false },
    currency: { symbol: '₹', locale: 'en-IN', code: 'INR' },
    countryCode: '91',
    team: [t('Owner'), t('Staff 1')],
    deviceTag: '',
  };
}

export function tasksTable(t, team) {
  return {
    id: 'tasks', name: t('Tasks'), icon: '✅', titleField: 'title', labelFields: ['title'], searchFields: ['title'],
    listColumns: ['title', 'due', 'assignee', 'done'],
    fields: [
      F('title', t('Task'), 'text', { required: true }),
      F('due', t('Due date'), 'date', { width: 'half' }),
      F('assignee', t('Assigned to'), 'select', { options: team, width: 'half', default: team[0] }),
      F('done', t('Done'), 'checkbox', { width: 'half' }),
      F('notes', t('Notes'), 'longtext'),
    ],
  };
}

export const STATUS_COLORS = (good = [], warn = [], bad = [], info = []) => {
  const m = {};
  good.forEach((v) => (m[v] = 'good')); warn.forEach((v) => (m[v] = 'warn')); bad.forEach((v) => (m[v] = 'bad')); info.forEach((v) => (m[v] = 'info'));
  return m;
};

export function makeApp({ name, template, settings, tables, rules, dashboards }) {
  return { v: 1, accessV: 1, counterV: 1, collectV: 2, name, template, settings, tables, rules, dashboards, updated: new Date().toISOString() };
}

export const cond = (field, op, value, vt = 'value') => ({ field, op, value, vt });

// ---- the counter: what the cashier counts at closing time vs what was billed -------------------------------
// "Sales today" used to be the billed total (cash + credit), which never matches the cash drawer. The home screen
// now shows the money actually received today (on any bill, old dues included, split by mode) next to what was billed.

/** Money received today, by payment date, split Cash / UPI / Card: the number the galla is counted against. */
export const collectedToday = (t, id = 'w1') => ({
  id, type: 'kpi', title: t('Collected today'), table: 'invoices', lines: 'payments', period: 'today', dateField: 'pdate',
  measure: { op: 'sum', field: 'amount' }, split: 'mode',
});
/** Value of today's bills, paid or on credit. */
export const billedToday = (t, id, conditions) => ({
  id, type: 'kpi', title: t('Billed today (cash + credit)'), table: 'invoices', period: 'today', dateField: 'date',
  measure: { op: 'sum', field: 'total' }, sub: t('{n} bills'), ...(conditions ? { conditions } : {}),
});
export const pendingSub = (t) => t('{n} unpaid bills, all dates');

/** A bill with no customer is a walk-in counter sale: saved as paid in full (in Cash unless another payment is added). */
export const walkInSale = (mode, when) => ({ party: 'customer', payments: 'payments', mode, ...(when ? { when } : {}) });

/**
 * Brings shops set up before the counter changes up to date, once: walk-in bills become cash sales and the home
 * screen shows "Collected today" next to "Billed today". Only touches widgets that are still the template's own.
 */
export function upgradeCounter(app, t) {
  if (!app || app.counterV || !['retail', 'gst'].includes(app.template)) return false;
  const inv = app.tables.find((x) => x.id === 'invoices');
  const pay = inv?.fields.find((f) => f.id === 'payments');
  const mode = pay?.columns?.find((c) => c.id === 'mode');
  if (inv && pay && mode && inv.walkIn === undefined && inv.fields.some((f) => f.id === 'customer')) {
    inv.walkIn = walkInSale(mode.default || mode.options?.[0] || 'Cash', app.template === 'gst' ? 'doc_type = "Tax Invoice" or doc_type = "Bill of Supply"' : undefined);
  }
  const board = app.dashboards?.find((d) => d.id === 'd_main');
  if (board) {
    const is = (w, id, table, op, field, period) => w && w.id === id && w.type === 'kpi' && w.table === table && !w.lines
      && w.measure?.op === op && (w.measure.field || '') === field && w.period === period;
    const ws = board.widgets;
    const i = ws.findIndex((w) => is(w, 'w1', 'invoices', 'sum', 'total', 'today'));
    if (i >= 0) {
      const billed = billedToday(t, 'w1b', ws[i].conditions?.length ? ws[i].conditions : undefined);
      ws.splice(i, 1, collectedToday(t), billed);
      // "Bills today" is now the line under "Billed today"
      const j = ws.findIndex((w) => is(w, 'w2', 'invoices', 'count', '', 'today'));
      if (j >= 0) ws.splice(j, 1);
    }
    const p = ws.find((w) => is(w, 'w3', 'invoices', 'sum', 'balance', 'all'));
    if (p && !p.sub) p.sub = pendingSub(t);
  }
  app.counterV = 1;
  return true;
}
