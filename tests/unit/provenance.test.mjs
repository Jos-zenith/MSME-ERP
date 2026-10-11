// The bank-confirmation snapshot (`bank`, `origin: 'server'`) can only come from the server, which builds it from
// records only its signed webhook creates. These tests try every way a device or a file could write it.
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
import { SYNC_PROTOCOL } from '../../public/js/protocol.js';
import { bankConfirmations, reconcileAll, refFor, COLLECT_TABLE } from '../../public/js/collect.js';

const PASS = 'tamarind-ledger-7', CODE = 'PROV-TEST-CODE', t = (s) => s;
async function setup() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-prov-'));
  process.env.SETUP_CODE = CODE;
  const mod = await import(`../../server/server.js?prov=${Date.now()}${Math.random()}`);
  const srv = await mod.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${srv.address().port}`;
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('retail', t, { businessName: 'Prov Mart', upi: 'prov@ybl' }));
  store.settings.collect = { enabled: true, since: '2026-01-01' };
  const sync = new Sync(store);
  sync.configure({ url, ws: 'prov-shop', token: PASS, create: true, setupCode: CODE });
  assert.equal((await sync.run()).error, undefined);
  const item = (await store.saveRecord('items', { code: 'R', name: 'Rice', price: 1000, stock: 50 })).record;
  const bill = (await store.saveRecord('invoices', { items: [{ item: item.id, qty: 1 }], customer: (await store.saveRecord('customers', { name: 'Ravi' })).record.id })).record;
  await sync.run();
  // one real, signed provider payment for that bill
  const hook = await sync.collectSetup();
  const body = JSON.stringify({ status: 'SUCCESS', utr: 'UTR777000111', amount: 1000, reference_id: refFor(bill.id) });
  const sig = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
  assert.equal((await fetch(hook.hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig }, body })).status, 200);
  await sync.run(); await reconcileAll(store); await sync.run();
  const raw = (records, extra = {}) => fetch(`${url}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ws: 'prov-shop', token: PASS, protocol: SYNC_PROTOCOL, since: 0, records, ...extra }) }).then((r) => r.json());
  const dump = async () => (await (await fetch(`${url}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ws: 'prov-shop', token: PASS }) })).json()).records;
  return { url, srv, store, sync, bill, raw, dump, close: () => new Promise((r) => srv.close(r)) };
}
const now = () => new Date(Date.now() + 1000).toISOString();

test('sync cannot create, overwrite or forge the bank snapshot (new, existing, other tables, raw requests)', async () => {
  const s = await setup();
  try {
    assert.deepEqual([...bankConfirmations(s.store).values()].map((b) => [b.amount, b.sandbox]), [[1000, false]], 'the real payment counts');
    const real = s.store.records(COLLECT_TABLE)[0];
    const fake = { utr: 'UTR777000111', amount: 99999, source: 'provider', ref: '', vpa: '', name: '', phone: '', at: real.bank.at };
    const out = await s.raw([
      // 1. a brand-new confirmation, with a forged snapshot and origin
      { id: 'col_forged', table: COLLECT_TABLE, origin: 'server', bank: { ...fake, utr: 'UTR999' }, data: { utr: 'UTR999', amount: 5000, source: 'provider', status: 'matched', allocations: [{ id: s.bill.id }] }, created: now(), updated: now(), vv: { x: 1 } },
      // 2. the real confirmation, with a bigger amount in both the snapshot and the data
      { ...real, bank: fake, origin: 'server', data: { ...real.data, amount: 99999, source: 'provider' }, updated: now(), vv: { ...real.vv, x: 9 } },
      // 3. an ordinary record carrying snapshot-looking fields
      { id: 'cust_x', table: 'customers', origin: 'server', bank: fake, data: { name: 'Sneaky' }, created: now(), updated: now(), vv: { x: 1 } },
    ]);
    assert.equal(out.ok, true);
    const onServer = await s.dump();
    assert.ok(!onServer.some((r) => r.id === 'col_forged'), '1: no confirmation created by sync');
    const kept = onServer.find((r) => r.id === real.id);
    assert.equal(kept.data.amount, 1000, '2: the bank amount is restored');
    assert.equal(kept.bank.amount, 1000, '2: and the snapshot sent out is built from it');
    const cust = onServer.find((r) => r.id === 'cust_x');
    assert.equal(cust.bank, undefined, '3: snapshot fields are not stored on ordinary records');
    assert.equal(cust.origin, undefined, '3: nor is the origin stamp');
    // the device pulls: still exactly the real payment
    await s.sync.run(); await s.sync.run();
    assert.deepEqual([...bankConfirmations(s.store)].map(([u, b]) => [u, b.amount]), [['UTR777000111', 1000]]);
    assert.equal(s.store.getRecord('customers', 'cust_x').bank, undefined);
  } finally { await s.close(); delete process.env.SETUP_CODE; }
});

test('a backup file cannot bring its own bank snapshot: it is restored without one, and the server supplies it again', async () => {
  const s = await setup();
  try {
    const bk = s.store.exportAll();
    const col = bk.records.find((r) => r.table === COLLECT_TABLE);
    col.bank = { ...col.bank, amount: 99999 };                        // an edited backup file
    bk.records.push({ id: 'col_from_file', table: COLLECT_TABLE, origin: 'server', bank: { utr: 'UTR888', amount: 5000, source: 'provider' },
      data: { utr: 'UTR888', amount: 5000, status: 'matched', allocations: [{ id: s.bill.id }] }, created: now(), updated: now() });
    const restored = new Store({ db: memoryDb() });
    await restored.init();
    await restored.importAll(JSON.parse(JSON.stringify(bk)));
    assert.equal(bankConfirmations(restored).size, 0, 'nothing from the file counts as bank-confirmed');
    // connected to the server again (downloading the shop), the real confirmation is back, at the bank's amount
    const sync = new Sync(restored);
    sync.configure({ url: s.url, ws: 'prov-shop', token: PASS, adopt: true });
    assert.equal((await sync.run()).error, undefined);
    assert.deepEqual([...bankConfirmations(restored)].map(([u, b]) => [u, b.amount]), [['UTR777000111', 1000]]);
  } finally { await s.close(); delete process.env.SETUP_CODE; }
});
