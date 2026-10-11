// Vina server: serves the app AND (optionally) keeps your devices in sync and backed up.
// Zero dependencies. Node 18+.   Run:  node server/server.js
//
//   PORT=8080  HOST=0.0.0.0  DATA_DIR=./data  ALLOW_NEW_WORKSPACES=true  SETUP_CODE=…  CORS_ORIGIN=  TRUST_PROXY=false  COLLECT_SANDBOX=true
//
// A new workspace is created only by a device that asks to create one AND gives the setup code. The code is printed
// when the server starts (and kept in DATA_DIR/setup-code.txt; SETUP_CODE sets your own). ALLOW_NEW_WORKSPACES=false
// turns creation off entirely. Joining an existing workspace needs only its name and passphrase.
//
// The app works fully offline without this server. The server only matters if you want the owner's laptop and the
// staff phone to see the same data, or an automatic off-device copy of the shop's records.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { protocolProblem, SERVER_ACCEPTS } from '../public/js/protocol.js';
import { mergeRecords, derivedFieldsOf, ledgerFieldsOf } from '../public/js/ledger.js';
import { computeRecord } from '../public/js/schema.js';
import '../public/gst/js/hooks.js';   // GST bills compute their totals with the GST engine, here as on the devices
import { passphraseProblem, workspaceKey, WORKSPACE_MIN, WORKSPACE_MAX } from '../public/js/security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW_NEW = process.env.ALLOW_NEW_WORKSPACES !== 'false';
// Which web pages may call the API. Unset: only pages served by this server (same origin). Otherwise a comma-separated
// list of exact origins (https://app.example.com), or * on purpose. TRUST_PROXY=true also accepts the host a reverse
// proxy reports (X-Forwarded-Host) as "this server".
const CORS_LIST = (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const MAX_BODY = 20 * 1024 * 1024;
const KEEP_BACKUPS = 14;
const SANDBOX = process.env.COLLECT_SANDBOX !== 'false';   // "Simulate a payment" in Settings; turn off in production

fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

// ---- setup code: who may create a workspace -----------------------------------------------------------------------------
// Without it, anyone who can reach the server could create workspaces (and fill its disk), and a typo in a workspace
// name on a new phone used to create an empty shop instead of saying the name was wrong.
const plainCode = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function loadSetupCode() {
  if (!ALLOW_NEW) return '';
  if (process.env.SETUP_CODE) return process.env.SETUP_CODE.trim();
  const f = path.join(DATA_DIR, 'setup-code.txt');
  try { const c = fs.readFileSync(f, 'utf8').trim(); if (c) return c; } catch { /* first start */ }
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const code = [0, 1, 2].map(() => Array.from({ length: 4 }, () => abc[crypto.randomInt(abc.length)]).join('')).join('-');
  fs.writeFileSync(f, `${code}\n`, { mode: 0o600 });
  return code;
}
export const SETUP_CODE = loadSetupCode();
function setupCodeOk(given) {
  if (!SETUP_CODE) return false;
  const a = crypto.createHash('sha256').update(plainCode(given)).digest(), b = crypto.createHash('sha256').update(plainCode(SETUP_CODE)).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---- workspace storage (JSON file per workspace, held in memory, written atomically) ----------------------------
const cache = new Map();
const fileFor = (ws) => path.join(DATA_DIR, `${crypto.createHash('sha256').update(ws).digest('hex').slice(0, 32)}.json`);

function load(ws) {
  if (cache.has(ws)) return cache.get(ws);
  const f = fileFor(ws);
  const doc = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  if (doc) cache.set(ws, doc);
  return doc;
}
// ---- durability: "saved" means on disk ------------------------------------------------------------------------------------
// Handlers change workspaces in memory and call persist() / afterCommit(). Nothing is answered until commit() has
// written every changed workspace durably: the bytes go to a temporary file, the file is fsync'd, renamed over the old
// one (atomic: a reader sees the old or the new file, never half of one), and the directory is fsync'd where the OS
// allows it. Only then is success returned and are other devices told. If any write fails, the request fails and
// the changed workspaces are dropped from memory, so the server falls back to what is on disk: it never keeps (or
// serves) a change it could not save. API requests that touch workspaces run one at a time (`exclusive`), so a failed
// write can never be overtaken by a later one built on top of it.
export const testHooks = { failWrites: false };
const pending = new Map();      // ws -> doc changed by the current request
let indexDirty = false;
let after = [];                 // things to do once the change is safe (tell devices, close old live feeds)
function persist(ws, doc) { pending.set(ws, doc); }
function afterCommit(fn) { after.push(fn); }
let tmpN = 0;
async function writeDurably(file, text) {
  if (testHooks.failWrites) throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
  const tmp = `${file}.${process.pid}.${++tmpN}.tmp`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file);
  } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
  await syncDir(path.dirname(file));
}
/** Make the rename itself durable. Windows cannot open a directory for this; NTFS journals the rename instead. */
async function syncDir(dir) {
  let d;
  try { d = await fsp.open(dir, 'r'); await d.sync(); } catch (e) { if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'EBADF'].includes(e.code)) throw e; } finally { await d?.close().catch(() => {}); }
}
async function commit() {
  const docs = [...pending.entries()], index = indexDirty, todo = after;
  pending.clear(); indexDirty = false; after = [];
  try {
    for (const [ws, doc] of docs) await writeDurably(fileFor(ws), JSON.stringify(doc));
    if (index) await writeDurably(INDEX_FILE, JSON.stringify(hookIndex));
  } catch (e) {
    // fall back to what is on disk: forget the unsaved versions
    for (const [ws, doc] of docs) { cache.delete(ws); if (doc.ws && doc.ws !== ws) cache.delete(doc.ws); }
    if (index) hookIndex = readIndex();
    console.error('write failed, nothing confirmed:', e.message);
    throw e;
  }
  for (const [ws] of docs) dailyBackup(ws, fileFor(ws));
  for (const fn of todo) { try { fn(); } catch (e) { console.error(e); } }
}
function rollbackPending() {
  for (const [ws, doc] of pending) { cache.delete(ws); if (doc.ws && doc.ws !== ws) cache.delete(doc.ws); }
  if (indexDirty) hookIndex = readIndex();
  pending.clear(); indexDirty = false; after = [];
}
let lane = Promise.resolve();
/** Run one request's read-change-write as a unit, one at a time; answers only after commit(). */
function exclusive(fn) {
  const run = lane.then(async () => {
    let out;
    try { out = await fn(); } catch (e) { rollbackPending(); throw e; }
    if (out && out.status >= 400) { await commit().catch(() => rollbackPending()); return out; }
    try { await commit(); } catch { return { status: 503, error: 'The server could not save this. Nothing was changed; it will be sent again.' }; }
    return out;
  });
  lane = run.catch(() => {});
  return run;
}
function dailyBackup(ws, file) {
  try { backupOnce(ws, file); } catch (e) { console.error('daily backup failed (the live file is safe):', e.message); }
}
function backupOnce(ws, file) {
  const day = new Date().toISOString().slice(0, 10);
  const id = path.basename(file, '.json');
  const dest = path.join(DATA_DIR, 'backups', `${id}-${day}.json`);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(file, dest);
    const mine = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((n) => n.startsWith(id)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(DATA_DIR, 'backups', old));
  }
}
// everything acknowledged is already on disk; just let a write in progress finish
process.on('SIGINT', () => lane.finally(() => process.exit(0)));
process.on('SIGTERM', () => lane.finally(() => process.exit(0)));

