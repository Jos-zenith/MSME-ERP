// Smart Collect: UPI payments that mark bills paid by themselves.
//
// Every bill carries its own UPI reference (`tr` in the QR). The payment provider (Decentro or any UPI collections API)
// tells the sync server when money lands; the server keeps the event as a record in the `_collect` table, every device
// pulls it within a second, and this file matches it to the right bill and records the payment with the bank's UTR.
//
//   sure match   (the bill's own reference, or the customer's phone and the exact amount)  -> applied straight away
//   likely match (customer known but several bills open, or one bill with that exact amount) -> owner taps "Apply"
//   no match     -> owner picks the bill, or marks it "not a sale"
//
// Applying is idempotent by UTR: a payment row with that UTR is never added twice, so two devices reconciling the same
// event at once, or the provider retrying its webhook, cannot double-count money.
// The QR is still made on the device, so billing works offline; only the confirmation needs a connection somewhere.
import { toNum, todayStr, daysBetween, round } from './formula.js';
import { normPhone, isBlank, newRow } from './schema.js';

export const COLLECT_TABLE = '_collect';
const EPS = 0.004;
const r2 = (n) => round(n, 2);

/** Smart Collect is on when the owner turned it on and there is a UPI id to collect into. */
export const collectOn = (store) => !!(store.settings.collect?.enabled && String(store.business.upi || '').trim());

/** Stable per-bill UPI reference (`tr`): the same on every device, 12 characters, letters and digits only. */
export function refFor(recordId) {
  const s = String(recordId);
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `MB${a.toString(36).toUpperCase().padStart(7, '0').slice(-7)}${b.toString(36).toUpperCase().padStart(3, '0').slice(-3)}`;
}

/** `upi://pay` intent (what the QR holds). `ref` goes in `tr`, which the bank returns with the payment. */
export function upiLink({ vpa, name, amount, note, ref }) {
  const q = new URLSearchParams();
  q.set('pa', vpa);
  if (name) q.set('pn', name);
  if (amount > 0) q.set('am', (Math.round(amount * 100) / 100).toFixed(2));
  if (ref) q.set('tr', ref);
  q.set('cu', 'INR');
  if (note) q.set('tn', note);
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
}

/** A reference this app made (as opposed to a provider's own id). */
export const isOurRef = (r) => /^MB[0-9A-Z]{10}$/.test(String(r || ''));

/**
 * Which table Smart Collect writes into and which columns it uses: the first table that keeps a `balance` and has a
 * payments list (a line field with a money column and a mode picker, and no item lookup).
 */
export function collectSetup(app) {
  for (const table of app?.tables || []) {
    if (!table.fields.some((f) => f.id === 'balance')) continue;
    const pay = table.fields.find((f) => f.type === 'lines' && !f.columns?.some((c) => c.type === 'lookup')
      && f.columns?.some((c) => c.type === 'money') && f.columns?.some((c) => c.type === 'select'));
    if (!pay) continue;
    const amount = pay.columns.find((c) => c.type === 'money' && !c.formula);
    const mode = pay.columns.find((c) => c.type === 'select');
    const date = pay.columns.find((c) => c.type === 'date');
    const ref = pay.columns.find((c) => c.id === 'ref');
    const party = table.fields.find((f) => f.type === 'lookup');
    const phone = table.fields.find((f) => f.type === 'phone');
    const upiMode = (mode.options || []).find((o) => /upi/i.test(o)) || 'UPI';
    return { table, pay, amount, mode, date, ref, party, phone, upiMode };
  }
  return null;
}

/** Ten-digit mobile number in a payer's UPI id or phone ("98765 43210@ybl" -> "9876543210"), or ''. */
export function payerMobile(evt) {
  for (const raw of [evt.phone, String(evt.vpa || '').split('@')[0]]) {
    const d = normPhone(raw, '91');
    if (/^91[6-9]\d{9}$/.test(d)) return d.slice(2);
  }
  return '';
}
const mobileOf = (raw) => { const d = normPhone(raw, '91'); return /^91[6-9]\d{9}$/.test(d) ? d.slice(2) : ''; };

/** Open bills (and their payment rows) in the shape the matcher needs. */
export function openBills(store, cfg = collectSetup(store.app)) {
  if (!cfg) return [];
  const partyTable = cfg.party ? store.table(cfg.party.ref) : null;
  const partyPhone = partyTable?.fields.find((f) => f.type === 'phone');
  return store.records(cfg.table.id).map((r) => {
    const d = r.data;
    const partyId = cfg.party ? d[cfg.party.id] || '' : '';
    const p = partyId && partyPhone ? store.getRecord(partyTable.id, partyId)?.data[partyPhone.id] : '';
    return {
      id: r.id, ref: refFor(r.id), number: d.number || '', date: d.date || '', due: d.due_date || '', partyId,
      mobile: mobileOf(cfg.phone ? d[cfg.phone.id] : '') || mobileOf(p),
      balance: r2(toNum(d.balance)), cancelled: !!d.cancelled,
      payments: (d[cfg.pay.id] || []).map((row) => ({ ref: cfg.ref ? String(row[cfg.ref.id] || '') : '', amount: toNum(row[cfg.amount.id]), mode: row[cfg.mode.id] || '' })),
    };
  });
}

