// Money that two devices record at the same time must never disappear.
//
// A bill used to sync as one snapshot: the newer copy replaced the older one, so a ₹300 cash payment taken on one
// offline device vanished when another device's ₹500 UPI payment synced after it. This module makes financial rows
// behave like a ledger, and is shared by the devices and the sync server so both apply exactly the same rules:
//
//   * every payment row has a permanent id (`_id`), given once when it is recorded, offline included
//   * rows are append-only: correcting or removing one writes a reversal (`<field>__void`) and keeps the history
//   * the only change allowed to a saved row is filling in its bank reference once (`ref`: blank -> UTR)
//   * syncing merges: rows from both sides are kept (by id, so a repeated delivery adds nothing), reversals win
//   * the same bank payment (same UTR) is never counted twice, even if two devices each recorded it
//   * every record carries a version vector (`vv`: device -> number of edits). Edits made without seeing each other are
//     *concurrent*: plain fields then keep the newer value AND an explicit conflict note is stored on the record
//     (`__conflicts`) with what was kept and what was not. Nothing is resolved silently
//   * a bill deleted on one device while another recorded a payment on it is restored, with a note
//
// Totals (paid, balance, status) are never merged: each device recomputes them from the merged rows.
//
// Stock uses the same rules. An item's stock is a ledger of movements (`stock_moves`): every sale, purchase, return and
// correction is a row with its own id, and `stock` is their sum (a field with `moves` names its ledger). Two devices
// that each sell the same item offline add two rows, so both sales count after sync.
// Pure: no DOM, no storage. Node imports it in the server and the tests.

export const VOID = (field) => `${field}__void`;
export const CONFLICTS = '__conflicts';
export const isVoidKey = (k) => k.endsWith('__void');

// ---- small helpers ----------------------------------------------------------------------------------------------------
const meta = (k) => k.startsWith('_');
/** JSON with sorted keys, so equal objects compare equal whatever order their keys were written in. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export function hash(s) {
  let a = 0x811c9dc5, b = 0x9e3779b9 ^ s.length;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x5bd1e995) >>> 0; }
  return a.toString(36).padStart(7, '0') + b.toString(36).padStart(7, '0');
}
const blank = (v) => v === undefined || v === null || v === '';
/** What a row says about money: every non-meta value except the set-once bank reference. */
const body = (row, cols) => stable(Object.fromEntries(Object.keys(row).filter((k) => !meta(k) && k !== 'ref' && (!cols || cols.includes(k))).sort().map((k) => [k, row[k]])));
const byId = (rows) => new Map((rows || []).filter((r) => r && typeof r === 'object' && typeof r._id === 'string').map((r) => [r._id, r]));
const smaller = (x, y) => (stable(x) <= stable(y) ? x : y);

// ---- version vectors ---------------------------------------------------------------------------------------------------
export function bump(vv, device) { return { ...(vv || {}), [device]: ((vv || {})[device] || 0) + 1 }; }
export function maxVV(a = {}, b = {}) { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v); return out; }
/** 'eq' | 'lt' (a is older than b) | 'gt' | 'concurrent' (neither saw the other's edits) | 'none' (no versions) */
export function compareVV(a, b) {
  const ka = Object.keys(a || {}), kb = Object.keys(b || {});
  if (!ka.length && !kb.length) return 'none';
  let less = false, more = false;
  for (const k of new Set([...ka, ...kb])) {
    const x = (a || {})[k] || 0, y = (b || {})[k] || 0;
    if (x < y) less = true; else if (x > y) more = true;
  }
  return less && more ? 'concurrent' : less ? 'lt' : more ? 'gt' : 'eq';
}

// ---- ids for rows saved before rows had ids ----------------------------------------------------------------------------------
/**
 * Rows saved before this change have no id. Every device must give the same old row the same id, or the merge would
 * see two different payments. So the id comes from the record, the field, the row's content and how many identical
 * rows came before it (two ₹100 cash rows on one bill stay two rows).
 */
export function normalizeRows(recordId, field, rows) {
  const seen = new Map();
  return (rows || []).map((r) => {
    if (!r || typeof r !== 'object' || typeof r._id === 'string') return r;
    const key = stable(Object.fromEntries(Object.entries(r).filter(([k]) => !meta(k))));
    const k = seen.get(key) || 0;
    seen.set(key, k + 1);
    return { ...r, _id: `L${hash(`${recordId}|${field}|${key}|${k}`)}` };
  });
}
export function legacyIdOf(recordId, field, rows, index) { return normalizeRows(recordId, field, rows)[index]?._id; }

/**
 * An item saved before stock had movements has a number and no rows. Its first save turns that number into an opening
 * row whose id depends only on the item, so two devices that upgrade the same item write the same row, not two.
 */
