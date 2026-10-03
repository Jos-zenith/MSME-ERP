// End-to-end tests: the real server + the real app in headless Chrome, driven with real keystrokes.
//   npm run test:e2e            (needs Chrome or Edge installed; set CHROME_PATH if it is elsewhere)
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, launch, onboard, goto, sleep } from './harness.mjs';

const shotsDir = process.env.SHOTS_DIR;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const only = process.argv[2];
const results = [];
let srv;

async function scenario(name, fn, opts = {}) {
  if (only && !name.includes(only)) return;
  const app = await launch({ url: srv.url, ...opts });
  const started = Date.now();
  try {
    await fn(app);
    const real = app.errors.filter((e) => !/favicon|net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e));
    assert.deepEqual(real, [], `browser errors: ${real.join(' | ')}`);
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
    if (shotsDir) await app.page.screenshot({ path: path.join(shotsDir, `FAIL-${name.replace(/\W+/g, '_')}.png`) }).catch(() => {});
  } finally { await app.close(); }
}

// ---- helpers --------------------------------------------------------------------------------------
const rowsOf = (page) => page.$$eval('[data-field=items] table.grid tbody tr', (trs) => trs.map((tr) => ({
  item: tr.querySelector('td[data-c=item] input')?.value || '',
  qty: tr.querySelector('td[data-c=qty] input')?.value || '',
  amount: tr.querySelector('td[data-c=amount] output')?.textContent || '',
})));
const active = (page) => page.evaluate(() => {
  const a = document.activeElement; const td = a?.closest('td[data-c]'); const tr = a?.closest('tr[data-r]');
  return { tag: a?.tagName, cls: a?.className, col: td?.dataset.c, row: tr ? +tr.dataset.r : null, inQuick: !!a?.closest('.quick'), inGrid: !!a?.closest('[data-field=items] table.grid'), aria: a?.getAttribute('aria-label') };
});
const press = async (page, key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods) await page.keyboard.up(m); };
const evalStore = (page, src) => page.evaluate((code) => new Function('store', 'sync', `return (async () => { ${code} })()`)(window.__app.store, window.__app.sync), src);
const text = (page) => page.evaluate(() => document.body.innerText);
const clickText = (page, sel, label) => page.evaluate((s, l) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(l)); if (!el) throw new Error(`no ${s} with text ${l}`); el.click(); }, sel, label);
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }); };

console.log('MSME Builder end-to-end tests');
srv = await startServer();

// ===================================================================================================
await scenario('boots, onboards, shows sample data with no console errors', async ({ page }) => {
  await onboard(page);
  await sleep(300);
  const t = await text(page);
  assert.match(t, /Test Mart/);
  assert.match(t, /Sales today/);
  assert.match(t, /Sales invoices/);
  await shot(page, 'home');
});

