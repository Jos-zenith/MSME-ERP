// Upgrades with the real old code: an app version from git history writes records in its own format while the server
// refuses it, then today's code opens that same stored data, migrates it as the app does at start, and syncs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../../public/js/store.js';
import { Sync } from '../../public/js/sync.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate } from '../../public/js/templates/index.js';
import { upgradeCounter, upgradeStock } from '../../public/js/templates/common.js';
import { upgradeCollect } from '../../public/js/collect.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PASS = 'tamarind-ledger-7', CODE = 'UPGRADE-TEST-CODE', t = (s) => s;
const RELEASES = [
  ['8327f05', 'before payment ledgers (sync protocol 1)'],
  ['7d8ee7a', 'ledgers and stock movements, no protocol number (3)'],
];

/** That commit's app code, unpacked from git into a temporary folder; null when the history is not available. */
function oldApp(commit) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vina-old-${commit}-`));
    execSync(`git archive ${commit} public | tar -x -C "${dir.replace(/\\/g, '/')}"`, { cwd: ROOT, stdio: 'pipe', shell: true });
    return (f) => pathToFileURL(path.join(dir, 'public/js', f)).href;
  } catch { return null; }
}
async function server() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-upgrade-'));
  process.env.SETUP_CODE = CODE;
  const mod = await import(`../../server/server.js?upgrade=${Date.now()}${Math.random()}`);
  const srv = await mod.start(0, '127.0.0.1');
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

for (const [commit, era] of RELEASES) {
  const at = oldApp(commit);
  test(`upgrade from ${commit} (${era}): refused while old, nothing lost, everything synced once after updating`, { skip: at ? false : `git history for ${commit} not available (shallow clone?)` }, async () => {
    const { Store: OldStore } = await import(at('store.js'));
    const { Sync: OldSync } = await import(at('sync.js'));
    const srv = await server();
    try {
      // the owner's laptop is already on today's version
      const owner = new Store({ db: memoryDb() });
      await owner.init();
      owner.setApp(buildTemplate('retail', t, { businessName: 'Upgrade Mart', upi: 'up@ybl' }));
      const item = (await owner.saveRecord('items', { code: 'R', name: 'Rice', price: 1000, stock: 20 })).record;
      const ownerSync = new Sync(owner);
      ownerSync.configure({ url: srv.url, ws: 'upgrade-shop', token: PASS, create: true, setupCode: CODE });
      assert.equal((await ownerSync.run()).error, undefined);

      // the counter phone still runs the old version, with the shop on it; it bills while the server refuses it
      const db = memoryDb();
      const phone = new OldStore({ db });
      await phone.init();
      phone.setApp(structuredClone(owner.app));
      phone._put({ ...structuredClone(owner.getRecord('items', item.id)), dirty: undefined });
      const cust = (await phone.saveRecord('customers', { name: 'Offline Meena', phone: '91234 56780' })).record;
      const bill = (await phone.saveRecord('invoices', { customer: cust.id, items: [{ item: item.id, qty: 1 }],
        payments: [{ mode: 'Cash', amount: 300 }, { mode: 'UPI', amount: 200 }] })).record;
      const oldSync = new OldSync(phone);
      oldSync.configure({ url: srv.url, ws: 'upgrade-shop', token: PASS });
      const refused = await oldSync.run();
      assert.ok(refused.error, `the old app is refused (${refused.error})`);
      await phone.flush();
      assert.equal(phone.getRecord('invoices', bill.id).dirty, 1, 'the bill is still waiting on the phone');
      await ownerSync.run();
      assert.equal(owner.getRecord('invoices', bill.id), null, 'and nothing of it reached the server');

      // the phone updates: today's code opens the same stored data and runs the start-up migrations, as main.js does
      const updated = new Store({ db });
      assert.equal(await updated.init(), true);
      updated.migrateAccess();
      for (const up of [upgradeCounter, upgradeCollect, upgradeStock]) if (up(updated.app, t)) updated.setApp(updated.app);
      const d0 = updated.getRecord('invoices', bill.id).data;
      assert.deepEqual(d0.payments.map((p) => `${p.mode} ${p.amount}`), ['Cash 300', 'UPI 200'], 'the old bill opens intact');
      assert.equal(updated.getRecord('customers', cust.id).data.name, 'Offline Meena');
      const newSync = new Sync(updated);
      assert.equal((await newSync.run()).error, undefined, 'the updated app syncs');
      for (let i = 0; i < 2; i++) { await newSync.run(); await ownerSync.run(); }

      for (const [who, s] of [['owner', owner], ['updated phone', updated]]) {
        const d = s.getRecord('invoices', bill.id).data;
        assert.deepEqual(d.payments.map((p) => `${p.mode} ${p.amount}`).sort(), ['Cash 300', 'UPI 200'], `${who}: both payments, once`);
        assert.equal(d.paid, 500, `${who}: paid`);
        assert.equal(s.getRecord('customers', cust.id).data.name, 'Offline Meena', `${who}: the customer`);
      }
      assert.equal(updated.dirtyRecords().length, 0, 'nothing left waiting');
    } finally { await srv.close(); delete process.env.SETUP_CODE; }
  });
}
