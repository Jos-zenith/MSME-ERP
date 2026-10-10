// GST shop / trader starter: the retail app, with the GST engine (public/gst) doing the tax.
// Tax invoices, bills of supply and credit notes; CGST + SGST or IGST worked out live from the place of supply;
// HSN codes and GST rates that travel from the item to the bill; purchases that feed input credit; GSTR-1 / 3B.
import { F, baseSettings, tasksTable, STATUS_COLORS, makeApp, cond, collectedToday, billedToday, pendingSub, walkInSale } from './common.js';
import { todayStr, addDays } from '../formula.js';
import { STATE_LABELS, UNIT_NAMES, GST_RATES, DOC_TYPES, stateCodeOf, stateLabel } from '../../gst/js/gst.js';
import '../../gst/js/hooks.js';

const RATES = GST_RATES.map(String);

export function gstShop(t, o = {}) {
  const state = stateLabel(stateCodeOf(o.gstin) || stateCodeOf(o.state));
  const settings = baseSettings(t, { ...o, state });
  // status values come from the GST engine (it also feeds the returns), so they stay in English
  const cash = t('Cash'), upi = t('UPI'), card = t('Card'), bank = t('Bank transfer');
  const payPresets = [
    { label: t('Cash received'), field: 'payments', values: { mode: cash, amount: '=balance' } },
    { label: t('UPI received'), field: 'payments', values: { mode: upi, amount: '=balance' } },
    { label: t('Card received'), field: 'payments', values: { mode: card, amount: '=balance' } },
  ];
  const party = (id, name, icon) => ({
    id, name, icon, hooks: 'gst_party',
    titleField: 'name', labelFields: ['name', 'phone'], searchFields: ['name', 'phone', 'gstin', 'city'], subFields: ['city', 'gstin'],
    listColumns: ['name', 'phone', 'city', 'gstin'],
    fields: [
      F('name', t('Name'), 'text', { required: true }),
      F('phone', t('Phone'), 'phone', { warnDuplicate: true, width: 'half' }),
      F('gstin', t('GSTIN'), 'text', { width: 'half', warnDuplicate: true, remember: false, hint: t('Leave empty if not registered. The state fills itself in from the GSTIN.') }),
      F('state', t('State'), 'select', { options: STATE_LABELS, width: 'half' }),
      F('city', t('City / area'), 'text', { width: 'half' }),
      F('address', t('Address'), 'text'),
      F('pincode', t('PIN code'), 'text', { width: 'half', remember: false }),
      F('email', t('Email'), 'email', { width: 'half' }),
    ],
  });
  const customers = party('customers', t('Customers'), '👤');
  const suppliers = { ...party('suppliers', t('Suppliers'), '🏭'), staff: 'none' };

  const items = {
    id: 'items', name: t('Items & stock'), icon: '📦', newLabel: t('Item'), staff: 'view',
    titleField: 'name', labelFields: ['code', 'name'], focusField: 'name',
    searchFields: ['code', 'barcode', 'name', 'hsn'], subFields: ['price', 'gst', 'stock'],
    listColumns: ['code', 'name', 'hsn', 'gst', 'price', 'stock'],
    fields: [
      F('name', t('Item name'), 'text', { required: true }),
      F('code', t('Item code'), 'text', { unique: true, autoCode: 'name', width: 'half', hint: t('Leave empty: one is made from the name') }),
      F('barcode', t('Barcode'), 'text', { width: 'half', remember: false }),
      F('hsn', t('HSN / SAC'), 'text', { width: 'third', hint: t('4 digits or more for B2B bills') }),
      F('gst', t('GST %'), 'select', { options: RATES, default: '18', width: 'third' }),
      F('unit', t('Unit'), 'select', { options: UNIT_NAMES, default: 'Nos', width: 'third' }),
      F('price', t('Selling price'), 'money', { required: true, width: 'third' }),
      F('cost', t('Buying price'), 'money', { width: 'third' }),
      F('cess', t('Cess %'), 'number', { default: 0, width: 'third' }),
      F('stock', t('Stock in hand'), 'number', { default: 0, width: 'third' }),
      F('reorder', t('Reorder level'), 'number', { default: 5, width: 'third', hint: t('You get an alert when stock falls to this level') }),
      F('stock_value', t('Stock value'), 'money', { formula: 'stock * cost' }),
    ],
  };

  // computed by the GST engine (hooks: 'gst_invoice'); shown read-only
  const C = (id, label, type = 'money', extra = {}) => F(id, label, type, { computed: true, ...extra });
  const invoices = {
    id: 'invoices', name: t('Invoices'), icon: '🧾', quick: true, hooks: 'gst_invoice', newLabel: t('GST invoice'),
    titleField: 'number', labelFields: ['number'], searchFields: ['number', 'bill_gstin'],
    listColumns: ['number', 'date', 'customer', 'total', 'balance', 'status'],
    statusField: 'status', sort: { field: 'date', dir: 'desc' }, focusField: 'items',
    walkIn: walkInSale(cash, 'doc_type = "Tax Invoice" or doc_type = "Bill of Supply"'),
    fields: [
      F('doc_type', t('Document'), 'select', { options: DOC_TYPES, default: 'Tax Invoice', width: 'third', noRepeat: true }),
      C('number', t('Invoice no.'), 'text', { numbered: true, width: 'third' }),
      F('date', t('Date'), 'date', { default: 'today', required: true, width: 'third' }),
      F('customer', t('Customer'), 'lookup', { ref: 'customers', width: 'half', canCreate: true, hint: t('Type a name or phone. Leave empty for a walk-in customer.'), fill: { customer_phone: 'phone', bill_gstin: 'gstin', pos: 'state' } }),
      F('customer_phone', t('Customer phone'), 'phone', { width: 'half', hint: t('Type a saved number and the customer is picked for you') }),
      F('bill_gstin', t('Customer GSTIN'), 'text', { width: 'half', remember: false, hint: t('Empty = unregistered (B2C) sale') }),
      F('pos', t('Place of supply'), 'select', { options: STATE_LABELS, width: 'half' }),
      C('tax_note', t('Tax'), 'text', { note: true }),
      F('items', t('Items'), 'lines', {
        required: true, quickEntry: true, flow: ['item', 'qty'],
        columns: [
          F('item', t('Item'), 'lookup', { ref: 'items', fill: { desc: 'name', rate: 'price', gst: 'gst', hsn: 'hsn', unit: 'unit', cess_pct: 'cess' } }),
          F('desc', t('Description'), 'text', { hidden: true }),
          F('hsn', t('HSN'), 'text'),
          F('qty', t('Qty'), 'number', { default: 1 }),
          F('unit', t('Unit'), 'text', { hidden: true }),
          F('rate', t('Rate'), 'money'),
          F('disc', t('Disc %'), 'number', { default: 0 }),
          F('gst', t('GST %'), 'select', { options: RATES, default: '18' }),
          F('cess_pct', t('Cess %'), 'number', { default: 0, hidden: true }),
          F('taxable', t('Taxable'), 'money', { computed: true, hidden: true }),
          F('cgst', 'CGST', 'money', { computed: true, hidden: true }),
          F('sgst', 'SGST', 'money', { computed: true, hidden: true }),
          F('igst', 'IGST', 'money', { computed: true, hidden: true }),
          F('cess', t('Cess'), 'money', { computed: true, hidden: true }),
          F('amount', t('Amount'), 'money', { computed: true }),
        ],
      }),
      F('price_incl', t('Prices include GST'), 'checkbox', { width: 'half' }),
      F('ref_note', t('Against invoice no.'), 'text', { width: 'half', showIf: 'doc_type = "Credit Note" or doc_type = "Debit Note"', remember: false }),
      C('discount_total', t('Discount'), 'money', { hideZero: true }),
      C('taxable', t('Taxable value')),
      C('cgst', 'CGST', 'money', { hideZero: true }),
      C('sgst', 'SGST / UTGST', 'money', { hideZero: true }),
      C('igst', 'IGST', 'money', { hideZero: true }),
      C('cess', t('Cess'), 'money', { hideZero: true }),
      C('round_off', t('Round off'), 'money', { hideZero: true }),
      C('tax_total', 'GST', 'money', { hidden: true }),
      C('total', t('Total'), 'money', { big: true }),
      F('payments', t('Payments received'), 'lines', {
        quickAdd: payPresets,
        columns: [
          F('pdate', t('Date'), 'date', { default: 'today' }),
          F('mode', t('Mode'), 'select', { options: [cash, upi, card, bank], default: cash }),
          F('amount', t('Amount'), 'money'),
          F('ref', t('UTR / ref'), 'text', { remember: false }),   // bank reference; Smart Collect fills it in
        ],
      }),
      C('paid', t('Paid'), 'money', { hideZero: true }),
      C('balance', t('Balance due'), 'money', { big: true }),
      C('status', t('Payment status'), 'select', { options: ['Unpaid', 'Partial', 'Paid', 'Cancelled'], colors: STATUS_COLORS(['Paid'], ['Partial'], ['Unpaid'], ['Cancelled']) }),
      F('due_date', t('Payment due date'), 'date', { width: 'half', hint: t('For credit sales: reminders start after this date') }),
      F('notes', t('Notes'), 'longtext'),
    ],
    recordActions: payPresets.map((p) => ({ ...p, type: 'add_line', showIf: 'balance > 0' })),
    print: {
      gst: true, number: 'number', date: 'date', party: 'customer', partyPhone: 'customer_phone',
      lines: 'items', columns: ['desc', 'hsn', 'qty', 'rate', 'disc', 'gst', 'taxable', 'amount'],
      totals: ['discount_total', 'taxable', 'cgst', 'sgst', 'igst', 'cess', 'round_off', 'total', 'paid', 'balance'], notes: 'notes', qr: true,
    },
  };

  const purchases = {
    id: 'purchases', name: t('Purchases'), icon: '🚚', hooks: 'gst_purchase', staff: 'none', newLabel: t('Purchase bill'),
    titleField: 'number', labelFields: ['number'], searchFields: ['number', 'bill_no'],
    listColumns: ['number', 'date', 'supplier', 'bill_no', 'tax_total', 'total'], sort: { field: 'date', dir: 'desc' }, focusField: 'items',
    fields: [
      F('number', t('Purchase no.'), 'text', { auto: { prefix: 'PUR-', pad: 4 }, width: 'third' }),
      F('date', t('Date'), 'date', { default: 'today', required: true, width: 'third' }),
      F('bill_no', t('Supplier bill no.'), 'text', { width: 'third', remember: false }),
      F('supplier', t('Supplier'), 'lookup', { ref: 'suppliers', canCreate: true, width: 'half', fill: { supplier_gstin: 'gstin', supplier_state: 'state' } }),
      F('supplier_gstin', t('Supplier GSTIN'), 'text', { width: 'half', remember: false }),
      F('supplier_state', t('Supplier state'), 'select', { options: STATE_LABELS, hidden: true }),
      C('tax_note', t('Tax'), 'text', { note: true }),
      F('items', t('Items bought'), 'lines', {
        required: true, quickEntry: true, flow: ['item', 'qty', 'rate'],
        columns: [
          F('item', t('Item'), 'lookup', { ref: 'items', fill: { desc: 'name', rate: 'cost', gst: 'gst', hsn: 'hsn', cess_pct: 'cess' } }),
          F('desc', t('Description'), 'text', { hidden: true }),
          F('hsn', t('HSN'), 'text', { hidden: true }),
          F('qty', t('Qty'), 'number', { default: 1 }),
          F('rate', t('Rate'), 'money'),
          F('gst', t('GST %'), 'select', { options: RATES, default: '18' }),
          F('cess_pct', t('Cess %'), 'number', { default: 0, hidden: true }),
          F('taxable', t('Taxable'), 'money', { computed: true, hidden: true }),
          F('amount', t('Amount'), 'money', { computed: true }),
        ],
      }),
      C('taxable', t('Taxable value')),
      C('cgst', 'CGST', 'money', { hideZero: true }),
      C('sgst', 'SGST / UTGST', 'money', { hideZero: true }),
      C('igst', 'IGST', 'money', { hideZero: true }),
      C('tax_total', t('GST paid'), 'money', { hideZero: true }),
      C('total', t('Total'), 'money', { big: true }),
      F('itc_eligible', t('Claim input tax credit'), 'checkbox', { default: true, width: 'half' }),
      F('notes', t('Notes'), 'longtext'),
    ],
  };

  const tasks = tasksTable(t, settings.team);
  const notCredit = [cond('doc_type', '!=', 'Credit Note'), cond('doc_type', '!=', 'Proforma Invoice')];
  const rules = [
    { id: 'r_stock_out', name: t('Reduce stock when a sale is saved'), enabled: true, table: 'invoices', trigger: 'any', match: 'all', conditions: notCredit,
      actions: [{ type: 'adjust_stock', linesField: 'items', itemColumn: 'item', qtyColumn: 'qty', targetField: 'stock', sign: -1 }] },
    { id: 'r_stock_return', name: t('Put stock back on a credit note'), enabled: true, table: 'invoices', trigger: 'any', match: 'all', conditions: [cond('doc_type', '=', 'Credit Note')],
      actions: [{ type: 'adjust_stock', linesField: 'items', itemColumn: 'item', qtyColumn: 'qty', targetField: 'stock', sign: 1 }] },
    { id: 'r_stock_in', name: t('Add stock when a purchase is saved'), enabled: true, table: 'purchases', trigger: 'any', match: 'all', conditions: [],
      actions: [{ type: 'adjust_stock', linesField: 'items', itemColumn: 'item', qtyColumn: 'qty', targetField: 'stock', sign: 1 }] },
    { id: 'r_low_stock', name: t('Low stock alert'), enabled: true, table: 'items', trigger: 'field_changed', field: 'stock', match: 'all', dedupeDays: 1,
      conditions: [cond('stock', '<=', 'reorder', 'field')],
      actions: [{ type: 'message', channel: 'inapp', body: t('Low stock: {{name}} — only {{stock}} {{unit}} left (reorder level {{reorder}})') }] },
    { id: 'r_share_invoice', name: t('Send the bill to the customer on WhatsApp'), enabled: true, table: 'invoices', trigger: 'created', match: 'all', conditions: [cond('doc_type', '=', 'Tax Invoice')],
      actions: [{
        type: 'message', channel: 'whatsapp', to: '{{customer_phone}}', key: 'invoice-msg',
        body: [
          t('{{#if customer}}Hello {{customer.name}},{{else}}Hello,{{/if}}'),
          t('Thank you for shopping at {{business.name}}.'),
          t('Bill {{number}} dated {{date}}'),
          '{{#each items}}{{@n}}. {{desc}} × {{qty}} = {{amount}}\n{{/each}}',
          t('Total: {{total}} (GST {{tax_total}})'),
          t('{{#if balance > 0}}Paid so far: {{paid}}\nBalance due: {{balance}}{{#if business.upi}}\nPay by UPI: {{business.upi}}{{/if}}{{else}}✅ Payment received in full. Thank you!{{/if}}'),
        ].join('\n'),
      }] },
    { id: 'r_receipt', name: t('Send a receipt when a bill becomes fully paid'), enabled: true, table: 'invoices', trigger: 'field_changed', field: 'status', match: 'all',
      conditions: [cond('status', '=', 'Paid')],
      actions: [{ type: 'message', channel: 'whatsapp', to: '{{customer_phone}}', key: 'invoice-msg', body: t('Payment of {{paid}} received for bill {{number}}. Thank you! — {{business.name}}') }] },
    { id: 'r_overdue', name: t('Remind customers about overdue payments'), enabled: true, table: 'invoices', trigger: 'schedule', match: 'all', dedupeDays: 3,
      conditions: [cond('balance', '>', 0), cond('due_date', 'past', '')],
      actions: [{ type: 'message', channel: 'whatsapp', to: '{{customer_phone}}', body: t('Hello {{customer.name}}, a gentle reminder: {{balance}} is pending for bill {{number}} (due {{due_date}}). {{business.name}}') }] },
    { id: 'r_collect_task', name: t('Create a follow-up task for credit sales'), enabled: true, table: 'invoices', trigger: 'created', match: 'all',
      conditions: [cond('balance', '>', 0), cond('due_date', 'notempty', '')],
      actions: [{ type: 'create_record', table: 'tasks', values: { title: t('Collect {{balance}} for bill {{number}}'), due: '=due_date', assignee: settings.team[0] } }] },
  ];

  const dashboards = [{
    id: 'd_main', name: t('Business overview'), ownerOnly: true,
    widgets: [
      collectedToday(t),
      billedToday(t, 'w1b', [cond('doc_type', '=', 'Tax Invoice')]),
      { id: 'w2', type: 'kpi', title: t('GST collected this month'), table: 'invoices', period: 'month', dateField: 'date', measure: { op: 'sum', field: 'tax_total' }, conditions: [cond('doc_type', '=', 'Tax Invoice')] },
      { id: 'w3', type: 'kpi', title: t('Payments pending'), table: 'invoices', period: 'all', measure: { op: 'sum', field: 'balance' }, conditions: [cond('balance', '>', 0)], sub: pendingSub(t) },
      { id: 'w4', type: 'kpi', title: t('Items low on stock'), table: 'items', period: 'all', measure: { op: 'count' }, conditions: [cond('stock', '<=', 'reorder', 'field')] },
      { id: 'w5', type: 'bar', title: t('Sales — last 7 days'), table: 'invoices', period: '7d', dateField: 'date', span: 2, measure: { op: 'sum', field: 'total' }, group: { field: 'date', by: 'day' } },
      { id: 'w6', type: 'bar', title: t('Best-selling items — last 30 days'), table: 'invoices', lines: 'items', period: '30d', dateField: 'date', span: 2, limit: 5, measure: { op: 'sum', field: 'amount' }, group: { field: 'item' } },
      { id: 'w7', type: 'bar', title: t('Taxable sales by GST rate — this month'), table: 'invoices', lines: 'items', period: 'month', dateField: 'date', measure: { op: 'sum', field: 'taxable' }, group: { field: 'gst' } },
      { id: 'w8', type: 'list', title: t('Unpaid bills'), table: 'invoices', period: 'all', conditions: [cond('balance', '>', 0)], sortField: 'date', sort: 'asc', limit: 6, fields: ['number', 'customer', 'balance'] },
      { id: 'w9', type: 'list', title: t('Low stock'), table: 'items', period: 'all', conditions: [cond('stock', '<=', 'reorder', 'field')], sortField: 'stock', sort: 'asc', limit: 6, fields: ['name', 'stock', 'reorder'] },
    ],
  }];

  return makeApp({ name: o.businessName || t('My shop'), template: 'gst', settings, tables: [invoices, customers, items, purchases, suppliers, tasks], rules, dashboards });
}