await scenario('#2 #3 #6 keyboard-only billing: code+Enter picks item, Enter adds next row, order top-to-bottom', async ({ page }) => {
  await onboard(page);
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('.quick input.cb-input');
  await sleep(200);
  assert.equal((await active(page)).inQuick, true, 'cursor starts in the quick-entry bar');

  // quick entry: type an item code, Enter (no mouse)
  await page.keyboard.type('sug1');
  assert.equal(await page.$eval('.cb-opt.active .cb-main', (e) => e.textContent), 'SUG1 · Sugar 1kg', 'best match is highlighted');
  await press(page, 'Enter');
  await page.keyboard.type('dal1*3'); await press(page, 'Enter');
  await page.keyboard.type('sug1*2'); await press(page, 'Enter');          // same item again -> quantity goes up, no duplicate row
  let rows = await rowsOf(page);
  assert.deepEqual(rows.map((r) => [r.item, r.qty]), [['SUG1 · Sugar 1kg', '3'], ['DAL1 · Toor Dal 1kg', '3']], 'entered order, top to bottom; repeat merges quantity');
  assert.equal((await active(page)).inQuick, true, 'focus stays in the quick bar for the next scan');

  // grid keyboard: item cell -> type exact code -> Enter selects -> cursor jumps to qty
  await page.focus('[data-field=items] table.grid tbody tr:last-child td[data-c=item] input');
  await press(page, 'Enter');                                               // nothing typed: Enter on an item cell just moves on
  let a = await active(page);
  assert.equal(a.col, 'qty');
  await press(page, 'Enter');                                               // Enter on last cell of last row -> NEW ROW appears
  rows = await rowsOf(page);
  assert.equal(rows.length, 3, 'Enter on the last cell adds the next row');
  a = await active(page);
  assert.deepEqual([a.row, a.col], [2, 'item'], 'cursor is in the new row, first cell');
  await page.keyboard.type('tea2');
  assert.match(await page.$eval('.cb-list .cb-opt.active .cb-main', (e) => e.textContent), /TEA2/);
  await press(page, 'Enter');                                               // <- the defect: Enter must pick the highlighted item
  a = await active(page);
  assert.deepEqual([a.row, a.col], [2, 'qty'], 'after picking with Enter the cursor moves to Qty');
  assert.match((await rowsOf(page))[2].item, /^TEA2/);
  await page.keyboard.type('2');
  await press(page, 'Enter');
  assert.equal((await rowsOf(page)).length, 4, 'row 4 opened by Enter');

  // shortcuts: Alt+N inserts a row, Alt+D deletes it
  await press(page, 'n', ['Alt']);
  assert.equal((await rowsOf(page)).length, 5, 'Alt+N adds a row');
  await press(page, 'd', ['Alt']);
  assert.equal((await rowsOf(page)).length, 4, 'Alt+D deletes the row');

  // Enter on an empty item cell leaves the grid instead of adding endless blank rows
  await press(page, 'Enter');
  a = await active(page);
  assert.equal(a.inGrid && a.col === 'item', false, 'Enter on an empty item cell exits the grid');
  assert.equal((await rowsOf(page)).length, 4);

  // Ctrl+S saves without the mouse
  await press(page, 's', ['Control']);
  await page.waitForFunction(() => /#\/t\/invoices\/[^/]+\?done=1/.test(location.hash), { timeout: 4000 });
  const saved = await evalStore(page, `const r = store.records('invoices').sort((a,b)=>a.created<b.created?1:-1)[0]; return r.data.items.map(x=>x.desc+'×'+x.qty);`);
  assert.deepEqual(saved, ['Sugar 1kg×3', 'Toor Dal 1kg×3', 'Tea Powder 250g×2'], 'saved order = entered order');
  await shot(page, 'invoice-saved');
});

await scenario('Tab also picks the highlighted item and lands on Qty', async ({ page }) => {
  await onboard(page);
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('[data-field=items] table.grid');
  await page.focus('[data-field=items] table.grid tbody tr:last-child td[data-c=item] input');
  await page.keyboard.type('mil1');
  await press(page, 'Tab');
  const a = await active(page);
  assert.equal(a.col, 'qty', 'Tab moved on to Qty');
  assert.match((await rowsOf(page))[0].item, /^MIL1/, 'Tab picked the highlighted item');
});

await scenario('Ctrl+Enter saves and opens the print / share page with the UPI QR', async ({ page }) => {
  await onboard(page);
  await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('.quick input.cb-input');
  await page.keyboard.type('oil1*2'); await press(page, 'Enter');
  await press(page, 'Enter', ['Control']);
  await page.waitForFunction(() => location.hash.includes('/print') && document.querySelector('.doc .qr svg'), { timeout: 5000 });
  await page.waitForFunction(() => window.__printed === true, { timeout: 3000 });   // fires shortly after the page renders
  assert.match(await page.$eval('.doc', (e) => e.textContent), /Oil|Sunflower/);
});

await scenario('#4 duplicate customer names are allowed; phone tells them apart; duplicate phone only warns', async ({ page }) => {
  await onboard(page);
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('[data-field=customer] input.cb-input');
  await page.click('[data-field=customer] input.cb-input');
  await page.keyboard.type('ravi');
  const opts = await page.$$eval('.cb-list .cb-opt:not(.cb-create) .cb-main', (els) => els.map((e) => e.textContent));
  assert.equal(opts.length, 2);
  assert.ok(opts.every((o) => o.startsWith('Ravi Kumar')) && new Set(opts).size === 2, `two same-name customers listed distinctly: ${opts}`);
  await press(page, 'ArrowDown'); await press(page, 'Enter');
  assert.equal(await page.$eval('[data-field=customer_phone] input', (e) => e.value), '98765 43210', 'phone auto-filled from the second Ravi in the list');

  // add a THIRD "Ravi Kumar" from the "+" button: allowed, no error
  await page.click('[data-field=customer] .with-btn button');
  await page.waitForSelector('.modal [data-field=name] input');
  await page.type('.modal [data-field=name] input', 'Ravi Kumar');
  await page.type('.modal [data-field=phone] input', '90000 55555');
  await clickText(page, '.modal .btn.primary', 'Save');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  const ravis = await evalStore(page, `return store.records('customers').filter(c => c.data.name === 'Ravi Kumar').length`);
  assert.equal(ravis, 3, 'third Ravi Kumar saved');

  // same PHONE as an existing customer: a confirmation, not a wall
  await page.click('[data-field=customer] .with-btn button');
  await page.waitForSelector('.modal [data-field=name] input');
  await page.type('.modal [data-field=name] input', 'Ravi Junior');
  await page.type('.modal [data-field=phone] input', '90000 55555');
  await clickText(page, '.modal .btn.primary', 'Save');
  await page.waitForFunction(() => [...document.querySelectorAll('.modal')].some((m) => /Save anyway/.test(m.textContent)));
  assert.match(await text(page), /Someone with the same details already exists/);
  await clickText(page, '.modal .btn.primary', 'Save anyway');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  assert.equal(await evalStore(page, `return store.records('customers').some(c => c.data.name === 'Ravi Junior')`), true);
});

await scenario('#1 message waits for you and reflects the real payment status (never a false "Balance due")', async ({ page }) => {
  await onboard(page);
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  // bill for a customer with a phone; NOT yet paid
  await evalStore(page, `
    const c = store.records('customers').find(x => x.data.phone === '98111 22233');
    const it = store.records('items').find(x => x.data.code === 'SUG1');
    const r = await store.saveRecord('invoices', { customer: c.id, items: [{ item: it.id, qty: 2 }] });
    window.__inv = r.record.id;`);
  const id = await page.evaluate(() => window.__inv);
  await goto(page, `#/t/invoices/${id}?done=1`);
  await page.waitForSelector('.next .msg textarea');
  assert.deepEqual(await page.evaluate(() => window.__opened), [], 'creating the bill sent nothing');
  let body = await page.$eval('.next .msg textarea', (e) => e.value);
  assert.match(body, /Balance due: ₹96\.00/);
  assert.match(body, /Pay by UPI: testmart@upi/);

  // customer hands over cash: tap "Cash received" on the bill
  await clickText(page, '.next .btn', 'Cash received');
  await page.waitForFunction(() => /Payment of/.test(document.querySelector('.next .msg textarea')?.value || ''), { timeout: 3000 });
  body = await page.$eval('.next .msg textarea', (e) => e.value);
  assert.doesNotMatch(body, /Balance due/);
  assert.match(body, /Payment of ₹96\.00 received for bill INV-/);
  assert.equal(await page.$$eval('.next .msg', (m) => m.length), 1, 'the receipt replaced the unsent bill message; no duplicate');
  assert.deepEqual(await page.evaluate(() => window.__opened), [], 'still nothing sent automatically');

  // only now does anything leave the device, on the owner's tap
  await clickText(page, '.next .msg .btn.primary', '💬');
  const opened = await page.evaluate(() => window.__opened);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^https:\/\/wa\.me\/919811122233\?text=/);
  assert.match(decodeURIComponent(opened[0]), /Payment of ₹96\.00 received/);
  await shot(page, 'record-next-steps');
});

