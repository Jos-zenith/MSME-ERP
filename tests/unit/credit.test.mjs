// Credit passport: readiness for a working-capital loan, from the shop's own bills and payments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../public/js/store.js';
import { memoryDb } from '../../public/js/db.js';
import { buildTemplate } from '../../public/js/templates/index.js';
import { creditPassport, passportExport, PASSPORT_FORMAT } from '../../public/js/credit.js';

const t = (s) => s;
const TODAY = '2026-10-15';
const monthDay = (monthsAgo, day = 10) => {
  const d = new Date(Date.UTC(2026, 9 - monthsAgo, day));
  return d.toISOString().slice(0, 10);
};

async function shop(opts = {}) {
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('retail', t, { businessName: 'Steady Mart', upi: 'steady@ybl', ...opts }));
  const item = (await store.saveRecord('items', { code: 'X1', name: 'Thing', price: 1000, cost: 800, stock: 1e6, reorder: 0 }, { noRules: true })).record;
  const sale = (date, { qty = 1, customer = '', paid = [], due = '' } = {}) => store.saveRecord('invoices', {
    date, customer, due_date: due, items: [{ item: item.id, qty }],
    payments: paid.map(([mode, amount, ref = '']) => ({ pdate: date, mode, amount, ref })),
  }, { noRules: true });
  return { store, sale };
}

test('passport: a new shop is "building", with no limit and an honest reason', async () => {
  const { store } = await shop();
  const p = creditPassport(store, { today: TODAY });
  assert.equal(p.ready, false);
  assert.equal(p.band, 'building');
  assert.equal(p.limit.indicative, 0);
  assert.equal(p.metrics.historyMonths, 0);
});

test('passport: steady, mostly-digital, cash-on-the-spot shop scores strong; limit follows the 20% norm', async () => {
  const { store, sale } = await shop({ gstin: '27AAPFU0939F1ZV' });
  for (let k = 7; k >= 1; k--) {
    for (let i = 0; i < 10; i++) {
      const mode = i < 7 ? 'UPI' : 'Cash';
      await sale(monthDay(k, 1 + i), { paid: [[mode, 1000, mode === 'UPI' ? `UTR${k}${i}0000` : '']] });
    }
  }
  const p = creditPassport(store, { today: TODAY });
  assert.equal(p.ready, true);
  assert.equal(p.metrics.historyMonths, 7);
  assert.equal(p.metrics.cv, 0, 'same sales every month');
  assert.equal(p.metrics.growth, 0);
  assert.equal(p.metrics.receivables, 0);
  assert.ok(Math.abs(p.metrics.digitalShare - 0.7) < 1e-9);
  assert.equal(p.metrics.verifiedShare, 1, 'every UPI receipt carries a bank UTR');
  const pts = Object.fromEntries(p.factors.map((f) => [f.id, f.points]));
  assert.deepEqual(pts, { history: 7, stability: 15, growth: 7, digital: 20, speed: 20, overdue: 10, concentration: 10, identity: 5 });
  assert.equal(p.score, 94);
  assert.equal(p.band, 'strong');
  assert.equal(p.limit.annual, 120000, '10,000 a month');
  assert.equal(p.limit.ceiling, 24000, '20% of annual turnover');
  assert.equal(p.limit.indicative, 24000);
  assert.equal(p.monthly.length, 8, 'seven full months and the current one');
});

test('passport: one slow, big credit customer shows up as speed, overdue and concentration, with what to fix first', async () => {
  const { store, sale } = await shop();
  const big = (await store.saveRecord('customers', { name: 'Anil Traders', phone: '90000 11122' }, { noRules: true })).record;
  for (let k = 4; k >= 0; k--) {
    await sale(monthDay(k, 2), { qty: 8, customer: big.id, due: monthDay(k, 12) });        // 8,000 on credit, unpaid
    await sale(monthDay(k, 3), { qty: 2, paid: [['Cash', 2000]] });                         // 2,000 cash
  }
  const p = creditPassport(store, { today: TODAY });
  const f = Object.fromEntries(p.factors.map((x) => [x.id, x]));
  assert.ok(p.metrics.dso > 60, `DSO ${p.metrics.dso}`);
  assert.equal(f.speed.points, 2);
  assert.ok(p.metrics.overdueShare > 0.5);
  assert.equal(f.overdue.points, 0);
  assert.ok(p.metrics.topShare >= 0.8);
  assert.equal(f.concentration.points, 1);
  assert.equal(f.digital.points, 3, 'all cash');
  assert.deepEqual(p.improve.slice(0, 2).sort(), ['digital', 'speed'], 'the biggest gaps first');
  assert.ok(p.score < 40, `score ${p.score}`);
  assert.equal(p.band, 'building');
  assert.equal(p.limit.factor, 0.25);
});

test('passport: GST shops count credit notes against sales and flag B2B invoices fit for discounting', async () => {
  const store = new Store({ db: memoryDb() });
  await store.init();
  store.setApp(buildTemplate('gst', t, { businessName: 'GST Co', gstin: '27AAPFU0939F1ZV', upi: 'gst@ybl' }));
  const item = (await store.saveRecord('items', { code: 'A', name: 'A', hsn: '1006', price: 1000, gst: 0, stock: 1e5 }, { noRules: true })).record;
  const buyer = (await store.saveRecord('customers', { name: 'Big Buyer', gstin: '07AAGFF2194N1Z1', state: '07 - Delhi' }, { noRules: true })).record;
  const r = await store.saveRecord('invoices', { doc_type: 'Tax Invoice', date: '2026-10-05', customer: buyer.id, bill_gstin: '07AAGFF2194N1Z1', items: [{ item: item.id, qty: 5 }] }, { noRules: true });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const cn = await store.saveRecord('invoices', { doc_type: 'Credit Note', ref_note: r.record.data.number, date: '2026-10-06', customer: buyer.id, bill_gstin: '07AAGFF2194N1Z1', items: [{ item: item.id, qty: 1 }] }, { noRules: true });
  assert.ok(cn.ok, JSON.stringify(cn.errors));
  const p = creditPassport(store, { today: TODAY });
  assert.equal(p.monthly.at(-1).sales, r.record.data.total - cn.record.data.total, 'credit note reduces sales');
  assert.equal(p.invoiceFinance.count, 1);
  assert.equal(p.invoiceFinance.amount, r.record.data.balance);
});

test('passport export: aggregates and consent only, no customer names or phones', async () => {
  const { store, sale } = await shop({ gstin: '27AAPFU0939F1ZV', state: '27 - Maharashtra' });
  const c = (await store.saveRecord('customers', { name: 'Sunita Sharma', phone: '99887 76655' }, { noRules: true })).record;
  for (let k = 3; k >= 1; k--) await sale(monthDay(k), { customer: c.id, paid: [['UPI', 1000]] });
  const out = passportExport(creditPassport(store, { today: TODAY }), store.business, { now: new Date('2026-10-15T10:00:00Z') });
  assert.equal(out.format, PASSPORT_FORMAT);
  assert.equal(out.business.gstin, '27AAPFU0939F1ZV');
  assert.equal(out.consent.validUntil, '2026-11-14');
  const text = JSON.stringify(out);
  assert.ok(!text.includes('Sunita') && !text.includes('99887') && !text.includes('INV-'), 'no personal data, no bill numbers');
});
