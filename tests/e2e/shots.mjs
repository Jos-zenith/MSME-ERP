// Screenshots of the main screens for design review:  node tests/e2e/shots.mjs <outDir> [width] [height] [dark]
import path from 'node:path';
import fs from 'node:fs';
import { startServer, launch, onboard, goto, sleep } from './harness.mjs';

const out = process.argv[2] || 'shots';
const width = +(process.argv[3] || 1366), height = +(process.argv[4] || 768);
const dark = process.argv[5] === 'dark';
fs.mkdirSync(out, { recursive: true });
const srv = await startServer();
const app = await launch({ url: srv.url, viewport: { width, height } });
const { page } = app;
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
await onboard(page);
await sleep(400);
const snap = async (name, hash, full = false) => {
  if (hash) { await goto(page, hash); await sleep(350); }
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: full });
};
await snap('1-home', '#/');
await snap('1b-home-full', null, true);
await snap('2-invoices', '#/t/invoices');
const id = await page.evaluate(() => window.__app.store.records('invoices').find((r) => r.data.balance > 0).id);
await snap('3-invoice', `#/t/invoices/${id}`, true);
await goto(page, '#/t/invoices/new'); await sleep(300);
await page.keyboard.type('sug1*2'); await page.keyboard.press('Enter'); await page.keyboard.type('dal1'); await page.keyboard.press('Enter');
await snap('4-new-invoice', null, true);
await goto(page, '#/pos'); await sleep(300);
for (const c of ['sug1*2', 'dal1', 'bis1*6', 'oil1']) { await page.keyboard.type(c); await page.keyboard.press('Enter'); }
await snap('0-counter-cash');
await page.keyboard.press('F1'); await page.keyboard.type('600'); await sleep(100);
await snap('0-counter-change');
await page.keyboard.press('F2'); await sleep(150);
await snap('0-counter-upi');
await page.keyboard.press('Escape'); await sleep(200); await page.keyboard.press('Enter'); await sleep(200);
await snap('5-customers', '#/t/customers');
await snap('6-items', '#/t/items');
await snap('7-reports', '#/reports', true);
await snap('8-builder', '#/build');
await snap('9-settings', '#/settings');
await app.close(); await srv.close();
console.log('saved to', out);
process.exit(0);