await scenario('#5 unpaid invoice prints with a UPI QR straight away (no sale order first); paid shows PAID', async ({ page }) => {
  await onboard(page);
  await goto(page, '#/t/invoices');
  await page.waitForSelector('tr.row');
  const info = await evalStore(page, `
    const inv = store.records('invoices').filter(i => i.data.balance > 0);
    const paid = store.records('invoices').find(i => i.data.balance <= 0);
    return { unpaid: inv[0].id, bal: inv[0].data.balance, paid: paid.id };`);
  await goto(page, `#/t/invoices/${info.unpaid}/print`);
  await page.waitForSelector('.doc .qr svg');
  const cap = await page.$eval('.doc .qr-cap', (e) => e.textContent);
  assert.match(cap, /Scan to pay/);
  assert.ok(cap.includes(new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(info.bal)), `caption shows the balance ${info.bal}: ${cap}`);
  assert.match(cap, /testmart@upi/);
  // the QR really encodes a UPI payment link for that amount
  const link = await page.evaluate(async (bal) => {
    const { upiLink } = await import('/js/print.js');
    return upiLink({ vpa: 'testmart@upi', name: 'Test Mart', amount: bal, note: 'x' });
  }, info.bal);
  assert.match(link, /^upi:\/\/pay\?pa=testmart%40upi|^upi:\/\/pay\?pa=testmart@upi/);
  assert.match(link, new RegExp(`am=${info.bal.toFixed(2)}`));
  await shot(page, 'print-upi');
  await goto(page, `#/t/invoices/${info.paid}/print`);
  await page.waitForSelector('.doc');
  assert.equal(await page.$('.doc .qr svg'), null, 'no QR once fully paid');
  assert.match(await page.$eval('.doc', (e) => e.textContent), /PAID/);
});

