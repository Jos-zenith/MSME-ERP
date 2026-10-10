// "Type it once": the app remembers customers, items, phones and codes so nobody re-enters them.
// And the GST engine running through the real store (hooks), the way the GST template uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../public/js/store.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate, TEMPLATES } from '../../public/js/templates/index.js';
import { searchRecords, parseQuickCreate, suggestCode, repeatData, computeRecord } from '../../public/js/schema.js';
import { gstr1, gstr3b } from '../../public/gst/js/returns.js';

const t = (s) => s;

async function shop() {
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('retail', t, { businessName: 'Test Mart' }));
  await TEMPLATES.find((x) => x.id === 'retail').sample(store, t);
  return store;
}
async function gstShop(gstin = '27AAPFU0939F1ZV', sample = true) {
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('gst', t, { businessName: 'Sharma Traders', gstin }));
  if (sample) await TEMPLATES.find((x) => x.id === 'gst').sample(store, t);
  return store;
}

test('a phone number is found however it is typed (spaces, +91, dashes)', async () => {
  const store = await shop();
  const table = store.table('customers');
  for (const q of ['9876543210', '98765 43210', '+91 98765-43210', '98765']) {
    const hits = searchRecords(table, store.records('customers'), q);
    assert.equal(hits[0]?.data.city, 'Pune', `"${q}" finds Ravi Kumar of Pune`);
  }
});

test('typing "name phone" in a picker splits into the right fields', () => {
  const table = buildTemplate('retail', t, {}).tables.find((x) => x.id === 'customers');
  assert.deepEqual(parseQuickCreate(table, 'Ravi Kumar 98765 43210'), { name: 'Ravi Kumar', phone: '98765 43210' });
  assert.deepEqual(parseQuickCreate(table, '9876543210'), { phone: '9876543210' });
  assert.deepEqual(parseQuickCreate(table, '+91 98765-43210 Meena'), { name: 'Meena', phone: '+91 98765-43210' });
  assert.deepEqual(parseQuickCreate(table, 'Shop No 12'), { name: 'Shop No 12' }, 'short numbers stay in the name');
});

test('item codes are made from the name when left empty, and stay unique', async () => {
  assert.equal(suggestCode('Sugar 1kg', []), 'SUG1');
  assert.equal(suggestCode('Sugar 1kg', ['SUG1']), 'SUG2');
  assert.equal(suggestCode('Sunflower Oil 1L', []), 'SUN1');
  assert.equal(suggestCode('Tea Powder 250g', []), 'TEA250');
  const store = await gstShop(undefined, false);
  const a = await store.saveRecord('items', { name: 'Sugar 1kg', price: 48 });
  const b = await store.saveRecord('items', { name: 'Sugar 1kg (loose)', price: 44 });
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.record.data.code, 'SUG1');
  assert.equal(b.record.data.code, 'SUG2');
  const typed = await store.saveRecord('items', { name: 'Rice', code: 'R-01', price: 60 });
  assert.equal(typed.record.data.code, 'R-01', 'a code you type is kept');
});

test('pickers offer the most-used records first, before anything is typed', async () => {
  const store = await shop();
  const rank = store.usage('customers');
  const top = searchRecords(store.table('customers'), store.records('customers'), '', 3, rank).map((r) => r.data.name);
  assert.ok(['Ravi Kumar', 'Sunita Sharma'].includes(top[0]), `regulars first: ${top}`);
  const meena = store.records('customers').find((r) => r.data.name === 'Meena Devi');
  for (let i = 0; i < 4; i++) await store.saveRecord('invoices', { customer: meena.id, items: [{ item: store.records('items')[0].id, qty: 1 }] }, { noRules: true });
  const after = searchRecords(store.table('customers'), store.records('customers'), '', 1, store.usage('customers'));
  assert.equal(after[0].data.name, 'Meena Devi', 'the ranking follows new bills (cache refreshed on save)');
});

test('a customer\'s usual items and last bill are remembered; repeat copies lines without payments', async () => {
  const store = await shop();
  const inv = store.table('invoices');
  const ravi = store.records('customers').find((r) => r.data.city === 'Pune' && r.data.name === 'Ravi Kumar');
  const u = store.usualLines(inv, inv.fields.find((f) => f.id === 'items'), inv.fields.find((f) => f.id === 'customer'), ravi.id);
  const codes = u.items.map((x) => store.getRecord('items', x.id).data.code);
  assert.ok(codes.includes('SUG1'), `Ravi buys sugar: ${codes}`);
  assert.equal(codes[0], 'SUG1', 'bought on both visits, so it comes first');
  assert.ok(u.last, 'last bill found');
  const copy = repeatData(inv, u.last.data);
  assert.equal(copy.customer, ravi.id);
  assert.equal(copy.payments, undefined, 'payments are not copied');
  assert.equal(copy.number, undefined, 'a fresh number');
  assert.equal(copy.date, undefined, 'today, not the old date');
  assert.deepEqual(copy.items.map((r) => Object.keys(r).some((k) => k.startsWith('_f_'))), copy.items.map(() => false), 'prices are re-read from the item');
  const shopWide = store.usualLines(inv, inv.fields.find((f) => f.id === 'items'), inv.fields.find((f) => f.id === 'customer'), '');
  assert.ok(shopWide.items.length >= 5, 'best sellers for a walk-in');
});

