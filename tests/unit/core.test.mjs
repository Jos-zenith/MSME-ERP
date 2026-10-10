import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, check, round, todayStr, addDays } from '../../public/js/formula.js';
import { Store } from '../../public/js/store.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate, TEMPLATES } from '../../public/js/templates/index.js';
import { upgradeCounter } from '../../public/js/templates/common.js';
import { renderTemplate } from '../../public/js/logic.js';
import { searchRecords, recordLabel } from '../../public/js/schema.js';
import { widgetData } from '../../public/js/analytics.js';
import { runScheduled } from '../../public/js/rules.js';

const t = (s) => s;
const sc = (vars) => (parts) => vars[parts[0]];

async function shop({ phone = '9000000001', upi = 'shop@upi' } = {}) {
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('retail', t, { businessName: 'Test Mart', phone, upi }));
  const sugar = (await store.saveRecord('items', { code: 'SUG1', name: 'Sugar 1kg', unit: 'kg', price: 50, cost: 40, tax: 0, stock: 20, reorder: 5 })).record;
  const soap = (await store.saveRecord('items', { code: 'SOA1', name: 'Soap', unit: 'pcs', price: 100, cost: 80, tax: 18, stock: 6, reorder: 5 })).record;
  return { store, sugar, soap };
}

test('formula: arithmetic, precedence, functions, strings', () => {
  const s = sc({ a: 2, b: 3, name: 'Ravi', items: [1, 2, 3] });
  assert.equal(evaluate('a + b * 4', s), 14);
  assert.equal(evaluate('(a + b) * 4', s), 20);
  assert.equal(evaluate('-a + 10', s), 8);
  assert.equal(evaluate('SUM(items) + MAX(a, b)', s), 9);
  assert.equal(evaluate('IF(a > b, "big", "small")', s), 'small');
  assert.equal(evaluate('name & "!"'.replace('&', '+'), s), 'Ravi!');
  assert.equal(evaluate('a = 2 and b >= 3', s), true);
  assert.equal(evaluate('not (a = 2)', s), false);
  assert.equal(evaluate('10 / 0', s), 0, 'division by zero does not blow up');
  assert.equal(evaluate('round(1.005, 2)', s), 1.01);
  assert.equal(round(-2.5), -3);
});

test('formula: is safe (no code execution) and reports errors', () => {
  assert.throws(() => evaluate('constructor.constructor("return 1")()', sc({})));
  assert.throws(() => evaluate('a +', sc({})));
  assert.match(check('a +', () => true), /ends too early/);
  assert.match(check('nope + 1', (n) => n === 'a'), /Unknown field/);
  assert.match(check('FOO(1)', () => true), /Unknown function/);
  assert.equal(check('a + 1', (n) => n === 'a'), null);
});

test('every template builds and only references fields that exist', () => {
  for (const tpl of TEMPLATES) {
    const app = tpl.build(t, { businessName: 'X', phone: '1' });
    const ids = new Set(app.tables.map((x) => x.id));
    for (const table of app.tables) {
      assert.ok(table.fields.some((f) => f.id === table.titleField), `${tpl.id}.${table.id} title field`);
      const names = new Set(table.fields.map((f) => f.id));
      for (const f of table.fields) {
        if (f.formula) {
          const problem = check(f.formula, (n) => names.has(n));
          assert.equal(problem, null, `${table.id}.${f.id}: ${problem}`);
        }
        if (f.type === 'lookup') assert.ok(ids.has(f.ref), `${table.id}.${f.id} -> ${f.ref}`);
        for (const c of f.columns || []) {
          const cn = new Set([...names, ...f.columns.map((x) => x.id)]);
          if (c.formula) assert.equal(check(c.formula, (n) => cn.has(n)), null, `${table.id}.${f.id}.${c.id}`);
          if (c.type === 'lookup') assert.ok(ids.has(c.ref));
        }
      }
    }
    for (const r of app.rules) {
      assert.ok(ids.has(r.table), `rule ${r.id} table`);
      const table = app.tables.find((x) => x.id === r.table);
      for (const c of r.conditions) assert.ok(table.fields.some((f) => f.id === c.field.split('.')[0]), `rule ${r.id} cond ${c.field}`);
    }
  }
});

