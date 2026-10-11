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

console.log('Vina end-to-end tests');
srv = await startServer();

// ===================================================================================================
await scenario('boots, onboards, shows sample data with no console errors', async ({ page }) => {
  await onboard(page);
  await sleep(300);
  const t = await text(page);
  assert.match(t, /Test Mart/);
  assert.match(t, /Collected today/);
  assert.match(t, /Billed today/);
  assert.match(t, /Sales invoices/);
  await shot(page, 'home');
});

await scenario('counter: N on the home screen, scan, Enter, Enter saves a walk-in bill paid in cash; tips stay one line', async ({ page }) => {
  await onboard(page);
  await page.waitForSelector('.home .big-btn.primary kbd');
  const tipH = await page.$eval('.banner.tip', (e) => e.getBoundingClientRect().height);
  assert.ok(tipH < 50, `tips strip is one slim line (${tipH}px)`);
  const kpi = await page.$eval('.home .kpi', (e) => e.innerText);
  assert.match(kpi, /Collected today[\s\S]*Cash ₹/, 'collected today, split by mode');

  await goto(page, '#/t/invoices/new');                                     // the full form (N opens the counter, tested below)
  await page.waitForFunction(() => document.activeElement?.closest('.quick'), { timeout: 4000 });
  assert.match(await page.$eval('[data-field=customer] input', (e) => e.placeholder), /Walk-in customer/);
  assert.equal(await page.$eval('.walkin-note', (e) => e.hidden), true, 'nothing to say on an empty bill');
  await page.keyboard.type('sug1'); await press(page, 'Enter');
  await page.keyboard.type('bis1*4'); await press(page, 'Enter');
  assert.match(await page.$eval('.walkin-note', (e) => (e.hidden ? '' : e.textContent)), /saves as paid ₹92\.80 in Cash/, '48 + 4 × 10 + 12% GST');
  await press(page, 'Enter');                                               // empty scan bar -> Save
  assert.equal(await page.evaluate(() => document.activeElement.textContent.startsWith('Save')), true, 'Enter on the empty scan bar lands on Save');
  await press(page, 'Enter');
  await page.waitForFunction(() => /#\/t\/invoices\/[^/]+\?done=1/.test(location.hash), { timeout: 4000 });
  const d = await evalStore(page, `const r = store.records('invoices').sort((a,b)=>a.created<b.created?1:-1)[0]; return { c: r.data.customer, st: r.data.status, bal: r.data.balance, p: r.data.payments.map(x => x.mode + ' ' + x.amount) };`);
  assert.deepEqual(d, { c: '', st: 'Paid', bal: 0, p: ['Cash 92.8'] }, 'walk-in bill saved as a cash sale');

  // a named customer is never auto-paid: credit stays credit
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('.quick input.cb-input');
  await page.keyboard.type('sal1'); await press(page, 'Enter');
  await page.focus('[data-field=customer] input'); await page.keyboard.type('Sunita'); await press(page, 'Enter');
  assert.equal(await page.$eval('.walkin-note', (e) => e.hidden), true);
  await press(page, 's', ['Control']);
  await page.waitForFunction(() => /\?done=1/.test(location.hash), { timeout: 4000 });
  const c = await evalStore(page, `const r = store.records('invoices').sort((a,b)=>a.created<b.created?1:-1)[0]; return [r.data.status, r.data.payments.length];`);
  assert.deepEqual(c, ['Unpaid', 0]);
});

await scenario('billing counter: N opens it, scan, F1 + cash given shows change, Enter saves and prints in place, clean for the next bill', async ({ page }) => {
  await onboard(page);
  await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  assert.equal(await page.$eval('html', (e) => e.dataset.theme), 'light', 'light by default: counters are brightly lit');
  await press(page, 'n');
  await page.waitForFunction(() => location.hash === '#/pos' && document.activeElement?.closest('.pos .quick'), { timeout: 4000 });
  await page.keyboard.type('sug1*2'); await press(page, 'Enter');
  await page.keyboard.type('bis1'); await press(page, 'Enter');
  assert.equal(await page.$eval('.pos-total-v', (e) => e.textContent), '₹107.20', '2 × 48 + 10 + 12% GST');
  await press(page, 'F1'); await page.keyboard.type('200');
  assert.match(await page.$eval('.pos-change', (e) => e.textContent), /Change to return₹92\.80/);
  await press(page, 'Enter');                                               // Enter in "Cash received" saves
  await page.waitForFunction(() => window.__printed === 1 && document.querySelector('.pos-last:not([hidden])'), { timeout: 4000 });
  assert.equal(await page.evaluate(() => location.hash), '#/pos', 'no page change: still at the counter');
  assert.match(await page.$eval('.pos-last', (e) => e.textContent), /Saved INV-0011[\s\S]*Change to return: ₹92\.80/);
  assert.equal((await rowsOf(page)).filter((r) => r.item).length, 0, 'clean for the next customer');
  assert.deepEqual(await evalStore(page, `const r = store.records('invoices').find((x) => x.data.number === 'INV-0011'); return [r.data.status, r.data.payments.map((p) => p.mode + ' ' + p.amount)];`),
    ['Paid', ['Cash 107.2']]);

  // next customer: UPI shows the QR to scan; credit needs a customer to collect from
  await page.keyboard.type('oil1'); await press(page, 'Enter');
  await press(page, 'F2');
  await page.waitForSelector('.pos-qr:not([hidden]) .qr svg');
  await press(page, 'F9');
  assert.match(await text(page), /Pick a customer first/);
  await press(page, 'F8'); await page.keyboard.type('Sunita'); await press(page, 'Enter');
  await press(page, 'F9');
  await page.click('.pos-print input[type=checkbox]');                      // no receipt this time
  await page.focus('.pos .quick input'); await press(page, 'Enter');        // Enter on the empty scan bar saves
  await page.waitForFunction(() => document.querySelector('.pos-last')?.textContent.includes('INV-0012'), { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__printed), 1, 'printing was switched off');
  assert.deepEqual(await evalStore(page, `const r = store.records('invoices').find((x) => x.data.number === 'INV-0012'); return [r.data.status, r.data.payments.length, !!r.data.customer];`),
    ['Unpaid', 0, true], 'on credit, on Sunita\'s account');
  await shot(page, 'counter');
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
  await page.focus('[data-field=customer] input'); await page.keyboard.type('Sunita'); await press(page, 'Enter');   // credit bill: walk-ins are paid at the counter
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
  assert.match(opts[0], /98765 43210/, 'the Ravi with more bills is offered first');
  await press(page, 'ArrowDown'); await press(page, 'Enter');
  assert.equal(await page.$eval('[data-field=customer_phone] input', (e) => e.value), opts[1].split(' · ')[1], 'phone auto-filled from the Ravi that was picked');

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
  await clickText(page, '.next .msg .btn.primary', 'Send on');
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
  await evalStore(page, 'await store.flush()');                             // the save is on disk before we pull the plug
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
    await evalStore(a.page, `sync.configure({ url: location.origin, ws: 'sharma', token: 'secret-pass', create: true, setupCode: '${srv.setupCode}' }); const r = await sync.run(); if (r.error) throw new Error(r.error);`);
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
    // A is on the live feed, so its own sync may already be under way: wait for it rather than racing it
    await a.page.waitForFunction(() => window.__app.store.records('customers').filter((c) => c.data.city === 'Goa').length === 1, { timeout: 5000 });
    // a wrong passphrase is refused
    const bad = await evalStore(b.page, `sync.configure({ url: location.origin, ws: 'sharma', token: 'wrong-pass' }); return (await sync.run()).error`);
    assert.match(bad, /did not accept/);
  } finally { await a.close(); await b.close(); }
});

