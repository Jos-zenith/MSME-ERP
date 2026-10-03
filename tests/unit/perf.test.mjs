// Guard rails for low-end hardware: a busy shop's data must stay fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../public/js/store.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate } from '../../public/js/templates/index.js';
import { searchRecords } from '../../public/js/schema.js';
import { widgetData } from '../../public/js/analytics.js';
import { todayStr, addDays } from '../../public/js/formula.js';

const t = (s) => s;

test('3,000 bills / 2,000 items: saves, search and dashboards stay fast', async () => {
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('retail', t, { businessName: 'Big Mart', phone: '9000000001' }));
  const items = [];
  for (let i = 0; i < 2000; i++) {
    items.push((await store.saveRecord('items', { code: `C${i}`, name: `Item number ${i}`, price: 10 + (i % 90), cost: 5, tax: 5, stock: 1e6, reorder: 5 }, { noRules: true })).record.id);
  }
  const today = todayStr();
  const t0 = performance.now();
  for (let i = 0; i < 3000; i++) {
    await store.saveRecord('invoices', {
      date: addDays(today, -(i % 30)),
      items: [0, 1, 2].map((k) => ({ item: items[(i * 7 + k * 13) % items.length], qty: 1 + (k % 3) })),
    });
  }
  const perSave = (performance.now() - t0) / 3000;
  assert.ok(perSave < 12, `saving a 3-line bill with all workflows took ${perSave.toFixed(2)} ms (limit 12)`);

  const ts = performance.now();
  for (let i = 0; i < 50; i++) searchRecords(store.table('items'), store.records('items'), `item number 1${i}`);
  const perSearch = (performance.now() - ts) / 50;
  assert.ok(perSearch < 15, `one item search over 2,000 items took ${perSearch.toFixed(2)} ms (limit 15)`);

  const td = performance.now();
  for (const w of store.app.dashboards[0].widgets) widgetData(w, store);
  const dash = performance.now() - td;
  assert.ok(dash < 600, `the whole dashboard over 3,000 bills took ${dash.toFixed(0)} ms (limit 600)`);
  console.log(`      save ${perSave.toFixed(2)} ms · search ${perSearch.toFixed(2)} ms · dashboard ${dash.toFixed(0)} ms`);
});