test('text fields remember earlier answers, most used first', async () => {
  const store = await shop();
  assert.equal(store.pastValues('customers', 'city')[0], 'Pune');
});

// ---- GST through the store ----------------------------------------------------------------------------------
test('GST template: a GSTIN fills in the state for the business and for customers', async () => {
  const store = await gstShop();
  assert.equal(store.business.state, '27 - Maharashtra');
  const c = await store.saveRecord('customers', { name: 'Delhi Buyer', gstin: '07aagff2194n1z1' });
  assert.equal(c.ok, true);
  assert.equal(c.record.data.gstin, '07AAGFF2194N1Z1', 'cleaned to upper case');
  assert.equal(c.record.data.state, '07 - Delhi', 'state read from the GSTIN');
  const bad = await store.saveRecord('customers', { name: 'Typo', gstin: '27AAPFU0939F1ZX' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.gstin, /does not match/);
});

test('GST invoice: CGST + SGST in-state, IGST out-of-state, picked from the customer with no typing', async () => {
  const store = await gstShop();
  const bucket = store.records('items').find((r) => r.data.name === 'Steel Bucket');
  const walkIn = await store.saveRecord('invoices', { doc_type: 'Tax Invoice', items: [{ item: bucket.id, qty: 1 }] });
  assert.equal(walkIn.ok, true, JSON.stringify(walkIn.errors));
  const w = walkIn.record.data;
  assert.equal(w.pos, '27 - Maharashtra', 'walk-in: place of supply is the shop');
  assert.equal(w.items[0].hsn, '7323', 'HSN came from the item');
  assert.equal(w.cgst, 15.6); assert.equal(w.sgst, 15.6); assert.equal(w.igst, 0);
  assert.equal(w.total, 291);
  assert.match(w.tax_note, /Maharashtra: CGST \+ SGST/);
  assert.match(w.number, /^INV\/\d\d-\d\d\/\d{4}$/, 'financial-year numbering');

  const delhi = store.records('customers').find((r) => r.data.gstin === '07AAGFF2194N1Z1');
  const b2b = await store.saveRecord('invoices', { doc_type: 'Tax Invoice', customer: delhi.id, items: [{ item: bucket.id, qty: 1 }] });
  const d = b2b.record.data;
  assert.equal(d.bill_gstin, '07AAGFF2194N1Z1');
  assert.equal(d.pos, '07 - Delhi');
  assert.equal(d.igst, 31.2); assert.equal(d.cgst, 0);
  assert.equal(d.bill_name, 'Capital Traders', 'name for the returns copied from the customer');
  assert.match(d.tax_note, /IGST/);
  const n1 = Number(w.number.slice(-4)), n2 = Number(d.number.slice(-4));
  assert.equal(n2, n1 + 1, 'numbers follow on with no gap');
});

test('GST: a failed save does not use up an invoice number', async () => {
  const store = await gstShop();
  const before = store.records('invoices').length;
  const bad = await store.saveRecord('invoices', { doc_type: 'Tax Invoice', items: [] });
  assert.equal(bad.ok, false);
  const good = await store.saveRecord('invoices', { doc_type: 'Tax Invoice', items: [{ item: store.records('items')[0].id, qty: 1 }] });
  assert.equal(Number(good.record.data.number.slice(-4)), before + 1);
});

test('GST: credit notes put stock back and reduce the return; purchases give input credit', async () => {
  const store = await gstShop();
  const soap = store.records('items').find((r) => r.data.name === 'Bath Soap');
  const stock0 = soap.data.stock;
  const sale = await store.saveRecord('invoices', { doc_type: 'Tax Invoice', items: [{ item: soap.id, qty: 5 }] });
  assert.equal(store.getRecord('items', soap.id).data.stock, stock0 - 5);
  const cn = await store.saveRecord('invoices', { doc_type: 'Credit Note', ref_note: sale.record.data.number, items: [{ item: soap.id, qty: 2 }] });
  assert.equal(cn.ok, true, JSON.stringify(cn.errors));
  assert.match(cn.record.data.number, /^CN\//);
  assert.equal(store.getRecord('items', soap.id).data.stock, stock0 - 3, 'returned goods are back in stock');

  const period = sale.record.data.date.slice(0, 7);
  const all = store.records('invoices').map((r) => r.data);
  const g1 = gstr1(all, { business: store.business, period, settings: store.settings });
  assert.ok(g1.invoiceCount >= 2);
  const purchases = store.records('purchases').map((r) => r.data);
  assert.ok(purchases[0].igst > 0, 'purchase from a Delhi supplier carries IGST');
  const g3 = gstr3b(all, purchases, { business: store.business, period: purchases[0].date.slice(0, 7), settings: store.settings });
  assert.ok(g3.itc.igst > 0, 'input credit claimed');
});

test('GST: no GSTIN for the shop means no tax invoice (never a guessed split)', async () => {
  const store = await gstShop('', false);
  const it = await store.saveRecord('items', { name: 'Thing', price: 100, hsn: '8501' });
  const r = await store.saveRecord('invoices', { doc_type: 'Tax Invoice', items: [{ item: it.record.id, qty: 1 }] });
  assert.equal(r.ok, false);
  assert.match(r.errors._business, /GSTIN/);
  const bos = await store.saveRecord('invoices', { doc_type: 'Bill of Supply', items: [{ item: it.record.id, qty: 1 }] });
  assert.equal(bos.ok, true, 'a bill of supply still works');
  assert.equal(bos.record.data.total, 100);
});

test('GST form maths runs live (same hook as the save)', async () => {
  const store = await gstShop();
  const inv = store.table('invoices');
  const bucket = store.records('items').find((r) => r.data.name === 'Steel Bucket');
  const d = computeRecord(inv, { doc_type: 'Tax Invoice', price_incl: true, items: [{ item: bucket.id, qty: 1 }] }, store.ctx());
  assert.equal(d.total, 260, 'GST-inclusive: the customer pays exactly the price');
  assert.equal(Math.round((d.taxable + d.cgst + d.sgst) * 100) / 100, 260);
});

// ---- counter ------------------------------------------------------------------------------------------------
test('a typo still finds the item, but never outranks a real match', async () => {
  const store = await shop();
  const items = store.table('items');
  const first = (q) => searchRecords(items, store.records('items'), q)[0]?.data.code;
  assert.equal(first('suagr'), 'SUG1');
  assert.equal(first('biscut'), 'BIS1');
  assert.equal(first('basmti'), 'RIC5');
  assert.equal(searchRecords(items, store.records('items'), 'qqqq').length, 0, 'nonsense finds nothing');
  assert.equal(first('salt'), 'SAL1', 'an exact word beats a near one');
});

test('WhatsApp reminder: only for bills with money due and a phone; text from the latest balance', async () => {
  const store = await shop();
  const c = store.records('customers').find((x) => x.data.phone === '98111 22233');
  const it = store.records('items').find((x) => x.data.code === 'SUG1');
  const r = await store.saveRecord('invoices', { customer: c.id, items: [{ item: it.id, qty: 2 }] });
  const rem = store.reminder('invoices', r.record.id);
  assert.match(rem.link, /^https:\/\/wa\.me\/919811122233\?text=/);
  assert.match(rem.body, /Hello Ravi Kumar, a gentle reminder: ₹96\.00 is pending for bill INV-/);
  assert.equal(rem.last, null);
  store.markReminded(r.record.id);
  assert.ok(store.reminder('invoices', r.record.id).last);
  await store.saveRecord('invoices', { payments: [{ mode: 'Cash', amount: 96 }] }, { id: r.record.id });
  assert.equal(store.reminder('invoices', r.record.id), null, 'paid: nothing to remind');
  const walkIn = await store.saveRecord('invoices', { items: [{ item: it.id, qty: 1 }] });
  assert.equal(store.reminder('invoices', walkIn.record.id), null, 'no phone: no button');
});

test('staff access: per-table rules, and older shops get the same defaults without losing their own choices', async () => {
  const store = await shop();
  store.currentUser = 'staff';
  assert.equal(store.canAddTo('invoices'), true);
  assert.equal(store.canAddTo('items'), false, 'staff look up items but cannot add or reprice them');
  store.currentUser = 'owner';
  assert.equal(store.canAddTo('items'), true);
  // an app saved before access settings existed
  const old = JSON.parse(JSON.stringify(store.app));
  delete old.accessV;
  for (const tb of old.tables) delete tb.staff;
  old.tables.find((x) => x.id === 'items').staff = 'full';     // the owner's own choice is kept
  store.setApp(old);
  assert.equal(store.migrateAccess(), true);
  assert.equal(store.table('purchases').staff, 'none');
  assert.equal(store.table('items').staff, 'full');
  assert.equal(store.migrateAccess(), false, 'runs once');
});
