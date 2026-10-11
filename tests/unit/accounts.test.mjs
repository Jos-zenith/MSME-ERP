// Sync accounts: who can create a workspace, how strong its passphrase must be, guessing limits, and changing the
// passphrase to cut off a lost phone. Uses the real sync server and real stores.
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
import { passphraseProblem, suggestPassphrase, workspaceKey } from '../../public/js/security.js';

const t = (s) => s;
const GOOD = 'mango-tree-417';

async function server(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-accounts-'))) {
  process.env.DATA_DIR = dir;
  const mod = await import(`../../server/server.js?accounts=${Date.now()}${Math.random()}`);
  const srv = await mod.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = async (route, body) => { const r = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  return { url, dir, code: mod.SETUP_CODE, mod, post, close: () => new Promise((r) => srv.close(r)) };
}
async function device(url, { fetchFn } = {}) {
  const store = new Store({ db: memoryDb() });
  await store.init();
  return { store, sync: new Sync(store, fetchFn ? { fetchFn } : {}) };
}
const workspaceFiles = (dir) => fs.readdirSync(dir).filter((f) => /^[0-9a-f]{32}\.json$/.test(f));

test('passphrase rules: length, variety, guessability; suggestions pass them', () => {
  assert.equal(passphraseProblem('abc12'), 'short');
  assert.equal(passphraseProblem('aaaabbbbaaaa'), 'simple');
  assert.equal(passphraseProblem('mypassword123'), 'guessable');
  assert.equal(passphraseProblem('sharmastore-77', 'Sharma Store'), 'guessable', 'the workspace name inside it');
  assert.equal(passphraseProblem(GOOD, 'sharma-store'), null);
  for (let i = 0; i < 50; i++) assert.equal(passphraseProblem(suggestPassphrase(), 'any-shop'), null);
  assert.equal(workspaceKey('  Sharma  Store '), 'sharma-store');
});

test('a workspace is created only on request, with the setup code and a strong passphrase; a typo when joining creates nothing', async () => {
  const s = await server();
  try {
    assert.match(s.code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/, 'a setup code is made on first start');
    assert.equal(fs.readFileSync(path.join(s.dir, 'setup-code.txt'), 'utf8').trim(), s.code, 'and kept in the data folder');
    // joining a name that does not exist: refused like a wrong passphrase, and no workspace appears
    const join = await s.post('/api/sync', { ws: 'sharma-stor', token: GOOD });
    assert.deepEqual([join.status, join.error], [403, 'Wrong workspace name or passphrase']);
    // creating needs the code
    assert.equal((await s.post('/api/sync', { ws: 'Sharma Store', token: GOOD, create: true })).status, 403);
    assert.match((await s.post('/api/sync', { ws: 'Sharma Store', token: GOOD, create: true, setupCode: 'aaaa-bbbb-cccc' })).error, /setup code/);
    // ... and a strong passphrase
    for (const [weak, code] of [['shop1234', 'weak_short'], ['aaaaaaaaaaaa', 'weak_simple'], ['password-2026', 'weak_guessable']]) {
      const r = await s.post('/api/sync', { ws: 'Sharma Store', token: weak, create: true, setupCode: s.code });
      assert.deepEqual([r.status, r.code], [400, code], weak);
    }
    assert.equal(workspaceFiles(s.dir).length, 0, 'nothing was created by any of that');
    // the code is typed loosely (case, spaces, no dashes) and works
    const ok = await s.post('/api/sync', { ws: 'Sharma Store', token: GOOD, create: true, setupCode: ` ${s.code.replace(/-/g, '').toUpperCase()} ` });
    assert.equal(ok.status, 200);
    assert.equal(ok.ws, 'sharma-store', 'names are kept without case or spaces');
    // other devices find it however they type the name, with the passphrase only
    assert.equal((await s.post('/api/sync', { ws: 'sharma-store', token: GOOD })).status, 200);
    assert.equal((await s.post('/api/sync', { ws: 'SHARMA STORE', token: GOOD })).status, 200);
    // create on a name that exists is just a normal sign-in (a device reconnecting with its shop)
    assert.equal((await s.post('/api/sync', { ws: 'sharma store', token: GOOD, create: true })).status, 200);
    assert.equal((await s.post('/api/sync', { ws: 'sharma store', token: 'mango-tree-418', create: true, setupCode: s.code })).status, 403, 'not a way to take over a name');
  } finally { await s.close(); }
});

test('the setup code survives a restart; SETUP_CODE sets it; ALLOW_NEW_WORKSPACES=false turns creation off', async () => {
  const s = await server();
  await s.close();
  const again = await server(s.dir);
  try { assert.equal(again.code, s.code); } finally { await again.close(); }
  process.env.SETUP_CODE = 'my-own-code-99';
  const own = await server();
  try {
    assert.equal(own.code, 'my-own-code-99');
    assert.equal((await own.post('/api/sync', { ws: 'own-shop', token: GOOD, create: true, setupCode: 'my-own-code-99' })).status, 200);
  } finally { delete process.env.SETUP_CODE; await own.close(); }
  process.env.ALLOW_NEW_WORKSPACES = 'false';
  const closed = await server();
  try {
    assert.equal(closed.code, '');
    const r = await closed.post('/api/sync', { ws: 'new-shop', token: GOOD, create: true, setupCode: 'anything' });
    assert.deepEqual([r.status, r.error], [403, 'New workspaces are disabled on this server']);
  } finally { delete process.env.ALLOW_NEW_WORKSPACES; await closed.close(); }
});

test('guessing is limited per address and per workspace across addresses; the shop\'s own devices are never locked out', async () => {
  const s = await server();
  try {
    assert.equal((await s.post('/api/sync', { ws: 'guard', token: GOOD, create: true, setupCode: s.code })).status, 200);
    const auth = s.mod._authenticate;
    // one address: 8 wrong tries a minute, then "too many", even with the right passphrase from that address...
    for (let i = 0; i < 8; i++) assert.equal(auth({ ws: 'guard', token: `wrong-guess-${i}` }, '10.0.0.1').status, 403);
    assert.equal(auth({ ws: 'guard', token: 'wrong-guess-x' }, '10.0.0.1').status, 429);
    // ...unless that passphrase was already accepted: known devices skip the limit (and the slow hash)
    assert.ok(auth({ ws: 'guard', token: GOOD }, '10.0.0.1').doc);
    // many addresses, a few guesses each: 30 in 15 minutes per workspace, then every new address waits too
    for (let i = 0; i < 22; i++) auth({ ws: 'guard', token: `spread-${i}` }, `10.1.0.${i}`);
    assert.equal(auth({ ws: 'guard', token: 'spread-x' }, '10.2.0.1').status, 429);
    assert.ok(auth({ ws: 'guard', token: GOOD }, '10.2.0.2').doc, 'the shop\'s devices still sync');
    // other workspaces are not affected
    assert.equal(auth({ ws: 'other', token: 'nope-nope-1' }, '10.2.0.1').status, 403);
  } finally { await s.close(); }
});

test('changing the passphrase: this device keeps syncing, the old phone is refused once and stops trying until the new one is typed', async () => {
  const s = await server();
  try {
    const A = await device(s.url);
    let calls = 0;
    const B = await device(s.url, { fetchFn: (...a) => { calls++; return fetch(...a); } });
    A.store.setApp(buildTemplate('retail', t, { businessName: 'Key Mart' }));
    A.sync.configure({ url: s.url, ws: 'key-mart', token: GOOD, create: true, setupCode: s.code });
    assert.equal((await A.sync.run()).error, undefined);
    assert.equal(A.store.meta.sync.setupCode, undefined, 'the setup code is not kept on the device');
    B.sync.configure({ url: s.url, ws: 'key-mart', token: GOOD, adopt: true });
    assert.equal((await B.sync.run()).error, undefined);
    B.sync.connectLive();
    for (let i = 0; i < 100 && !B.sync.live; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(B.sync.live, 'the old phone is on the live feed');

    await assert.rejects(A.sync.changePassphrase('short'), /at least 10/, 'a weak new passphrase is refused');
    await A.sync.changePassphrase('river-stone-882');
    assert.equal(A.store.meta.sync.token, 'river-stone-882');
    await A.store.saveRecord('customers', { name: 'After Change' });
    assert.equal((await A.sync.run()).error, undefined, 'this device keeps syncing');

    // the old phone loses the feed at once, is refused on its next try, and then stops trying by itself
    for (let i = 0; i < 100 && B.sync.live; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(B.sync.live, false, 'feed closed');
    const r = await B.sync.run();
    assert.match(r.error, /did not accept/);
    assert.equal(B.store.meta.sync.refused, true);
    const before = calls;
    await B.sync.run(); await B.sync.run(); B.sync.connectLive();
    assert.equal(calls, before, 'no more tries (each would count as a guess)');
    // typing the new passphrase brings it back
    B.sync.configure({ url: s.url, ws: 'key-mart', token: 'river-stone-882' });
    assert.equal((await B.sync.run()).error, undefined);
    assert.ok(B.store.records('customers').some((c) => c.data.name === 'After Change'));
    B.sync.stopLive();
  } finally { await s.close(); }
});

test('a workspace made before these rules keeps working with its short passphrase, and says it should be changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-accounts-old-'));
  // what an older server wrote: a mixed-case name and a 4-character passphrase
  const salt = crypto.randomBytes(16).toString('hex');
  const doc = { ws: 'Old Shop', auth: { salt, hash: crypto.scryptSync('1234', salt, 32).toString('hex') }, seq: 0, app: null, records: {} };
  fs.writeFileSync(path.join(dir, `${crypto.createHash('sha256').update('Old Shop').digest('hex').slice(0, 32)}.json`), JSON.stringify(doc));
  const s = await server(dir);
  try {
    const A = await device(s.url);
    A.store.setApp(buildTemplate('retail', t, { businessName: 'Old Shop' }));
    A.sync.configure({ url: s.url, ws: 'Old Shop', token: '1234' });
    assert.equal((await A.sync.run()).error, undefined, 'still works');
    assert.equal(A.store.meta.sync.weak, true, 'flagged as weak');
    await A.sync.changePassphrase('fresh-leaf-305');
    assert.equal(A.store.meta.sync.weak, undefined);
    assert.equal((await A.sync.run()).error, undefined);
    assert.equal((await s.post('/api/sync', { ws: 'Old Shop', token: '1234' })).status, 403, 'the old passphrase is gone');
  } finally { await s.close(); }
});
