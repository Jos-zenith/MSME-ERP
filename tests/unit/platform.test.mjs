import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv, autoMap, parseDate, parseNumber, safeCell } from '../../public/js/csv.js';
import { extractKeys } from '../../scripts/extract-i18n.mjs';
import { listFiles } from '../../scripts/build-sw.mjs';
import { Store } from '../../public/js/store.js';
import { Sync } from '../../public/js/sync.js';
import { SYNC_PROTOCOL } from '../../public/js/protocol.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate } from '../../public/js/templates/index.js';
import { renderTemplate } from '../../public/js/logic.js';
import { encryptJson, decryptJson } from '../../public/js/security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---- CSV ------------------------------------------------------------------------------------
test('csv: quotes, commas, newlines, BOM, tabs (Excel paste) and semicolons', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n1,2'), [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  assert.deepEqual(parseCsv('Item\tRate\nTea\t10'), [['Item', 'Rate'], ['Tea', '10']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n"line1\nline2",x'), [['a', 'b'], ['line1\nline2', 'x']]);
  const round = [['n', 'v'], ['a,b', 'q"q'], ['x', 'multi\nline']];
  assert.deepEqual(parseCsv(toCsv(round)), round);
});

test('csv: formula injection is neutralised, numbers and phones are not mangled', () => {
  assert.equal(safeCell('=HYPERLINK("http://evil")'), `'=HYPERLINK("http://evil")`);
  assert.equal(safeCell('@SUM(A1)'), `'@SUM(A1)`);
  assert.equal(safeCell('+91 98765 43210'), '+91 98765 43210');
  assert.equal(safeCell('-12.5'), '-12.5');
  assert.equal(safeCell(-12.5), -12.5);
  assert.equal(safeCell('Sugar'), 'Sugar');
});

test('csv: Indian dates and money', () => {
  assert.equal(parseDate('12/03/2026'), '2026-03-12');
  assert.equal(parseDate('5-1-26'), '2026-01-05');
  assert.equal(parseDate('2026-03-12'), '2026-03-12');
  assert.equal(parseDate('nonsense'), '');
  assert.equal(parseNumber('₹1,23,456.50'), 123456.5);
  assert.equal(parseNumber('Rs. 40'), 40);
  assert.equal(parseNumber('abc'), null);
});

test('csv: Zoho Books / Vyapar / Tally style headers map to our fields', () => {
  const app = buildTemplate('retail', (s) => s, {});
  const fields = app.tables.find((t) => t.id === 'items').fields.filter((f) => !f.formula);
  assert.deepEqual(autoMap(['Item Name', 'SKU', 'Rate', 'Purchase Rate', 'Opening Stock', 'Usage unit', 'Tax Percentage', 'Junk'], fields),
    ['name', 'code', 'price', 'cost', 'stock', 'unit', 'tax', '']);
  const cust = app.tables.find((t) => t.id === 'customers').fields;
  assert.deepEqual(autoMap(['Display Name', 'MobilePhone', 'EmailID', 'Billing City'], cust), ['name', 'phone', 'email', 'city']);
});

// ---- translations --------------------------------------------------------------------------------
const placeholders = (s) => [...String(s).matchAll(/\{\{[^}]*\}\}|\{\w+\}/g)].map((m) => m[0]).sort();

for (const code of ['hi', 'ta', 'te']) {
  test(`i18n ${code}: no stale keys and every {placeholder} / {{variable}} survives translation`, async () => {
    const dict = (await import(`../../public/js/lang/${code}.js`)).default;
    const keys = new Set(extractKeys());
    const stale = Object.keys(dict).filter((k) => !keys.has(k));
    assert.deepEqual(stale, [], `translations for strings that no longer exist (typo in the English key?): ${stale.slice(0, 3).join(' | ')}`);
    for (const [k, v] of Object.entries(dict)) {
      assert.deepEqual(placeholders(v), placeholders(k), `placeholders differ in "${k}"`);
      assert.ok(String(v).trim().length > 0, `empty translation for "${k}"`);
    }
  });
}

test('i18n hi: every everyday-screen string is translated', async () => {
  const dict = (await import('../../public/js/lang/hi.js')).default;
  const missing = extractKeys({ everydayOnly: true }).filter((k) => !(k in dict));
  assert.deepEqual(missing, []);
});

