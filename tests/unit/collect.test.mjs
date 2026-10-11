// Smart Collect: UPI payments matched to bills, idempotent by UTR, and a signed webhook on the sync server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store } from '../../public/js/store.js';
import { Sync } from '../../public/js/sync.js';
import { SYNC_PROTOCOL } from '../../public/js/protocol.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate } from '../../public/js/templates/index.js';
import { addDays, todayStr } from '../../public/js/formula.js';
import {
  refFor, matchPayment, reconcileAll, openBills, unverifiedUpi, upgradeCollect, collectSetup, settleManually, ignorePayment,
  paymentsToReview, payerMobile, COLLECT_TABLE, collectStats,
} from '../../public/js/collect.js';
import { upiLink } from '../../public/js/collect.js';

const t = (s) => s;
const today = todayStr();

async function shop(template = 'retail') {
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate(template, t, { businessName: 'Test Mart', phone: '9000000001', upi: 'testmart@ybl', gstin: '27AAPFU0939F1ZV' }));
  store.settings.collect = { enabled: true, since: addDays(today, -1) };
  const item = (await store.saveRecord('items', { code: 'RIC5', name: 'Rice 5kg', price: 500, cost: 450, stock: 100, reorder: 5 })).record;
  const ravi = (await store.saveRecord('customers', { name: 'Ravi Kumar', phone: '98765 43210' })).record;
  const bill = async (qty, { customer = ravi.id, date = today, payments = [] } = {}) =>
    (await store.saveRecord('invoices', { customer, date, items: [{ item: item.id, qty }], payments })).record;
  return { store, item, ravi, bill };
}
let n = 0;
const event = (store, data) => store.putSystemRecord(COLLECT_TABLE, `col_test${++n}`, { status: 'new', at: new Date().toISOString(), ...data });

test('collect: per-bill reference is stable, short and UPI-safe; the QR carries it as tr', () => {
  const a = refFor('3f9a1c0b7d2e4f5a6b7c'), b = refFor('3f9a1c0b7d2e4f5a6b7d');
  assert.equal(a, refFor('3f9a1c0b7d2e4f5a6b7c'), 'same on every device');
  assert.notEqual(a, b);
  assert.match(a, /^MB[0-9A-Z]{10}$/);
  const link = upiLink({ vpa: 'shop@ybl', name: 'Test Mart', amount: 540, note: 'INV-0001', ref: a });
  assert.match(link, new RegExp(`[?&]tr=${a}(&|$)`));
  assert.ok(!upiLink({ vpa: 'shop@ybl', amount: 1 }).includes('tr='), 'no reference unless Smart Collect is on');
});

test('collect: payer mobile is read from the UPI id or phone', () => {
  assert.equal(payerMobile({ vpa: '9876543210@ybl' }), '9876543210');
  assert.equal(payerMobile({ phone: '+91 98765-43210' }), '9876543210');
  assert.equal(payerMobile({ vpa: 'ravi.kumar@okhdfc' }), '');
  assert.equal(payerMobile({ vpa: '1234567890@ybl' }), '', 'not a mobile number');
});

