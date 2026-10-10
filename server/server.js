// Vina server: serves the app AND (optionally) keeps your devices in sync and backed up.
// Zero dependencies. Node 18+.   Run:  node server/server.js
//
//   PORT=8080  HOST=0.0.0.0  DATA_DIR=./data  ALLOW_NEW_WORKSPACES=true  CORS_ORIGIN=*  COLLECT_SANDBOX=true
//
// The app works fully offline without this server. The server only matters if you want the owner's laptop and the
// staff phone to see the same data, or an automatic off-device copy of the shop's records.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW_NEW = process.env.ALLOW_NEW_WORKSPACES !== 'false';
const CORS = process.env.CORS_ORIGIN ?? '*';
const MAX_BODY = 20 * 1024 * 1024;
const KEEP_BACKUPS = 14;
const SANDBOX = process.env.COLLECT_SANDBOX !== 'false';   // "Simulate a payment" in Settings; turn off in production

fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

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
const timers = new Map();
function persist(ws, doc) {
  clearTimeout(timers.get(ws));
  timers.set(ws, setTimeout(() => flush(ws, doc), 300));
}
function flush(ws, doc) {
  const f = fileFor(ws);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, f);
  dailyBackup(ws, f);
}
function dailyBackup(ws, file) {
  const day = new Date().toISOString().slice(0, 10);
  const id = path.basename(file, '.json');
  const dest = path.join(DATA_DIR, 'backups', `${id}-${day}.json`);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(file, dest);
    const mine = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((n) => n.startsWith(id)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(DATA_DIR, 'backups', old));
  }
}
process.on('SIGINT', () => { for (const [ws, doc] of cache) flush(ws, doc); process.exit(0); });
process.on('SIGTERM', () => { for (const [ws, doc] of cache) flush(ws, doc); process.exit(0); });

