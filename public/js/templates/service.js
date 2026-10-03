// Service desk starter: repair shops, salons, workshops, tailors - anything with "jobs" that move through stages.
import { F, baseSettings, tasksTable, STATUS_COLORS, makeApp, cond } from './common.js';
import { todayStr, addDays } from '../formula.js';

export function service(t, o = {}) {
  const settings = baseSettings(t, o);
  const st = {
    received: t('Received'), progress: t('In progress'), waiting: t('Waiting for parts'),
    ready: t('Ready'), delivered: t('Delivered'), cancelled: t('Cancelled'),
  };
  const open = [st.received, st.progress, st.waiting];

  const customers = {
    id: 'customers', name: t('Customers'), icon: '👤', titleField: 'name',
    labelFields: ['name', 'phone'], searchFields: ['name', 'phone'], listColumns: ['name', 'phone', 'city'],
    fields: [
      F('name', t('Customer name'), 'text', { required: true }),
      F('phone', t('Phone'), 'phone', { warnDuplicate: true, width: 'half' }),
      F('city', t('City / area'), 'text', { width: 'half' }),
      F('notes', t('Notes'), 'longtext'),
    ],
  };

  const jobs = {
    id: 'jobs', name: t('Service requests'), icon: '🛠️', quick: true,
    titleField: 'number', labelFields: ['number', 'item_desc'], searchFields: ['number', 'item_desc'],
    listColumns: ['number', 'customer', 'item_desc', 'status', 'promised', 'balance'],
    statusField: 'status', sort: { field: 'received', dir: 'desc' },
    fields: [
      F('number', t('Job no.'), 'text', { auto: { prefix: 'SR-', pad: 4 }, width: 'half' }),
      F('received', t('Received on'), 'date', { default: 'today', required: true, width: 'half' }),
      F('customer', t('Customer'), 'lookup', { ref: 'customers', required: true, canCreate: true }),
      F('item_desc', t('Item / device'), 'text', { required: true }),
      F('issue', t('Problem reported'), 'longtext', { required: true }),
      F('priority', t('Priority'), 'select', { options: [t('Normal'), t('Urgent')], default: t('Normal'), width: 'third' }),
      F('assignee', t('Assigned to'), 'select', { options: settings.team, width: 'third' }),
      F('promised', t('Promised by'), 'date', { width: 'third' }),
      F('status', t('Status'), 'select', {
        options: Object.values(st), default: st.received, required: true,
        colors: STATUS_COLORS([st.ready, st.delivered], [st.waiting], [st.cancelled], [st.progress]),
      }),
      F('parts', t('Parts used'), 'lines', {
        columns: [
          F('part', t('Part / material'), 'text'),
          F('qty', t('Qty'), 'number', { default: 1 }),
          F('price', t('Price'), 'money'),
          F('amount', t('Amount'), 'money', { formula: 'qty * price' }),
        ],
      }),
      F('labour', t('Labour charge'), 'money', { default: 0, width: 'half' }),
      F('total', t('Total'), 'money', { formula: 'SUM(parts.amount) + labour', big: true }),
      F('advance', t('Advance received'), 'money', { default: 0, width: 'half' }),
      F('balance', t('Balance due'), 'money', { formula: 'total - advance', big: true }),
    ],
    recordActions: [
      { type: 'set_field', label: t('Mark ready'), field: 'status', value: st.ready, showIf: `status = "${st.received}" or status = "${st.progress}" or status = "${st.waiting}"` },
      { type: 'set_field', label: t('Mark delivered'), field: 'status', value: st.delivered, showIf: `status = "${st.ready}"` },
    ],
    print: {
      title: t('SERVICE JOB SHEET'), number: 'number', date: 'received', party: 'customer', lines: 'parts', columns: ['part', 'qty', 'price', 'amount'],
      totals: ['labour', 'total', 'advance', 'balance'], notes: 'issue', qr: true,
    },
  };

  const tasks = tasksTable(t, settings.team);

  const rules = [
    {
      id: 's_ack', name: t('Confirm to the customer when a job is received'), enabled: true, table: 'jobs', trigger: 'created', match: 'all', conditions: [],
      actions: [{
        type: 'message', channel: 'whatsapp', to: '{{customer.phone}}',
        body: t('Hello {{customer.name}}, we have received your {{item_desc}}. Job no. {{number}}.{{#if promised}} Expected by {{promised}}.{{/if}} — {{business.name}}'),
      }],
    },
    {
      id: 's_ready', name: t('Tell the customer when the job is ready'), enabled: true, table: 'jobs', trigger: 'field_changed', field: 'status', match: 'all',
      conditions: [cond('status', '=', st.ready)],
      actions: [{
        type: 'message', channel: 'whatsapp', to: '{{customer.phone}}',
        body: t('Hello {{customer.name}}, your {{item_desc}} (job {{number}}) is ready for pickup.{{#if balance > 0}} Amount due: {{balance}}.{{/if}} — {{business.name}}'),
      }],
    },
    {
      id: 's_overdue', name: t('Alert me about late jobs'), enabled: true, table: 'jobs', trigger: 'schedule', match: 'all',
      conditions: [cond('promised', 'past', ''), cond('status', '=', st.received)],
      actions: [{ type: 'message', channel: 'inapp', body: t('Job {{number}} ({{item_desc}}) is late — promised {{promised}}') }],
    },
    {
      id: 's_late2', name: t('Alert me about late jobs (in progress)'), enabled: true, table: 'jobs', trigger: 'schedule', match: 'all',
      conditions: [cond('promised', 'past', ''), cond('status', '=', st.progress)],
      actions: [{ type: 'message', channel: 'inapp', body: t('Job {{number}} ({{item_desc}}) is late — promised {{promised}}') }],
    },
    {
      id: 's_urgent', name: t('Create a task for urgent jobs'), enabled: true, table: 'jobs', trigger: 'created', match: 'all',
      conditions: [cond('priority', '=', t('Urgent'))],
      actions: [{ type: 'create_record', table: 'tasks', values: { title: t('Urgent: {{item_desc}} ({{number}})'), due: '=promised', assignee: '=assignee' } }],
    },
    {
      id: 's_approve', name: t('Owner approval for expensive repairs'), enabled: true, table: 'jobs', trigger: 'saved', match: 'all',
      conditions: [cond('total', '>', 5000)],
      actions: [{ type: 'approval', note: t('Job {{number}} total is {{total}}') }],
    },
    {
      id: 's_block', name: t('Do not deliver while money is due'), enabled: true, table: 'jobs', trigger: 'before_save', match: 'all',
      conditions: [cond('status', '=', st.delivered), cond('balance', '>', 0)],
      actions: [{ type: 'block', text: t('Collect the balance of {{balance}} before marking the job as delivered.') }],
    },
  ];

  const dashboards = [{
    id: 'd_main', name: t('Workshop overview'), ownerOnly: true,
    widgets: [
      { id: 'w1', type: 'kpi', title: t('Open jobs'), table: 'jobs', period: 'all', measure: { op: 'count' }, match: 'any', conditions: open.map((v) => cond('status', '=', v)) },
      { id: 'w2', type: 'kpi', title: t('Ready for pickup'), table: 'jobs', period: 'all', measure: { op: 'count' }, conditions: [cond('status', '=', st.ready)] },
      { id: 'w3', type: 'kpi', title: t('Money to collect'), table: 'jobs', period: 'all', measure: { op: 'sum', field: 'balance' }, conditions: [cond('balance', '>', 0)] },
      { id: 'w4', type: 'kpi', title: t('Earned this month'), table: 'jobs', period: 'month', dateField: 'received', measure: { op: 'sum', field: 'total' }, conditions: [cond('status', '=', st.delivered)] },
      { id: 'w5', type: 'bar', title: t('Jobs by status'), table: 'jobs', period: 'all', span: 2, measure: { op: 'count' }, group: { field: 'status' } },
      { id: 'w6', type: 'bar', title: t('Jobs received — last 7 days'), table: 'jobs', period: '7d', dateField: 'received', span: 2, measure: { op: 'count' }, group: { field: 'received', by: 'day' } },
      { id: 'w7', type: 'list', title: t('Late jobs'), table: 'jobs', period: 'all', conditions: [cond('promised', 'past', ''), cond('status', '!=', st.delivered), cond('status', '!=', st.cancelled)], sortField: 'promised', sort: 'asc', limit: 6, fields: ['number', 'customer', 'promised'] },
    ],
  }];

  return makeApp({ name: o.businessName || t('My workshop'), template: 'service', settings, tables: [jobs, customers, tasks], rules, dashboards });
}

export async function serviceSample(store, t) {
  const c1 = (await store.saveRecord('customers', { name: 'Kavita Joshi', phone: '98220 11223', city: 'Pune' }, { noRules: true })).record.id;
  const c2 = (await store.saveRecord('customers', { name: 'Imran Shaikh', phone: '99700 44556', city: 'Pune' }, { noRules: true })).record.id;
  const today = todayStr();
  const mk = (data) => store.saveRecord('jobs', data, { noRules: true });
  await mk({ customer: c1, item_desc: 'Mixer grinder', issue: 'Motor makes noise, jar leaks', received: addDays(today, -4), promised: addDays(today, -1), status: t('In progress'), labour: 350, advance: 100 });
  await mk({ customer: c2, item_desc: 'Samsung phone A32', issue: 'Cracked screen', received: addDays(today, -2), promised: addDays(today, 2), status: t('Waiting for parts'), parts: [{ part: 'Screen', qty: 1, price: 2800 }], labour: 300, advance: 500 });
  await mk({ customer: c1, item_desc: 'Ceiling fan', issue: 'Capacitor replacement', received: addDays(today, -1), promised: today, status: t('Ready'), parts: [{ part: 'Capacitor', qty: 1, price: 120 }], labour: 150, advance: 0 });
}