/** Pays oldest bills first (how a khata is settled), returns allocations and what is left over. */
function fifo(bills, amount) {
  const out = [];
  let left = r2(amount);
  for (const b of [...bills].sort((x, y) => (x.date || '').localeCompare(y.date || '') || x.number.localeCompare(y.number, undefined, { numeric: true }))) {
    if (left <= EPS) break;
    if (b.balance <= EPS) continue;
    const take = r2(Math.min(left, b.balance));
    out.push({ id: b.id, amount: take });
    left = r2(left - take);
  }
  return { allocations: out, unapplied: left > EPS ? left : 0 };
}

/**
 * Decide where one incoming payment belongs. Pure: give it the event and the bills.
 * Returns { kind, sure, allocations: [{id, amount}], unapplied, verify?: {id, index}, reason }.
 *   kind: 'done' (already recorded with this UTR) | 'verify' (a cashier already marked this bill paid by UPI: attach
 *   the UTR to that row) | 'ref' | 'party' | 'party-fifo' | 'amount' | 'wait' | 'none'
 * 'wait': the payment carries one of our bill references but that bill is not here yet (still on the counter, or on a
 * device that is offline). Guessing by customer or amount then could pay the wrong bill, so it waits (`holdRef`).
 */
export function matchPayment(evt, bills, { upiMode = 'UPI', today = todayStr(), holdRef = true } = {}) {
  const amount = r2(toNum(evt.amount));
  const utr = String(evt.utr || '');
  const none = (reason) => ({ kind: 'none', sure: false, allocations: [], unapplied: amount, reason });
  if (!(amount > 0) || !utr) return none('invalid');

  // 1. already recorded (another device got there first, or the provider sent the webhook twice)
  const done = bills.find((b) => b.payments.some((p) => p.ref === utr));
  if (done) return { kind: 'done', sure: true, allocations: [], unapplied: 0, reason: 'utr_seen', billId: done.id };

  const live = bills.filter((b) => !b.cancelled);
  const open = live.filter((b) => b.balance > EPS);
  const byRef = evt.ref ? live.find((b) => b.ref === String(evt.ref).toUpperCase()) : null;

  if (byRef) {
    // 2. the counter already marked it "paid by UPI" (F2 / UPI received): the bank's word now confirms that row
    const index = byRef.payments.findIndex((p) => !p.ref && Math.abs(p.amount - amount) <= EPS && /upi/i.test(p.mode || upiMode));
    if (index >= 0) return { kind: 'verify', sure: true, allocations: [], unapplied: 0, verify: { id: byRef.id, index }, reason: 'counter_marked' };
    // 3. the bill's own QR: pay it, and anything extra goes to the same customer's older bills
    const first = { id: byRef.id, amount: r2(Math.min(amount, Math.max(0, byRef.balance))) };
    const rest = r2(amount - first.amount);
    const more = rest > EPS && byRef.partyId ? fifo(open.filter((b) => b.partyId === byRef.partyId && b.id !== byRef.id), rest) : { allocations: [], unapplied: rest > EPS ? rest : 0 };
    const allocations = [first, ...more.allocations].filter((a) => a.amount > EPS);
    // money left over (paid twice, or more than was owed) is an owner decision, not a guess
    return { kind: 'ref', sure: allocations.length > 0 && !more.unapplied, allocations, unapplied: more.unapplied, reason: more.unapplied ? 'overpaid' : 'bill_reference' };
  }

  if (holdRef && isOurRef(evt.ref)) return { kind: 'wait', sure: false, allocations: [], unapplied: amount, reason: 'bill_not_here_yet' };

  // 4. no reference (the customer scanned the shop's plain QR or typed the UPI id): who paid?
  const mobile = payerMobile(evt);
  if (mobile) {
    const mine = open.filter((b) => b.mobile === mobile);
    const exact = mine.filter((b) => Math.abs(b.balance - amount) <= EPS);
    if (exact.length === 1) return { kind: 'party', sure: true, allocations: [{ id: exact[0].id, amount }], unapplied: 0, reason: 'payer_exact_amount' };
    if (mine.length) return { kind: 'party-fifo', sure: false, ...fifo(mine, amount), reason: 'payer_open_bills' };
  }

  // 5. only the amount to go on: suggest it when exactly one recent open bill has that balance
  const recent = open.filter((b) => Math.abs(b.balance - amount) <= EPS && (daysBetween(today, b.date) ?? 0) <= 45);
  if (recent.length === 1) return { kind: 'amount', sure: false, allocations: [{ id: recent[0].id, amount }], unapplied: 0, reason: 'unique_amount' };
  return none(recent.length > 1 ? 'several_amount_matches' : 'no_candidate');
}

