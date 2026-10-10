// Browser test harness: starts the real server on a random port and drives the real app in headless Chrome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));

export async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msme-e2e-'));
  process.env.DATA_DIR = dataDir;
  const mod = await import(`../../server/server.js?e2e=${Date.now()}`);
  const server = await mod.start(0, '127.0.0.1');
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)), dataDir };
}

export async function launch({ url, viewport = { width: 1280, height: 900 }, lang } = {}) {
  if (!CHROME) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--lang=en-US'] });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  if (lang) await page.evaluateOnNewDocument((l) => localStorage.setItem('lang', l), lang);
  await page.goto(url, { waitUntil: 'networkidle0' });
  return { browser, page, errors, context, close: () => browser.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Complete onboarding with the retail template + sample data. */
export async function onboard(page, { name = 'Test Mart', phone = '9876500001', upi = 'testmart@upi', template = 'retail', sample = true, gstin = '' } = {}) {
  await page.waitForSelector('.onboard-card .lang-grid');
  await page.evaluate(() => [...document.querySelectorAll('.lang-grid button')].find((b) => b.textContent.trim() === 'English').click());
  await page.waitForSelector('.onboard-card input');
  const inputs = await page.$$('.onboard-card input');
  await inputs[0].type(name); await inputs[1].type(phone); await inputs[2].type(upi);
  await page.evaluate(() => [...document.querySelectorAll('.onboard-card button')].find((b) => b.textContent.trim() === 'Next').click());
  await page.waitForSelector('.tpl-grid');
  await page.evaluate((tpl) => document.querySelector(`.tpl-grid .tile[data-tpl=${tpl}]`).click(), template);
  await page.waitForSelector(`.tpl-grid .tile.sel[data-tpl=${template}]`);
  if (gstin) { await page.waitForSelector('.gstin-input'); await page.type('.gstin-input', gstin); }
  if (!sample) await page.evaluate(() => { document.querySelector('.onboard-card input[type=checkbox]').click(); });
  await page.evaluate(() => [...document.querySelectorAll('.onboard-card button')].find((b) => b.textContent.trim() === 'Start').click());
  await page.waitForSelector('.topbar');
}

export async function goto(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(150);
}