test('collect: matching rules, from sure to suggestion', () => {
  const b = (id, balance, extra = {}) => ({ id, ref: refFor(id), number: id, date: today, due: '', partyId: '', mobile: '', balance, cancelled: false, payments: [], ...extra });
  const bills = [
    b('a', 500, { partyId: 'p1', mobile: '9876543210', date: addDays(today, -10) }),
    b('b', 300, { partyId: 'p1', mobile: '9876543210', date: addDays(today, -2) }),
    b('c', 720, { partyId: 'p2', mobile: '9111111111' }),
    b('d', 0, { payments: [{ ref: 'UTR000111', amount: 250, mode: 'UPI' }] }),
    b('e', 0, { payments: [{ ref: '', amount: 410, mode: 'UPI' }] }),
  ];
  // the bill's own QR
  let m = matchPayment({ utr: 'UTR1000001', amount: 500, ref: refFor('a') }, bills);
  assert.deepEqual([m.kind, m.sure, m.allocations], ['ref', true, [{ id: 'a', amount: 500 }]]);
  // more than the bill: the rest settles the same customer's other bills, oldest first
  m = matchPayment({ utr: 'UTR1000002', amount: 650, ref: refFor('b') }, bills);
  assert.deepEqual(m.allocations, [{ id: 'b', amount: 300 }, { id: 'a', amount: 350 }]);
  assert.equal(m.sure, true);
  // more than everything owed: an owner decision
  m = matchPayment({ utr: 'UTR1000003', amount: 2000, ref: refFor('c') }, bills);
  assert.equal(m.sure, false); assert.equal(m.unapplied, 1280);
  // already recorded with this UTR (webhook retried, or another device was first)
  m = matchPayment({ utr: 'UTR000111', amount: 250, ref: refFor('d') }, bills);
  assert.equal(m.kind, 'done');
  // the cashier pressed "UPI received": the bank's confirmation verifies that row instead of adding a second payment
  m = matchPayment({ utr: 'UTR1000004', amount: 410, ref: refFor('e') }, bills);
  assert.deepEqual([m.kind, m.verify], ['verify', { id: 'e', index: 0 }]);
  // no reference: the payer's mobile + the exact balance
  m = matchPayment({ utr: 'UTR1000005', amount: 300, vpa: '9876543210@ybl' }, bills);
  assert.deepEqual([m.kind, m.sure, m.allocations], ['party', true, [{ id: 'b', amount: 300 }]]);
  // known payer, amount fits no single bill: oldest first, but only as a suggestion
  m = matchPayment({ utr: 'UTR1000006', amount: 600, vpa: '9876543210@ybl' }, bills);
  assert.deepEqual([m.kind, m.sure, m.allocations], ['party-fifo', false, [{ id: 'a', amount: 500 }, { id: 'b', amount: 100 }]]);
  // stranger, but exactly one open bill has that balance: suggestion
  m = matchPayment({ utr: 'UTR1000007', amount: 720, vpa: 'someone@okaxis' }, bills);
  assert.deepEqual([m.kind, m.sure], ['amount', false]);
  // nothing to go on
  m = matchPayment({ utr: 'UTR1000008', amount: 99, vpa: 'someone@okaxis' }, bills);
  assert.equal(m.kind, 'none');
  assert.equal(matchPayment({ utr: '', amount: 10 }, bills).reason, 'invalid');
});

test('collect: a confirmed payment marks the bill paid with its UTR, queues the receipt, and never counts twice', async () => {
  const { store, bill } = await shop();
  const inv = await bill(2);                                   // 1,000 on credit
  assert.equal(inv.data.status, 'Unpaid');
  const ev = event(store, { utr: 'UTR2000001', amount: 1000, ref: refFor(inv.id), vpa: '9876543210@ybl' });
  const r = await reconcileAll(store);
  assert.deepEqual(r, { applied: 1, review: 0, waiting: 0 });
  const paid = store.getRecord('invoices', inv.id).data;
  assert.equal(paid.status, 'Paid');
  assert.deepEqual(paid.payments.map((p) => [p.mode, p.amount, p.ref]), [['UPI', 1000, 'UTR2000001']]);
  assert.equal(store.getRecord(COLLECT_TABLE, ev.id).data.status, 'matched');
  assert.equal(store.getRecord(COLLECT_TABLE, ev.id).data.by, 'auto');
  // the existing workflow sends the customer a receipt (written when the owner taps Send)
  assert.ok(store.listOutbox((o) => o.status === 'pending' && o.recordId === inv.id && o.channel === 'whatsapp').length);
  // the provider retries, and a second device holds the same event: still one payment
  store.putSystemRecord(COLLECT_TABLE, 'col_dup', { status: 'new', utr: 'UTR2000001', amount: 1000, ref: refFor(inv.id), at: new Date().toISOString() });
  await reconcileAll(store);
  assert.equal(store.getRecord('invoices', inv.id).data.payments.length, 1);
  assert.equal(store.getRecord(COLLECT_TABLE, 'col_dup').data.how, 'done');
  assert.equal(collectStats(store).auto, 2);
});

test('collect: at the counter, "UPI received" is verified by the bank instead of paid twice', async () => {
  const { store, bill } = await shop();
  const inv = await bill(1, { customer: '', payments: [{ mode: 'UPI', amount: 500 }] });
  assert.equal(inv.data.status, 'Paid');
  assert.equal(unverifiedUpi(store, { graceMinutes: 0, now: new Date(Date.now() + 1000) }).length, 1, 'marked UPI, no bank confirmation yet');
  event(store, { utr: 'UTR3000001', amount: 500, ref: refFor(inv.id) });
  await reconcileAll(store);
  const d = store.getRecord('invoices', inv.id).data;
  assert.deepEqual(d.payments.map((p) => [p.amount, p.ref]), [[500, 'UTR3000001']]);
  assert.equal(unverifiedUpi(store, { graceMinutes: 0, now: new Date(Date.now() + 1000) }).length, 0);
});