test('translated customer messages still render (template syntax intact in every language)', async () => {
  const sample = { customer_phone: '9', number: 'INV-1', total: 100, paid: 40, balance: 60, date: '2026-09-19', items: [{ desc: 'Tea', qty: 2, amount: 100 }] };
  for (const lang of ['en', 'hi', 'ta', 'te']) {
    const dict = lang === 'en' ? {} : (await import(`../../public/js/lang/${lang}.js`)).default;
    const t = (k) => dict[k] ?? k;
    const store = new Store({ db: memoryDb() });
    await store.init();
    store.setApp(buildTemplate('retail', t, { businessName: 'X', upi: 'x@upi' }));
    const rule = store.app.rules.find((r) => r.id === 'r_share_invoice');
    const table = store.table('invoices');
    const body = renderTemplate(rule.actions[0].body, { table, data: sample, ctx: store.ctx() });
    assert.doesNotMatch(body, /\{\{|\}\}|#if|#each/, `${lang}: unrendered template syntax in\n${body}`);
    assert.match(body, /1\. Tea × 2/);
  }
});

// ---- offline shell -----------------------------------------------------------------------------------
test('service worker pre-caches every file the app needs (run `npm run build:sw` if this fails)', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  const listed = JSON.parse(/const PRECACHE = (\[[\s\S]*?\]);/.exec(sw)[1]);
  const actual = ['./', ...listFiles().map((f) => `./${f}`)];
  assert.deepEqual([...listed].sort(), [...actual].sort());
});

// ---- backup encryption ------------------------------------------------------------------------------------
test('encrypted backup round-trips and rejects a wrong passphrase', async () => {
  const data = { hello: 'शर्मा स्टोर', n: [1, 2, 3] };
  const box = await encryptJson(data, 'correct horse');
  assert.equal(box.format, 'vina-encrypted');
  assert.doesNotMatch(JSON.stringify(box), /शर्मा/);
  assert.deepEqual(await decryptJson(box, 'correct horse'), data);
  await assert.rejects(() => decryptJson(box, 'wrong'), /Wrong passphrase/);
});

// ---- sync server ------------------------------------------------------------------------------------------------
test('sync server: two devices converge, last edit wins, wrong passphrase refused, daily backup written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-sync-'));
  process.env.DATA_DIR = dir;
  const mod = await import(`../../server/server.js?sync=${Date.now()}`);
  const setupCode = mod.SETUP_CODE;
  const server = await mod.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let clock = 1000;
    const mk = async (name) => {
      const s = new Store({ db: memoryDb(), now: () => new Date(Date.UTC(2026, 8, 19, 10, 0, clock++)).toISOString() });
      await s.init();
      return { s, sync: new Sync(s) };
    };
    const A = await mk('A'), B = await mk('B');
    A.s.setApp(buildTemplate('retail', (x) => x, { businessName: 'Sync Mart' }));
    const c = (await A.s.saveRecord('customers', { name: 'Asha', phone: '9000000001' })).record;
    A.sync.configure({ url, ws: 'shop', token: 'counter-key-42', create: true, setupCode });
    assert.equal((await A.sync.run()).error, undefined);

    B.sync.configure({ url, ws: 'shop', token: 'counter-key-42', adopt: true });
    assert.equal((await B.sync.run()).error, undefined);
    assert.equal(B.s.app.name, 'Sync Mart');
    assert.equal(B.s.getRecord('customers', c.id).data.name, 'Asha');

    // both edit the same record; B edits later -> B wins everywhere
    await A.s.patchRecord('customers', c.id, { city: 'Pune' });
    await B.s.patchRecord('customers', c.id, { city: 'Mumbai' });
    await A.sync.run(); await B.sync.run(); await A.sync.run();
    assert.equal(A.s.getRecord('customers', c.id).data.city, 'Mumbai');
    assert.equal(B.s.getRecord('customers', c.id).data.city, 'Mumbai');
    assert.equal(A.s.dirtyRecords().length, 0, 'nothing left waiting to sync');

    // a deletion travels too
    await A.s.deleteRecord('customers', c.id);
    await A.sync.run(); await B.sync.run();
    assert.equal(B.s.getRecord('customers', c.id), null);

    // wrong passphrase refused
    B.sync.configure({ url, ws: 'shop', token: 'nope-nope' });
    assert.match((await B.sync.run()).error, /did not accept/);

    // the server kept an off-device copy
    await new Promise((r) => setTimeout(r, 700));
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    assert.equal(backups.length, 1);
  } finally { await new Promise((r) => server.close(r)); }
});

