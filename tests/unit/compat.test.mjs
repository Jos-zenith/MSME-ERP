// Client compatibility: the server refuses devices outside its protocol range before touching any data; an outdated
// device keeps its records and syncs them after updating.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../../public/js/store.js';
import { Sync } from '../../public/js/sync.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate } from '../../public/js/templates/index.js';
import { SYNC_PROTOCOL, SERVER_ACCEPTS, protocolProblem } from '../../public/js/protocol.js';

const PASS = 'tamarind-ledger-7';
const CODE = 'COMPAT-TEST-CODE';
const t = (s) => s;
async function server() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-compat-'));
  process.env.SETUP_CODE = CODE;
  const mod = await import(`../../server/server.js?compat=${Date.now()}${Math.random()}`);
  const srv = await mod.start(0, '127.0.0.1');
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
const post = (url, p, body) => fetch(`${url}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const rec = (id) => { const now = new Date().toISOString(); return { id, table: 'customers', data: { name: id }, created: now, updated: now, vv: { d: 1 } }; };

test('policy: the current app is accepted; older and newer protocols are refused with different instructions', () => {
  assert.equal(protocolProblem(SYNC_PROTOCOL), null);
  assert.equal(protocolProblem(undefined).code, 'update_required', 'no protocol number: an app from before protocols');
  assert.equal(protocolProblem(SERVER_ACCEPTS.min - 1).status, 426);
  assert.equal(protocolProblem(SERVER_ACCEPTS.max + 1).code, 'server_outdated');
  assert.equal(protocolProblem('4').code, 'update_required', 'not a number is not trusted');
});

test('the server refuses an outdated device before reading anything: no workspace created, no record applied, no live feed', async () => {
  const srv = await server();
  try {
    const auth = { ws: 'compat-shop', token: PASS };
    // an app from before protocols tries to create a workspace: refused, and nothing is created
    let r = await post(srv.url, '/api/sync', { ...auth, create: true, setupCode: CODE, since: 0, records: [rec('old1')] });
    assert.equal(r.status, 426);
    assert.equal((await r.json()).code, 'update_required');
    assert.equal((await post(srv.url, '/api/export', auth)).status, 403, 'no workspace was created');
    // the current app creates it
    r = await post(srv.url, '/api/sync', { ...auth, protocol: SYNC_PROTOCOL, create: true, setupCode: CODE, since: 0, records: [rec('new1')] });
    assert.equal(r.status, 200);
    // an older protocol pushing to the existing workspace changes nothing
    for (const protocol of [undefined, 1, 2, 3]) {
      r = await post(srv.url, '/api/sync', { ...auth, protocol, since: 0, records: [rec(`old-${protocol}`)] });
      assert.equal(r.status, 426, `protocol ${protocol}`);
    }
    for (const p of ['/api/live', '/api/passphrase', '/api/collect/setup', '/api/collect/simulate']) {
      assert.equal((await post(srv.url, p, { ...auth, newToken: 'another-strong-pass-9' })).status, 426, p);
    }
    // a newer app than the server: told the server needs updating, nothing sent is applied
    r = await post(srv.url, '/api/sync', { ...auth, protocol: SERVER_ACCEPTS.max + 1, since: 0, records: [rec('future1')] });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'server_outdated');
    const ids = (await (await post(srv.url, '/api/export', auth)).json()).records.map((x) => x.id);
    assert.deepEqual(ids, ['new1'], 'only the compatible device changed anything; the passphrase is unchanged too');
  } finally { await srv.close(); delete process.env.SETUP_CODE; }
});

test('an outdated device is told to update, keeps every local record, and syncs them after updating', async () => {
  const srv = await server();
  try {
    const owner = new Store({ db: memoryDb() });
    await owner.init();
    owner.setApp(buildTemplate('retail', t, { businessName: 'Compat Mart' }));
    const ownerSync = new Sync(owner);
    ownerSync.configure({ url: srv.url, ws: 'compat-two', token: PASS, create: true, setupCode: CODE });
    assert.equal((await ownerSync.run()).error, undefined);

    // a phone still running an older app version (protocol 3) joins with data of its own
    const phone = new Store({ db: memoryDb() });
    await phone.init();
    phone.setApp(structuredClone(owner.app));
    const old = new Sync(phone, { protocol: 3 });
    old.configure({ url: srv.url, ws: 'compat-two', token: PASS });
    const sale = (await phone.saveRecord('customers', { name: 'Offline Sunita' })).record;
    const res = await old.run();
    assert.match(res.error, /Update to keep syncing/);
    assert.equal(old.status, 'update');
    assert.equal(old.needs, 'app');
    assert.equal(phone.getRecord('customers', sale.id).dirty, 1, 'still waiting to be sent, not lost');
    assert.equal(phone.getRecord('customers', sale.id).data.name, 'Offline Sunita');
    // the phone updates (same stored data, new app code): its record goes up, once
    const updated = new Sync(phone);
    assert.equal((await updated.run()).error, undefined);
    assert.equal((await updated.run()).error, undefined);
    await ownerSync.run();
    assert.equal(owner.records('customers').filter((c) => c.id === sale.id).length, 1);
    assert.equal(phone.getRecord('customers', sale.id).dirty, undefined);

    // an app newer than its server: told the server needs updating
    const future = new Sync(phone, { protocol: SERVER_ACCEPTS.max + 1 });
    await phone.saveRecord('customers', { name: 'Later' });
    const f = await future.run();
    assert.match(f.error, /sync server needs an update/i);
    assert.equal(future.needs, 'server');
  } finally { await srv.close(); delete process.env.SETUP_CODE; }
});