test('collect: a payment that arrives before its bill waits for it, and never pays an older bill by guesswork', async () => {
  const { store, item, ravi, bill } = await shop();
  const old = await bill(1);                                   // Ravi already owes exactly 500 on an older bill
  const rid = 'counterdraft000000001';                         // the counter fixes the new bill's id when it shows the QR
  const ev = event(store, { utr: 'UTR4000001', amount: 500, ref: refFor(rid), vpa: '9876543210@ybl' });
  assert.deepEqual(await reconcileAll(store), { applied: 0, review: 0, waiting: 1 });
  assert.equal(store.getRecord(COLLECT_TABLE, ev.id).data.status, 'new', 'not in the owner queue while the bill is on its way');
  assert.equal(store.getRecord('invoices', old.id).data.status, 'Unpaid', 'the older bill is untouched');
  await store.saveRecord('invoices', { customer: ravi.id, date: today, items: [{ item: item.id, qty: 1 }] }, { id: rid });
  assert.deepEqual(await reconcileAll(store), { applied: 1, review: 0, waiting: 0 });
  assert.equal(store.getRecord('invoices', rid).data.status, 'Paid');
  // a bill that never arrives: after the hold, the owner decides (the older bill is only a suggestion)
  const lost = event(store, { utr: 'UTR4000002', amount: 500, ref: refFor('neverSaved'), vpa: '9876543210@ybl' });
  assert.equal((await reconcileAll(store)).waiting, 1);
  assert.equal((await reconcileAll(store, { now: Date.now() + 13 * 3600000 })).review, 1);
  assert.deepEqual(store.getRecord(COLLECT_TABLE, lost.id).data.suggestion.allocations, [{ id: old.id, amount: 500 }]);
  assert.equal(store.getRecord('invoices', old.id).data.status, 'Unpaid');
});

test('collect: suggestions wait for the owner; manual settle and "not a sale" both close the item', async () => {
  const { store, bill } = await shop();
  const a = await bill(1, { date: addDays(today, -9) });       // 500
  const b = await bill(1);                                     // 500
  const ev = event(store, { utr: 'UTR5000001', amount: 700, vpa: '9876543210@ybl' });
  await reconcileAll(store);
  const waiting = paymentsToReview(store);
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0].data.suggestion.allocations, [{ id: a.id, amount: 500 }, { id: b.id, amount: 200 }]);
  assert.equal(store.badgeCount() >= 1, true, 'counts in the bell');
  await settleManually(store, ev.id, waiting[0].data.suggestion.allocations);
  assert.equal(store.getRecord('invoices', a.id).data.status, 'Paid');
  assert.equal(store.getRecord('invoices', b.id).data.balance, 300);
  assert.equal(paymentsToReview(store).length, 0);
  const odd = event(store, { utr: 'UTR5000002', amount: 3, vpa: 'stranger@okaxis' });
  await reconcileAll(store);
  ignorePayment(store, odd.id, 'refund test');
  assert.equal(store.getRecord(COLLECT_TABLE, odd.id).data.status, 'ignored');
});

test('collect: works on the GST template, and older shops get the UTR column once', async () => {
  const { store, bill } = await shop('gst');
  const inv = await bill(1);
  assert.ok(collectSetup(store.app).ref);
  event(store, { utr: 'UTR6000001', amount: inv.data.total, ref: refFor(inv.id) });
  await reconcileAll(store);
  assert.equal(store.getRecord('invoices', inv.id).data.balance, 0);
  assert.equal(openBills(store).find((x) => x.id === inv.id).payments[0].ref, 'UTR6000001');

  const old = buildTemplate('retail', t, {});
  delete old.collectV;
  const pay = old.tables.find((x) => x.id === 'invoices').fields.find((f) => f.id === 'payments');
  pay.columns = pay.columns.filter((c) => c.id !== 'ref');
  assert.equal(upgradeCollect(old, t), true);
  assert.ok(pay.columns.some((c) => c.id === 'ref'));
  assert.equal(upgradeCollect(old, t), false, 'runs once');
  assert.equal(upgradeCollect(buildTemplate('retail', t, {}), t), false, 'new shops already have it');
});