export function openingRow(recordId, field, qty) { return { _id: `S${hash(`${recordId}|${field}|opening`)}`, qty, kind: 'opening' }; }

/** Fields that hold ledger rows in this record pair: declared ones, or any array whose rows carry ids. */
function ledgerKeys(a, b, declared = []) {
  const keys = new Set(declared);
  for (const d of [a, b]) for (const [k, v] of Object.entries(d || {})) {
    if (k === CONFLICTS || isVoidKey(k)) continue;
    if (Array.isArray(v) && v.some((r) => r && typeof r === 'object' && typeof r._id === 'string')) keys.add(k);
  }
  for (const d of [a, b]) for (const k of Object.keys(d || {})) if (isVoidKey(k)) keys.add(k.slice(0, -6));
  return [...keys];
}

// ---- local edits: a save turns into appends and reversals --------------------------------------------------------------------
/**
 * What a save may do to ledger rows: add rows, fill in a blank bank reference, and reverse rows. A row whose amount,
 * mode or date was changed becomes a reversal of the old row plus a new row; a row taken out becomes a reversal.
 * `cols` limits the comparison to the columns a person types (computed columns change by themselves).
 * `base` is the rows the editor started from (an edit form opened a while ago). Only rows the editor actually saw can
 * be taken out: a payment that synced in while the form was open is kept, and one reversed elsewhere meanwhile stays
 * reversed. Without `base`, the stored rows are the base (code that edits the current record).
 * Returns { rows, voids, notes }: notes are conflict notes for the record.
 */
export function applyLedgerEdits(recordId, field, prev, next, { newId, now, by, cols, base } = {}) {
  // rows saved before ids existed get the same id every device would give them; a save that passes them through
  // untouched (same content, same order) is recognised by that id, anything else typed without an id is new money
  const hadLegacy = (prev.rows || []).some((r) => r && typeof r._id !== 'string');
  const before = normalizeRows(recordId, field, prev.rows);
  const prevLive = byId(before);
  const voids = [...(prev.voids || [])];
  const voided = new Set(voids.map((v) => v._id));
  const incoming = hadLegacy ? normalizeRows(recordId, field, next) : (next || []);
  const keep = [];
  const taken = new Set();
  const notes = [];
  const seen = base ? byId(normalizeRows(recordId, field, base)) : prevLive;
  const reverse = (row, reason, extra = {}) => { voids.push({ ...row, _void: { reason, at: now, by, ...extra } }); voided.add(row._id); };
  for (const r of incoming) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r._id === 'string' && voided.has(r._id) && !taken.has(r._id)) {
      // reversed on another device while this editor was open: unchanged here, so it stays reversed; changed here,
      // so someone typed a new amount for it: keep that as new money and tell the owner
      const was = seen.get(r._id);
      if (was && body(was, cols) === body(r, cols)) { taken.add(r._id); continue; }
      const fresh = { ...r, _id: newId(), _at: now, _by: by };
      keep.push(fresh); taken.add(fresh._id);
      notes.push({ kind: 'edited-after-reversal', field, row: r._id, replacedBy: fresh._id });
      continue;
    }
    const old = typeof r._id === 'string' && !taken.has(r._id) ? prevLive.get(r._id) : null;
    if (!old) {
      // new money: a fresh permanent id, given now, on this device. A new row that already carries an id never seen on
      // this record keeps it: the caller chose it so that the same event recorded on two devices is one row (stock)
      const own = typeof r._id === 'string' && !prevLive.has(r._id) && !voided.has(r._id) && !taken.has(r._id);
      const fresh = { ...r, _id: own ? r._id : newId(), _at: now, _by: by };
      keep.push(fresh); taken.add(fresh._id);
      continue;
    }
    taken.add(old._id);
    if (r === old || (body(old, cols) === body(r, cols) && (blank(old.ref) || old.ref === r.ref))) {
      keep.push(blank(old.ref) && !blank(r.ref) ? { ...old, ref: r.ref } : old);   // unchanged, or its bank reference filled in
      continue;
    }
    // a correction: the old row is reversed and kept in history, the corrected amount is a new row
    const fresh = { ...r, _id: newId(), _at: now, _by: by };
    reverse(old, 'edited', { replacedBy: fresh._id });
    keep.push(fresh); taken.add(fresh._id);
  }
  for (const old of before) {
    if (!old || taken.has(old._id) || voided.has(old._id)) continue;
    if (seen.has(old._id)) reverse(old, 'removed');
    else keep.push(old);                     // arrived after this edit began: the editor never saw it, so it stays
  }
  return { rows: keep, voids, notes };
}