test('invoice totals, GST, payment status and stock deduction', async () => {
  const { store, sugar, soap } = await shop();
  const r = await store.saveRecord('invoices', {
    items: [{ item: sugar.id, qty: 2 }, { item: soap.id, qty: 1 }],
  });
  assert.equal(r.ok, true);
  const d = r.record.data;
  assert.equal(d.number, 'INV-0001');
  assert.equal(d.items[0].rate, 50, 'rate auto-filled from item');
  assert.equal(d.items[1].tax, 18, 'tax auto-filled from item');
  assert.equal(d.subtotal, 200);
  assert.equal(d.tax_total, 18);
  assert.equal(d.total, 218);
  assert.equal(d.balance, 218);
  assert.equal(d.status, 'Unpaid');
  assert.equal(store.getRecord('items', sugar.id).data.stock, 18, 'stock reduced');
  assert.equal(store.getRecord('items', soap.id).data.stock, 5);

  // editing the quantity only applies the difference
  await store.saveRecord('invoices', { items: [{ ...d.items[0], qty: 5 }, d.items[1]] }, { id: r.record.id });
  assert.equal(store.getRecord('items', sugar.id).data.stock, 15);
  // deleting the bill puts the stock back
  await store.deleteRecord('invoices', r.record.id);
  assert.equal(store.getRecord('items', sugar.id).data.stock, 20);
  assert.equal(store.getRecord('items', soap.id).data.stock, 6);
});