await scenario('works offline: reload with no network, create a bill, it is still there after coming back online', async ({ page, context }) => {
  await onboard(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload({ waitUntil: 'networkidle0' });                         // now controlled by the service worker
  await sleep(500);
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'service worker is controlling the page');
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.topbar', { timeout: 8000 });
  assert.match(await text(page), /Offline: saved on this device/);
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('.quick input.cb-input');
  await page.keyboard.type('bis1*4'); await press(page, 'Enter');
  await press(page, 's', ['Control']);
  await page.waitForFunction(() => /done=1/.test(location.hash), { timeout: 4000 });
  await page.setOfflineMode(false);
  await page.reload({ waitUntil: 'networkidle0' });
  const n = await evalStore(page, `return store.count('invoices')`);
  assert.equal(n, 11, '10 sample bills + the one made offline survived the restart');
  assert.equal(await evalStore(page, `return store.dirtyRecords().length > 0`), true, 'and it is marked as waiting to sync');
});

await scenario('two devices stay in sync through the server (offline edits merge, last edit wins)', async () => {
  const a = await launch({ url: srv.url });
  const b = await launch({ url: srv.url });
  try {
    await onboard(a.page);
    await evalStore(a.page, `sync.configure({ url: location.origin, ws: 'sharma', token: 'secret-pass' }); const r = await sync.run(); if (r.error) throw new Error(r.error);`);
    // device B joins the existing workspace from its first-run screen
    await b.page.waitForSelector('.onboard-card .lang-grid');
    await clickText(b.page, '.onboard-card .link', 'I already use this');
    await b.page.waitForSelector('.onboard-card input');
    const ins = await b.page.$$('.onboard-card input');
    await ins[0].click({ clickCount: 3 }); await ins[0].type(srv.url);
    await ins[1].type('sharma'); await ins[2].type('secret-pass');
    await clickText(b.page, '.onboard-card .btn.primary', 'Join');
    await b.page.waitForSelector('.topbar', { timeout: 8000 });
    assert.equal(await evalStore(b.page, `return store.count('items')`), 10, 'B downloaded the shop');
    assert.equal(await evalStore(b.page, `return store.app.name`), await evalStore(a.page, `return store.app.name`));

    // A sells offline-style (just local), B edits a customer; both sync
    await evalStore(a.page, `const it = store.records('items')[0]; await store.saveRecord('invoices', { items: [{ item: it.id, qty: 1 }] }); await sync.run();`);
    await evalStore(b.page, `const c = store.records('customers')[0]; await store.patchRecord('customers', c.id, { city: 'Goa' }); await sync.run();`);
    await evalStore(a.page, `await sync.run();`);
    await evalStore(b.page, `await sync.run();`);
    assert.equal(await evalStore(b.page, `return store.count('invoices')`), 11, 'B sees the bill A made');
    assert.equal(await evalStore(a.page, `return store.records('customers').filter(c => c.data.city === 'Goa').length`), 1, 'A sees the edit B made');
    // a wrong passphrase is refused
    const bad = await evalStore(b.page, `sync.configure({ url: location.origin, ws: 'sharma', token: 'wrong-pass' }); return (await sync.run()).error`);
    assert.match(bad, /did not accept/);
  } finally { await a.close(); await b.close(); }
});

