// Credit passport: how ready this shop is for a working-capital loan, read from its own books.
//
// Lenders to small shops look at the same few things: how long the business has been trading, how steady and growing
// its sales are, how much money arrives digitally (provable), how fast customers pay, and whether it leans on one big
// buyer. All of that is already in the bills and payments here, so the owner can see their standing, see what would
// improve it, and share a summary (no customer names) with a lender of their choosing.
//
// Indicative only: not a credit score, not an offer. The limit uses the 20%-of-annual-turnover norm (Nayak Committee)
// that Indian banks apply to working-capital limits for micro and small businesses, scaled down by readiness.
// Pure: no DOM, no storage, no translations (the screen words the codes), so it is tested like the GST engine.
import { toNum, todayStr, addDays, daysBetween, round } from './formula.js';
import { collectSetup, bankConfirmations } from './collect.js';
import { docOf, validateGstin } from '../gst/js/gst.js';

export const PASSPORT_FORMAT = 'vina-credit-passport';
export const NAYAK_SHARE = 0.2;
export const BANDS = [[75, 'strong', 1], [60, 'good', 0.75], [40, 'fair', 0.5], [0, 'building', 0.25]];
const r2 = (n) => round(n, 2);
const monthOf = (d) => String(d || '').slice(0, 7);
const prevMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const sum = (a) => a.reduce((s, x) => s + x, 0);

/** Points for a value against thresholds: [[limit, points], ...] checked in order with `cmp`. */
const grade = (v, steps, cmp, floor) => { for (const [lim, pts] of steps) if (cmp(v, lim)) return pts; return floor; };
const atMost = (v, lim) => v <= lim, atLeast = (v, lim) => v >= lim;

/**
 * Reads the bills table and returns everything the passport screen and export need, or null when the app has no
 * table that keeps balances and payments.
 */