test('live sync: a change saved on one device reaches the other in about a second, without polling', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-live-'));
  process.env.DATA_DIR = dir;
  const mod = await import(`../../server/server.js?live=${Date.now()}`);
  const setupCode = mod.SETUP_CODE;
  const server = await mod.start(0, '127.0.0.1');
  const url = `http://127.0.0.1:${server.address().port}`;
  const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
  let clock = 1000;
  const mk = async () => {
    const s = new Store({ db: memoryDb(), now: () => new Date(Date.UTC(2026, 8, 19, 10, 0, clock++)).toISOString() });
    await s.init();
    return { s, sync: new Sync(s, { pushDelay: 50 }) };
  };
  const A = await mk(), B = await mk();
  try {
    A.s.setApp(buildTemplate('retail', (x) => x, { businessName: 'Live Mart' }));
    A.sync.configure({ url, ws: 'live', token: 'counter-key-42', create: true, setupCode });
    await A.sync.run();
    B.sync.configure({ url, ws: 'live', token: 'counter-key-42', adopt: true });
    await B.sync.run();

    // B listens on the live feed only: no interval, no manual run()
    B.sync.connectLive();
    assert.ok(await waitFor(() => B.sync.live), 'live feed connected');

    const t0 = Date.now();
    const c = (await A.s.saveRecord('customers', { name: 'Live Lata', phone: '9000000077' })).record;
    await A.sync.run();
    assert.ok(await waitFor(() => B.s.getRecord('customers', c.id)), 'record arrived on B through the live feed');
    assert.ok(Date.now() - t0 < 2000, `arrived in ${Date.now() - t0} ms`);

    // a wrong passphrase never gets a feed
    const bad = await fetch(`${url}/api/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ws: 'live', token: 'wrong-pass', protocol: SYNC_PROTOCOL }) });
    assert.equal(bad.status, 403);
  } finally {
    B.sync.stopLive();
    await new Promise((r) => server.close(r));
  }
});

test('sync server: rejects path traversal and oversized garbage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-sync2-'));
  process.env.DATA_DIR = dir;
  const mod = await import(`../../server/server.js?sec=${Date.now()}`);
  const server = await mod.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const trav = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.ok([403, 404].includes(trav.status), `traversal answered ${trav.status}`);
    const bad = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(bad.status, 400);
    const noAuth = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: SYNC_PROTOCOL }) });
    assert.equal(noAuth.status, 400);
    const headers = (await fetch(base)).headers;
    assert.match(headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
  } finally { await new Promise((r) => server.close(r)); }
});

// ---- webhook action ------------------------------------------------------------------------------------------------
test('webhook action: POSTs the record when online, keeps it queued when offline', async () => {
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('retail', (x) => x, { businessName: 'Hook Mart' }));
  store.app.rules.push({ id: 'w1', name: 'Tell Zoho Flow', enabled: true, table: 'customers', trigger: 'created', match: 'all', conditions: [], actions: [{ type: 'webhook', url: 'https://flow.example.com/hook/abc' }] });
  const { record } = await store.saveRecord('customers', { name: 'Hook Customer', phone: '9000000009' });
  assert.equal(store.listOutbox((o) => o.channel === 'webhook' && o.status === 'pending').length, 1);

  const offline = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await store.flushWebhooks(offline), 0);
  assert.equal(store.listOutbox((o) => o.channel === 'webhook' && o.status === 'pending').length, 1, 'still queued while offline');

  const calls = [];
  assert.equal(await store.flushWebhooks(async (url, init) => { calls.push({ url, init }); return {}; }), 1);
  assert.equal(calls[0].url, 'https://flow.example.com/hook/abc');
  assert.equal(calls[0].init.method, 'POST');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.table, 'customers');
  assert.equal(payload.id, record.id);
  assert.equal(payload.record.name, 'Hook Customer');
  assert.equal(store.listOutbox((o) => o.channel === 'webhook' && o.status === 'pending').length, 0);
});
