// "Saved" means recoverable: the server answers success only after the change is on disk, survives the process being
// killed straight after that answer, and never answers success for a write that failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../../public/js/store.js';
import { Sync } from '../../public/js/sync.js';
import { SYNC_PROTOCOL } from '../../public/js/protocol.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate } from '../../public/js/templates/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PASS = 'tamarind-ledger-7';
const CODE = 'DURABLE-TEST-CODE';
const t = (s) => s;

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
/** The real server as its own process, as it runs in a shop. */
async function startProcess(dataDir, port, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', SETUP_CODE: CODE, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => { out += b; if (out.includes('Vina is running')) resolve(); });
    child.on('exit', (c) => reject(new Error(`server exited ${c}: ${out}`)));
  });
  return child;
}
const killHard = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); });
const post = (url, p, body) => fetch(`${url}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: SYNC_PROTOCOL, ...body }) });
const record = (id, n) => {
  const now = new Date().toISOString();
  return { id, table: 'customers', data: { name: `Customer ${n}` }, created: now, updated: now, deleted: false, vv: { dev1: 1 } };
};

test('acknowledged changes survive the server process being killed straight after it answered', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-durable-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child = await startProcess(dataDir, port);
  try {
    const auth = { ws: 'durable-shop', token: PASS };
    const first = await post(url, '/api/sync', { ...auth, create: true, setupCode: CODE, since: 0, records: [record('c1', 1)] });
    assert.equal(first.status, 200);
    // ten saves in a row, each followed by an instant hard kill and a restart: every acknowledged record must be there
    for (let n = 2; n <= 10; n++) {
      const res = await post(url, '/api/sync', { ...auth, since: 0, records: [record(`c${n}`, n)] });
      assert.equal(res.status, 200, `save ${n} acknowledged`);
      await killHard(child);                                   // no SIGTERM, no chance to flush anything
      child = await startProcess(dataDir, port);
    }
    // a payment confirmation acknowledged to the provider must survive the same way (the provider will not resend it)
    const setup = await (await post(url, '/api/collect/setup', auth)).json();
    const hook = `${url}${setup.hookPath}`;
    const body = JSON.stringify({ status: 'SUCCESS', utr: 'UTR555000111', amount: 250 });
    const sig = crypto.createHmac('sha256', setup.secret).update(body).digest('hex');
    const ack = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig }, body });
    assert.equal(ack.status, 200, 'provider told: received');
    await killHard(child);
    child = await startProcess(dataDir, port);

    const dump = await (await post(url, '/api/export', auth)).json();
    const ids = dump.records.map((r) => r.id);
    for (let n = 1; n <= 10; n++) assert.ok(ids.includes(`c${n}`), `acknowledged record c${n} survived`);
    assert.ok(dump.records.some((r) => r.table === '_collect' && r.data.utr === 'UTR555000111'), 'acknowledged bank payment survived');
    // nothing half-written left behind
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), []);
  } finally { await killHard(child).catch(() => {}); }
});

test('a failed write is never reported as saved, and the server does not keep the unsaved change in memory', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-failwrite-'));
  process.env.SETUP_CODE = CODE;
  const mod = await import(`../../server/server.js?fail=${Date.now()}`);
  const server = await mod.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const store = new Store({ db: memoryDb() });
    await store.init();
    store.setApp(buildTemplate('retail', t, { businessName: 'Fail Mart' }));
    const sync = new Sync(store);
    sync.configure({ url, ws: 'fail-shop', token: PASS, create: true, setupCode: CODE });
    assert.equal((await sync.run()).error, undefined);

    const c = (await store.saveRecord('customers', { name: 'Unsaved Ravi' })).record;
    mod.testHooks.failWrites = true;                         // the disk refuses the next writes (full, read-only, failing)
    const r = await sync.run();
    assert.ok(r.error, 'the device is told it did not save');
    assert.equal(store.getRecord('customers', c.id).dirty, 1, 'and keeps the change to send again');
    const webhookish = await post(url, '/api/collect/setup', { ws: 'fail-shop', token: PASS });
    assert.equal(webhookish.status, 503, 'any write that fails is an error, never a success');

    mod.testHooks.failWrites = false;
    const dump = await (await post(url, '/api/export', { ws: 'fail-shop', token: PASS })).json();
    assert.ok(!dump.records.some((x) => x.id === c.id), 'the server did not keep what it could not save');
    // once the disk works again, the device's retry lands, exactly once
    assert.equal((await sync.run()).error, undefined);
    assert.equal(store.getRecord('customers', c.id).dirty, undefined);
    const after = await (await post(url, '/api/export', { ws: 'fail-shop', token: PASS })).json();
    assert.equal(after.records.filter((x) => x.id === c.id).length, 1);
  } finally { await new Promise((r) => server.close(r)); delete process.env.SETUP_CODE; }
});

// ---- interrupted writes, failures at every step, a damaged file ----------------------------------------------------------
const workspaceFile = (dir) => fs.readdirSync(dir).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => path.join(dir, f))[0];
const tmpFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

for (const [point, survives] of [['after-temp', false], ['after-rename', true]]) {
  test(`a crash ${point === 'after-temp' ? 'after the temporary file is written, before the rename' : 'after the rename, before the answer'}: nothing acknowledged is lost, the retry lands once`, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `vina-crash-${point}-`));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const auth = { ws: 'crash-shop', token: PASS };
    // write 1 creates the workspace with c1; the process dies inside write 2 (c2)
    let child = await startProcess(dataDir, port, { VINA_CRASH_AT: `${point}:2` });
    try {
      assert.equal((await post(url, '/api/sync', { ...auth, create: true, setupCode: CODE, since: 0, records: [record('c1', 1)] })).status, 200);
      const before = fs.readFileSync(workspaceFile(dataDir), 'utf8');
      await assert.rejects(post(url, '/api/sync', { ...auth, since: 0, records: [record('c2', 2)] }), 'no answer: the process died mid-write');
      await new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.once('exit', r)));
      if (point === 'after-temp') {
        assert.equal(tmpFiles(dataDir).length, 1, 'the crash left its temporary file');
        assert.equal(fs.readFileSync(workspaceFile(dataDir), 'utf8'), before, 'the real file was never touched');
      }
      child = await startProcess(dataDir, port);
      assert.deepEqual(tmpFiles(dataDir), [], 'leftovers are removed at start');
      let ids = (await (await post(url, '/api/export', auth)).json()).records.map((r) => r.id);
      assert.ok(ids.includes('c1'), 'the acknowledged record is there');
      assert.equal(ids.includes('c2'), survives, survives ? 'renamed but unanswered: on disk' : 'never renamed: not there');
      // the device got no answer, so it sends c2 again: exactly one copy either way
      assert.equal((await post(url, '/api/sync', { ...auth, since: 0, records: [record('c2', 2)] })).status, 200);
      ids = (await (await post(url, '/api/export', auth)).json()).records.map((r) => r.id);
      assert.deepEqual(ids.filter((id) => id === 'c2'), ['c2']);
    } finally { await killHard(child).catch(() => {}); }
  });
}

test('a failure at any step of a write returns an error; before the rename the file is untouched; the retry lands once', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-steps-'));
  process.env.SETUP_CODE = CODE;
  const mod = await import(`../../server/server.js?steps=${Date.now()}`);
  const server = await mod.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${server.address().port}`;
  const auth = { ws: 'steps-shop', token: PASS };
  try {
    assert.equal((await post(url, '/api/sync', { ...auth, create: true, setupCode: CODE, since: 0, records: [record('c0', 0)] })).status, 200);
    const file = workspaceFile(process.env.DATA_DIR);
    let n = 0;
    for (const at of ['open', 'write', 'fsync', 'rename', 'dirsync']) {
      const id = `s${++n}`;
      const before = fs.readFileSync(file, 'utf8');
      mod.testHooks.failAt = at;
      const r = await post(url, '/api/sync', { ...auth, since: 0, records: [record(id, n)] });
      mod.testHooks.failAt = '';
      assert.equal(r.status, 503, `${at}: an error, never success`);
      assert.deepEqual(tmpFiles(process.env.DATA_DIR), [], `${at}: no temporary file left`);
      if (at !== 'dirsync') assert.equal(fs.readFileSync(file, 'utf8'), before, `${at}: the file is exactly as before`);
      // the device retries: one copy, whatever the failed attempt left on disk
      assert.equal((await post(url, '/api/sync', { ...auth, since: 0, records: [record(id, n)] })).status, 200, `${at}: retry`);
      const ids = (await (await post(url, '/api/export', auth)).json()).records.map((x) => x.id);
      assert.deepEqual(ids.filter((x) => x === id), [id], `${at}: exactly once`);
    }
  } finally { await new Promise((r) => server.close(r)); delete process.env.SETUP_CODE; }
});

test('a damaged workspace file is refused, never replaced: not by a sync, not by "create"', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-damaged-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const auth = { ws: 'damaged-shop', token: PASS };
  let child = await startProcess(dataDir, port);
  try {
    assert.equal((await post(url, '/api/sync', { ...auth, create: true, setupCode: CODE, since: 0, records: [record('c1', 1)] })).status, 200);
    await killHard(child);
    const file = workspaceFile(dataDir);
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));   // e.g. a disk fault: half a file
    const damaged = fs.readFileSync(file, 'utf8');
    child = await startProcess(dataDir, port);
    for (const body of [{ ...auth, since: 0, records: [record('c2', 2)] }, { ...auth, create: true, setupCode: CODE, since: 0, records: [] }]) {
      const r = await post(url, '/api/sync', body);
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /cannot be read[\s\S]*backup/);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'the damaged file is left exactly as it is, for recovery');
  } finally { await killHard(child).catch(() => {}); }
});