// ---- applying a match to the store ----------------------------------------------------------------------------------------

/** Record the payment on each bill (idempotent by UTR), then file the event as matched. */
export async function applyMatch(store, evtRec, m, { by = 'auto' } = {}) {
  const cfg = collectSetup(store.app);
  if (!cfg) return { ok: false, error: 'no_table' };
  const e = evtRec.data;
  const pdate = String(e.at || '').slice(0, 10) || todayStr();
  const applied = [];
  if (m.kind === 'verify') {
    const rec = store.getRecord(cfg.table.id, m.verify.id);
    const rows = [...(rec?.data[cfg.pay.id] || [])];
    if (rec && rows[m.verify.index] && cfg.ref) {
      rows[m.verify.index] = { ...rows[m.verify.index], [cfg.ref.id]: e.utr };
      const res = await store.patchRecord(cfg.table.id, rec.id, { [cfg.pay.id]: rows }, { noRules: true });
      if (res.ok) applied.push({ id: rec.id, amount: toNum(e.amount), verified: true });
    }
  }
  for (const a of m.allocations || []) {
    const rec = store.getRecord(cfg.table.id, a.id);
    if (!rec) continue;
    const rows = rec.data[cfg.pay.id] || [];
    if (cfg.ref && rows.some((r) => r[cfg.ref.id] === e.utr)) continue;
    const row = { ...newRow(cfg.pay), [cfg.amount.id]: a.amount, [cfg.mode.id]: cfg.upiMode, _src: 'bank' };
    if (cfg.date) row[cfg.date.id] = pdate;
    if (cfg.ref) row[cfg.ref.id] = e.utr;
    // rules run: the bill turns Paid and the usual "payment received" WhatsApp receipt is queued
    const res = await store.patchRecord(cfg.table.id, rec.id, { [cfg.pay.id]: [...rows, row] });
    if (res.ok) applied.push({ id: rec.id, amount: a.amount });
  }
  if (applied.length && by === 'auto') {
    store.emit({ type: 'collected', amount: toNum(e.amount), verified: m.kind === 'verify', bills: applied.map((a) => store.getRecord(cfg.table.id, a.id)?.data.number || '') });
  }
  store.putSystemRecord(COLLECT_TABLE, evtRec.id, {
    ...e, status: 'matched', how: m.kind, by, matchedAt: store.now(),
    allocations: applied.length ? applied : m.kind === 'done' && m.billId ? [{ id: m.billId, amount: toNum(e.amount) }] : [],
    unapplied: m.unapplied || 0, suggestion: null,
  });
  return { ok: true, applied };
}

/** Owner put the money against bills by hand (or said it is not a sale). */
export async function settleManually(store, evtId, allocations, { by = 'owner' } = {}) {
  const rec = store.getRecord(COLLECT_TABLE, evtId);
  if (!rec) return { ok: false };
  const total = r2(allocations.reduce((s, a) => s + toNum(a.amount), 0));
  return applyMatch(store, rec, { kind: 'manual', allocations, unapplied: r2(Math.max(0, toNum(rec.data.amount) - total)) }, { by });
}
export function ignorePayment(store, evtId, note = '') {
  const rec = store.getRecord(COLLECT_TABLE, evtId);
  if (rec) store.putSystemRecord(COLLECT_TABLE, evtId, { ...rec.data, status: 'ignored', note, matchedAt: store.now() });
}

const sameSuggestion = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

/**
 * Match every payment that is still waiting. Sure matches are applied; the rest are filed for review with the best
 * suggestion. Events are only rewritten when something changed, so devices do not ping-pong sync traffic.
 */
