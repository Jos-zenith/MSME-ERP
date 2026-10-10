// Retail / kirana starter: customers, items & stock, sales invoices with payments, purchases, tasks,
// plus the workflows and dashboards a shop owner needs on day one.
import { F, baseSettings, tasksTable, STATUS_COLORS, makeApp, cond, collectedToday, billedToday, pendingSub, walkInSale } from './common.js';
import { todayStr, addDays } from '../formula.js';

export function retail(t, o = {}) {
  const settings = baseSettings(t, o);
  const paid = t('Paid'), partial = t('Partial'), unpaid = t('Unpaid');
  const cash = t('Cash'), upi = t('UPI'), card = t('Card'), bank = t('Bank transfer');

  // One-tap "payment received" presets. Used both on the bill form and on the saved bill.
  const payPresets = [
    { label: t('Cash received'), field: 'payments', values: { mode: cash, amount: '=balance' } },
    { label: t('UPI received'), field: 'payments', values: { mode: upi, amount: '=balance' } },
    { label: t('Card received'), field: 'payments', values: { mode: card, amount: '=balance' } },
  ];

  const customers = {
    id: 'customers', name: t('Customers'), icon: '👤',
    titleField: 'name',
    // Two customers may share a name: the phone number tells them apart everywhere they are picked.
    labelFields: ['name', 'phone'], searchFields: ['name', 'phone', 'city'], subFields: ['city'],
    listColumns: ['name', 'phone', 'city'],
    fields: [
      F('name', t('Customer name'), 'text', { required: true }),
      F('phone', t('Phone'), 'phone', { warnDuplicate: true, width: 'half' }),
      F('city', t('City / area'), 'text', { width: 'half' }),
      F('email', t('Email'), 'email'),
      F('notes', t('Notes'), 'longtext'),
    ],
  };

  const items = {
    id: 'items', name: t('Items & stock'), icon: '📦', staff: 'view',
    titleField: 'name', labelFields: ['code', 'name'], focusField: 'name',
    // code first: an exact code (or barcode) match is always the top result, so Enter picks it.
    searchFields: ['code', 'barcode', 'name'], subFields: ['price', 'stock'],
    listColumns: ['code', 'name', 'price', 'stock', 'reorder'],
    fields: [
      F('name', t('Item name'), 'text', { required: true }),
      F('code', t('Item code'), 'text', { unique: true, autoCode: 'name', width: 'half', hint: t('Leave empty: one is made from the name') }),
      F('barcode', t('Barcode'), 'text', { width: 'half', remember: false }),
      F('unit', t('Unit'), 'select', { options: [t('pcs'), t('kg'), t('litre'), t('box'), t('dozen')], default: t('pcs'), width: 'third' }),
      F('price', t('Selling price'), 'money', { required: true, width: 'third' }),
      F('cost', t('Buying price'), 'money', { width: 'third' }),
      F('tax', t('Tax %'), 'number', { default: 0, width: 'third' }),
      F('stock', t('Stock in hand'), 'number', { default: 0, width: 'third' }),
      F('reorder', t('Reorder level'), 'number', { default: 5, width: 'third', hint: t('You get an alert when stock falls to this level') }),
      F('stock_value', t('Stock value'), 'money', { formula: 'stock * cost' }),
    ],
  };

  const invoices = {
    id: 'invoices', name: t('Sales invoices'), icon: '🧾', quick: true,
    titleField: 'number', labelFields: ['number'], searchFields: ['number'],
    listColumns: ['number', 'date', 'customer', 'total', 'balance', 'status'],
    statusField: 'status', sort: { field: 'date', dir: 'desc' }, focusField: 'items', walkIn: walkInSale(cash),
    fields: [
      F('number', t('Invoice no.'), 'text', { auto: { prefix: 'INV-', pad: 4 }, width: 'half' }),
      F('date', t('Date'), 'date', { default: 'today', required: true, width: 'half' }),
      F('customer', t('Customer'), 'lookup', { ref: 'customers', width: 'half', hint: t('Leave empty for a walk-in customer'), fill: { customer_phone: 'phone' }, canCreate: true }),
      F('customer_phone', t('Customer phone'), 'phone', { width: 'half', hint: t('Used to send the bill on WhatsApp') }),
      F('items', t('Items'), 'lines', {
        required: true, quickEntry: true, flow: ['item', 'qty'],
        columns: [
          F('item', t('Item'), 'lookup', { ref: 'items', fill: { desc: 'name', rate: 'price', tax: 'tax' } }),
          F('desc', t('Description'), 'text', { hidden: true }),
          F('qty', t('Qty'), 'number', { default: 1 }),
          F('rate', t('Rate'), 'money'),
          F('disc', t('Disc %'), 'number', { default: 0 }),
          F('tax', t('Tax %'), 'number', { default: 0 }),
          F('taxable', t('Taxable'), 'money', { hidden: true, formula: 'qty * rate * (1 - disc / 100)' }),
          F('amount', t('Amount'), 'money', { formula: 'taxable * (1 + tax / 100)' }),
        ],
      }),
      F('subtotal', t('Subtotal'), 'money', { formula: 'SUM(items.taxable)' }),
      F('tax_total', t('Tax'), 'money', { formula: 'SUM(items.amount) - subtotal' }),
      F('discount', t('Extra discount'), 'money', { default: 0, width: 'half' }),
      F('total', t('Total'), 'money', { formula: 'subtotal + tax_total - discount', big: true }),
      F('payments', t('Payments received'), 'lines', {
        quickAdd: payPresets,
        columns: [
          F('pdate', t('Date'), 'date', { default: 'today' }),
          F('mode', t('Mode'), 'select', { options: [cash, upi, card, bank], default: cash }),
          F('amount', t('Amount'), 'money'),
          F('ref', t('UTR / ref'), 'text', { remember: false }),   // bank reference; Smart Collect fills it in
        ],
      }),
      F('paid', t('Paid'), 'money', { formula: 'SUM(payments.amount)' }),
      F('balance', t('Balance due'), 'money', { formula: 'total - paid', big: true }),
      F('status', t('Payment status'), 'select', {
        options: [unpaid, partial, paid],
        colors: STATUS_COLORS([paid], [partial], [unpaid]),
        formula: `IF(total <= 0 and paid <= 0, "", IF(balance <= 0, "${paid}", IF(paid > 0, "${partial}", "${unpaid}")))`,
      }),
      F('due_date', t('Payment due date'), 'date', { width: 'half', hint: t('For credit sales: reminders start after this date') }),
      F('notes', t('Notes'), 'longtext'),
    ],
    recordActions: payPresets.map((p) => ({ ...p, type: 'add_line', showIf: 'balance > 0' })),
    print: {
      title: t('TAX INVOICE'), number: 'number', date: 'date', party: 'customer', partyPhone: 'customer_phone',
      lines: 'items', columns: ['desc', 'qty', 'rate', 'disc', 'tax', 'amount'],
      totals: ['subtotal', 'tax_total', 'discount', 'total', 'paid', 'balance'], notes: 'notes', qr: true,
    },
  };

  const purchases = {
    id: 'purchases', name: t('Purchases'), icon: '🚚', staff: 'none',
    titleField: 'number', labelFields: ['number'], searchFields: ['number', 'supplier'],
    listColumns: ['number', 'date', 'supplier', 'total'], sort: { field: 'date', dir: 'desc' }, focusField: 'items',
    fields: [
      F('number', t('Purchase no.'), 'text', { auto: { prefix: 'PUR-', pad: 4 }, width: 'half' }),
      F('date', t('Date'), 'date', { default: 'today', required: true, width: 'half' }),
      F('supplier', t('Supplier'), 'text'),
      F('items', t('Items bought'), 'lines', {
        required: true, quickEntry: true, flow: ['item', 'qty', 'rate'],
        columns: [
          F('item', t('Item'), 'lookup', { ref: 'items', fill: { desc: 'name', rate: 'cost' } }),
          F('desc', t('Description'), 'text', { hidden: true }),
          F('qty', t('Qty'), 'number', { default: 1 }),
          F('rate', t('Rate'), 'money'),
          F('amount', t('Amount'), 'money', { formula: 'qty * rate' }),
        ],
      }),
      F('total', t('Total'), 'money', { formula: 'SUM(items.amount)', big: true }),
      F('notes', t('Notes'), 'longtext'),
    ],
  };

  const tasks = tasksTable(t, settings.team);

  const ownerPhone = '{{business.phone}}';
  const rules = [
    {
      id: 'r_stock_out', name: t('Reduce stock when a sale is saved'), enabled: true, table: 'invoices', trigger: 'any', match: 'all', conditions: [],
      actions: [{ type: 'adjust_stock', linesField: 'items', itemColumn: 'item', qtyColumn: 'qty', targetField: 'stock', sign: -1 }],
    },
    {
      id: 'r_stock_in', name: t('Add stock when a purchase is saved'), enabled: true, table: 'purchases', trigger: 'any', match: 'all', conditions: [],
      actions: [{ type: 'adjust_stock', linesField: 'items', itemColumn: 'item', qtyColumn: 'qty', targetField: 'stock', sign: 1 }],
    },
    {
      id: 'r_low_stock', name: t('Low stock alert'), enabled: true, table: 'items', trigger: 'field_changed', field: 'stock', match: 'all', dedupeDays: 1,
      conditions: [cond('stock', '<=', 'reorder', 'field')],
      actions: [
        { type: 'message', channel: 'inapp', body: t('Low stock: {{name}} — only {{stock}} {{unit}} left (reorder level {{reorder}})') },
        ...(o.phone ? [{ type: 'message', channel: 'whatsapp', to: ownerPhone, body: t('Low stock: {{name}} — only {{stock}} {{unit}} left. Time to reorder!') }] : []),
      ],
    },
    {
      // The message keeps its template and is filled in when you tap Send, from the latest bill.
      // So if you record the payment a moment later, the customer gets "Paid", never a false "Balance due".
      id: 'r_share_invoice', name: t('Send the bill to the customer on WhatsApp'), enabled: true, table: 'invoices', trigger: 'created', match: 'all', conditions: [],
      actions: [{
        type: 'message', channel: 'whatsapp', to: '{{customer_phone}}', key: 'invoice-msg',
        body: [
          t('{{#if customer}}Hello {{customer.name}},{{else}}Hello,{{/if}}'),
          t('Thank you for shopping at {{business.name}}.'),
          t('Bill {{number}} dated {{date}}'),
          '{{#each items}}{{@n}}. {{desc}} × {{qty}} = {{amount}}\n{{/each}}',
          t('Total: {{total}}'),
          t('{{#if balance > 0}}Paid so far: {{paid}}\nBalance due: {{balance}}{{#if business.upi}}\nPay by UPI: {{business.upi}}{{/if}}{{else}}✅ Payment received in full. Thank you!{{/if}}'),
        ].join('\n'),
      }],
    },
    {
      id: 'r_receipt', name: t('Send a receipt when a bill becomes fully paid'), enabled: true, table: 'invoices', trigger: 'field_changed', field: 'status', match: 'all',
      conditions: [cond('status', '=', paid)],
      actions: [{
        type: 'message', channel: 'whatsapp', to: '{{customer_phone}}', key: 'invoice-msg',
        body: t('Payment of {{paid}} received for bill {{number}}. Thank you! — {{business.name}}'),
      }],
    },
    {
      id: 'r_overdue', name: t('Remind customers about overdue payments'), enabled: true, table: 'invoices', trigger: 'schedule', match: 'all', dedupeDays: 3,
      conditions: [cond('balance', '>', 0), cond('due_date', 'past', '')],
      actions: [{
        type: 'message', channel: 'whatsapp', to: '{{customer_phone}}',
        body: t('Hello {{customer.name}}, a gentle reminder: {{balance}} is pending for bill {{number}} (due {{due_date}}). {{business.name}}'),
      }],
    },
    {
      id: 'r_collect_task', name: t('Create a follow-up task for credit sales'), enabled: true, table: 'invoices', trigger: 'created', match: 'all',
      conditions: [cond('balance', '>', 0), cond('due_date', 'notempty', '')],
      actions: [{ type: 'create_record', table: 'tasks', values: { title: t('Collect {{balance}} for bill {{number}}'), due: '=due_date', assignee: settings.team[0] } }],
    },
    {
      id: 'r_big_discount', name: t('Owner approval for big discounts'), enabled: true, table: 'invoices', trigger: 'created', match: 'all',
      conditions: [cond('discount', '>', 500)],
      actions: [{ type: 'approval', note: t('Discount of {{discount}} on bill {{number}}') }],
    },
    {
      id: 'r_check_discount', name: t('Discount cannot be more than the bill'), enabled: true, table: 'invoices', trigger: 'before_save', match: 'all',
      conditions: [cond('discount', '>', 'subtotal', 'field')],
      actions: [{ type: 'block', text: t('The extra discount is more than the bill amount.') }],
    },
  ];

  const dashboards = [{
    id: 'd_main', name: t('Business overview'), ownerOnly: true,
    widgets: [
      collectedToday(t),
      billedToday(t, 'w1b'),
      { id: 'w3', type: 'kpi', title: t('Payments pending'), table: 'invoices', period: 'all', measure: { op: 'sum', field: 'balance' }, conditions: [cond('balance', '>', 0)], sub: pendingSub(t) },
      { id: 'w4', type: 'kpi', title: t('Items low on stock'), table: 'items', period: 'all', measure: { op: 'count' }, conditions: [cond('stock', '<=', 'reorder', 'field')] },
      { id: 'w5', type: 'bar', title: t('Sales — last 7 days'), table: 'invoices', period: '7d', dateField: 'date', span: 2, measure: { op: 'sum', field: 'total' }, group: { field: 'date', by: 'day' } },
      { id: 'w6', type: 'bar', title: t('Best-selling items — last 30 days'), table: 'invoices', lines: 'items', period: '30d', dateField: 'date', span: 2, limit: 5, measure: { op: 'sum', field: 'amount' }, group: { field: 'item' } },
      { id: 'w7', type: 'bar', title: t('Money received by mode — last 30 days'), table: 'invoices', lines: 'payments', period: '30d', dateField: 'date', measure: { op: 'sum', field: 'amount' }, group: { field: 'mode' } },
      { id: 'w8', type: 'list', title: t('Unpaid bills'), table: 'invoices', period: 'all', conditions: [cond('balance', '>', 0)], sortField: 'date', sort: 'asc', limit: 6, fields: ['number', 'customer', 'balance'] },
      { id: 'w9', type: 'list', title: t('Low stock'), table: 'items', period: 'all', conditions: [cond('stock', '<=', 'reorder', 'field')], sortField: 'stock', sort: 'asc', limit: 6, fields: ['name', 'stock', 'reorder'] },
    ],
  }];

  return makeApp({ name: o.businessName || t('My shop'), template: 'retail', settings, tables: [invoices, customers, items, purchases, tasks], rules, dashboards });
}