// ---- server: the webhook -------------------------------------------------------------------------------------------------
test('collect server: signed webhook -> record on every device; bad signatures, retries and forgeries change nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-collect-'));
  process.env.DATA_DIR = dir;
  const mod = await import(`../../server/server.js?collect=${Date.now()}`);
  const setupCode = mod.SETUP_CODE;
  const server = await mod.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { store, bill } = await shop();
    const sync = new Sync(store);
    sync.configure({ url, ws: 'collect-shop', token: 'secret-pass', create: true, setupCode });
    await sync.run();
    const inv = await bill(2);
    await sync.run();

    const setup = await sync.collectSetup();
    assert.match(setup.hookUrl, /\/api\/collect\/hook\/[0-9a-f]{24}$/);
    assert.equal((await sync.collectSetup()).secret, setup.secret, 'stable until rotated');

    const post = (body, sig) => fetch(setup.hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Signature': sig } : {}) }, body });
    const payload = JSON.stringify({ data: { transaction_status: 'SUCCESS', bank_reference_number: 'UTR7000001', amount: '1000.00', reference_id: refFor(inv.id), payer_vpa: '9876543210@ybl' } });
    assert.equal((await post(payload)).status, 401, 'unsigned');
    assert.equal((await post(payload, 'f'.repeat(64))).status, 401, 'wrong signature');
    const sig = mod.signBody(setup.secret, payload);
    const ok = await post(payload, `sha256=${sig}`);
    assert.equal(ok.status, 200);
    const again = await (await post(payload, sig)).json();
    assert.equal(again.duplicate, true, 'a retried webhook is recognised');
    const failed = JSON.stringify({ status: 'FAILED', utr: 'UTR7000002', amount: 10 });
    assert.equal((await (await post(failed, mod.signBody(setup.secret, failed))).json()).ignored, 'FAILED');

    // the device pulls it and the bill pays itself
    await sync.run();
    await reconcileAll(store);
    assert.equal(store.getRecord('invoices', inv.id).data.status, 'Paid');
    await sync.run();                                         // the "matched" filing goes back to the server

    // a device cannot invent a bank confirmation, nor change the amount the bank reported
    const forged = { id: 'col_forged', table: COLLECT_TABLE, data: { status: 'new', utr: 'FAKE000001', amount: 99999 }, created: new Date().toISOString(), updated: new Date().toISOString() };
    const ev = store.records(COLLECT_TABLE)[0];
    const tampered = { ...ev, data: { ...ev.data, amount: 1 }, updated: new Date(Date.now() + 5000).toISOString() };
    await fetch(`${url}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ws: 'collect-shop', token: 'secret-pass', protocol: SYNC_PROTOCOL, since: 0, records: [forged, tampered] }) });
    const dump = await (await fetch(`${url}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ws: 'collect-shop', token: 'secret-pass' }) })).json();
    const coll = dump.records.filter((r) => r.table === COLLECT_TABLE);
    assert.equal(coll.length, 1, 'forged confirmation refused');
    assert.equal(coll[0].data.amount, 1000, 'bank amount kept');

    // sandbox: "Simulate a payment" takes the same path as a real one
    const inv2 = await bill(1);
    await sync.simulatePayment({ amount: 500, ref: refFor(inv2.id) });
    await sync.run();
    await reconcileAll(store);
    assert.equal(store.getRecord('invoices', inv2.id).data.status, 'Paid');
    assert.equal(store.getRecord('invoices', inv2.id).data.payments[0].ref.startsWith('SIM'), true);

    // provenance, end to end: the signed provider payment is bank-confirmed; the sandbox one is only simulated
    await sync.run();
    const { creditPassport } = await import('../../public/js/credit.js');
    const pp = creditPassport(store).metrics;
    assert.deepEqual([pp.bankConfirmed90, pp.simulated90], [1000, 500]);
    // a device rewrites the sandbox payment as a large "provider" one: its own passport ignores the edit, and the
    // server sends the bank's version back
    const sim = store.records(COLLECT_TABLE).find((r) => r.bank?.source === 'sandbox');
    store.putSystemRecord(COLLECT_TABLE, sim.id, { ...sim.data, source: 'provider', amount: 99999, verified: true });
    assert.equal(creditPassport(store).metrics.bankConfirmed90, 1000, 'local edits to a confirmation never count');
    await sync.run(); await sync.run();
    const back = store.getRecord(COLLECT_TABLE, sim.id);
    assert.deepEqual([back.data.source, back.data.amount], ['sandbox', 500], 'the server restored the bank version on this device');

    // rotating the secret retires the old hook address
    const rotated = await sync.collectSetup({ rotate: true });
    assert.notEqual(rotated.hookUrl, setup.hookUrl);
    assert.equal((await post(payload, sig)).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});

test('collect server: provider payloads are normalised', async () => {
  const mod = await import(`../../server/server.js?norm=${Date.now()}`);
  const e = mod.normalizeEvent({ data: { rrn: '412345678901', transaction_amount: '249.5', tr: 'mbabc', payer_mobile: '+91 98765 43210', transaction_status: 'success' } });
  assert.deepEqual([e.ok, e.utr, e.amount, e.ref, e.phone], [true, '412345678901', 249.5, 'MBABC', '+919876543210']);
  assert.equal(mod.normalizeEvent({ status: 'PENDING', utr: 'X' }).ok, false);
  assert.ok(crypto.timingSafeEqual(Buffer.from(mod.signBody('k', 'body'), 'hex'), crypto.createHmac('sha256', 'k').update('body').digest()));
});
