// Quick manual smoke run: node tests/e2e/smoke.mjs [screenshotDir]
import path from 'node:path';
import fs from 'node:fs';
import { startServer, launch, onboard, goto, sleep } from './harness.mjs';

const shots = process.argv[2] || path.join(process.cwd(), 'tests', 'e2e', 'shots');
fs.mkdirSync(shots, { recursive: true });
const srv = await startServer();
const app = await launch({ url: srv.url });
const { page, errors } = app;
try {
  await page.screenshot({ path: path.join(shots, '01-onboarding.png') });
  await onboard(page);
  await sleep(400);
  await page.screenshot({ path: path.join(shots, '02-home.png') });
  const routes = process.env.ROUTES ? JSON.parse(process.env.ROUTES) : [['03-invoices', '#/t/invoices'], ['04-new-invoice', '#/t/invoices/new'], ['05-reports', '#/reports'], ['06-build', '#/build'], ['07-rules', '#/build/rules'], ['08-settings', '#/settings'], ['09-outbox', '#/outbox']];
  for (const [name, hash] of routes) {
    await goto(page, hash); await sleep(300);
    await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
  }
} finally {
  console.log('errors:', errors);
  await app.close(); await srv.close();
}