await scenario('real time: a bill saved on the counter appears on the owner\'s open screen within 2 s, no reload', async () => {
  const a = await launch({ url: srv.url });
  const b = await launch({ url: srv.url, viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
  try {
    await onboard(a.page);
    await evalStore(a.page, `sync.configure({ url: location.origin, ws: 'live-shop', token: 'secret-pass', create: true, setupCode: '${srv.setupCode}' }); const r = await sync.run(); if (r.error) throw new Error(r.error);`);
    await b.page.waitForSelector('.onboard-card .lang-grid');
    await clickText(b.page, '.onboard-card .link', 'I already use this');
    await b.page.waitForSelector('.onboard-card input');
    const ins = await b.page.$$('.onboard-card input');
    await ins[0].click({ clickCount: 3 }); await ins[0].type(srv.url);
    await ins[1].type('live-shop'); await ins[2].type('secret-pass');
    await clickText(b.page, '.onboard-card .btn.primary', 'Join');
    await b.page.waitForSelector('.topbar', { timeout: 8000 });

    // both show the live indicator
    for (const p of [a.page, b.page]) await p.waitForFunction(() => document.querySelector('.net')?.dataset.tone === 'live', { timeout: 5000 });

    // owner's phone sits on the invoice list; the counter saves a bill through the real form
    await goto(b.page, '#/t/invoices');
    const before = await b.page.$$eval('table.data tbody tr', (r) => r.length);
    await goto(a.page, '#/t/invoices/new');
    await a.page.waitForSelector('.quick input.cb-input');
    await a.page.type('.quick input.cb-input', 'SUG1*4'); await press(a.page, 'Enter');
    const t0 = Date.now();
    await press(a.page, 's', ['Control']);
    await b.page.waitForFunction((n) => document.querySelectorAll('table.data tbody tr').length === n + 1, { timeout: 2000 }, before);
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `arrived in ${ms} ms`);
    assert.equal(await evalStore(b.page, `return store.records('invoices').some((r) => r.data.items?.some((l) => l.qty === 4))`), true, 'the new bill (4 × sugar) is on the owner\'s phone');
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
  await onboard(page, { lang: 'हिन्दी', name: 'शर्मा स्टोर', phone: '9876500001', upi: 'sharma@upi' });
  await sleep(300);
  const t = await text(page);
  assert.match(t, /आज की वसूली/);
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
  await evalStore(page, `store.settings.collect = { enabled: true, sandbox: true, since: '2026-01-01' }; store.touchApp();`);
  for (const h of ['#/', '#/t/invoices', '#/t/invoices/new', '#/reports', '#/outbox', '#/outbox/payments', '#/credit', '#/build', '#/settings', '#/pos']) {
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

await scenario('type it once: regulars offered on focus, "name phone" creates a customer, a known phone picks the customer', async ({ page }) => {
  await onboard(page);
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('[data-field=customer] input.cb-input');
  // focus with nothing typed: the regulars are listed, nothing is highlighted (so Enter would still just move on)
  await page.click('[data-field=customer] input.cb-input');
  await page.waitForSelector('.cb-list .cb-head');
  assert.match(await page.$eval('.cb-list .cb-head', (e) => e.textContent), /Used most/);
  assert.equal(await page.$$eval('.cb-list .cb-opt.active', (x) => x.length), 0, 'nothing pre-selected');
  // a brand-new customer in one go: name and phone in the same box, Enter
  await page.keyboard.type('Kavita Rao 99001 22334');
  assert.match(await page.$eval('.cb-list .cb-create', (e) => e.textContent), /Kavita Rao/);
  await press(page, 'Enter');
  await page.waitForFunction(() => document.querySelector('[data-field=customer_phone] input')?.value === '99001 22334');
  assert.equal(await page.$$eval('.modal', (m) => m.length), 0, 'no popup form needed');
  assert.equal(await evalStore(page, `return store.records('customers').filter(c => c.data.name === 'Kavita Rao' && c.data.phone === '99001 22334').length`), 1);
  assert.match(await text(page), /Added Kavita Rao/);

  // a fresh bill: type a saved phone number (without its space) and the customer is recognised
  await goto(page, '#/');
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('[data-field=customer_phone] input');
  await page.type('[data-field=customer_phone] input', '9811122233');
  await page.waitForFunction(() => /Ravi Kumar · 98111 22233/.test(document.querySelector('[data-field=customer] input')?.value || ''));
  // ... and that customer's usual items are one tap away
  await page.waitForSelector('.usual:not([hidden]) .usual-chip');
  assert.match(await page.$eval('.usual-lbl', (e) => e.textContent), /Ravi Kumar usually buys/);
  await page.click('.usual .repeat-chip');
  const rows = (await rowsOf(page)).filter((r) => r.item);
  assert.deepEqual(rows.map((r) => r.item.split(' · ')[0]), ['MIL1', 'SOA1'], 'last bill repeated in its order');
  assert.deepEqual(rows.map((r) => r.qty), ['4', '3']);
  await shot(page, 'type-it-once');
});

await scenario('repeat a saved bill; item codes are made from the name', async ({ page }) => {
  await onboard(page);
  const id = await evalStore(page, `return store.records('invoices').find(r => r.data.customer && r.data.items.length === 2).id`);
  await goto(page, `#/t/invoices/${id}`);
  await clickText(page, '.page-actions a', 'Repeat');
  await page.waitForFunction(() => location.hash.includes('/new?from='));
  await page.waitForSelector('[data-field=items] table.grid');
  assert.match(await text(page), /Copy of INV-/);
  assert.equal((await rowsOf(page)).filter((r) => r.item).length, 2, 'same items');
  assert.notEqual(await page.$eval('[data-field=customer] input', (e) => e.value), '', 'same customer');
  await press(page, 's', ['Control']);
  await page.waitForFunction(() => /\?done=1/.test(location.hash));

  await goto(page, '#/t/items/new');
  await page.waitForSelector('[data-field=name] input');
  await page.type('[data-field=name] input', 'Coconut Oil 500ml');
  assert.equal(await page.$eval('[data-field=code] input', (e) => e.placeholder), 'COC500', 'code previewed from the name');
  await page.type('[data-field=price] input', '95');
  await press(page, 's', ['Control']);
  await page.waitForFunction(() => /\?done=1/.test(location.hash));
  assert.equal(await evalStore(page, `return store.records('items').find(i => i.data.name === 'Coconut Oil 500ml').data.code`), 'COC500');
});

await scenario('GST: onboarding reads the state from the GSTIN; bill splits tax live; returns screen and tax invoice print', async ({ page }) => {
  await onboard(page, { template: 'gst', gstin: '27AAPFU0939F1ZV' });
  await sleep(300);
  assert.match(await text(page), /GST this month/, 'GST card on the home screen');
  assert.equal(await evalStore(page, `return store.business.state`), '27 - Maharashtra');

  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('.quick input.cb-input');
  await page.keyboard.type('ste1*2'); await press(page, 'Enter');
  await page.waitForFunction(() => /CGST \+ SGST/.test(document.querySelector('[data-field=tax_note]')?.textContent || ''));
  assert.equal(await page.$eval('[data-field=igst]', (e) => e.hidden), true, 'no IGST line on an in-state bill');
  // pick the Delhi customer: place of supply and the split change by themselves
  await page.click('[data-field=customer] input.cb-input');
  await page.keyboard.type('capital'); await press(page, 'Enter');
  await page.waitForFunction(() => /IGST/.test(document.querySelector('[data-field=tax_note]')?.textContent || ''));
  assert.equal(await page.$eval('[data-field=bill_gstin] input', (e) => e.value), '07AAGFF2194N1Z1');
  assert.equal(await page.$eval('[data-field=cgst]', (e) => e.hidden), true, 'CGST hidden on an inter-state bill');
  await page.evaluate(() => { window.print = () => {}; });
  await press(page, 'Enter', ['Control']);
  await page.waitForFunction(() => location.hash.includes('/print') && document.querySelector('.doc-gst'));
  const doc = await page.$eval('.doc', (e) => e.textContent);
  assert.match(doc, /TAX INVOICE/);
  assert.match(doc, /Place of supply: 07 - Delhi/);
  assert.match(doc, /GSTIN: 07AAGFF2194N1Z1/);
  assert.match(doc, /Rupees .* Only/, 'amount in words');
  assert.match(doc, /IGST/);
  await shot(page, 'gst-print');

  await goto(page, '#/gst/gstr1');
  await page.waitForSelector('.gst-page .kpi');
  const t2 = await text(page);
  assert.match(t2, /GSTR-1 JSON/);
  await clickText(page, '.tab', 'GSTR-3B');
  await page.waitForFunction(() => /Input tax credit/.test(document.body.innerText));
  await shot(page, 'gst-returns');
});

await scenario('counter: hand over to staff; staff bill but cannot see purchases or change item prices', async ({ page }) => {
  await onboard(page);
  // without PINs, "Hand over" explains what to set up instead of doing nothing
  await clickText(page, '.sidebar button', 'Hand over to staff');
  await page.waitForFunction(() => location.hash === '#/settings');
  await evalStore(page, `const { setPin } = await import('/js/security.js'); await setPin(store, 'owner', '1234'); await setPin(store, 'staff', '5678'); await store.flush();`);
  await goto(page, '#/');
  await clickText(page, '.sidebar button', 'Hand over to staff');
  await page.waitForSelector('.lock input');
  await page.type('.lock input', '5678'); await press(page, 'Enter');
  await page.waitForSelector('.topbar');
  const nav = await page.$eval('.sidebar', (e) => e.innerText);
  assert.doesNotMatch(nav, /Purchases/, 'purchases (cost prices) hidden from staff');
  assert.match(nav, /Sales invoices/);
  await goto(page, '#/t/purchases');
  assert.match(await text(page), /Only the owner can open this/);
  await goto(page, '#/t/items');
  await page.waitForSelector('.list');
  assert.match(await text(page), /View only/);
  assert.equal(await page.$('.list .page-actions a.btn.primary'), null, 'no New item for staff');
  const item = await evalStore(page, `return store.records('items')[0].id`);
  await goto(page, `#/t/items/${item}/edit`);
  assert.match(await text(page), /Only the owner can open this/, 'staff cannot change prices');
  // billing still works, and an unknown code does not offer to create an item
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('.quick input.cb-input');
  await page.focus('.quick input.cb-input');
  await page.keyboard.type('zz99');
  await sleep(100);
  assert.equal(await page.$('.cb-list .cb-create'), null);
});

await scenario('unknown code at the counter: owner adds the item with the code already filled, and it lands on the bill', async ({ page }) => {
  await onboard(page);
  await goto(page, '#/t/invoices/new');
  await page.waitForSelector('.quick input.cb-input');
  await page.focus('.quick input.cb-input');
  await page.keyboard.type('8901234567890');
  await page.waitForSelector('.cb-list .cb-create');
  await press(page, 'Enter');
  await page.waitForSelector('.modal [data-field=barcode] input');
  assert.equal(await page.$eval('.modal [data-field=barcode] input', (e) => e.value), '8901234567890', 'scanned barcode carried over');
  await page.type('.modal [data-field=name] input', 'Ghee 500ml');
  await page.type('.modal [data-field=price] input', '330');
  await clickText(page, '.modal .btn.primary', 'Save');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  const rows = (await rowsOf(page)).filter((r) => r.item);
  assert.match(rows[0].item, /GHE500 · Ghee 500ml/, 'new item (with a code made from its name) is on the bill');
});

await scenario('one-tap WhatsApp payment reminder next to unpaid bills', async ({ page }) => {
  await onboard(page);
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await evalStore(page, `
    const c = store.records('customers').find(x => x.data.phone === '98111 22233');
    const it = store.records('items').find(x => x.data.code === 'SUG1');
    await store.saveRecord('invoices', { customer: c.id, items: [{ item: it.id, qty: 2 }] });`);
  await goto(page, '#/t/invoices');
  await page.waitForSelector('.list td.act .btn.remind');
  const n = await page.$$eval('.list td.act .btn.remind', (b) => b.length);
  const unpaidWithPhone = await evalStore(page, `return store.records('invoices').filter(r => r.data.balance > 0 && r.data.customer_phone).length`);
  assert.equal(n, unpaidWithPhone, 'a Remind button on every unpaid bill that has a phone, none on paid ones');
  await page.click('.list td.act .btn.remind');
  const url = decodeURIComponent((await page.evaluate(() => window.__opened))[0]);
  assert.match(url, /^https:\/\/wa\.me\/91\d{10}\?text=/);
  assert.match(url, /a gentle reminder: ₹[\d,.]+ is pending for bill INV-/);
  assert.match(url, /Pay by UPI: testmart@upi/);
  await page.waitForFunction(() => /today/.test(document.querySelector('.list td.act .remind-ago')?.textContent || ''));
});

// ---- Smart Collect & credit passport ---------------------------------------------------------------------------------
const collectOnFor = (page, ws) => evalStore(page, `
  sync.configure({ url: location.origin, ws: '${ws}', token: 'secret-pass', create: true, setupCode: '${srv.setupCode}' });
  const r = await sync.run(); if (r.error) throw new Error(r.error);
  store.settings.collect = { enabled: true, sandbox: true, since: new Date().toISOString().slice(0, 10) };
  store.touchApp();`);

await scenario('Smart Collect: counter QR, the bank confirms on the server, "received" shows at the counter, Enter saves it paid with the UTR', async ({ page }) => {
  await onboard(page);
  await collectOnFor(page, 'collect-counter');
  await page.waitForFunction(() => window.__app.sync.live, { timeout: 6000 });
  await press(page, 'n');
  await page.waitForFunction(() => location.hash === '#/pos' && document.activeElement?.closest('.pos .quick'), { timeout: 4000 });
  await page.click('.pos-print input[type=checkbox]');                      // no receipt printing in this test
  await page.focus('.pos .quick input');
  await page.keyboard.type('oil1'); await press(page, 'Enter');
  await press(page, 'F2');
  await page.waitForSelector('.pos-upi[data-tone=wait]');
  assert.match(await page.$eval('.pos-qr', (e) => e.textContent), /Waiting for the payment/);
  // the QR carries this bill's own reference
  const ref = await page.evaluate(async () => { const { refFor } = await import('./js/collect.js'); return refFor(JSON.parse(sessionStorage.getItem('pos-draft-invoices')).rid); });
  assert.match(ref, /^MB[0-9A-Z]{10}$/);
  await shot(page, 'collect-counter-waiting');
  await page.click('.pos-upi .link');                                        // sandbox: the "bank" pays through the server
  await page.waitForSelector('.pos-upi[data-tone=good]', { timeout: 6000 });
  assert.match(await page.$eval('.pos-upi', (e) => e.textContent), /received · confirmed by the bank[\s\S]*UTR SIM\d+/);
  await shot(page, 'collect-counter-received');
  await page.focus('.pos .quick input'); await press(page, 'Enter');        // Enter on the empty scan bar saves
  await page.waitForFunction(() => document.querySelector('.pos-last')?.textContent.includes('INV-0011'), { timeout: 4000 });
  await sleep(600);                                                          // the event is filed as matched
  const [status, pays, ev] = await evalStore(page, `
    const r = store.records('invoices').find((x) => x.data.number === 'INV-0011');
    return [r.data.status, r.data.payments.map((p) => p.mode + ' ' + p.ref.slice(0, 3)), store.records('_collect').map((e) => e.data.status + ' ' + e.data.how)];`);
  assert.equal(status, 'Paid');
  assert.deepEqual(pays, ['UPI SIM'], 'one UPI payment, carrying the bank reference');
  assert.deepEqual(ev, ['matched done']);
});

await scenario('Smart Collect: a credit bill pays itself later; "UPI received" with no bank confirmation is flagged; strangers wait for the owner', async ({ page }) => {
  await onboard(page);
  await collectOnFor(page, 'collect-later');
  await page.waitForFunction(() => window.__app.sync.live, { timeout: 6000 });
  const id = await evalStore(page, `
    const c = store.records('customers').find(x => x.data.name === 'Sunita Sharma');
    const it = store.records('items').find(x => x.data.code === 'RIC5');
    return (await store.saveRecord('invoices', { customer: c.id, items: [{ item: it.id, qty: 1 }] })).record.id;`);
  await goto(page, `#/t/invoices/${id}?done=1`);
  await page.waitForSelector('.qr-card');
  assert.match(await page.$eval('.qr-card', (e) => e.textContent), /Marked paid by itself when the bank confirms/);
  // two days later the customer scans the QR on the WhatsApp bill: the bank tells the server, the open screen updates
  await evalStore(page, `const { refFor } = await import('./js/collect.js'); const r = store.getRecord('invoices', '${id}');
    await sync.simulatePayment({ amount: r.data.balance, ref: refFor(r.id), vpa: '9988776655@ybl', name: 'Sunita Sharma' });`);
  await page.waitForFunction(() => /Payment status\s*Paid/i.test(document.querySelector('.record')?.innerText || ''), { timeout: 6000 });
  assert.match(await text(page), /received by UPI · INV-0011 marked paid/);
  assert.match(await evalStore(page, `return store.getRecord('invoices', '${id}').data.payments[0].ref`), /^SIM/);
  // the receipt is waiting to be sent (the existing workflow), written from the paid bill
  assert.ok(await evalStore(page, `return store.listOutbox((o) => o.status === 'pending' && o.recordId === '${id}').length`) >= 1);

  // a staff member marks a bill "UPI received" from a screenshot; the bank never confirms it
  await evalStore(page, `const it = store.records('items')[0];
    const r = (await store.saveRecord('invoices', { items: [{ item: it.id, qty: 1 }], payments: [{ mode: 'UPI', amount: it.data.price }] }, { by: 'staff' })).record;
    r.updated = new Date(Date.now() - 3600000).toISOString();`);
  // and someone pays the shop's UPI id with no reference, for an amount that fits no bill
  await evalStore(page, `await sync.simulatePayment({ amount: 3, vpa: 'stranger@okaxis', name: 'A Stranger' });`);
  await goto(page, '#/outbox/payments');
  await page.waitForFunction(() => /Payments to match[\s\S]*₹3\.00/.test(document.body.innerText), { timeout: 6000 });
  const body = await text(page);
  assert.match(body, /Marked UPI, not confirmed by the bank/);
  assert.match(body, /INV-0012[\s\S]*Staff/);
  assert.match(body, /Recently confirmed[\s\S]*Automatic/);
  await shot(page, 'collect-payments');
  await clickText(page, '.pay-card .btn', 'Not a sale');
  await page.waitForFunction(() => /Nothing waiting/.test(document.body.innerText));
});

await scenario('credit passport: score, factors, indicative limit and an export with no customer details; staff cannot open it', async ({ page }) => {
  await onboard(page);
  // six more months of trading, mostly UPI, so the passport has history to read
  await evalStore(page, `
    const items = store.records('items'); const cust = store.records('customers');
    const day = (m, d) => { const x = new Date(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() - m); x.setUTCDate(d); return x.toISOString().slice(0, 10); };
    for (let m = 6; m >= 1; m--) for (let i = 0; i < 12; i++) {
      const it = items[(i + m) % items.length]; const who = i % 3 ? '' : cust[i % cust.length].id;
      const r = (await store.saveRecord('invoices', { date: day(m, 1 + i * 2), customer: who, items: [{ item: it.id, qty: 2 + (i % 4) }] }, { noRules: true })).record;
      const mode = i % 4 === 3 ? 'Cash' : 'UPI';
      await store.saveRecord('invoices', { payments: [{ pdate: r.data.date, mode, amount: r.data.total, ref: mode === 'UPI' ? 'UTR' + m + i + '000000' : '' }] }, { id: r.id, noRules: true });
    }`);
  await goto(page, '#/credit');
  await page.waitForSelector('.pp-score-v b');
  const score = Number(await page.$eval('.pp-score-v b', (e) => e.textContent));
  assert.ok(score >= 40 && score <= 100, `score ${score}`);
  const body = await text(page);
  for (const s of ['Readiness score', 'Indicative working-capital limit', 'What the score is made of', 'Trading history', 'Money received digitally', 'Collection speed', 'Sales by month']) assert.ok(body.includes(s), s);
  assert.match(body, /₹[\d,]+/);
  const exp = await page.evaluate(async () => {
    const { creditPassport, passportExport } = await import('./js/credit.js');
    return JSON.stringify(passportExport(creditPassport(window.__app.store), window.__app.store.business));
  });
  assert.ok(!/Sunita|Ravi|98765|INV-/.test(exp), 'export holds no names, phones or bill numbers');
  await shot(page, 'credit-passport');
  // staff do not see it
  await evalStore(page, `window.__app.state.role = 'staff'; store.currentUser = 'staff';`);
  await goto(page, '#/');
  await goto(page, '#/credit');
  assert.match(await text(page), /Only the owner can open this/);
});


await scenario('two browsers offline: ₹300 cash on one, ₹500 UPI on the other, both survive sync; conflicts and reversals are shown, not hidden', async () => {
  const a = await launch({ url: srv.url });
  const b = await launch({ url: srv.url });
  try {
    await onboard(a.page);
    await evalStore(a.page, `sync.configure({ url: location.origin, ws: 'ledger-shop', token: 'secret-pass', create: true, setupCode: '${srv.setupCode}' }); const r = await sync.run(); if (r.error) throw new Error(r.error);`);
    await b.page.waitForSelector('.onboard-card .lang-grid');
    await clickText(b.page, '.onboard-card .link', 'I already use this');
    await b.page.waitForSelector('.onboard-card input');
    const ins = await b.page.$$('.onboard-card input');
    await ins[0].click({ clickCount: 3 }); await ins[0].type(srv.url);
    await ins[1].type('ledger-shop'); await ins[2].type('secret-pass');
    await clickText(b.page, '.onboard-card .btn.primary', 'Join');
    await b.page.waitForSelector('.topbar', { timeout: 8000 });
    // a ₹1,000+ credit bill for Sunita, on both devices
    const id = await evalStore(a.page, `
      const c = store.records('customers').find(x => x.data.name === 'Sunita Sharma');
      const it = store.records('items').find(x => x.data.code === 'RIC5');
      const r = (await store.saveRecord('invoices', { customer: c.id, items: [{ item: it.id, qty: 2 }] })).record;
      await sync.run(); return r.id;`);
    await evalStore(b.page, `await sync.run();`);
    assert.ok(await evalStore(b.page, `return !!store.getRecord('invoices', '${id}')`));
    // both lose the internet; each records a payment and a different delivery note
    await a.page.setOfflineMode(true); await b.page.setOfflineMode(true);
    const add = (mode, amount, note) => `const r = store.getRecord('invoices', '${id}');
      await store.patchRecord('invoices', r.id, { notes: '${note}', payments: [...r.data.payments, { mode: '${mode}', amount: ${amount} }] });`;
    await evalStore(a.page, add('Cash', 300, 'Deliver Monday'));
    await sleep(20);
    await evalStore(b.page, add('UPI', 500, 'Deliver Friday'));
    // and each sells one bag of the same rice: both sales must come off the stock
    const rice = `store.getRecord('items', store.records('items').find(x => x.data.code === 'RIC5').id)`;
    const stockBefore = await evalStore(a.page, `return ${rice}.data.stock`);
    const sellRice = `const it = ${rice}; await store.saveRecord('invoices', { items: [{ item: it.id, qty: 1 }] });`;
    await evalStore(a.page, sellRice); await evalStore(b.page, sellRice);
    assert.match(await evalStore(a.page, `return (await sync.run()).skipped ? 'skipped' : 'ran'`), /skipped/, 'offline: nothing is sent');
    // back online, in either order
    await b.page.setOfflineMode(false); await a.page.setOfflineMode(false);
    for (const p of [b.page, a.page, b.page, a.page]) await evalStore(p, `await sync.run();`);
    for (const p of [a.page, b.page]) {
      const d = await evalStore(p, `const d = store.getRecord('invoices', '${id}').data; return { rows: d.payments.map(x => x.mode + ' ' + x.amount).sort(), paid: d.paid };`);
      assert.deepEqual(d, { rows: ['Cash 300', 'UPI 500'], paid: 800 });
      assert.equal(await evalStore(p, `return ${rice}.data.stock`), stockBefore - 2, 'both offline sales came off the stock');
    }
    // after a reload (IndexedDB, not memory) the owner sees both payments, and the note conflict, on the bill
    await a.page.reload(); await a.page.waitForSelector('.topbar');
    await goto(a.page, `#/t/invoices/${id}`);
    await a.page.waitForSelector('.conflict-banner');
    const banner = await a.page.$eval('.conflict-banner', (e) => e.textContent);
    assert.match(banner, /Changed on two devices at the same time/);
    assert.match(banner, /Notes: kept “Deliver (Monday|Friday)”; the other device had “Deliver (Monday|Friday)”/);
    assert.match(await text(a.page), /Cash[\s\S]*₹300\.00[\s\S]*UPI[\s\S]*₹500\.00/);
    await shot(a.page, 'ledger-conflict');
    await clickText(a.page, '.conflict-banner .btn', 'Checked');
    await a.page.waitForFunction(() => !document.querySelector('.conflict-banner'));
    // correcting a payment keeps the old one in history, crossed out
    await evalStore(a.page, `const r = store.getRecord('invoices', '${id}');
      await store.patchRecord('invoices', r.id, { payments: r.data.payments.map(p => p.amount === 300 ? { ...p, amount: 350 } : p) });`);
    await a.page.waitForSelector('.reversals');
    assert.match(await a.page.$eval('.reversals', (e) => e.textContent), /Reversed: Payments received[\s\S]*₹300\.00[\s\S]*Corrected/);
    await shot(a.page, 'ledger-reversal');
    // the item shows where its stock went: both sales, each linked to its bill
    await goto(a.page, `#/t/items/${await evalStore(a.page, `return ${rice}.id`)}`);
    await a.page.waitForSelector('.stock-history');
    assert.equal((await a.page.$$('.stock-history tbody a')).length >= 2, true, 'each sale links to its bill');
    await shot(a.page, 'stock-history');
  } finally { await a.close(); await b.close(); }
});

await scenario('sync accounts: the owner connects with the setup code and a suggested passphrase; a typo cannot join; changing the passphrase stops the old phone', async () => {
  const a = await launch({ url: srv.url });
  const b = await launch({ url: srv.url });
  const field = (page, label) => page.$(`.settings-page input[aria-label="${label}"]`);
  try {
    await onboard(a.page);
    await goto(a.page, '#/settings');
    await a.page.waitForSelector('.settings-page input[aria-label="Workspace name"]');
    await (await field(a.page, 'Workspace name')).type('Verma Kirana');
    // a weak passphrase is caught on the device, before the server
    await (await field(a.page, 'Passphrase')).type('verma123');
    assert.match(await a.page.$eval('.settings-page .pass-note', (e) => e.textContent), /at least 10 characters/);
    await clickText(a.page, '.settings-page .btn', 'Suggest one');
    const pass = await a.page.$eval('.settings-page input[aria-label="Passphrase"]', (e) => e.value);
    assert.match(pass, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.match(await text(a.page), /Write it down: every device needs it/);
    // without the setup code a new workspace is refused
    await clickText(a.page, '.settings-page .btn.primary', 'Connect');
    await a.page.waitForFunction(() => /did not accept/.test(document.querySelector('.sync-status')?.textContent || ''));
    await (await field(a.page, 'Setup code')).type(srv.setupCode.toUpperCase());
    // connected: the page reloads to show the connected card
    await Promise.all([a.page.waitForNavigation({ timeout: 8000 }), clickText(a.page, '.settings-page .btn.primary', 'Connect')]);
    await a.page.waitForSelector('.topbar');
    assert.equal(await evalStore(a.page, `return store.meta.sync.since > 0 && !store.meta.sync.refused`), true);
    assert.equal(await evalStore(a.page, `return store.meta.sync.setupCode`), undefined, 'the setup code is not kept');

    // the phone mistypes the shop's name: refused, nothing created; then the right name, typed differently, works
    await b.page.waitForSelector('.onboard-card .lang-grid');
    await clickText(b.page, '.onboard-card .link', 'I already use this');
    await b.page.waitForSelector('.onboard-card input');
    const ins = await b.page.$$('.onboard-card input');
    await ins[0].click({ clickCount: 3 }); await ins[0].type(srv.url);
    await ins[1].type('verma kiranaa'); await ins[2].type(pass);
    await clickText(b.page, '.onboard-card .btn.primary', 'Join');
    await b.page.waitForFunction(() => /did not accept/.test(document.querySelector('.onboard-card .hint.bad')?.textContent || ''));
    await ins[1].click({ clickCount: 3 }); await ins[1].type('VERMA KIRANA');
    await clickText(b.page, '.onboard-card .btn.primary', 'Join');
    await b.page.waitForSelector('.topbar', { timeout: 8000 });
    assert.equal(await evalStore(b.page, `return store.app.name`), await evalStore(a.page, `return store.app.name`));

    // the owner changes the passphrase (the phone was lost); the phone stops syncing and says why
    await goto(a.page, '#/settings');
    await clickText(a.page, '.settings-page .btn', 'Change passphrase');
    await a.page.waitForSelector('.modal input');
    const next = await a.page.$eval('.modal input', (e) => e.value);
    assert.notEqual(next, pass, 'a fresh one is suggested');
    await clickText(a.page, '.modal .btn.primary', 'OK');
    await a.page.waitForFunction(() => /Other devices stop syncing/.test(document.querySelector('.modal')?.textContent || ''));
    await clickText(a.page, '.modal .btn.primary', 'Change passphrase');
    await a.page.waitForFunction((n) => window.__app.store.meta.sync.token === n, {}, next);
    await evalStore(a.page, `const c = store.records('customers')[0]; await store.patchRecord('customers', c.id, { city: 'Indore' }); const r = await sync.run(); if (r.error) throw new Error(r.error);`);
    await evalStore(b.page, `await sync.run();`);
    await goto(b.page, '#/settings');
    await b.page.waitForSelector('.sync-refused');
    assert.match(await b.page.$eval('.sync-refused', (e) => e.textContent), /stopped syncing because the server turned down the passphrase/);
    await b.page.$eval('.sync-refused', (e) => e.scrollIntoView({ block: 'center' }));
    await shot(b.page, 'sync-refused');
    assert.equal(await evalStore(b.page, `return store.records('customers').filter(c => c.data.city === 'Indore').length`), 0, 'nothing reaches the old passphrase');
  } finally { await a.close(); await b.close(); }
});

await scenario('an app version the sync server no longer accepts says "Update to keep syncing", keeps its bill, and syncs it after updating', async (app) => {
  const { page } = app;
  await onboard(page);
  await evalStore(page, `sync.configure({ url: location.origin, ws: 'compat-shop', token: 'secret-pass', create: true, setupCode: '${srv.setupCode}' }); const r = await sync.run(); if (r.error) throw new Error(r.error);`);
  // pretend this page is an older app (sync protocol 3) and sell something on it
  const id = await evalStore(page, `sync.protocol = 3;
    const it = store.records('items')[0];
    const r = (await store.saveRecord('invoices', { items: [{ item: it.id, qty: 1 }] })).record;
    await sync.run(); return r.id;`);
  await page.waitForSelector('.update-banner');
  assert.match(await page.$eval('.update-banner', (e) => e.textContent), /Update to keep syncing\. Everything on this device is kept/);
  assert.match(await page.$eval('.net', (e) => e.textContent), /Update to keep syncing/);
  assert.equal(await evalStore(page, `return store.getRecord('invoices', '${id}').dirty`), 1, 'the bill is waiting, not lost');
  await shot(page, 'update-to-keep-syncing');
  // the update arrives (same device, same stored data, current protocol): the bill goes up and the banner goes away
  await evalStore(page, `sync.protocol = (await import('./js/protocol.js')).SYNC_PROTOCOL; sync.needs = null; const r = await sync.run(); if (r.error) throw new Error(r.error);`);
  await page.waitForFunction(() => !document.querySelector('.update-banner'));
  assert.equal(await evalStore(page, `return store.getRecord('invoices', '${id}').dirty`), undefined, 'sent');
  // the app itself cancelled its live feed when the server refused its version: expected, not an error
  app.errors.splice(0, app.errors.length, ...app.errors.filter((e) => !/requestfailed: .*\/api\/live$/.test(e)));
});

for (const [label, viewport] of [['laptop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
  await scenario(`first run (${label}): one question, Start billing, a guided first bill in two taps, what Vina did by itself, then what is left`, async ({ page }) => {
    await page.waitForSelector('.onboard-card .onboard-start');
    assert.equal(await page.$$eval('.onboard-card input', (i) => i.length), 1, 'one question on the first screen (the shop name)');
    assert.match(await page.$eval('.onboard-card', (e) => e.textContent), /Start billing/);
    await shot(page, `first-run-${label}`);
    let taps = 0;
    const tap = async (sel) => { taps++; await page.click(sel); };
    await page.type('.onboard-card input[name=shop]', 'Asha Kirana');
    await tap('.onboard-start');
    // straight to the counter, with the first bill guided
    await page.waitForFunction(() => location.hash === '#/pos' && document.querySelector('.coach:not([hidden])'), { timeout: 6000 });
    assert.match(await page.$eval('.coach', (e) => e.textContent), /Your first bill[\s\S]*Tap an item/);
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await tap('.usual .usual-chip');                                         // one tap: a popular item
    await page.waitForFunction(() => document.querySelector('.coach li.done'));
    await tap(label === 'phone' ? '.pos-bar-save' : '.pos-save');            // one tap: Save
    await page.waitForSelector('.overlay .aha-list');
    const aha = await page.$eval('.overlay', (e) => e.textContent);
    assert.match(aha, /Your first bill is saved/);
    assert.match(aha, /Stock updated: .+ \d+ → \d+/, 'shows the stock it moved');
    assert.match(aha, /Today’s takings on your dashboard: ₹[\d,.]+/);
    assert.match(aha, /working without internet/i);
    assert.equal(await page.evaluate(() => window.__printed), 0, 'no print dialog on a newcomer\'s first bill');
    assert.equal(taps, 3, 'Start billing, an item, Save');
    await shot(page, `first-bill-${label}`);
    // the dashboard: the bill counted, and what is left to set up (the first bill already ticked)
    await clickText(page, '.overlay .btn', 'See my dashboard');
    await page.waitForSelector('.getting-started');
    const gs = await page.$eval('.getting-started', (e) => e.textContent);
    assert.match(gs, /Get set up\s*1\/5/);
    assert.equal(await page.$eval('.getting-started li.done', (e) => e.textContent.trim()), 'Make your first bill');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1, true, 'no sideways scrolling');
    await shot(page, `getting-started-${label}`);
    // adding the UPI ID where it is needed ticks it off
    await evalStore(page, `store.business.upi = 'asha@okaxis'; store.touchApp();`);
    await page.waitForFunction(() => /2\/5/.test(document.querySelector('.getting-started')?.textContent || ''));
  }, { viewport });
}

// ===================================================================================================
await srv.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
