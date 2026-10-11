// Financial records across devices: payments recorded on different devices, offline, must all survive sync, exactly
// once, with the bill's totals derived from them. These tests use the real sync server and two real stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../../public/js/store.js';
import { Sync } from '../../public/js/sync.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate } from '../../public/js/templates/index.js';

const t = (s) => s;
const tick = () => new Promise((r) => setTimeout(r, 3));

let SETUP = '';   // the setup code of the server under test: the first device of each shop creates its workspace with it
async function server() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-ledger-'));
  const mod = await import(`../../server/server.js?ledger=${Date.now()}${Math.random()}`);
  SETUP = mod.SETUP_CODE;
  const srv = await mod.start(0, '127.0.0.1');
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
async function device(url, ws) {
  const store = new Store({ db: memoryDb() });
  await store.init();
  const sync = new Sync(store);
  return { store, sync, join: (adopt) => { sync.configure({ url, ws, token: 'secret-pass-123', adopt, create: !adopt, setupCode: SETUP }); return sync.run(); } };
}
/** Owner's laptop sets up the shop and one credit bill of ₹1,000; the counter phone joins and downloads it. */
async function twoDevices(url, ws) {
  const A = await device(url, ws), B = await device(url, ws);
  A.store.setApp(buildTemplate('retail', t, { businessName: 'Two Device Mart', upi: 'mart@ybl' }));
  const item = (await A.store.saveRecord('items', { code: 'R', name: 'Rice', price: 1000, stock: 50 })).record;
  const cust = (await A.store.saveRecord('customers', { name: 'Ravi', phone: '9876543210' })).record;
  const bill = (await A.store.saveRecord('invoices', { customer: cust.id, items: [{ item: item.id, qty: 1 }] })).record;
  assert.equal((await A.join()).error, undefined);
  assert.equal((await B.join(true)).error, undefined);
  assert.equal(B.store.getRecord('invoices', bill.id).data.total, 1000);
  return { A, B, billId: bill.id, itemId: item.id, custId: cust.id };
}
const pay = (dev, id, mode, amount, extra = {}) => {
  const rec = dev.store.getRecord('invoices', id);
  return dev.store.patchRecord('invoices', id, { payments: [...rec.data.payments, { mode, amount, ...extra }] });
};
const summary = (dev, id) => {
  const d = dev.store.getRecord('invoices', id).data;
  return { rows: d.payments.map((p) => `${p.mode} ${p.amount}`).sort(), paid: d.paid, balance: d.balance, status: d.status };
};

for (const order of [['A', 'B'], ['B', 'A']]) {
  test(`acceptance: ₹300 cash on A and ₹500 UPI on B, both offline, sync ${order.join(' then ')}: both survive, once, ₹800 paid`, async () => {
    const srv = await server();
    try {
      const { A, B, billId } = await twoDevices(srv.url, `accept-${order.join('')}`);
      // both go offline (nothing syncs) and each records a payment on bill X
      await pay(A, billId, 'Cash', 300);
      await tick();
      await pay(B, billId, 'UPI', 500);
      const dev = { A, B };
      // reconnect in the given order, then once more each so both have everything
      await dev[order[0]].sync.run(); await dev[order[1]].sync.run();
      await dev[order[0]].sync.run(); await dev[order[1]].sync.run();
      // retries of the same sync change nothing
      await A.sync.run(); await B.sync.run(); await A.sync.run();
      const want = { rows: ['Cash 300', 'UPI 500'], paid: 800, balance: 200, status: 'Partial' };
      assert.deepEqual(summary(A, billId), want, 'device A');
      assert.deepEqual(summary(B, billId), want, 'device B');
      // a third device that downloads the shop now sees the same bill
      const C = await device(srv.url, `accept-${order.join('')}`);
      await C.join(true);
      assert.deepEqual(summary(C, billId), want, 'a fresh device');
    } finally { await srv.close(); }
  });
}