function hashToken(token, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(token), salt, 32).toString('hex') };
}
function tokenOk(doc, token) {
  const { hash } = hashToken(token, doc.auth.salt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(doc.auth.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- brute-force protection ----------------------------------------------------------------------------------------
const fails = new Map();
function limited(key) {
  const now = Date.now();
  const list = (fails.get(key) || []).filter((t) => now - t < 60000);
  fails.set(key, list);
  return list.length >= 8;
}
const noteFail = (key) => fails.set(key, [...(fails.get(key) || []), Date.now()]);

// ---- API ------------------------------------------------------------------------------------------------------------------
function authenticate(body, ip) {
  const { ws, token } = body || {};
  if (typeof ws !== 'string' || typeof token !== 'string' || !ws.trim() || token.length < 4) return { status: 400, error: 'Workspace name and a passphrase of at least 4 characters are required' };
  const key = `${ip}|${ws}`;
  if (limited(key)) return { status: 429, error: 'Too many attempts' };
  let doc = load(ws);
  if (!doc) {
    if (!ALLOW_NEW) return { status: 403, error: 'New workspaces are disabled on this server' };
    doc = { ws, auth: hashToken(token), seq: 0, app: null, records: {} };
    cache.set(ws, doc);
  } else if (!tokenOk(doc, token)) { noteFail(key); return { status: 403, error: 'Wrong workspace name or passphrase' }; }
  return { doc };
}

function handleSync(body, ip) {
  const a = authenticate(body, ip);
  if (a.error) return a;
  const { doc } = a;
  const accepted = new Set();
  let changed = false;

  for (let r of Array.isArray(body.records) ? body.records : []) {
    if (!r || typeof r.id !== 'string' || typeof r.table !== 'string' || typeof r.updated !== 'string') continue;
    const cur = doc.records[r.id];
    if (cur && cur.updated >= r.updated) continue;          // last edit wins
    if (r.table === '_collect' || cur?.table === '_collect') {
      // bank confirmations are created only by the webhook; devices may file them (matched, ignored) but never
      // invent one or change what the bank said
      if (!cur || r.table !== '_collect') continue;
      r = { ...r, deleted: false, data: { ...(r.data || {}), ...Object.fromEntries(BANK_FIELDS.map((k) => [k, cur.data[k]])) } };
    }
    doc.records[r.id] = { ...r, _seq: ++doc.seq };
    accepted.add(r.id);
    changed = true;
  }
  let appOut = null;
  if (body.app && typeof body.app === 'object' && body.app.updated && (!doc.app || body.app.updated > doc.app.updated)) {
    doc.app = body.app; doc.seq++; changed = true;
  } else if (doc.app && doc.app.updated > (body.appUpdated || '')) appOut = doc.app;

  const since = Number(body.since) || 0;
  const records = [];
  for (const r of Object.values(doc.records)) {
    if (r._seq > since && !accepted.has(r.id)) { const { _seq, ...rest } = r; records.push(rest); }
  }
  if (changed) { persist(doc.ws, doc); notify(doc.ws, doc.seq); }
  return { status: 200, json: { ok: true, seq: doc.seq, records, app: appOut } };
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
  return { status: 200, json: { format: 'vina-backup', version: 1, exported: new Date().toISOString(), app: doc.app, records: Object.values(doc.records).map(({ _seq, ...r }) => r) } };
}

// ---- Smart Collect: UPI payment confirmations from the collections provider ---------------------------------------------
// The provider (Decentro or any UPI collections API) POSTs to /api/collect/hook/<id> when money lands. The body is
// signed with the workspace's secret (HMAC-SHA256 of the raw body, hex, in X-Signature). A confirmed payment becomes a
// record in the `_collect` table, keyed by its UTR, so a retried or replayed webhook changes nothing. Devices pull it
// through the normal sync and match it to a bill (public/js/collect.js). The server never touches bills itself.
const INDEX_FILE = path.join(DATA_DIR, 'collect-index.json');
let hookIndex = {};
try { hookIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { hookIndex = {}; }
function saveIndex() {
  const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(hookIndex));
  fs.renameSync(tmp, INDEX_FILE);
}
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

function ingest(doc, e, source) {
  const id = `col_${crypto.createHash('sha256').update(e.utr).digest('hex').slice(0, 20)}`;
  if (doc.records[id]) return { status: 200, json: { ok: true, duplicate: true, id } };
  const now = new Date().toISOString();
  const { ok, status, ...data } = e;
  doc.records[id] = { id, table: '_collect', data: { ...data, status: 'new', source }, created: now, updated: now, deleted: false, by: null, _seq: ++doc.seq };
  persist(doc.ws, doc);
  notify(doc.ws, doc.seq);
  return { status: 200, json: { ok: true, id } };
}
function ensureHook(doc, rotate = false) {
  if (doc.collect && !rotate) return doc.collect;
  if (doc.collect) delete hookIndex[doc.collect.id];
  doc.collect = { id: crypto.randomBytes(12).toString('hex'), secret: crypto.randomBytes(24).toString('hex'), created: new Date().toISOString() };
  hookIndex[doc.collect.id] = doc.ws;
  saveIndex();
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
  if (limited(key)) return { status: 429, error: 'Too many attempts' };
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
function corsHeaders(req) {
  if (!CORS) return {};
  return { 'Access-Control-Allow-Origin': CORS, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = req.socket.remoteAddress || '';
    if (url.pathname.startsWith('/api/')) {
      const cors = corsHeaders(req);
      if (req.method === 'OPTIONS') return send(res, 204, '', cors);
      if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true }), { ...cors, 'Content-Type': 'application/json' });
      if (req.method !== 'POST') return send(res, 405, '{"error":"POST only"}', { ...cors, 'Content-Type': 'application/json' });
      const raw = await readRaw(req);
      const hook = /^\/api\/collect\/hook\/([0-9a-f]{24})$/.exec(url.pathname);
      if (hook) {
        const out = handleCollectHook(hook[1], raw, req.headers, ip);
        return send(res, out.status, JSON.stringify(out.json || { error: out.error }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      }
      const body = parseJson(raw);
      if (url.pathname === '/api/live') return handleLive(body, ip, req, res, cors);
      const routes = { '/api/sync': handleSync, '/api/export': handleExport, '/api/collect/setup': handleCollectSetup, '/api/collect/simulate': handleCollectSimulate };
      const out = routes[url.pathname] ? routes[url.pathname](body, ip) : { status: 404, error: 'Not found' };
      return send(res, out.status, JSON.stringify(out.json || { error: out.error }), { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then(() => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`Vina is running.\n  On this computer:  http://localhost:${PORT}`);
    for (const ip of ips) console.log(`  On your Wi-Fi:     http://${ip}:${PORT}   (phones on the same Wi-Fi can open this)`);
    console.log(`Data is kept in ${DATA_DIR}\nTip: the app installs and works offline only from https:// or localhost. See README.`);
  });
}