// ---- merging two copies of one record -------------------------------------------------------------------------------------------
function mergeRow(x, y, note) {
  if (stable(x) === stable(y)) return x;
  if (body(x) === body(y)) {
    // same money; the bank reference is set once: a filled one beats a blank one
    if (blank(x.ref) !== blank(y.ref)) return blank(x.ref) ? { ...x, ref: y.ref } : x;
    if (x.ref === y.ref) return smaller(x, y);
  }
  // an immutable row that differs on two devices should never happen: keep one deterministically, record both
  const kept = smaller(x, y);
  note({ kind: 'row', field: note.field, row: x._id, kept, lost: kept === x ? y : x });
  return kept;
}

/** Rows of one ledger field from both sides: union by id, reversals win, the same bank payment kept once. */
function mergeLedger(field, a, b, note, order) {
  const voids = new Map();
  for (const v of [...(a[VOID(field)] || []), ...(b[VOID(field)] || [])]) {
    if (!v || typeof v._id !== 'string') continue;
    const had = voids.get(v._id);
    // one payment corrected differently on two devices: both corrections stay (no money hidden), and the owner is told
    if (had && had._void?.replacedBy && v._void?.replacedBy && had._void.replacedBy !== v._void.replacedBy) {
      note({ kind: 'corrected-twice', field, row: v._id, replacements: [had._void.replacedBy, v._void.replacedBy].sort() });
    }
    voids.set(v._id, had ? smaller(had, v) : v);
  }
  const rows = new Map();
  const first = order === 'b' ? [b, a] : [a, b];
  for (const side of first) for (const r of side[field] || []) {
    if (!r || typeof r._id !== 'string') continue;
    rows.set(r._id, { ...(rows.has(r._id) ? mergeRow(rows.get(r._id), r, Object.assign((x) => note(x), { field })) : r) });
  }
  const live = [...rows.values()].filter((r) => !voids.has(r._id));
  const reverseAuto = (r, reason, of) => { voids.set(r._id, { ...r, _void: { reason, of, auto: true } }); };

  // the cashier's "UPI received" and the bank's confirmation of the same money, recorded on two devices: one payment
  for (const bank of live.filter((r) => r._src === 'bank' && !blank(r.ref))) {
    if (voids.has(bank._id) || live.some((r) => r !== bank && r.ref === bank.ref)) continue;
    const claim = live.filter((r) => r._src !== 'bank' && blank(r.ref) && /upi/i.test(r.mode || '') && Number(r.amount) === Number(bank.amount) && !voids.has(r._id))
      .sort((x, y) => (x._id < y._id ? -1 : 1))[0];
    if (!claim) continue;
    claim.ref = bank.ref;                       // set once: the counter entry is now bank-verified
    reverseAuto(bank, 'same payment as a counter entry', claim._id);
  }
  // the same UTR recorded twice (two devices matched the same bank payment): keep one
  const byRef = new Map();
  for (const r of live) if (!blank(r.ref) && !voids.has(r._id)) byRef.set(r.ref, [...(byRef.get(r.ref) || []), r]);
  for (const [ref, same] of byRef) {
    if (same.length < 2) continue;
    const amounts = new Set(same.map((r) => Number(r.amount)));
    if (amounts.size > 1) { note({ kind: 'ref', field, ref, rows: same.map((r) => r._id) }); continue; }
    const [keep, ...dupes] = same.sort((x, y) => (x._id < y._id ? -1 : 1));
    for (const d of dupes) reverseAuto(d, 'same bank payment recorded twice', keep._id);
  }
  // order: when each payment was recorded (the same on every device, whichever synced first); rows from before ids
  // existed have no time and keep their old order at the top
  const winnerOrder = (order === 'b' ? b : a)[field] || [];
  const pos = new Map(winnerOrder.map((r, i) => [r?._id, i]));
  const out = [...rows.values()].filter((r) => !voids.has(r._id))
    .sort((x, y) => String(x._at || '').localeCompare(String(y._at || '')) || (pos.has(x._id) ? pos.get(x._id) : 1e9) - (pos.has(y._id) ? pos.get(y._id) : 1e9) || (x._id < y._id ? -1 : 1));
  return { rows: out, voids: [...voids.values()].sort((x, y) => (x._id < y._id ? -1 : 1)) };
}

/**
 * Merge two copies of one record. `a` is the copy held here, `b` the one that arrived.
 *   derived  field ids whose values are computed (totals): never reported as conflicts
 *   ledger   field ids declared as ledgers (rows are also recognised by their ids)
 *   tie      which copy's plain fields to keep when both have the same version ('a' on devices, 'b' on the server)
 * Returns { record, changedA, changedB, conflicts }: changedA = the result differs from `a` (store it),
 * changedB = it differs from `b` (send it back / push it).
 */
