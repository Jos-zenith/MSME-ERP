// Payment webhooks end to end: authentication, duplicates, partial payments, refunds and reversals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store } from '../../public/js/store.js';
import { Sync } from '../../public/js/sync.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate } from '../../public/js/templates/index.js';
import { reconcileAll, refFor, COLLECT_TABLE, bankConfirmations, paymentsToReview, applyReversal, ignorePayment } from '../../public/js/collect.js';
import { creditPassport } from '../../public/js/credit.js';

const PASS = 'tamarind-ledger-7', CODE = 'MATCH-TEST-CODE', t = (s) => s;
async function shop() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-match-'));
  process.env.SETUP_CODE = CODE;
  const mod = await import(`../../server/server.js?match=${Date.now()}${Math.random()}`);
  const srv = await mod.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${srv.address().port}`;
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('retail', t, { businessName: 'Match Mart', upi: 'match@ybl' }));
  store.settings.collect = { enabled: true, since: '2026-01-01' };
  const sync = new Sync(store);
  sync.configure({ url, ws: 'match-shop', token: PASS, create: true, setupCode: CODE });
  assert.equal((await sync.run()).error, undefined);
  const item = (await store.saveRecord('items', { code: 'R', name: 'Rice', price: 1000, stock: 50 })).record;
  const cust = (await store.saveRecord('customers', { name: 'Ravi', phone: '98765 43210' })).record;
  const bill = async () => (await store.saveRecord('invoices', { customer: cust.id, items: [{ item: item.id, qty: 1 }] })).record;
  await sync.run();
  const hook = await sync.collectSetup();
  const send = async (payload, { secret = hook.secret, sig, at = hook.hookUrl } = {}) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const s = sig ?? crypto.createHmac('sha256', secret).update(body).digest('hex');
    const r = await fetch(at, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(s ? { 'X-Signature': s } : {}) }, body });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const settle = async () => { await sync.run(); await reconcileAll(store); await sync.run(); };
  return { url, store, sync, bill, send, settle, hook, close: () => new Promise((r) => srv.close(r)) };
}

test('webhook authentication: only the exact body signed with this shop\'s secret is accepted', async () => {
  const s = await shop();
  try {
    const p = { status: 'SUCCESS', utr: 'UTR100000001', amount: 10 };
    const body = JSON.stringify(p);
    const good = crypto.createHmac('sha256', s.hook.secret).update(body).digest('hex');
    assert.equal((await s.send(p, { sig: '' })).status, 401, 'unsigned');
    assert.equal((await s.send(p, { secret: 'another-shop-secret' })).status, 401, 'signed with another secret');
    assert.equal((await s.send(JSON.stringify({ ...p, amount: 10000 }), { sig: good })).status, 401, 'a valid signature for a different body');
    assert.equal((await s.send(p, { sig: good.slice(0, 40) })).status, 401, 'a truncated signature');
    assert.equal((await s.send(p, { at: s.hook.hookUrl.replace(/[0-9a-f]{24}$/, '0'.repeat(24)) })).status, 404, 'an unknown hook address');
    assert.equal((await s.send(p, { sig: `sha256=${good.toUpperCase()}` })).status, 200, 'the same signature, prefixed and upper-case');
  } finally { await s.close(); delete process.env.SETUP_CODE; }
});

test('duplicates: a repeated event is acknowledged once; the same UTR with a different amount is refused, not ignored', async () => {
  const s = await shop();
  try {
    const p = { status: 'SUCCESS', utr: 'UTR200000001', amount: 500 };
    assert.equal((await s.send(p)).status, 200);
    const again = await s.send(p);
    assert.deepEqual([again.status, again.duplicate], [200, true]);
    const changed = await s.send({ ...p, amount: 5000 });
    assert.equal(changed.status, 409, 'the provider is told something is wrong');
    await s.settle();
    assert.deepEqual(s.store.records(COLLECT_TABLE).map((r) => r.bank.amount), [500], 'the first amount stands, once');
  } finally { await s.close(); delete process.env.SETUP_CODE; }
});

test('partial payments: each part lands on the bill, the balance falls, and each part is bank-confirmed', async () => {
  const s = await shop();
  try {
    const b = await s.bill();                                       // 1,000
    await s.sync.run();
    assert.equal((await s.send({ status: 'SUCCESS', utr: 'UTR300000001', amount: 400, reference_id: refFor(b.id) })).status, 200);
    await s.settle();
    let d = s.store.getRecord('invoices', b.id).data;
    assert.deepEqual([d.paid, d.balance, d.status], [400, 600, 'Partial']);
    assert.equal((await s.send({ status: 'SUCCESS', utr: 'UTR300000002', amount: 600, reference_id: refFor(b.id) })).status, 200);
    await s.settle();
    d = s.store.getRecord('invoices', b.id).data;
    assert.deepEqual([d.paid, d.balance, d.status, d.payments.length], [1000, 0, 'Paid', 2]);
    assert.equal(creditPassport(s.store).metrics.bankConfirmed90, 1000);
  } finally { await s.close(); delete process.env.SETUP_CODE; }
});

test('refunds and reversals are kept, not dropped: confirmed money falls at once, and the owner records it on the bill', async () => {
  const s = await shop();
  try {
    const b = await s.bill();
    await s.sync.run();
    await s.send({ status: 'SUCCESS', utr: 'UTR400000001', amount: 1000, reference_id: refFor(b.id) });
    await s.settle();
    assert.equal(s.store.getRecord('invoices', b.id).data.status, 'Paid');
    // the bank reverses 300 of it (a partial refund), then the full rest (a chargeback, reported against the same UTR)
    const r1 = await s.send({ status: 'REFUNDED', utr: 'RFD400000001', original_utr: 'UTR400000001', amount: 300 });
    assert.equal(r1.status, 200);
    assert.equal(r1.ignored, undefined, 'a refund is recorded, not ignored');
    assert.equal((await s.send({ status: 'REFUNDED', utr: 'RFD400000001', original_utr: 'UTR400000001', amount: 300 })).duplicate, true, 'a repeated refund counts once');
    await s.settle();
    assert.equal(bankConfirmations(s.store).get('UTR400000001').amount, 700, 'the passport stops counting refunded money immediately');
    assert.equal(creditPassport(s.store).metrics.bankConfirmed90, 700);
    // it waits for the owner (money going back is never booked by guesswork), pointing at the bill it was paid on
    const waiting = paymentsToReview(s.store);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].data.kind, 'reversal');
    assert.deepEqual(waiting[0].data.suggestion.allocations.map((a) => a.id), [b.id]);
    await applyReversal(s.store, waiting[0].id);
    let d = s.store.getRecord('invoices', b.id).data;
    assert.deepEqual([d.paid, d.balance, d.status], [700, 300, 'Partial'], 'the bill shows what is owed again');
    assert.deepEqual(d.payments.map((p) => [p.amount, p.ref]), [[1000, 'UTR400000001'], [-300, 'RFD400000001']]);
    await applyReversal(s.store, waiting[0].id);
    assert.equal(s.store.getRecord('invoices', b.id).data.payments.length, 2, 'recording it twice adds nothing');
    // a chargeback reported with the original UTR itself, for the rest
    await s.send({ status: 'CHARGEBACK', utr: 'UTR400000001', amount: 700 });
    await s.settle();
    assert.equal(bankConfirmations(s.store).get('UTR400000001').amount, 0);
    await applyReversal(s.store, paymentsToReview(s.store)[0].id);
    d = s.store.getRecord('invoices', b.id).data;
    assert.deepEqual([d.paid, d.balance, d.status], [0, 1000, 'Unpaid']);
    const m = creditPassport(s.store).metrics;
    assert.deepEqual([m.bankConfirmed90, m.digital90], [0, 0], 'refunded money is neither bank-confirmed nor collected');
    // a reversal of a payment this shop never had goes to the owner with no suggestion; it can be dismissed
    await s.send({ status: 'REVERSED', utr: 'RFD999', original_utr: 'UTR_UNKNOWN_1', amount: 50 });
    await s.settle();
    const odd = paymentsToReview(s.store).find((r) => r.data.of === 'UTR_UNKNOWN_1');
    assert.ok(odd && !odd.data.suggestion);
    ignorePayment(s.store, odd.id, 'not ours');
    assert.equal(paymentsToReview(s.store).length, 0);
  } finally { await s.close(); delete process.env.SETUP_CODE; }
});