// ---- the rest of the lifecycle ----------------------------------------------------------------------------------------
const exportFrom = async (url, ws) => (await fetch(`${url}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ws, token: 'secret-pass-123' }) })).json();
const pushRaw = (url, ws, store, since = 0) => fetch(`${url}/api/sync`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ws, token: 'secret-pass-123', since, records: store.dirtyRecords().map(({ dirty, ...r }) => r) }),
}).then((r) => r.json());
const both = async (A, B) => { await A.sync.run(); await B.sync.run(); await A.sync.run(); await B.sync.run(); };

test('the server keeps a consistent copy: merged rows and the totals derived from them agree', async () => {
  const srv = await server();
  try {
    const { A, B, billId } = await twoDevices(srv.url, 'derived');
    await pay(A, billId, 'Cash', 300); await tick(); await pay(B, billId, 'UPI', 500);
    await both(A, B);
    const onServer = (await exportFrom(srv.url, 'derived')).records.find((r) => r.id === billId).data;
    assert.deepEqual(onServer.payments.map((p) => p.amount).sort(), [300, 500]);
    assert.equal(onServer.paid, 800, 'server copy: paid = sum of its payment rows');
    assert.equal(onServer.balance, 200);
    // a backup restored from the server copy is consistent too
    const R = await device(srv.url, 'derived-restore');
    await R.store.importAll(await exportFrom(srv.url, 'derived'));
    assert.deepEqual(summary(R, billId), { rows: ['Cash 300', 'UPI 500'], paid: 800, balance: 200, status: 'Partial' });
  } finally { await srv.close(); }
});

test('the same payment delivered twice, a replayed sync request, and an interrupted sync add nothing', async () => {
  const srv = await server();
  try {
    const { A, B, billId } = await twoDevices(srv.url, 'replay');
    await pay(A, billId, 'Cash', 300);
    // interrupted: the server stores the push but the reply never reaches the device (it stays "to send")
    const lost = await pushRaw(srv.url, 'replay', A.store);
    assert.equal(lost.ok, true);
    assert.equal(A.store.dirtyRecords().length > 0, true, 'device still thinks it has to send');
    // the identical request again (a retry), then normal syncs
    await pushRaw(srv.url, 'replay', A.store);
    await A.sync.run(); await A.sync.run();
    await B.sync.run(); await B.sync.run();
    const rows = (await exportFrom(srv.url, 'replay')).records.find((r) => r.id === billId).data.payments;
    assert.equal(rows.length, 1, 'server: one payment');
    assert.deepEqual(summary(B, billId).rows, ['Cash 300']);
    // the same record arriving twice on a device changes nothing the second time
    const copy = structuredClone(A.store.getRecord('invoices', billId));
    B.store.applyRemote(copy);
    assert.equal(B.store.applyRemote(structuredClone(copy)), false);
    assert.deepEqual(summary(B, billId).rows, ['Cash 300']);
  } finally { await srv.close(); }
});

test('payments are append-only: a correction or removal is a reversal kept in history, and never comes back', async () => {
  const srv = await server();
  try {
    const { A, B, billId } = await twoDevices(srv.url, 'history');
    await pay(A, billId, 'Cash', 300);
    await both(A, B);
    // A corrects 300 to 350 and syncs; B still holds the old 300 row and syncs after
    const rec = A.store.getRecord('invoices', billId);
    await A.store.patchRecord('invoices', billId, { payments: rec.data.payments.map((p) => ({ ...p, amount: 350 })) });
    await A.sync.run(); await B.sync.run(); await A.sync.run();
    for (const dev of [A, B]) {
      const d = dev.store.getRecord('invoices', billId).data;
      assert.deepEqual(d.payments.map((p) => p.amount), [350], 'the old 300 does not come back');
      assert.equal(d.paid, 350);
      assert.deepEqual(d.payments__void.map((v) => [v.amount, v._void.reason]), [[300, 'edited']], 'the 300 is in history as a reversal');
    }
    // removing a payment reverses it; a stale device does not resurrect it
    await A.store.patchRecord('invoices', billId, { payments: [] });
    await B.sync.run(); await A.sync.run(); await B.sync.run();
    for (const dev of [A, B]) {
      const d = dev.store.getRecord('invoices', billId).data;
      assert.deepEqual([d.payments.length, d.paid, d.status], [0, 0, 'Unpaid']);
      assert.deepEqual(d.payments__void.map((v) => [v.amount, v._void.reason]).sort(), [[300, 'edited'], [350, 'removed']]);
    }
  } finally { await srv.close(); }
});

test('simultaneous edits are never resolved silently: plain fields keep one value and record the other', async () => {
  const srv = await server();
  try {
    const { A, B, billId } = await twoDevices(srv.url, 'conflict');
    await A.store.patchRecord('invoices', billId, { notes: 'Deliver Monday' });
    await tick();
    await B.store.patchRecord('invoices', billId, { notes: 'Deliver Friday' });
    await both(A, B);
    const a = A.store.getRecord('invoices', billId).data, b = B.store.getRecord('invoices', billId).data;
    assert.equal(a.notes, b.notes, 'both devices agree');
    const c = a.__conflicts.filter((x) => x.kind === 'edit');
    assert.equal(c.length, 1, 'one conflict note');
    assert.deepEqual(new Set([c[0].fields.notes.kept, c[0].fields.notes.lost]), new Set(['Deliver Monday', 'Deliver Friday']));
    assert.equal(c[0].fields.paid, undefined, 'computed totals are not reported as conflicts');
    assert.deepEqual(b.__conflicts, a.__conflicts, 'the same note on both devices');
    assert.equal(A.store.conflicted().length, 1);
    await A.store.resolveConflicts('invoices', billId);
    await both(A, B);
    assert.equal(B.store.conflicted().length, 0, 'checked once, checked everywhere');
    assert.equal(B.store.getRecord('invoices', billId).data.__conflicts.length, 1, 'the note stays in history');
  } finally { await srv.close(); }
});

test('one payment corrected differently on two devices: both corrections kept, and the owner is told', async () => {
  const srv = await server();
  try {
    const { A, B, billId } = await twoDevices(srv.url, 'twice');
    await pay(A, billId, 'Cash', 300);
    await both(A, B);
    const fix = (dev, amount) => dev.store.patchRecord('invoices', billId, { payments: dev.store.getRecord('invoices', billId).data.payments.map((p) => ({ ...p, amount })) });
    await fix(A, 350); await tick(); await fix(B, 320);
    await both(A, B);
    const d = A.store.getRecord('invoices', billId).data;
    assert.deepEqual(d.payments.map((p) => p.amount).sort(), [320, 350], 'no correction is hidden');
    assert.ok(d.__conflicts.some((c) => c.kind === 'corrected-twice'), 'flagged for the owner');
    assert.deepEqual(B.store.getRecord('invoices', billId).data.payments.map((p) => p.amount).sort(), [320, 350]);
  } finally { await srv.close(); }
});

for (const deleteFirst of [true, false]) test(`a bill deleted on one device while another recorded a payment on it is restored, with a note (${deleteFirst ? 'delete older' : 'delete newer'})`, async () => {
  const srv = await server();
  try {
    const { A, B, billId } = await twoDevices(srv.url, `deleted-${deleteFirst}`);
    if (deleteFirst) { await A.store.deleteRecord('invoices', billId); await tick(); await pay(B, billId, 'UPI', 500); }
    else { await pay(B, billId, 'UPI', 500); await tick(); await A.store.deleteRecord('invoices', billId); }
    await both(A, B);
    for (const dev of [A, B]) {
      const r = dev.store.getRecord('invoices', billId);
      assert.ok(r, 'the bill is back, so the payment is visible');
      assert.deepEqual([r.data.paid, r.data.payments.length], [500, 1]);
      assert.ok(r.data.__conflicts.some((c) => c.kind === 'restored'));
    }
  } finally { await srv.close(); }
});

test('UPI across devices: a replayed bank payment matched on two devices counts once; so does a counter entry plus the bank', async () => {
  const { reconcileAll, refFor, COLLECT_TABLE } = await import('../../public/js/collect.js');
  const srv = await server();
  try {
    const { A, B, billId } = await twoDevices(srv.url, 'upi');
    for (const d of [A, B]) d.store.settings.collect = { enabled: true, since: '2026-01-01' };
    // the provider's webhook fires twice; both devices (not yet synced with each other) match it
    const evt = { status: 'new', utr: 'UTR900000001', amount: 400, ref: refFor(billId), at: new Date().toISOString() };
    A.store.putSystemRecord(COLLECT_TABLE, 'col_same', { ...evt });
    B.store.putSystemRecord(COLLECT_TABLE, 'col_same', { ...evt });
    await reconcileAll(A.store); await reconcileAll(B.store);
    await both(A, B);
    for (const dev of [A, B]) {
      const d = dev.store.getRecord('invoices', billId).data;
      assert.deepEqual(d.payments.map((p) => `${p.amount} ${p.ref}`), ['400 UTR900000001'], 'one payment for one UTR');
      assert.equal(d.paid, 400);
    }
    // the counter marks 600 "UPI received" on A while B, offline from A, matches the bank's 600 for the same bill
    await pay(A, billId, 'UPI', 600);
    B.store.putSystemRecord(COLLECT_TABLE, 'col_two', { status: 'new', utr: 'UTR900000002', amount: 600, ref: refFor(billId), at: new Date().toISOString() });
    await reconcileAll(B.store);
    await both(A, B);
    for (const dev of [A, B]) {
      const d = dev.store.getRecord('invoices', billId).data;
      assert.equal(d.paid, 1000, 'the 600 counts once');
      assert.deepEqual(d.payments.map((p) => `${p.amount} ${p.ref}`).sort(), ['400 UTR900000001', '600 UTR900000002'], 'the counter entry now carries the bank UTR');
      assert.equal(d.status, 'Paid');
    }
  } finally { await srv.close(); }
});

test('payments saved before rows had ids get the same id on every device: upgrading duplicates nothing', async () => {
  const srv = await server();
  try {
    const A = await device(srv.url, 'legacy'), B = await device(srv.url, 'legacy');
    const app = buildTemplate('retail', t, { businessName: 'Old Shop' });
    const payF = app.tables.find((x) => x.id === 'invoices').fields.find((f) => f.id === 'payments');
    delete payF.ledger; app.collectV = 1;                       // an app from before this change
    A.store.setApp(app);
    const item = (await A.store.saveRecord('items', { code: 'R', name: 'Rice', price: 1000, stock: 9 })).record;
    const cust = (await A.store.saveRecord('customers', { name: 'Old' })).record;
    const bill = (await A.store.saveRecord('invoices', { items: [{ item: item.id, qty: 1 }], customer: cust.id,
      payments: [{ mode: 'Cash', amount: 100 }, { mode: 'Cash', amount: 100 }] })).record;   // two identical old rows
    assert.equal(bill.data.payments[0]._id, undefined, 'old rows have no id');
    await A.join(); await B.join(true);
    // both devices are upgraded (as on their next start), then each records a payment offline
    const { upgradeCollect } = await import('../../public/js/collect.js');
    for (const d of [A, B]) { upgradeCollect(d.store.app, t); d.store.setApp(d.store.app); }
    await pay(A, bill.id, 'Cash', 300); await tick(); await pay(B, bill.id, 'UPI', 500);
    await both(A, B);
    for (const dev of [A, B]) assert.deepEqual(summary(dev, bill.id), { rows: ['Cash 100', 'Cash 100', 'Cash 300', 'UPI 500'], paid: 1000, balance: 0, status: 'Paid' });
  } finally { await srv.close(); }
});

test('an edit form opened before a sync cannot remove payments it never saw, nor bring back ones reversed meanwhile', async () => {
  const srv = await server();
  try {
    const { A, B, billId } = await twoDevices(srv.url, 'stale');
    await pay(A, billId, 'Cash', 300);
    await both(A, B);
    // the owner opens the bill's edit form on A (this is what the form keeps as its starting point)
    const base = structuredClone(A.store.getRecord('invoices', billId).data);
    const form = structuredClone(base);
    // meanwhile the counter (B) takes 500 by UPI, and it syncs onto A while the form is open
    await pay(B, billId, 'UPI', 500);
    await B.sync.run(); await A.sync.run();
    // the owner only changes the note and saves the form as they saw it (300 only)
    form.notes = 'Called the customer';
    const res = await A.store.saveRecord('invoices', form, { id: billId, base });
    assert.ok(res.ok);
    assert.deepEqual(summary(A, billId).rows, ['Cash 300', 'UPI 500'], 'the 500 the form never showed is kept');
    assert.equal(A.store.getRecord('invoices', billId).data.payments__void, undefined, 'nothing reversed');
    // now B reverses the 300 while a form on A that still shows it is open; A saves that form unchanged
    const base2 = structuredClone(A.store.getRecord('invoices', billId).data);
    await both(A, B);
    const onB = B.store.getRecord('invoices', billId);
    await B.store.patchRecord('invoices', billId, { payments: onB.data.payments.filter((p) => p.amount !== 300) });
    await B.sync.run(); await A.sync.run();
    await A.store.saveRecord('invoices', { ...structuredClone(base2), notes: 'Second call' }, { id: billId, base: base2 });
    await both(A, B);
    for (const dev of [A, B]) assert.deepEqual(summary(dev, billId).rows, ['UPI 500'], 'the reversed 300 does not come back');
    // a form that CHANGED a payment reversed elsewhere keeps the typed amount as new money, and says so
    const base3 = structuredClone(A.store.getRecord('invoices', billId).data);
    const edited = structuredClone(base3);
    edited.payments = edited.payments.map((p) => ({ ...p, amount: 450 }));
    await B.store.patchRecord('invoices', billId, { payments: [] });
    await B.sync.run(); await A.sync.run();
    await A.store.saveRecord('invoices', edited, { id: billId, base: base3 });
    await both(A, B);
    const d = B.store.getRecord('invoices', billId).data;
    assert.deepEqual(d.payments.map((p) => p.amount), [450]);
    assert.ok(d.__conflicts.some((c) => c.kind === 'edited-after-reversal'), 'flagged for the owner');
  } finally { await srv.close(); }
});

test('randomised: three devices, random payments, corrections, removals and sync orders: all agree, nothing lost or doubled', async () => {
  for (const seed of [1, 7, 42]) {
    let x = seed;
    const rnd = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
    const srv = await server();
    try {
      const { A, B, billId } = await twoDevices(srv.url, `fuzz-${seed}`);
      const C = await device(srv.url, `fuzz-${seed}`);
      await C.join(true);
      const devs = [A, B, C];
      const created = new Set(), reversed = new Set();
      const snapshot = (dev) => {
        const d = dev.store.getRecord('invoices', billId).data;
        return { live: new Set(d.payments.map((p) => p._id)), voids: new Set((d.payments__void || []).map((v) => v._id)) };
      };
      for (let step = 0; step < 40; step++) {
        const dev = devs[rnd(3)];
        const before = snapshot(dev);
        const rows = dev.store.getRecord('invoices', billId).data.payments;
        const op = rnd(10);
        if (op < 4) await pay(dev, billId, ['Cash', 'UPI', 'Card'][rnd(3)], 10 * (1 + rnd(20)));
        else if (op < 6 && rows.length) { const i = rnd(rows.length); await dev.store.patchRecord('invoices', billId, { payments: rows.map((p, j) => (j === i ? { ...p, amount: p.amount + 5 } : p)) }); }
        else if (op < 7 && rows.length) { const i = rnd(rows.length); await dev.store.patchRecord('invoices', billId, { payments: rows.filter((_, j) => j !== i) }); }
        else await dev.sync.run();
        const after = snapshot(dev);
        for (const id of after.live) if (!before.live.has(id)) created.add(id);
        for (const id of after.voids) if (!before.voids.has(id)) reversed.add(id);
        await tick();
      }
      for (let round = 0; round < 3; round++) for (const d of devs) await d.sync.run();
      const views = devs.map((d) => d.store.getRecord('invoices', billId).data);
      const ids = (d) => d.payments.map((p) => p._id).sort().join();
      assert.equal(ids(views[1]), ids(views[0]), `seed ${seed}: B agrees with A`);
      assert.equal(ids(views[2]), ids(views[0]), `seed ${seed}: C agrees with A`);
      const expected = [...created].filter((id) => !reversed.has(id)).sort();
      assert.deepEqual(views[0].payments.map((p) => p._id).sort(), expected, `seed ${seed}: every payment not reversed is there exactly once`);
      assert.equal(new Set(views[0].payments.map((p) => p._id)).size, views[0].payments.length, 'no duplicates');
      for (const v of views) assert.equal(v.paid, v.payments.reduce((s, p) => s + p.amount, 0), `seed ${seed}: paid = sum of payments`);
    } finally { await srv.close(); }
  }
});

// ---- stock: the same treatment as payments ---------------------------------------------------------------------------
// Stock used to be one number per item: two devices selling the same item offline kept one device's result (true 7,
// shown 8). Now every sale, purchase and correction is a movement row and stock is their sum.
const sell = async (dev, itemId, qty, custId) => (await dev.store.saveRecord('invoices', { customer: custId, items: [{ item: itemId, qty }] })).record;
const stockOf = (dev, itemId) => dev.store.getRecord('items', itemId).data.stock;
const kinds = (dev, itemId) => dev.store.getRecord('items', itemId).data.stock_moves.map((m) => m.kind).sort();
const soap = async (dev, stock = 9) => (await dev.store.saveRecord('items', { code: 'S', name: 'Soap', price: 40, cost: 30, stock })).record.id;

for (const order of [['A', 'B'], ['B', 'A']]) {
  test(`stock acceptance: the same item sold offline on A and on B, sync ${order.join(' then ')}: both sales count (9 -> 7)`, async () => {
    const srv = await server();
    const ws = `stock-${order.join('')}`;
    try {
      const { A, B, custId } = await twoDevices(srv.url, ws);
      const itemId = await soap(A);
      await both(A, B);
      assert.equal(stockOf(B, itemId), 9);
      // both offline: each sells one soap
      await sell(A, itemId, 1, custId); await tick(); await sell(B, itemId, 1, custId);
      assert.deepEqual([stockOf(A, itemId), stockOf(B, itemId)], [8, 8]);
      const dev = { A, B };
      await dev[order[0]].sync.run(); await dev[order[1]].sync.run(); await dev[order[0]].sync.run(); await dev[order[1]].sync.run();
      await A.sync.run(); await B.sync.run();   // retries change nothing
      for (const d of [A, B]) {
        assert.equal(stockOf(d, itemId), 7, 'both sales count');
        assert.deepEqual(kinds(d, itemId), ['opening', 'rule', 'rule']);
        assert.equal((d.store.getRecord('items', itemId).data.__conflicts || []).length, 0, 'nothing to resolve: no conflict note');
      }
      const onServer = (await exportFrom(srv.url, ws)).records.find((r) => r.id === itemId).data;
      assert.equal(onServer.stock, 7, 'server copy: stock = sum of its movements');
      assert.equal(onServer.stock_value, 7 * 30, 'and values computed from stock agree');
      const C = await device(srv.url, ws);
      await C.join(true);
      assert.equal(stockOf(C, itemId), 7, 'a fresh device');
    } finally { await srv.close(); }
  });
}

test('stock: a correction typed on one device and a sale on another both count; each movement says where it came from', async () => {
  const srv = await server();
  try {
    const { A, B, custId } = await twoDevices(srv.url, 'stock-count');
    const itemId = await soap(A);
    await both(A, B);
    // the owner receives 3 more and types 12 on A, while the counter (B) sells 2, offline
    await A.store.patchRecord('items', itemId, { stock: 12 });
    await sell(B, itemId, 2, custId);
    await both(A, B);
    for (const d of [A, B]) {
      assert.equal(stockOf(d, itemId), 10);
      const moves = d.store.getRecord('items', itemId).data.stock_moves;
      assert.deepEqual(moves.map((m) => `${m.kind} ${m.qty}`).sort(), ['adjust 3', 'opening 9', 'rule -2']);
      assert.ok(moves.find((m) => m.kind === 'rule').src, 'a sale says which bill it came from');
    }
  } finally { await srv.close(); }
});

test('stock: an item form opened before a sync cannot undo a sale it never saw', async () => {
  const srv = await server();
  try {
    const { A, B, custId } = await twoDevices(srv.url, 'stock-stale');
    const itemId = await soap(A);
    await both(A, B);
    const base = structuredClone(A.store.getRecord('items', itemId).data);
    await sell(B, itemId, 2, custId);
    await B.sync.run(); await A.sync.run();
    assert.equal(stockOf(A, itemId), 7);
    // the form still shows 9; the owner only changes the price
    await A.store.saveRecord('items', { ...structuredClone(base), price: 45 }, { id: itemId, base });
    assert.equal(stockOf(A, itemId), 7, 'the sale is kept');
    // a form that still shows 9 where the owner adds 11 (types 20): the 11 is added to what is there now
    await A.store.saveRecord('items', { ...structuredClone(base), stock: 20 }, { id: itemId, base });
    await both(A, B);
    for (const d of [A, B]) assert.equal(stockOf(d, itemId), 18);
  } finally { await srv.close(); }
});

test('stock: editing, deleting and restoring a bill moves stock once, also when two devices delete or restore the same bill', async () => {
  const srv = await server();
  try {
    const { A, B, custId } = await twoDevices(srv.url, 'stock-edit');
    const itemId = await soap(A);
    const bill = await sell(A, itemId, 2, custId);
    assert.equal(stockOf(A, itemId), 7);
    await A.store.patchRecord('invoices', bill.id, { items: [{ item: itemId, qty: 3 }] });
    assert.equal(stockOf(A, itemId), 6);
    await both(A, B);
    // both devices delete the same bill offline: the 3 go back once, not twice
    await A.store.deleteRecord('invoices', bill.id); await tick(); await B.store.deleteRecord('invoices', bill.id);
    await both(A, B);
    for (const d of [A, B]) assert.equal(stockOf(d, itemId), 9, 'deleted twice, put back once');
    // restored on both devices: taken out once
    await A.store.restoreRecord('invoices', bill.id); await tick(); await B.store.restoreRecord('invoices', bill.id);
    await both(A, B);
    for (const d of [A, B]) assert.equal(stockOf(d, itemId), 6, 'restored twice, taken out once');
  } finally { await srv.close(); }
});

test('stock: one bill changed differently on two devices at once is flagged on the item, never silently off', async () => {
  const srv = await server();
  try {
    const { A, B, custId } = await twoDevices(srv.url, 'stock-twice');
    const itemId = await soap(A);
    const bill = await sell(A, itemId, 2, custId);
    await both(A, B);
    await A.store.patchRecord('invoices', bill.id, { items: [{ item: itemId, qty: 3 }] }); await tick();
    await B.store.patchRecord('invoices', bill.id, { items: [{ item: itemId, qty: 4 }] });
    await both(A, B);
    const a = A.store.getRecord('items', itemId).data, b = B.store.getRecord('items', itemId).data;
    assert.equal(a.stock, b.stock, 'both devices agree');
    assert.ok([6, 5].includes(a.stock), `one of the two changes counts, not both (got ${a.stock})`);
    assert.ok(a.__conflicts.some((c) => c.kind === 'row' && c.field === 'stock_moves'), 'the item says its stock needs a count');
  } finally { await srv.close(); }
});

test('stock saved before movements: upgrading two devices counts the opening stock once', async () => {
  const srv = await server();
  try {
    const A = await device(srv.url, 'stock-legacy'), B = await device(srv.url, 'stock-legacy');
    const app = buildTemplate('retail', t, { businessName: 'Old Shop' });
    const items = app.tables.find((x) => x.id === 'items');
    items.fields = items.fields.filter((f) => f.id !== 'stock_moves');
    delete items.fields.find((f) => f.id === 'stock').moves;    // an app from before this change
    A.store.setApp(app);
    const itemId = await soap(A);
    const cust = (await A.store.saveRecord('customers', { name: 'Old' })).record;
    assert.equal(A.store.getRecord('items', itemId).data.stock_moves, undefined, 'a plain number');
    await A.join(); await B.join(true);
    const { upgradeStock } = await import('../../public/js/templates/common.js');
    for (const d of [A, B]) { assert.equal(upgradeStock(d.store.app, t), true); d.store.setApp(d.store.app); }
    assert.equal(upgradeStock(A.store.app, t), false, 'runs once');
    await sell(A, itemId, 1, cust.id); await tick(); await sell(B, itemId, 1, cust.id);
    await both(A, B);
    for (const d of [A, B]) {
      assert.equal(stockOf(d, itemId), 7);
      assert.deepEqual(kinds(d, itemId), ['opening', 'rule', 'rule'], 'one opening row');
    }
  } finally { await srv.close(); }
});

test('stock randomised: three devices, random sales, deleted bills, corrections and sync orders: stock = opening + corrections - live sales', async () => {
  for (const seed of [3, 11, 99]) {
    let x = seed;
    const rnd = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
    const srv = await server();
    try {
      const { A, B, custId } = await twoDevices(srv.url, `stock-fuzz-${seed}`);
      const itemId = await soap(A, 100);
      await both(A, B);
      const C = await device(srv.url, `stock-fuzz-${seed}`);
      await C.join(true);
      const devs = [A, B, C];
      let corrections = 0;
      const soapBills = (d) => d.store.records('invoices').filter((r) => r.data.items.some((l) => l.item === itemId));
      for (let step = 0; step < 50; step++) {
        const dev = devs[rnd(3)];
        const op = rnd(10);
        if (op < 4) await sell(dev, itemId, 1 + rnd(3), custId);
        else if (op < 5) { const bills = soapBills(dev); if (bills.length) await dev.store.deleteRecord('invoices', bills[rnd(bills.length)].id); }
        else if (op < 6) { const by = rnd(5) - 2; if (by) { await dev.store.patchRecord('items', itemId, { stock: stockOf(dev, itemId) + by }); corrections += by; } }
        else await dev.sync.run();
        await tick();
      }
      for (let round = 0; round < 3; round++) for (const d of devs) await d.sync.run();
      const sold = soapBills(A).reduce((s, r) => s + r.data.items.filter((l) => l.item === itemId).reduce((q, l) => q + l.qty, 0), 0);
      for (const d of devs) assert.equal(stockOf(d, itemId), 100 + corrections - sold, `seed ${seed}: every device`);
      assert.deepEqual(soapBills(B).map((r) => r.id).sort(), soapBills(A).map((r) => r.id).sort(), `seed ${seed}: same bills`);
    } finally { await srv.close(); }
  }
});