export function mergeRecords(a, b, { derived = [], ledger = [], tie = 'a', now = new Date().toISOString() } = {}) {
  const ord = compareVV(a.vv, b.vv);
  const legacyNewer = (a.updated || '') >= (b.updated || '') ? 'a' : 'b';
  const winner = ord === 'gt' ? 'a' : ord === 'lt' ? 'b' : ord === 'eq' ? tie : ord === 'none' ? (a.updated === b.updated ? tie : legacyNewer)
    : (a.updated === b.updated ? (stable(a.data) <= stable(b.data) ? 'a' : 'b') : legacyNewer);
  const W = winner === 'a' ? a : b, L = winner === 'a' ? b : a;
  const ad = { ...(a.data || {}) }, bd = { ...(b.data || {}) };
  const keys = ledgerKeys(ad, bd, ledger);
  for (const k of keys) { ad[k] = normalizeRows(a.id, k, ad[k]); bd[k] = normalizeRows(b.id, k, bd[k]); }

  const notes = [];
  const note = (n) => notes.push(n);
  const data = { ...(W.data || {}) };
  for (const k of keys) {
    const m = mergeLedger(k, ad, bd, note, winner);
    data[k] = m.rows;
    if (m.voids.length) data[VOID(k)] = m.voids; else delete data[VOID(k)];
  }

  let deleted = !!W.deleted;
  if (ord === 'concurrent' || ord === 'none') {
    // plain fields edited on both devices without seeing each other: keep the newer, say so
    const skip = new Set([...derived, ...keys, CONFLICTS]);
    const fields = {};
    for (const k of new Set([...Object.keys(W.data || {}), ...Object.keys(L.data || {})])) {
      if (skip.has(k) || meta(k) || isVoidKey(k)) continue;
      if (stable((W.data || {})[k]) !== stable((L.data || {})[k])) fields[k] = { kept: (W.data || {})[k] ?? null, lost: (L.data || {})[k] ?? null };
    }
    if (ord === 'concurrent' && Object.keys(fields).length) note({ kind: 'edit', fields });
    // deleted on one device while the other recorded money on it: bring it back, so the money stays visible
    // (whichever copy is newer: the note says the same thing on every device)
    const del = W.deleted && !L.deleted ? W : L.deleted && !W.deleted ? L : null;
    if (del) {
      const seen = new Set(keys.flatMap((k) => (normalizeRows(del.id, k, (del.data || {})[k]) || []).map((r) => r._id)));
      const added = keys.flatMap((k) => data[k] || []).filter((r) => !seen.has(r._id));
      if (added.length) { deleted = false; note({ kind: 'restored', rows: added.map((r) => r._id) }); }
      else if (del === L && ord === 'concurrent') note({ kind: 'delete-undone' });
    }
  }

  // conflict notes: union by id (their ids come from what collided, so every device writes the same note once)
  const prior = new Map();
  for (const c of [...(ad[CONFLICTS] || []), ...(bd[CONFLICTS] || [])]) {
    if (!c?._id) continue;
    prior.set(c._id, prior.has(c._id) ? { ...smaller(prior.get(c._id), c), resolved: !!(prior.get(c._id).resolved || c.resolved) } : c);
  }
  for (const n of notes) {
    const id = `C${hash(`${a.id}|${stable(n)}`)}`;
    if (!prior.has(id)) prior.set(id, { _id: id, at: now, ...n });
  }
  if (prior.size) data[CONFLICTS] = [...prior.values()].sort((x, y) => String(x.at).localeCompare(String(y.at)) || (x._id < y._id ? -1 : 1));
  else delete data[CONFLICTS];

  const record = {
    ...W, data, deleted,
    vv: maxVV(a.vv, b.vv),
    created: [a.created, b.created].filter(Boolean).sort()[0] || W.created,
    updated: [a.updated || '', b.updated || ''].sort()[1] || W.updated,
  };
  delete record.dirty; delete record._seq;
  const same = (x) => stable(x.data || {}) === stable(record.data) && !!x.deleted === record.deleted && stable(x.vv || {}) === stable(record.vv);
  return { record, changedA: !same(a), changedB: !same(b), conflicts: notes };
}

/** Field ids that are computed in this table (formulas, auto numbers, values the GST engine fills in, stock summed from its movements). */
export function derivedFieldsOf(app, tableId) {
  const table = app?.tables?.find((x) => x.id === tableId);
  if (!table) return [];
  return table.fields.filter((f) => f.formula || f.auto || f.computed || f.moves).map((f) => f.id);
}
export function ledgerFieldsOf(app, tableId) {
  const table = app?.tables?.find((x) => x.id === tableId);
  return table ? table.fields.filter((f) => f.type === 'lines' && f.ledger).map((f) => f.id) : [];
}