export function creditPassport(store, { today = todayStr() } = {}) {
  const cfg = collectSetup(store.app);
  if (!cfg) return null;
  const partyTable = cfg.party ? store.table(cfg.party.ref) : null;
  const partyGstin = partyTable?.fields.find((f) => f.id === 'gstin');
  const bills = store.records(cfg.table.id).filter((r) => !r.data.cancelled && r.data.date)
    .sort((x, y) => x.data.date.localeCompare(y.data.date) || (x.id < y.id ? -1 : 1))
    .map((r) => ({ id: r.id, d: r.data, sign: r.data.doc_type ? docOf(r.data.doc_type).sign : 1, payable: r.data.doc_type ? docOf(r.data.doc_type).payable : true }))
    .filter((b) => b.sign !== 0);
  // provenance of every digital payment: bank-confirmed (a server-delivered confirmation for this bill, never more than
  // the bank reported for that UTR), reference supplied (typed, copied, simulated, or above the confirmed amount), none
  const banks = bankConfirmations(store);
  const left = new Map([...banks].map(([utr, b]) => [utr, b.amount]));
  const provenance = (billId, row, amt) => {
    const ref = cfg.ref ? String(row[cfg.ref.id] || '').trim() : '';
    if (!ref) return { confirmed: 0, simulated: 0, referenced: 0 };
    const b = banks.get(ref);
    if (!b || !b.bills.has(billId)) return { confirmed: 0, simulated: 0, referenced: amt };
    const take = Math.min(amt, left.get(ref));
    left.set(ref, left.get(ref) - take);
    return b.sandbox ? { confirmed: 0, simulated: take, referenced: amt } : { confirmed: take, simulated: 0, referenced: amt - take };
  };
  const thisMonth = monthOf(today);
  const from90 = addDays(today, -90);

  // ---- monthly sales and collections ----------------------------------------------------------------------------------
  const months = new Map();
  const blankMonth = (k) => ({ month: k, sales: 0, collected: 0, digital: 0, referenced: 0, confirmed: 0, simulated: 0 });
  const m = (k) => { if (!months.has(k)) months.set(k, blankMonth(k)); return months.get(k); };
  let first = '';
  let coll90 = 0, digital90 = 0, referenced90 = 0, confirmed90 = 0, simulated90 = 0, billed90 = 0;
  const partySales = new Map();
  for (const { id, d, sign } of bills) {
    const total = sign * toNum(d.total);
    if (!first || d.date < first) first = d.date;
    m(monthOf(d.date)).sales += total;
    if (d.date >= from90 && d.date <= today) {
      billed90 += total;
      const who = cfg.party ? d[cfg.party.id] : '';
      if (who) partySales.set(who, (partySales.get(who) || 0) + total);
    }
    for (const row of d[cfg.pay.id] || []) {
      const amt = toNum(row[cfg.amount.id]);
      const day = (cfg.date && row[cfg.date.id]) || d.date;
      const isDigital = !/cash/i.test(row[cfg.mode.id] || '');
      const pv = isDigital ? provenance(id, row, amt) : { confirmed: 0, simulated: 0, referenced: 0 };
      const bucket = m(monthOf(day));
      bucket.collected += amt;
      if (isDigital) { bucket.digital += amt; bucket.referenced += pv.referenced; bucket.confirmed += pv.confirmed; bucket.simulated += pv.simulated; }
      if (day >= from90 && day <= today) {
        coll90 += amt;
        if (isDigital) { digital90 += amt; referenced90 += pv.referenced; confirmed90 += pv.confirmed; simulated90 += pv.simulated; }
      }
    }
  }

  // full months only (the current one is still running), from the first month with a sale, at most the last 12
  const full = [];
  if (first) for (let k = prevMonth(thisMonth); k >= monthOf(first) && full.length < 12; k = prevMonth(k)) full.unshift(months.get(k) || blankMonth(k));
  const series = [...full, months.get(thisMonth) || blankMonth(thisMonth)]
    .map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])));
  const fullSales = full.map((x) => x.sales);
  const last3 = fullSales.slice(-3);
  const dayOfMonth = Number(today.slice(8, 10)) || 1;
  const runRate = last3.length ? sum(last3) / last3.length : (months.get(thisMonth)?.sales || 0) / dayOfMonth * 30;
  const annual = r2(runRate * 12);
  const growth = fullSales.length >= 6 ? (() => { const a = sum(fullSales.slice(-3)), b = sum(fullSales.slice(-6, -3)); return b > 0 ? a / b - 1 : null; })() : null;
  const recent = fullSales.slice(-6);
  const mean = recent.length ? sum(recent) / recent.length : 0;
  const cv = recent.length >= 3 && mean > 0 ? Math.sqrt(sum(recent.map((v) => (v - mean) ** 2)) / recent.length) / mean : null;

  // ---- receivables --------------------------------------------------------------------------------------------------------
  let ar = 0, overdue = 0, b2bOpen = 0, b2bCount = 0;
  for (const { d, payable, sign } of bills) {
    const bal = toNum(d.balance);
    if (!payable || sign <= 0 || bal <= 0.004) continue;
    ar += bal;
    const due = d.due_date || addDays(d.date, 30);
    const late = daysBetween(today, due) ?? 0;
    if (late > 0) overdue += bal;
    const partyRec = cfg.party && d[cfg.party.id] && partyTable ? store.getRecord(partyTable.id, d[cfg.party.id]) : null;
    const gstin = d.bill_gstin || (partyGstin && partyRec?.data[partyGstin.id]) || '';
    if (validateGstin(gstin).ok && late <= 90) { b2bOpen += bal; b2bCount++; }
  }
  const dso = billed90 > 0 ? (ar / billed90) * 90 : null;
  const overdueShare = ar > 0 ? overdue / ar : 0;
  const topShare = billed90 > 0 && partySales.size ? Math.max(...partySales.values()) / billed90 : 0;
  const digitalShare = coll90 > 0 ? digital90 / coll90 : null;
  const historyMonths = first ? Math.max(0, full.length) : 0;
  const gstinOk = validateGstin(store.business.gstin).ok;

  // ---- score ----------------------------------------------------------------------------------------------------------------
  // weights: how predictable the cash is (history, stability, growth: 35), how provable (digital: 20),
  // how fast it comes back (collection speed, overdue: 30), how concentrated (10), and a formal identity (5)
  const factors = [
    { id: 'history', max: 10, value: historyMonths, points: grade(historyMonths, [[12, 10], [6, 7], [3, 4], [1, 1]], atLeast, 0) },
    { id: 'stability', max: 15, value: cv, points: cv === null ? 0 : grade(cv, [[0.2, 15], [0.35, 11], [0.5, 7]], atMost, 3) },
    { id: 'growth', max: 10, value: growth, points: growth === null ? 0 : grade(growth, [[0.1, 10], [0, 7], [-0.1, 4]], atLeast, 1) },
    { id: 'digital', max: 20, value: digitalShare, points: digitalShare === null ? 0 : grade(digitalShare, [[0.6, 20], [0.4, 15], [0.2, 9]], atLeast, 3) },
    { id: 'speed', max: 20, value: dso, points: dso === null ? 0 : grade(dso, [[15, 20], [30, 15], [60, 8]], atMost, 2) },
    { id: 'overdue', max: 10, value: overdueShare, points: billed90 > 0 ? grade(overdueShare, [[0.1, 10], [0.25, 7], [0.5, 4]], atMost, 0) : 0 },
    { id: 'concentration', max: 10, value: topShare, points: billed90 > 0 ? grade(topShare, [[0.2, 10], [0.35, 7], [0.5, 4]], atMost, 1) : 0 },
    { id: 'identity', max: 5, value: gstinOk, points: gstinOk ? 5 : 0 },
  ].map((f) => ({ ...f, gap: f.max - f.points }));
  const score = sum(factors.map((f) => f.points));
  const [, band, factor] = BANDS.find(([min]) => score >= min);
  const ceiling = r2(annual * NAYAK_SHARE);
  const indicative = Math.floor((ceiling * factor) / 1000) * 1000;
  // what to work on first: biggest gain, but only things the owner can change this quarter
  const improve = factors.filter((f) => f.gap > 0 && f.id !== 'history').sort((a, b) => b.gap - a.gap).slice(0, 3).map((f) => f.id);

  return {
    today, ready: historyMonths >= 3, score, band, factors, improve,
    limit: { annual, ceiling, indicative, share: NAYAK_SHARE, factor, projected: !last3.length },
    metrics: {
      historyMonths, firstSale: first, runRate: r2(runRate), annual, growth, cv, billed90: r2(billed90),
      collected90: r2(coll90), digitalShare,
      digital90: r2(digital90), referenced90: r2(referenced90), bankConfirmed90: r2(confirmed90), simulated90: r2(simulated90),
      referenceShare: digital90 > 0 ? referenced90 / digital90 : null, bankConfirmedShare: digital90 > 0 ? confirmed90 / digital90 : null,
      receivables: r2(ar), overdue: r2(overdue), overdueShare, dso: dso === null ? null : round(dso, 1), topShare, customers90: partySales.size, gstinOk,
    },
    invoiceFinance: { amount: r2(b2bOpen), count: b2bCount },
    monthly: series,
  };
}