/**
 * Demo data. The two party GSTINs are the public sample numbers used in GST documentation (one in Maharashtra, one in
 * Delhi), so the bills show both a CGST + SGST and an IGST case whatever state the shop is in.
 */
export async function gstShopSample(store, t) {
  const item = {};
  const rows = [
    ['Sugar 1kg', '1701', '5', 'Kg', 48, 42, 40, 10], ['Basmati Rice 5kg', '1006', '5', 'Bag', 520, 460, 12, 4],
    ['Toor Dal 1kg', '0713', '5', 'Kg', 165, 148, 25, 8], ['Sunflower Oil 1L', '1512', '5', 'Bottle', 142, 128, 3, 6],
    ['Tea Powder 250g', '0902', '5', 'Packet', 118, 100, 18, 5], ['Biscuit Pack', '1905', '18', 'Packet', 10, 8, 60, 20],
    ['Bath Soap', '3401', '18', 'Pcs', 38, 31, 30, 10], ['Steel Bucket', '7323', '12', 'Nos', 260, 210, 8, 3],
  ];
  for (const [name, hsn, gst, unit, price, cost, stock, reorder] of rows) {
    const r = await store.saveRecord('items', { name, hsn, gst, unit, price, cost, stock, reorder }, { noRules: true });
    item[name.split(' ')[0]] = r.record.id;
  }
  const cust = {};
  for (const [k, name, phone, city, gstin] of [
    ['ravi', 'Ravi Kumar', '98765 43210', 'Pune', ''], ['ravi2', 'Ravi Kumar', '98111 22233', 'Nashik', ''],
    ['caterers', 'Pune Caterers', '90000 11122', 'Pune', '27AAPFU0939F1ZV'], ['delhi', 'Capital Traders', '91234 56780', 'New Delhi', '07AAGFF2194N1Z1'],
  ]) cust[k] = (await store.saveRecord('customers', { name, phone, city, gstin, state: gstin ? '' : store.business.state }, { noRules: true })).record.id;
  const sup = (await store.saveRecord('suppliers', { name: 'Metro Wholesale', phone: '90000 33344', gstin: '07AAGFF2194N1Z1', city: 'New Delhi' }, { noRules: true })).record.id;

  const today = todayStr();
  const bills = [
    [6, 'ravi', [['Sugar', 5], ['Toor', 2]], 'Cash'], [5, null, [['Biscuit', 6]], 'Cash'], [4, 'caterers', [['Basmati', 4], ['Sunflower', 6]], null, 10],
    [3, 'delhi', [['Steel', 10], ['Bath', 24]], 'Bank transfer'], [2, 'ravi2', [['Tea', 2], ['Bath', 3]], 'UPI'], [1, null, [['Biscuit', 10], ['Sugar', 2]], 'Cash'],
    [0, 'ravi', [['Basmati', 1], ['Sugar', 2]], 'UPI'], [0, 'caterers', [['Toor', 6], ['Tea', 3]], null, 7],
  ];
  for (const [ago, who, lines, mode, dueOffset] of bills) {
    const data = {
      doc_type: 'Tax Invoice', date: addDays(today, -ago), customer: who ? cust[who] : '',
      items: lines.map(([k, qty]) => ({ item: item[k], qty })), due_date: dueOffset !== undefined ? addDays(today, dueOffset) : '',
    };
    const r = await store.saveRecord('invoices', data, { noRules: true });
    if (!r.ok) continue;
    if (mode) await store.saveRecord('invoices', { payments: [{ pdate: data.date, mode: t(mode), amount: r.record.data.total }] }, { id: r.record.id, noRules: true });
  }
  await store.saveRecord('purchases', {
    date: addDays(today, -5), supplier: sup, bill_no: 'MW/2201',
    items: [['Steel', 12], ['Bath', 48], ['Biscuit', 100]].map(([k, qty]) => ({ item: item[k], qty })),
  }, { noRules: true });
}