export async function reconcileAll(store, { now = Date.now(), holdHours = 12 } = {}) {
  const cfg = collectSetup(store.app);
  if (!cfg) return { applied: 0, review: 0, waiting: 0 };
  let applied = 0, review = 0, waiting = 0;
  const queue = store.records(COLLECT_TABLE).filter((r) => r.data.status === 'new' || r.data.status === 'review')
    .sort((a, b) => String(a.data.at || '').localeCompare(String(b.data.at || '')));
  for (const ev of queue) {
    const bills = openBills(store, cfg);
    let m = matchPayment(ev.data, bills, { upiMode: cfg.upiMode });
    if (m.kind === 'wait') {
      if (now - Date.parse(ev.data.at || ev.created) < holdHours * 3600000) { waiting++; continue; }
      // its bill never arrived: the owner decides, with the best guess as a suggestion only
      m = { ...matchPayment(ev.data, bills, { upiMode: cfg.upiMode, holdRef: false }), sure: false };
    }
    if (m.sure) { await applyMatch(store, ev, m); applied++; continue; }
    review++;
    const suggestion = m.allocations.length ? { kind: m.kind, allocations: m.allocations, unapplied: m.unapplied } : null;
    if (ev.data.status !== 'review' || !sameSuggestion(ev.data.suggestion, suggestion)) {
      store.putSystemRecord(COLLECT_TABLE, ev.id, { ...ev.data, status: 'review', suggestion, reason: m.reason });
    }
  }
  return { applied, review, waiting };
}

/** Payments waiting for the owner, newest first. */
export const paymentsToReview = (store) => store.records(COLLECT_TABLE).filter((r) => r.data.status === 'review')
  .sort((a, b) => String(b.data.at || '').localeCompare(String(a.data.at || '')));

/**
 * UPI payments someone marked as received that the bank never confirmed: the "fake screenshot" check.
 * Only rows dated on or after the day Smart Collect was turned on, and older than `graceMinutes` (the confirmation
 * usually lands within seconds; a few minutes covers a slow network).
 */
export function unverifiedUpi(store, { graceMinutes = 15, now = new Date() } = {}) {
  const cfg = collectSetup(store.app);
  const since = store.settings.collect?.since || '';
  if (!cfg?.ref || !collectOn(store) || !since) return [];
  const out = [];
  const cutoff = new Date(now.getTime() - graceMinutes * 60000).toISOString();
  for (const r of store.records(cfg.table.id)) {
    if (r.data.cancelled || r.updated > cutoff) continue;
    (r.data[cfg.pay.id] || []).forEach((row, index) => {
      const day = cfg.date ? String(row[cfg.date.id] || '') : String(r.data.date || '');
      if (!/upi/i.test(row[cfg.mode.id] || '') || !isBlank(row[cfg.ref.id]) || day < since) return;
      out.push({ id: r.id, index, number: r.data.number || '', amount: toNum(row[cfg.amount.id]), date: day, by: r.by || '' });
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Bank confirmations this device may rely on, by UTR: { amount, bills, sandbox }.
 * Only records the sync server sent (`origin: 'server'`), and only the bank's facts the server attached to them
 * (`bank`: UTR, amount, source). The server creates these records solely from its signed webhook and restores the bank's
 * fields if a device changes them. A record this device wrote itself, or any flag or field it edited, never counts. Only events filed against bills (status matched); `bills` is where the owner or the matcher
 * put the money, so a real UTR typed onto a different bill does not count for that bill. `sandbox` marks simulated
 * payments, which are never bank-confirmed.
 */
export function bankConfirmations(store) {
  const out = new Map();
  for (const r of store.records(COLLECT_TABLE)) {
    // the bank's facts come only from the snapshot the server attached (`bank`), never from `data`, which devices edit
    const b = r.origin === 'server' ? r.bank : null;
    const d = r.data || {};
    if (!b?.utr || d.status !== 'matched') continue;
    out.set(String(b.utr), { amount: toNum(b.amount), bills: new Set((d.allocations || []).map((a) => a.id)), sandbox: b.source !== 'provider' });
  }
  return out;
}

/** Smart Collect numbers for the home screen and the credit passport. */
export function collectStats(store, { days = 30, today = todayStr() } = {}) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  let auto = 0, autoAmt = 0, manual = 0, total = 0;
  for (const r of store.records(COLLECT_TABLE)) {
    if (String(r.data.at || '').slice(0, 10) < from) continue;
    total++;
    if (r.data.status === 'matched' && r.data.by === 'auto') { auto++; autoAmt += toNum(r.data.amount); } else if (r.data.status === 'matched') manual++;
  }
  return { total, auto, manual, autoAmount: r2(autoAmt), autoRate: total ? auto / total : 0 };
}

/**
 * Shops set up before Smart Collect get, once: a "UTR / ref" column on their payments list (v1), and that list kept
 * as a ledger whose rows merge across devices instead of being replaced (v2). Used for the bank
 * reference of UPI and bank transfers, typed or filled in by Smart Collect.
 */
export function upgradeCollect(app, t) {
  if (!app || (app.collectV || 0) >= 2) return false;
  const cfg = collectSetup(app);
  if (cfg && !cfg.ref) cfg.pay.columns.push({ id: 'ref', label: t('UTR / ref'), type: 'text', remember: false });
  if (cfg) cfg.pay.ledger = true;   // v2: money rows are append-only and merge across devices (ledger.js)
  app.collectV = 2;
  return true;
}