function hashToken(token, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(token), salt, 32).toString('hex') };
}
function tokenOk(doc, token) {
  const { hash } = hashToken(token, doc.auth.salt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(doc.auth.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- brute-force protection ----------------------------------------------------------------------------------------
// Failed attempts are limited per address and workspace (8 a minute) and per workspace from all addresses together
// (30 in 15 minutes, against guessing spread over many addresses). A device whose passphrase was already accepted is
// recognised without the slow hash and is never limited, so an attacker cannot lock the shop's own devices out.
const fails = new Map();
const PER_IP = [8, 60000], PER_WS = [30, 15 * 60000];
function limited(key, [max, ms]) {
  const now = Date.now();
  const list = (fails.get(key) || []).filter((t) => now - t < ms);
  if (list.length) fails.set(key, list); else fails.delete(key);
  return list.length >= max;
}
const noteFail = (...keys) => { for (const k of keys) fails.set(k, [...(fails.get(k) || []), Date.now()]); };
setInterval(() => { for (const k of [...fails.keys()]) limited(k, k.startsWith('ws|') ? PER_WS : PER_IP); }, 10 * 60000).unref();
const verified = new WeakMap();   // workspace doc -> sha256 of passphrases accepted since the server started
const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

// ---- API ------------------------------------------------------------------------------------------------------------------
const WRONG = 'Wrong workspace name or passphrase';
const WEAK = {
  short: 'Use a passphrase of at least 10 characters',
  simple: 'That passphrase has too few different characters',
  guessable: 'That passphrase is easy to guess (a common password, or the workspace name in it)',
};
/**
 * Every API call names a workspace and its passphrase. A workspace that does not exist is created only when the device
 * asks (`create: true`, sent by the first device of a shop) with the server's setup code and a strong passphrase.
 * Returns { doc, weak } or { status, error }. `weak`: the passphrase works but would not be accepted today.
 */
function authenticate(body, ip) {
  const { ws, token } = body || {};
  const name = typeof ws === 'string' ? ws.trim() : '';
  if (name.length < WORKSPACE_MIN || name.length > WORKSPACE_MAX || typeof token !== 'string' || !token || token.length > 200) {
    return { status: 400, error: `A workspace name (${WORKSPACE_MIN} to ${WORKSPACE_MAX} characters) and a passphrase are required` };
  }
  const norm = workspaceKey(name);
  let doc = load(name) || (norm !== name ? load(norm) : null);   // names made before matching ignored case: exact first
  const d = digest(token);
  if (doc && verified.get(doc)?.has(d)) return { doc, weak: !!passphraseProblem(token, doc.ws) };
  const keys = [`${ip}|${norm}`, `ws|${norm}`];
  if (limited(keys[0], PER_IP) || limited(keys[1], PER_WS)) return { status: 429, error: 'Too many attempts' };
  if (!doc) {
    if (!body.create) { noteFail(...keys); return { status: 403, error: WRONG }; }
    if (!ALLOW_NEW) return { status: 403, error: 'New workspaces are disabled on this server' };
    if (!setupCodeOk(body.setupCode)) { noteFail(...keys); return { status: 403, error: 'Wrong setup code. It is shown in the server window when it starts (and in setup-code.txt in its data folder)' }; }
    const weak = passphraseProblem(token, norm);
    if (weak) return { status: 400, error: WEAK[weak], code: `weak_${weak}` };
    doc = { ws: norm, auth: hashToken(token), seq: 0, app: null, records: {}, created: new Date().toISOString() };
    cache.set(norm, doc);
    persist(norm, doc);
  } else if (!tokenOk(doc, token)) { noteFail(...keys); return { status: 403, error: WRONG }; }
  if (!verified.has(doc)) verified.set(doc, new Set());
  verified.get(doc).add(d);
  return { doc, weak: !!passphraseProblem(token, doc.ws) };
}

/**
 * Change the workspace passphrase (a phone was lost, someone left). Devices still using the old one lose their live
 * feed at once and are refused from their next request until the new passphrase is typed on them.
 */
function handlePassphrase(body, ip) {
  const a = authenticate(body, ip);
  if (a.error) return a;
  const next = body.newToken;
  if (typeof next !== 'string' || next.length > 200) return { status: 400, error: 'A new passphrase is required' };
  const weak = passphraseProblem(next, a.doc.ws);
  if (weak) return { status: 400, error: WEAK[weak], code: `weak_${weak}` };
  a.doc.auth = hashToken(next);
  a.doc.authChanged = new Date().toISOString();
  verified.set(a.doc, new Set([digest(next)]));
  persist(a.doc.ws, a.doc);
  const ws = a.doc.ws;
  afterCommit(() => { for (const res of [...(watchers.get(ws) || [])]) res.end(); });
  return { status: 200, json: { ok: true } };
}

/**
 * Totals of a record the server has just combined from two copies, computed with the same engine the devices use,
 * so the copy kept here (and in backups, and on a device that downloads the shop) never has a stale "paid".
 */
function recompute(doc, rec) {
  const table = doc.app?.tables?.find((x) => x.id === rec.table);
  if (!table || rec.deleted) return rec;
  const ctx = {
    getRecord: (tb, id) => { const r = doc.records[id]; return r && r.table === tb && !r.deleted ? r : null; },
    getTable: (id) => doc.app.tables.find((x) => x.id === id),
    business: doc.app.settings?.business || {}, settings: doc.app.settings || {},
  };
  try { return { ...rec, data: computeRecord(table, rec.data, ctx) }; } catch (e) { console.error('recompute', e); return rec; }
}

/** What a device may send for a record. `origin` and `bank` (payment provenance) are only ever added by this server. */
const RECORD_KEYS = ['id', 'table', 'data', 'created', 'updated', 'deleted', 'approval', 'by', 'vv'];

function handleSync(body, ip) {
  const a = authenticate(body, ip);
  if (a.error) return a;
  const { doc } = a;
  const accepted = new Set();
  const resend = new Map();
  let changed = false;

  // the app definition first: it says which fields are money ledgers and which are computed
  let appOut = null;
  if (body.app && typeof body.app === 'object' && body.app.updated && (!doc.app || body.app.updated > doc.app.updated)) {
    doc.app = body.app; doc.seq++; changed = true;
  } else if (doc.app && doc.app.updated > (body.appUpdated || '')) appOut = doc.app;

  for (let r of Array.isArray(body.records) ? body.records : []) {
    if (!r || typeof r.id !== 'string' || typeof r.table !== 'string' || typeof r.updated !== 'string') continue;
    // only the fields a record has; anything else a device sends (an origin stamp, a bank snapshot...) is dropped
    r = Object.fromEntries(RECORD_KEYS.filter((k) => k in r).map((k) => [k, r[k]]));
    const cur = doc.records[r.id];
    if (r.table === '_collect' || cur?.table === '_collect') {
      // bank confirmations are created only by the webhook; devices may file them (matched, ignored) but never
      // invent one or change what the bank said
      if (!cur || r.table !== '_collect' || cur.updated >= r.updated) continue;
      const tampered = BANK_FIELDS.some((k) => JSON.stringify(r.data?.[k] ?? null) !== JSON.stringify(cur.data[k] ?? null));
      const { origin, bank, ...sent } = r;
      r = { ...sent, deleted: false, data: { ...(r.data || {}), ...Object.fromEntries(BANK_FIELDS.map((k) => [k, cur.data[k]])) } };
      // the device's copy said something else about the money: send the bank's version back, newer, so it replaces it
      if (tampered) r.updated = new Date(Math.max(Date.now(), Date.parse(sent.updated) + 1)).toISOString();
      doc.records[r.id] = { ...r, _seq: ++doc.seq };
      if (!tampered) accepted.add(r.id);
      changed = true;
      continue;
    }
    if (!cur) { doc.records[r.id] = { ...r, _seq: ++doc.seq }; accepted.add(r.id); changed = true; continue; }
    // never "newest copy wins" for a whole record: merge (public/js/ledger.js). Payments from both copies are kept,
    // a repeated delivery adds nothing, and edits that did not see each other leave a conflict note on the record.
    const { _seq, ...held } = cur;
    const m = mergeRecords(held, r, { derived: derivedFieldsOf(doc.app, r.table), ledger: ledgerFieldsOf(doc.app, r.table), tie: 'b' });
    if (!m.changedA) {
      if (m.changedB) resend.set(r.id, held);             // the device is missing something the server has
      continue;
    }
    const merged = m.changedB ? recompute(doc, m.record) : m.record;
    doc.records[r.id] = { ...merged, _seq: ++doc.seq };
    if (!m.changedB) accepted.add(r.id);                   // otherwise it goes back so the device gets the combination
    changed = true;
  }

  const since = Number(body.since) || 0;
  const records = [...resend.values()].map(outgoing);
  for (const r of Object.values(doc.records)) {
    if (r._seq > since && !accepted.has(r.id) && !resend.has(r.id)) { const { _seq, ...rest } = r; records.push(outgoing(rest)); }
  }
  if (changed) { persist(doc.ws, doc); afterCommit(() => notify(doc.ws, doc.seq)); }
  return { status: 200, json: { ok: true, seq: doc.seq, records, app: appOut, ws: doc.ws, ...(a.weak ? { weak: true } : {}) } };
}

// ---- live channel: devices hold one streaming response open and are told the moment anything changes -----------
// The message carries only the new sequence number; the device then pulls the changes through /api/sync as usual,
// so the data path (and its auth and merge rules) stays in one place.
const watchers = new Map();   // ws -> Set<res>
const HEARTBEAT_MS = 25000;
function notify(ws, seq) {
  for (const res of watchers.get(ws) || []) res.write(`data: ${JSON.stringify({ seq })}\n\n`);
}
function handleLive(body, ip, req, res, cors) {
  const a = authenticate(body, ip);
  if (a.error) return send(res, a.status, JSON.stringify({ error: a.error }), { ...cors, 'Content-Type': 'application/json' });
  const { doc } = a;
  res.writeHead(200, { ...SECURITY, ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.write(`data: ${JSON.stringify({ seq: doc.seq })}\n\n`);
  if (!watchers.has(doc.ws)) watchers.set(doc.ws, new Set());
  watchers.get(doc.ws).add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  res.on('close', () => { clearInterval(beat); watchers.get(doc.ws)?.delete(res); });
}

function handleExport(body, ip) {
  const a = authenticate(body, ip);
  if (a.error) return a;
  const { doc } = a;
  return { status: 200, json: { format: 'vina-backup', version: 1, exported: new Date().toISOString(), app: doc.app, records: Object.values(doc.records).map(({ _seq, ...r }) => outgoing(r)) } };
}

// ---- Smart Collect: UPI payment confirmations from the collections provider ---------------------------------------------
// The provider (Decentro or any UPI collections API) POSTs to /api/collect/hook/<id> when money lands. The body is
// signed with the workspace's secret (HMAC-SHA256 of the raw body, hex, in X-Signature). A confirmed payment becomes a
// record in the `_collect` table, keyed by its UTR, so a retried or replayed webhook changes nothing. Devices pull it
// through the normal sync and match it to a bill (public/js/collect.js). The server never touches bills itself.
const INDEX_FILE = path.join(DATA_DIR, 'collect-index.json');
function readIndex() { try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return {}; } }
let hookIndex = readIndex();   // written durably by commit() (indexDirty)
export const signBody = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

const pick = (o, keys) => {
  for (const k of keys) { const v = o?.[k]; if (v !== undefined && v !== null && v !== '') return v; }
  return undefined;
};
const OK_STATUS = new Set(['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'PAID', 'CREDITED', 'CREDIT', 'S']);
/**
 * Provider payload -> { ok, utr, amount, ref, vpa, name, phone, at }. Tolerant of common field names (utr / rrn /
 * bank_reference_number, reference_id / tr, payer_vpa ...), flat or under `data`. Map a provider's exact contract
 * here when integrating; nothing else in the system depends on its shape.
 */
export function normalizeEvent(body) {
  const o = body && typeof body === 'object' ? (body.data && typeof body.data === 'object' ? { ...body, ...body.data } : body) : {};
  const status = String(pick(o, ['status', 'transaction_status', 'txn_status', 'payment_status']) ?? 'SUCCESS').toUpperCase();
  const at = new Date(pick(o, ['timestamp', 'transaction_time', 'txn_time', 'at']) || Date.now());
  return {
    ok: OK_STATUS.has(status), status,
    utr: String(pick(o, ['utr', 'rrn', 'bank_reference_number', 'bank_ref', 'npci_transaction_id']) ?? '').trim(),
    amount: Math.round(Number(pick(o, ['amount', 'transaction_amount', 'txn_amount'])) * 100) / 100,
    ref: String(pick(o, ['reference', 'reference_id', 'tr', 'merchant_reference', 'merchant_transaction_id']) ?? '').trim().toUpperCase().slice(0, 35),
    vpa: String(pick(o, ['payer_vpa', 'payer_upi', 'payer_address', 'vpa']) ?? '').trim().slice(0, 100),
    name: String(pick(o, ['payer_name', 'payer_account_name', 'name']) ?? '').trim().slice(0, 100),
    phone: String(pick(o, ['payer_mobile', 'payer_phone', 'mobile']) ?? '').replace(/[^\d+]/g, '').slice(0, 15),
    at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
  };
}
const BANK_FIELDS = ['utr', 'amount', 'ref', 'vpa', 'name', 'phone', 'at', 'source'];
const validEvent = (e) => /^[A-Za-z0-9-]{6,40}$/.test(e.utr) && Number.isFinite(e.amount) && e.amount > 0 && e.amount < 1e8;

/**
 * Payment confirmations exist on this server only because the signed webhook (or, in sandbox, the simulator) created
 * them: devices cannot create one, and the bank's fields are restored if a device changes them (handleSync). Every
 * copy sent out says so (`origin: 'server'`) and carries the bank's facts separately (`bank`: UTR, amount, source...),
 * a copy no device code writes. Devices count a payment as bank-confirmed only from that snapshot (collect.js
 * bankConfirmations), never from anything a device wrote itself.
 */
const outgoing = (r) => (r.table === '_collect'
  ? { ...r, origin: 'server', bank: Object.fromEntries(BANK_FIELDS.map((k) => [k, r.data?.[k] ?? null])) }
  : r);

function ingest(doc, e, source) {
  const id = `col_${crypto.createHash('sha256').update(e.utr).digest('hex').slice(0, 20)}`;
  if (doc.records[id]) return { status: 200, json: { ok: true, duplicate: true, id } };
  const now = new Date().toISOString();
  const { ok, status, ...data } = e;
  doc.records[id] = { id, table: '_collect', origin: 'server', data: { ...data, status: 'new', source }, created: now, updated: now, deleted: false, by: null, _seq: ++doc.seq };
  persist(doc.ws, doc);
  afterCommit(() => notify(doc.ws, doc.seq));
  return { status: 200, json: { ok: true, id } };
}
function ensureHook(doc, rotate = false) {
  if (doc.collect && !rotate) return doc.collect;
  if (doc.collect) delete hookIndex[doc.collect.id];
  doc.collect = { id: crypto.randomBytes(12).toString('hex'), secret: crypto.randomBytes(24).toString('hex'), created: new Date().toISOString() };
  hookIndex[doc.collect.id] = doc.ws;
  indexDirty = true;
  persist(doc.ws, doc);
  return doc.collect;
}
function handleCollectSetup(body, ip) {
  const a = authenticate(body, ip);
  if (a.error) return a;
  const c = ensureHook(a.doc, !!body.rotate);
  return { status: 200, json: { ok: true, hookPath: `/api/collect/hook/${c.id}`, secret: c.secret, sandbox: SANDBOX } };
}
function handleCollectHook(id, raw, headers, ip) {
  const key = `hook|${ip}`;
  if (limited(key, PER_IP)) return { status: 429, error: 'Too many attempts' };
  const ws = hookIndex[id];
  const doc = ws ? load(ws) : null;
  if (!doc?.collect || doc.collect.id !== id) { noteFail(key); return { status: 404, error: 'Unknown hook' }; }
  const got = String(headers['x-signature'] || headers['x-webhook-signature'] || '').trim().replace(/^sha256=/i, '').toLowerCase();
  const want = signBody(doc.collect.secret, raw);
  const ok = got.length === want.length && /^[0-9a-f]+$/.test(got) && crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
  if (!ok) { noteFail(key); return { status: 401, error: 'Bad signature' }; }
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, error: 'Bad JSON' }; }
  const e = normalizeEvent(body);
  if (!e.ok) return { status: 200, json: { ok: true, ignored: e.status } };   // failed / pending payments are not money
  if (!validEvent(e)) return { status: 400, error: 'Missing UTR or amount' };
  return ingest(doc, e, 'provider');
}
/** Sandbox: pretend the bank confirmed a payment, through the same path a real one takes. */
function handleCollectSimulate(body, ip) {
  if (!SANDBOX) return { status: 403, error: 'Sandbox payments are turned off on this server' };
  const a = authenticate(body, ip);
  if (a.error) return a;
  ensureHook(a.doc);
  const e = normalizeEvent({
    status: 'SUCCESS', amount: body.amount, reference: body.ref, payer_vpa: body.vpa, payer_name: body.name, payer_mobile: body.phone,
    utr: body.utr || `SIM${Date.now().toString().slice(-9)}${crypto.randomInt(100, 999)}`,
  });
  if (!validEvent(e)) return { status: 400, error: 'Missing UTR or amount' };
  return ingest(a.doc, e, 'sandbox');
}

// ---- http -------------------------------------------------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src *; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
}
const corsFor = (origin) => ({
  'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600', ...(origin === '*' ? {} : { Vary: 'Origin' }),
});
/**
 * May this request use the API? A request without an Origin header is not from a web page (the payment provider's
 * webhook, a script): CORS does not apply, and it still needs the passphrase or the webhook signature. A web page is
 * allowed if it was served by this server, or its origin is listed in CORS_ORIGIN. Anything else is refused here,
 * by the server, not only by the browser (a browser sends some cross-site requests before asking permission).
 * Returns { ok, headers }.
 */
function originCheck(req) {
  const origin = req.headers.origin;
  if (!origin) return { ok: true, headers: {} };
  if (CORS_LIST.includes('*')) return { ok: true, headers: corsFor('*') };
  if (CORS_LIST.includes(origin)) return { ok: true, headers: corsFor(origin) };
  let host = '';
  try { host = new URL(origin).host; } catch { host = ''; }
  const mine = [req.headers.host, TRUST_PROXY ? req.headers['x-forwarded-host'] : '']
    .filter(Boolean).flatMap((h) => String(h).split(',').map((x) => x.trim().toLowerCase()));
  if (host && mine.includes(host.toLowerCase())) return { ok: true, headers: {} };   // same origin: no CORS needed
  return { ok: false, headers: {} };
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJson(raw) {
  try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

/** API calls from devices that read or write shop records: only for a compatible sync protocol (protocol.js). */
const GATED = new Set(['/api/sync', '/api/live', '/api/passphrase', '/api/collect/setup', '/api/collect/simulate']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = req.socket.remoteAddress || '';
    if (url.pathname.startsWith('/api/')) {
      const oc = originCheck(req);
      if (!oc.ok) {
        return send(res, 403, JSON.stringify({ error: 'This web site may not use the sync API (origin not allowed). The server owner can allow it with CORS_ORIGIN.' }),
          { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' });
      }
      const cors = oc.headers;
      if (req.method === 'OPTIONS') return send(res, 204, '', cors);
      if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true }), { ...cors, 'Content-Type': 'application/json' });
      if (req.method !== 'POST') return send(res, 405, '{"error":"POST only"}', { ...cors, 'Content-Type': 'application/json' });
      const raw = await readRaw(req);
      const hook = /^\/api\/collect\/hook\/([0-9a-f]{24})$/.exec(url.pathname);
      if (hook) {
        const out = await exclusive(() => handleCollectHook(hook[1], raw, req.headers, ip));
        return send(res, out.status, JSON.stringify(out.json || { error: out.error }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      }
      const body = parseJson(raw);
      // devices outside the accepted sync protocols are turned away before anything is read, created or changed
      if (GATED.has(url.pathname)) {
        const bad = protocolProblem(body?.protocol);
        if (bad) return send(res, bad.status, JSON.stringify({ error: bad.error, code: bad.code, accepts: SERVER_ACCEPTS }), { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/api/live') return exclusive(() => { handleLive(body, ip, req, res, cors); return null; });
      const routes = { '/api/sync': handleSync, '/api/export': handleExport, '/api/passphrase': handlePassphrase, '/api/collect/setup': handleCollectSetup, '/api/collect/simulate': handleCollectSimulate };
      const out = routes[url.pathname] ? await exclusive(() => routes[url.pathname](body, ip)) : { status: 404, error: 'Not found' };
      return send(res, out.status, JSON.stringify(out.json || { error: out.error, ...(out.code ? { code: out.code } : {}) }), { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    }
    // static files
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      // always revalidate so a new version reaches shops quickly; the service worker handles offline
      res.writeHead(200, { ...SECURITY, 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache', ...(file.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/' } : {}) });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) {
    send(res, e.status || 500, JSON.stringify({ error: e.status ? e.message : 'Server error' }), { 'Content-Type': 'application/json' });
    if (!e.status) console.error(e);
  }
});

export function start(port = PORT, host = HOST) {
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
export { server };
export { authenticate as _authenticate };   // tests: guessing from many addresses without needing many addresses

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then(() => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`Vina is running.\n  On this computer:  http://localhost:${PORT}`);
    for (const ip of ips) console.log(`  On your Wi-Fi:     http://${ip}:${PORT}   (phones on the same Wi-Fi can open this)`);
    console.log(`Data is kept in ${DATA_DIR}\nTip: the app installs and works offline only from https:// or localhost. See README.`);
    console.log(SETUP_CODE ? `Setup code for connecting a shop's first device: ${SETUP_CODE}   (other devices only need the workspace name and passphrase)` : 'New workspaces are turned off (ALLOW_NEW_WORKSPACES=false).');
  });
}