/** Demo data so the dashboards are not empty. Includes two different customers called "Ravi Kumar". */
export async function retailSample(store, t) {
  const item = {};
  const rows = [
    ['SUG1', 'Sugar 1kg', 'kg', 48, 42, 0, 40, 10], ['RIC5', 'Basmati Rice 5kg', 'pcs', 520, 460, 5, 12, 4],
    ['DAL1', 'Toor Dal 1kg', 'kg', 165, 148, 5, 25, 8], ['OIL1', 'Sunflower Oil 1L', 'pcs', 142, 128, 5, 3, 6],
    ['TEA2', 'Tea Powder 250g', 'pcs', 118, 100, 5, 18, 5], ['BIS1', 'Biscuit Pack', 'pcs', 10, 8, 12, 60, 20],
    ['SOA1', 'Bath Soap', 'pcs', 38, 31, 18, 30, 10], ['ATA5', 'Wheat Flour 5kg', 'pcs', 235, 210, 0, 2, 5],
    ['SAL1', 'Salt 1kg', 'pcs', 24, 19, 0, 44, 10], ['MIL1', 'Milk 500ml', 'pcs', 30, 27, 0, 20, 10],
  ];
  for (const [code, name, unit, price, cost, tax, stock, reorder] of rows) {
    const r = await store.saveRecord('items', { code, name, unit: t(unit), price, cost, tax, stock, reorder }, { noRules: true });
    item[code] = r.record.id;
  }
  const cust = {};
  const people = [
    ['ravi1', 'Ravi Kumar', '98765 43210', 'Pune'], ['ravi2', 'Ravi Kumar', '98111 22233', 'Nashik'],
    ['sunita', 'Sunita Sharma', '99887 76655', 'Pune'], ['anil', 'Anil Traders', '90000 11122', 'Mumbai'],
    ['meena', 'Meena Devi', '91234 56780', 'Pune'],
  ];
  for (const [k, name, phone, city] of people) cust[k] = (await store.saveRecord('customers', { name, phone, city }, { noRules: true })).record.id;

  const today = todayStr();
  const bills = [
    [6, 'ravi1', [['SUG1', 5], ['DAL1', 2]], 'Cash'], [6, null, [['BIS1', 6]], 'Cash'], [5, 'sunita', [['RIC5', 1], ['OIL1', 1]], 'UPI'],
    [4, 'anil', [['SAL1', 10], ['SUG1', 10], ['TEA2', 4]], null, -1], [3, 'ravi2', [['MIL1', 4], ['SOA1', 3]], 'UPI'],
    [2, null, [['BIS1', 10], ['MIL1', 2]], 'Cash'], [1, 'meena', [['DAL1', 3], ['TEA2', 2]], 'Cash'], [0, 'ravi1', [['RIC5', 2], ['SUG1', 2]], 'UPI'],
    [0, 'sunita', [['OIL1', 2], ['SOA1', 4], ['SAL1', 3]], null, 7], [0, null, [['MIL1', 3]], 'Cash'],
  ];
  for (const [ago, who, lines, mode, dueOffset] of bills) {
    const data = {
      date: addDays(today, -ago), customer: who ? cust[who] : '',
      items: lines.map(([code, qty]) => ({ item: item[code], qty })),
      due_date: dueOffset !== undefined ? addDays(today, dueOffset) : '',
    };
    const r = await store.saveRecord('invoices', data, { noRules: true });
    if (mode) await store.saveRecord('invoices', { payments: [{ pdate: data.date, mode: t(mode), amount: r.record.data.total }] }, { id: r.record.id, noRules: true });
  }
}