/**
 * The shareable summary: totals and ratios only, never a customer's name, phone or bill. The owner decides who gets it,
 * for what, and until when (the consent block travels with the data).
 */
export function passportExport(p, business = {}, { purpose = 'Working-capital loan assessment', validDays = 30, now = new Date() } = {}) {
  const g = validateGstin(business.gstin);
  const rounded = (x) => (typeof x === 'number' ? round(x, 4) : x);
  return {
    format: PASSPORT_FORMAT, version: 1, generated: now.toISOString(),
    business: { name: business.name || '', gstin: g.ok ? g.gstin : '', state: business.state || '' },
    consent: { purpose, validUntil: new Date(now.getTime() + validDays * 86400000).toISOString().slice(0, 10), contains: 'Monthly totals and ratios only. No customer names, phone numbers or individual bills.' },
    score: p.score, band: p.band,
    factors: p.factors.map(({ id, points, max, value }) => ({ id, points, max, value: rounded(value) })),
    metrics: Object.fromEntries(Object.entries(p.metrics).map(([k, v]) => [k, rounded(v)])),
    limit: p.limit,
    invoiceFinance: p.invoiceFinance,
    monthly: p.monthly,
    basis: 'Computed on the business’s own device from its billing records. Digital payments are split by provenance: '
      + 'bank-confirmed (bankConfirmedShare) means only payments whose confirmation came from the payment provider through the sync server’s signed webhook and was applied to that bill, never more than the amount the bank reported; '
      + 'reference only (referenceShare) means payments that carry a reference (UTR) nobody verified: typed by hand, copied, simulated in the sandbox, or above the confirmed amount. '
      + 'Indicative only: not a credit score or a loan offer.',
  };
}