await scenario('owner PIN / staff PIN: staff cannot open builder, settings or delete', async ({ page }) => {
  await onboard(page);
  await evalStore(page, `const { setPin } = await import('/js/security.js'); await setPin(store, 'owner', '1234'); await setPin(store, 'staff', '5678'); await store.flush();`);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.lock input');
  await page.type('.lock input', '0000'); await press(page, 'Enter');
  await page.waitForFunction(() => /Wrong PIN/.test(document.body.innerText));
  await page.type('.lock input', '5678'); await press(page, 'Enter');
  await page.waitForSelector('.topbar');
  const nav = await page.$eval('.sidebar', (e) => e.innerText);
  assert.doesNotMatch(nav, /App builder|Settings/);
  await goto(page, '#/build');
  assert.match(await text(page), /Only the owner can open this/);
  const id = await evalStore(page, `return store.records('invoices')[0].id`);
  await goto(page, `#/t/invoices/${id}`);
  await page.waitForSelector('.record');
  assert.equal(await page.$('.record .btn.danger'), null, 'no Delete button for staff');
  await goto(page, '#/reports');
  assert.match(await text(page), /No reports yet/, 'owner-only dashboards are hidden from staff');
});

await scenario('app builder: add a field with drag-free click, it appears in the real form and saves', async ({ page }) => {
  await onboard(page, { sample: false, template: 'blank' });
  await goto(page, '#/build');
  await page.waitForSelector('.cards-grid');
  await page.evaluate(() => window.prompt = () => 'Orders');
  // create a table through the API-free UI: the "New table" tile uses a modal prompt
  await clickText(page, '.tile.add', '');
  await page.waitForSelector('.modal input');
  await page.type('.modal input', 'Orders'); await press(page, 'Enter');
  await page.waitForFunction(() => /#\/build\/t\/orders/.test(location.hash));
  await page.waitForSelector('.palette .pal');
  await clickText(page, '.palette .pal', 'Money');
  await page.waitForSelector('.panel .settings input');
  const label = await page.$('.panel .settings input');
  await label.click({ clickCount: 3 }); await page.keyboard.type('Order value');
  await sleep(500);
  await goto(page, '#/t/orders/new');
  await page.waitForSelector('[data-field=name] input');
  await page.type('[data-field=name] input', 'Big order');
  const lbls = await page.$$eval('.form-grid .fld > .lbl', (e) => e.map((x) => x.textContent.trim()));
  assert.ok(lbls.some((l) => l.startsWith('Order value')), `new field visible in the form: ${lbls}`);
  await page.type('[data-field=money] input', '2500');
  await press(page, 's', ['Control']);
  await page.waitForFunction(() => /done=1/.test(location.hash));
  assert.equal(await evalStore(page, `return store.records('orders')[0].data.money`), 2500);
});

await scenario('workflow builder: create a rule in the UI and it fires', async ({ page }) => {
  await onboard(page);
  await goto(page, '#/build/rules');
  await page.waitForSelector('.cards-grid.small .tile');
  await clickText(page, '.cards-grid.small .tile', 'Ask the owner to approve');
  await page.waitForSelector('.rule-editor');
  await sleep(400);
  const summary = await page.$eval('.summary', (e) => e.textContent);
  assert.match(summary, /When a record is added in “/);
  assert.match(summary, /Ask the owner to approve/);
  const n = await evalStore(page, `return store.app.rules.length`);
  assert.ok(n >= 9);
  await shot(page, 'rule-editor');
  // the built-in retail rules are readable sentences too
  await goto(page, '#/build/rules');
  assert.match(await text(page), /Send the bill to the customer on WhatsApp/);
});

await scenario('CSV import: Zoho-style items file maps automatically and upserts by item code', async ({ page }) => {
  await onboard(page);
  await goto(page, '#/t/items');
  await page.waitForSelector('.list-body');
  await clickText(page, '.page-actions button', 'Import');
  await page.waitForSelector('.modal textarea');
  const csv = 'Item Name,SKU,Rate,Purchase Rate,Opening Stock,Usage unit\r\n"Ghee, 1L",GHE1,620,540,8,litre\r\nSugar 1kg (updated),SUG1,52,42,40,kg\r\n';
  await page.evaluate((c) => { const ta = document.querySelector('.modal textarea'); ta.value = c; }, csv);
  await clickText(page, '.modal .btn.primary', 'Continue');
  await page.waitForSelector('.map-grid');
  const mapped = await page.$$eval('.map-row select', (s) => s.map((x) => x.selectedOptions[0].textContent));
  assert.deepEqual(mapped, ['Item name', 'Item code', 'Selling price', 'Buying price', 'Stock in hand', 'Unit']);
  await clickText(page, '.modal .btn.primary', 'Import');
  await page.waitForFunction(() => /Import finished/.test(document.body.innerText));
  assert.match(await text(page), /1 added, 1 updated/);
  assert.equal(await evalStore(page, `return store.records('items').find(i => i.data.code === 'GHE1').data.name`), 'Ghee, 1L');
  assert.equal(await evalStore(page, `return store.records('items').filter(i => i.data.code === 'SUG1').length`), 1, 'no duplicate item code');
  assert.equal(await evalStore(page, `return store.records('items').find(i => i.data.code === 'SUG1').data.price`), 52);
});

await scenario('Hindi UI: nav, dashboard, form and the customer message are in Hindi', async ({ page }) => {
  await page.waitForSelector('.onboard-card .lang-grid');
  await page.evaluate(() => [...document.querySelectorAll('.lang-grid button')].find((b) => b.textContent.trim() === 'हिन्दी').click());
  await page.waitForSelector('.onboard-card input');
  const ins = await page.$$('.onboard-card input');
  await ins[0].type('शर्मा स्टोर'); await ins[1].type('9876500001'); await ins[2].type('sharma@upi');
  await clickText(page, '.onboard-card button', 'आगे');
  await page.waitForSelector('.tpl-grid');
  await page.evaluate(() => document.querySelectorAll('.tpl-grid .tile')[0].click());
  await clickText(page, '.onboard-card .btn.primary', 'शुरू करें');
  await page.waitForSelector('.topbar');
  await sleep(300);
  const t = await text(page);
  assert.match(t, /आज की बिक्री/);
  assert.match(t, /बकाया भुगतान/);
  assert.match(t, /सामान और स्टॉक/);
  const msg = await evalStore(page, `
    const c = store.records('customers')[0]; const it = store.records('items')[0];
    const r = await store.saveRecord('invoices', { customer: c.id, items: [{ item: it.id, qty: 1 }] });
    const m = store.pendingFor('invoices', r.record.id)[0]; return store.renderOutbox(m).body;`);
  assert.match(msg, /नमस्ते/);
  assert.match(msg, /बकाया:/);
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('.quick input');
  assert.match(await page.$eval('.quick input', (e) => e.placeholder), /तेज़ एंट्री/);
  await shot(page, 'hindi-form');
}, { lang: 'hi' });

await scenario('phone layout: no sideways scrolling on the main screens (375px)', async ({ page }) => {
  await onboard(page);
  const wide = [];
  for (const h of ['#/', '#/t/invoices', '#/t/invoices/new', '#/reports', '#/outbox', '#/build', '#/settings']) {
    await goto(page, h); await sleep(250);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) wide.push(`${h} (+${over}px)`);
  }
  assert.deepEqual(wide, [], `horizontal overflow on: ${wide.join(', ')}`);
  // the hamburger opens the menu and choosing an item closes it
  await goto(page, '#/');
  await page.click('#nav-toggle');
  await page.waitForFunction(() => document.body.classList.contains('nav-open'));
  await sleep(400);   // slide-in animation
  const box = await page.$eval('.sidebar', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
  assert.ok(box.left >= -1 && box.right <= 375, 'menu is on screen');
  await clickText(page, '.sidebar .nav-item', 'Customers');
  await page.waitForFunction(() => location.hash.includes('/t/customers') && !document.body.classList.contains('nav-open'));
  await goto(page, '#/t/invoices/new'); await sleep(300);
  await shot(page, 'phone-invoice');
}, { viewport: { width: 375, height: 800 } });

// ===================================================================================================
await srv.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