test('FIX #4: two customers can share a name; the phone tells them apart', async () => {
  const { store } = await shop();
  const a = await store.saveRecord('customers', { name: 'Ravi Kumar', phone: '98765 43210', city: 'Pune' });
  const b = await store.saveRecord('customers', { name: 'Ravi Kumar', phone: '98111 22233', city: 'Nashik' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, 'a same-name customer is NOT rejected');
  const table = store.table('customers');
  assert.notEqual(recordLabel(table, a.record), recordLabel(table, b.record));
  assert.match(recordLabel(table, b.record), /98111 22233/);
  // same phone: only a soft warning, never a block
  const soft = store.softDuplicates('customers', { name: 'Someone', phone: '9876543210' });
  assert.equal(soft.length, 1);
  assert.equal(soft[0].matches[0].id, a.record.id);
  const c = await store.saveRecord('customers', { name: 'Someone', phone: '9876543210' });
  assert.equal(c.ok, true);
  // but item codes ARE unique (exact-code entry depends on it)
  const dupe = await store.saveRecord('items', { code: 'sug1', name: 'Other', price: 1 });
  assert.equal(dupe.ok, false);
  assert.equal(dupe.errors.code, 'duplicate');
});

test('FIX #2: an exact item code (or barcode) always ranks first, so Enter picks it', async () => {
  const { store } = await shop();
  await store.saveRecord('items', { code: 'SUG10', name: 'Sugar 10kg sack', price: 450 });
  await store.saveRecord('items', { code: 'X1', barcode: '8901234567890', name: 'Sugar-free mints', price: 20 });
  const items = store.table('items');
  const all = store.records('items');
  assert.equal(searchRecords(items, all, 'sug1')[0].data.code, 'SUG1', 'exact code beats prefix matches');
  assert.equal(searchRecords(items, all, 'SUG1')[0].data.code, 'SUG1', 'case-insensitive');
  assert.equal(searchRecords(items, all, '8901234567890')[0].data.code, 'X1', 'barcode scan');
  assert.ok(searchRecords(items, all, 'sugar').length >= 3, 'name search still works');
  assert.equal(searchRecords(items, all, 'zzz').length, 0);
});

test('FIX #6: line items keep the order they were entered (top to bottom)', async () => {
  const { store, sugar, soap } = await shop();
  const r = await store.saveRecord('invoices', { items: [{ item: soap.id, qty: 1 }, { item: sugar.id, qty: 1 }, { item: soap.id, qty: 2 }] });
  assert.deepEqual(r.record.data.items.map((x) => x.desc), ['Soap', 'Sugar 1kg', 'Soap']);
  const text = renderTemplate('{{#each items}}{{@n}}. {{desc}}\n{{/each}}', { table: store.table('invoices'), data: r.record.data, ctx: store.ctx() });
  assert.equal(text, '1. Soap\n2. Sugar 1kg\n3. Soap');
});

test('FIX #1: the bill message is written when you send it, from the latest payment status', async () => {
  const { store, sugar } = await shop();
  const r = await store.saveRecord('invoices', { customer_phone: '98765 43210', items: [{ item: sugar.id, qty: 2 }] });
  const id = r.record.id;
  const pending = store.pendingFor('invoices', id);
  assert.equal(pending.length, 1, 'one message waits in the outbox; nothing is sent automatically');
  assert.equal(pending[0].status, 'pending');
  const before = store.renderOutbox(pending[0]);
  assert.match(before.body, /Balance due: ₹100\.00/);
  assert.match(before.body, /Pay by UPI: shop@upi/);
  assert.equal(before.link.startsWith('https://wa.me/919876543210?text='), true);

  // customer hands over cash a moment later
  await store.saveRecord('invoices', { payments: [{ mode: 'Cash', amount: 100 }] }, { id });
  const still = store.pendingFor('invoices', id);
  assert.equal(still.length, 1, 'the receipt REPLACES the unsent bill message instead of adding another');
  const after = store.renderOutbox(still[0]);
  assert.doesNotMatch(after.body, /Balance due/);
  assert.match(after.body, /Payment of ₹100\.00 received/);

  // paid at the counter: the bill message never says "Balance due"
  const r2 = await store.saveRecord('invoices', {
    customer_phone: '9811122233', items: [{ item: sugar.id, qty: 1 }], payments: [{ mode: 'Cash', amount: 50 }],
  });
  const msg = store.renderOutbox(store.pendingFor('invoices', r2.record.id)[0]);
  assert.doesNotMatch(msg.body, /Balance due/);
  assert.match(msg.body, /Payment received in full/);
});

test('payment reminders (scheduled), once per interval', async () => {
  const { store, sugar } = await shop();
  const r = await store.saveRecord('invoices', { customer_phone: '9811122233', due_date: '2020-01-01', items: [{ item: sugar.id, qty: 1 }] });
  for (const o of store.listOutbox()) store.dismissOutbox(o.id);
  const fired = await runScheduled(store);
  assert.equal(fired, 1);
  const msgs = store.listOutbox((o) => o.status === 'pending' && o.ruleId === 'r_overdue');
  assert.equal(msgs.length, 1);
  assert.match(store.renderOutbox(msgs[0]).body, /gentle reminder: ₹50\.00 is pending/);
  assert.equal(await runScheduled(store), 0, 'does not nag again on the same day');
  // paying removes it from future reminders
  await store.saveRecord('invoices', { payments: [{ mode: 'UPI', amount: 50 }] }, { id: r.record.id });
});

test('low-stock alert fires when stock drops to the reorder level', async () => {
  const { store, soap } = await shop();
  for (const o of store.listOutbox()) store.dismissOutbox(o.id);
  await store.saveRecord('invoices', { items: [{ item: soap.id, qty: 2 }] }); // 6 -> 4, reorder is 5
  const alerts = store.listOutbox((o) => o.status === 'pending' && o.ruleId === 'r_low_stock');
  assert.equal(alerts.length, 2, 'in-app alert + WhatsApp to the owner');
  const inapp = alerts.find((a) => a.channel === 'inapp');
  assert.match(store.renderOutbox(inapp).body, /Low stock: Soap — only 4 pcs left/);
  const wa = alerts.find((a) => a.channel === 'whatsapp');
  assert.equal(store.renderOutbox(wa).to, '9000000001');
});

test('validation rule blocks a save, and big discounts need approval', async () => {
  const { store, sugar } = await shop();
  const bad = await store.saveRecord('invoices', { discount: 999, items: [{ item: sugar.id, qty: 1 }] });
  assert.equal(bad.ok, false);
  assert.match(bad.blocked, /more than the bill/);
  assert.equal(store.count('invoices'), 0);

  await store.saveRecord('items', { ...sugar.data, price: 5000 }, { id: sugar.id });
  const ok = await store.saveRecord('invoices', { discount: 600, items: [{ item: sugar.id, qty: 1 }] });
  assert.equal(ok.ok, true);
  const pend = store.pendingApprovals();
  assert.equal(pend.length, 1);
  assert.match(pend[0].approval.note, /Discount of ₹600\.00/);
  await store.decideApproval('invoices', ok.record.id, 'approved', 'Owner');
  assert.equal(store.pendingApprovals().length, 0);
  assert.equal(store.getRecord('invoices', ok.record.id).approval.status, 'approved');
});

test('service template: cannot deliver while money is due; customer told when ready', async () => {
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('service', t, { businessName: 'Fix It' }));
  const c = (await store.saveRecord('customers', { name: 'Kavita', phone: '9822011223' })).record;
  const job = await store.saveRecord('jobs', { customer: c.id, item_desc: 'Mixer', issue: 'Noise', labour: 400, advance: 100, promised: '2030-01-01' });
  assert.equal(job.ok, true);
  assert.equal(job.record.data.balance, 300);
  const ack = store.listOutbox((o) => o.ruleId === 's_ack')[0];
  assert.match(store.renderOutbox(ack).body, /Hello Kavita, we have received your Mixer/);
  const blocked = await store.patchRecord('jobs', job.record.id, { status: 'Delivered' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.blocked, /Collect the balance of ₹300\.00/);
  await store.patchRecord('jobs', job.record.id, { status: 'Ready' });
  const ready = store.listOutbox((o) => o.ruleId === 's_ready')[0];
  assert.match(store.renderOutbox(ready).body, /is ready for pickup\. Amount due: ₹300\.00/);
  await store.patchRecord('jobs', job.record.id, { advance: 400 });
  assert.equal((await store.patchRecord('jobs', job.record.id, { status: 'Delivered' })).ok, true);
});

test('dashboard widgets: KPI, time series with zero days, grouped by line item', async () => {
  const { store, sugar, soap } = await shop();
  await store.saveRecord('invoices', { items: [{ item: sugar.id, qty: 2 }, { item: soap.id, qty: 1 }], payments: [{ mode: 'Cash', amount: 100 }] });
  const dash = store.app.dashboards[0];
  const w = (id) => dash.widgets.find((x) => x.id === id);
  const billed = widgetData(w('w1b'), store);
  assert.deepEqual([billed.value, billed.count], [218, 1], 'billed today: the whole bill, credit part included');
  const got = widgetData(w('w1'), store);
  assert.equal(got.value, 100, 'collected today: only the money received');
  assert.deepEqual(got.parts, [{ label: 'Cash', value: 100 }]);
  assert.equal(widgetData(w('w3'), store).value, 118, 'payments pending');
  const week = widgetData(w('w5'), store);
  assert.equal(week.series.length, 7);
  assert.equal(week.series.filter((s) => s.value > 0).length, 1, 'six empty days are still drawn');
  const top = widgetData(w('w6'), store);
  assert.deepEqual(top.series.map((x) => [x.label, x.value]), [['SOA1 · Soap', 118], ['SUG1 · Sugar 1kg', 100]], 'ranked by amount incl. GST');
  const modes = widgetData(w('w7'), store);
  assert.deepEqual(modes.series.map((s) => [s.label, s.value]), [['Cash', 100]]);
  assert.equal(widgetData(w('w4'), store).value, 1, 'soap is at its reorder level (5 of 5)');
});

test('galla closing: "Collected today" is the money received today by mode, old dues included; credit given today is not', async () => {
  const { store, sugar, soap } = await shop();
  const today = todayStr();
  const old = (await store.saveRecord('invoices', { date: addDays(today, -3), items: [{ item: soap.id, qty: 1 }] })).record;     // 118 on credit, 3 days ago
  await store.patchRecord('invoices', old.id, { payments: [{ pdate: today, mode: 'UPI', amount: 118 }] });                       // ...paid today
  await store.saveRecord('invoices', { items: [{ item: sugar.id, qty: 2 }], payments: [{ pdate: today, mode: 'Cash', amount: 50 }] }); // 100 today, 50 on credit
  await store.saveRecord('invoices', { date: addDays(today, -1), items: [{ item: sugar.id, qty: 1 }], payments: [{ pdate: '', mode: 'Cash', amount: 50 }] }); // imported with a blank date: counts on the bill's date
  const w = (id) => store.app.dashboards[0].widgets.find((x) => x.id === id);
  const got = widgetData(w('w1'), store);
  assert.equal(got.value, 168);
  assert.deepEqual(got.parts, [{ label: 'UPI', value: 118 }, { label: 'Cash', value: 50 }]);
  assert.equal(widgetData(w('w1b'), store).value, 100, 'billed today ignores the old bill paid today');
  assert.equal(widgetData(w('w3'), store).value, 50, 'pending: only the credit still open');
});

test('shops set up earlier get the counter dashboard and walk-in sales once, without losing their own changes', async () => {
  const fresh = buildTemplate('retail', t, {});
  assert.equal(upgradeCounter(fresh, t), false, 'new shops already have it');
  // a shop made before: "Sales today" + "Bills today", no walk-in setting, and one widget the owner renamed
  const old = buildTemplate('retail', t, {});
  delete old.counterV;
  delete old.tables.find((x) => x.id === 'invoices').walkIn;
  const board = old.dashboards[0];
  board.widgets.splice(0, 2,
    { id: 'w1', type: 'kpi', title: 'आज की बिक्री', table: 'invoices', period: 'today', dateField: 'date', measure: { op: 'sum', field: 'total' } },
    { id: 'w2', type: 'kpi', title: 'Bills today', table: 'invoices', period: 'today', dateField: 'date', measure: { op: 'count' } });
  delete board.widgets.find((x) => x.id === 'w3').sub;
  board.widgets.find((x) => x.id === 'w4').title = 'Reorder these';
  assert.equal(upgradeCounter(old, t), true);
  assert.deepEqual(board.widgets.slice(0, 4).map((x) => x.id), ['w1', 'w1b', 'w3', 'w4']);
  assert.equal(board.widgets[0].lines, 'payments');
  assert.equal(board.widgets[2].sub, '{n} unpaid bills, all dates');
  assert.equal(board.widgets[3].title, 'Reorder these', 'other widgets untouched');
  assert.deepEqual(old.tables.find((x) => x.id === 'invoices').walkIn, { party: 'customer', payments: 'payments', mode: 'Cash' });
  assert.equal(upgradeCounter(old, t), false, 'runs once');
  // an owner who already changed "Sales today" keeps it
  const custom = buildTemplate('gst', t, { gstin: '27AAPFU0939F1ZV' });
  delete custom.counterV;
  custom.dashboards[0].widgets.splice(0, 2, { id: 'w1', type: 'kpi', title: 'Sales this month', table: 'invoices', period: 'month', dateField: 'date', measure: { op: 'sum', field: 'total' } });
  upgradeCounter(custom, t);
  assert.equal(custom.dashboards[0].widgets[0].title, 'Sales this month');
  assert.match(custom.tables.find((x) => x.id === 'invoices').walkIn.when, /Tax Invoice/, 'GST: credit notes are never walk-in cash sales');
});

test('backup round-trip restores everything', async () => {
  const { store, sugar } = await shop();
  await store.saveRecord('invoices', { items: [{ item: sugar.id, qty: 1 }] });
  const backup = JSON.parse(JSON.stringify(store.exportAll()));
  const fresh = new Store({ db: memoryDb() });
  await fresh.init();
  await fresh.importAll(backup);
  assert.equal(fresh.count('invoices'), 1);
  assert.equal(fresh.count('items'), 2);
  assert.equal(fresh.app.name, 'Test Mart');
  // numbering continues, it does not restart at 1
  const next = await fresh.saveRecord('invoices', { items: [{ item: sugar.id, qty: 1 }] });
  assert.equal(next.record.data.number, 'INV-0002');
});

test('backups made before the rename to Vina still restore; anything else is refused', async () => {
  const { store, sugar } = await shop();
  await store.saveRecord('invoices', { items: [{ item: sugar.id, qty: 1 }] });
  const backup = JSON.parse(JSON.stringify(store.exportAll()));
  assert.equal(backup.format, 'vina-backup');
  const old = new Store({ db: memoryDb() });
  await old.init();
  await old.importAll({ ...backup, format: 'msme-builder-backup' });
  assert.equal(old.count('invoices'), 1);
  await assert.rejects(() => old.importAll({ ...backup, format: 'something-else' }), /Not a valid backup file/);
});
