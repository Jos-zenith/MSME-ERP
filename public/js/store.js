// The data store: app definition + records (in memory, mirrored to the storage adapter),
// rules, outbox, approvals, counters. Local-first: everything works without a network.
import { runRules, runScheduled } from './rules.js';
import {
  computeRecord, cleanRecord, validateRecord, findDuplicates, newRecordData, uid, normPhone, setLocale, hooksFor, suggestCode, isBlank, rowIsBlank,
} from './schema.js';
import { renderTemplate } from './logic.js';
import { todayStr, toNum } from './formula.js';
import { t } from './i18n.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
// Backup files say what they are. Files made before the app was renamed to Vina say 'msme-builder-backup' and still restore.
export const BACKUP_FORMAT = 'vina-backup';
export const BACKUP_FORMATS = [BACKUP_FORMAT, 'msme-builder-backup'];
const enc = encodeURIComponent;

/** wa.me / sms: / mailto: link. Works with a normal WhatsApp app: no paid API needed. */
export function buildShareLink(channel, to, subject, body, cc = '91') {
  const p = normPhone(to, cc);
  if (channel === 'whatsapp') return p ? `https://wa.me/${p}?text=${enc(body)}` : `https://wa.me/?text=${enc(body)}`;
  if (channel === 'sms') return `sms:${p ? '+' + p : ''}?body=${enc(body)}`;
  if (channel === 'email') return `mailto:${to}?subject=${enc(subject)}&body=${enc(body)}`;
  return '';
}

export class Store {
  constructor({ db, now = () => new Date().toISOString() }) {
    this.db = db;
    this.now = now;
    this.app = null;
    this.meta = { counters: {}, runs: {} };
    this.byTable = new Map();
    this.outbox = new Map();
    this.listeners = new Set();
    this._chain = Promise.resolve();
  }

  // ---- lifecycle ---------------------------------------------------------------
  async init() {
    const { meta, records, outbox } = await this.db.load();
    this.meta = { counters: {}, runs: {}, ...meta };
    delete this.meta.app;
    this.app = meta.app || null;
    for (const r of records) this._put(r);
    for (const o of outbox) this.outbox.set(o.id, o);
    if (!this.meta.device) { this.meta.device = uid().slice(0, 8); this._persistMeta('device'); }
    if (!this.meta.firstRun) { this.meta.firstRun = this.now(); this._persistMeta('firstRun'); }
    this._applyLocale();
    return !!this.app;
  }
  _applyLocale() {
    const s = this.app?.settings;
    if (s) setLocale({ lang: s.lang || 'en', locale: s.currency?.locale || 'en-IN', symbol: s.currency?.symbol || '₹', currency: s.currency?.code || 'INR' });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt) {
    if (evt.type === 'record' || evt.type === 'app') this._memo = null;
    for (const fn of this.listeners) { try { fn(evt); } catch (e) { console.error(e); } }
  }
  /** Cached per-table answers that only change when a record changes. */
  _memoize(key, fn) {
    this._memo ||= new Map();
    if (!this._memo.has(key)) this._memo.set(key, fn());
    return this._memo.get(key);
  }
  _queue(fn) { this._chain = this._chain.then(fn).catch((e) => console.error('storage error', e)); return this._chain; }
  flush() { return this._chain; }
  _persistMeta(k) { const v = k === 'app' ? this.app : this.meta[k]; return this._queue(() => this.db.putMeta(k, v)); }
  _persistRecord(rec) { return this._queue(() => this.db.putRecords([rec])); }

  // ---- app definition ------------------------------------------------------------
  setApp(app, { fromSync = false } = {}) {
    this.app = app;
    if (!fromSync) { this.app.updated = this.now(); this.meta.appDirty = true; this._persistMeta('appDirty'); }
    this._applyLocale();
    this._persistMeta('app');
    this.emit({ type: 'app' });
  }
  touchApp() { this.setApp(this.app); }
  table(id) { return this.app?.tables.find((t) => t.id === id); }
  /** Staff (signed in with the staff PIN) may only add to tables marked staff: 'full' (the default). */
  canAddTo(tableId) { return this.currentUser !== 'staff' || (this.table(tableId)?.staff || 'full') === 'full'; }
  /**
   * Shops set up before per-table staff access existed get the same defaults as new ones: staff can look up items
   * but not change prices, and do not see purchases (cost prices) or suppliers. Only fills settings never made.
   */
  migrateAccess() {
    if (!this.app || this.app.accessV) return false;
    const defaults = { items: 'view', purchases: 'none', suppliers: 'none' };
    if (['retail', 'gst'].includes(this.app.template)) for (const tb of this.app.tables) if (defaults[tb.id] && !tb.staff) tb.staff = defaults[tb.id];
    this.app.accessV = 1;
    this.setApp(this.app);
    return true;
  }
  get settings() { return this.app?.settings || {}; }
  get business() { return this.settings.business || {}; }
  ctx() {
    const self = this;
    return {
      getRecord: (t, id) => self.byTable.get(t)?.get(id) || null,
      getTable: (id) => self.table(id),
      get business() { return self.business; },
      get settings() { return self.settings; },
    };
  }

  // ---- records ---------------------------------------------------------------------
  _put(rec) {
    if (!this.byTable.has(rec.table)) this.byTable.set(rec.table, new Map());
    this.byTable.get(rec.table).set(rec.id, rec);
  }
  getRecord(tableId, id) { const r = this.byTable.get(tableId)?.get(id); return r && !r.deleted ? r : null; }
  records(tableId) { return [...(this.byTable.get(tableId)?.values() || [])].filter((r) => !r.deleted); }
  count(tableId) { let n = 0; for (const r of this.byTable.get(tableId)?.values() || []) if (!r.deleted) n++; return n; }
  blankData(tableId) { return newRecordData(this.table(tableId)); }

  nextNumber(table, field) {
    const key = `${table.id}.${field.id}`;
    const { prefix = '', pad = 4 } = field.auto || {};
    const tag = this.settings.deviceTag || '';
    const taken = new Set(this.records(table.id).map((r) => r.data[field.id]));
    let n = this.meta.counters[key] || 0, out;
    do { n++; out = `${prefix}${tag}${String(n).padStart(pad, '0')}`; } while (taken.has(out));
    this.meta.counters[key] = n;
    this._persistMeta('counters');
    return out;
  }

  // ---- memory: what this shop keeps typing, so it does not have to ----------------------------------------
  /**
   * id -> score for records of `tableId`, from how often (and how recently) other records link to them.
   * The customers and items you use most are offered first, before you type anything.
   */
  usage(tableId) {
    return this._memoize(`usage:${tableId}`, () => {
      const score = new Map();
      const now = Date.now();
      const add = (id, when) => {
        if (isBlank(id)) return;
        const days = Math.max(0, (now - new Date(when || 0).getTime()) / 86400000);
        score.set(id, (score.get(id) || 0) + 1 / (1 + days / 30));
      };
      for (const tb of this.app?.tables || []) {
        const links = tb.fields.filter((f) => f.type === 'lookup' && f.ref === tableId);
        const lines = tb.fields.filter((f) => f.type === 'lines').map((f) => [f, (f.columns || []).filter((c) => c.type === 'lookup' && c.ref === tableId)]).filter(([, c]) => c.length);
        if (!links.length && !lines.length) continue;
        for (const r of this.records(tb.id)) {
          for (const f of links) add(r.data[f.id], r.updated);
          for (const [f, cols] of lines) for (const row of r.data[f.id] || []) for (const c of cols) add(row[c.id], r.updated);
        }
      }
      return score;
    });
  }

  /** Values already typed into a text field, most used first (offered as suggestions: city, supplier, ...). */
  pastValues(tableId, fieldId, limit = 40) {
    return this._memoize(`past:${tableId}.${fieldId}`, () => {
      const n = new Map();
      for (const r of this.records(tableId)) {
        const v = String(r.data[fieldId] ?? '').trim();
        if (v) n.set(v, (n.get(v) || 0) + 1);
      }
      return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([v]) => v);
    });
  }

  /**
   * What a party (customer, supplier) usually takes on `table`: its most frequent line items with the
   * quantity they took last time, and its most recent record. Without a party: the shop's best sellers.
   */
  usualLines(table, linesField, partyField, partyId, limit = 6) {
    return this._memoize(`usual:${table.id}.${linesField.id}.${partyField?.id}.${partyId || ''}`, () => {
      const itemCol = (linesField.columns || []).find((c) => c.type === 'lookup');
      const qtyId = linesField.qtyColumn || 'qty';
      if (!itemCol) return { items: [], last: null };
      const recs = this.records(table.id)
        .filter((r) => (partyId ? r.data[partyField.id] === partyId : true))
        .sort((a, b) => (a.created < b.created ? 1 : -1));
      const pool = partyId ? recs : recs.slice(0, 200);
      const freq = new Map();
      for (const r of pool) {
        for (const row of r.data[linesField.id] || []) {
          const id = row[itemCol.id];
          if (isBlank(id) || !this.getRecord(itemCol.ref, id)) continue;
          const x = freq.get(id) || { id, times: 0, qty: row[qtyId] ?? 1 };
          x.times++;
          freq.set(id, x);
        }
      }
      const items = [...freq.values()].sort((a, b) => b.times - a.times).slice(0, limit);
      const last = partyId ? recs.find((r) => (r.data[linesField.id] || []).some((row) => !rowIsBlank(linesField, row))) || null : null;
      return { items, last, itemTable: itemCol.ref, itemColumn: itemCol.id };
    });
  }

  /** Code for a field marked `autoCode: 'name'` when it is left empty (item codes: "Sugar 1kg" -> "SUG1"). */
  suggestCode(table, f, data) {
    const taken = new Set(this.records(table.id).map((r) => String(r.data[f.id] ?? '').toUpperCase()));
    return suggestCode(data[f.autoCode], taken);
  }

  /** Soft duplicate hints (e.g. same phone) - shown to the user, never blocking. */
  softDuplicates(tableId, data, selfId) {
    const table = this.table(tableId);
    const out = [];
    for (const f of table.fields.filter((x) => x.warnDuplicate)) {
      const matches = findDuplicates(table, f.id, data, this.records(tableId), selfId);
      if (matches.length) out.push({ field: f.id, matches });
    }
    return out;
  }

  /**
   * Create or update a record. Runs: cleanup -> auto numbers -> formulas -> validation -> "before save"
   * rules -> persist -> after-save rules.
   * Returns { ok, record } or { ok:false, errors } / { ok:false, blocked }.
   */
  async saveRecord(tableId, input, { id, depth = 0, by, noRules = false } = {}) {
    const table = this.table(tableId);
    if (!table) throw new Error(`Unknown table ${tableId}`);
    const existing = id ? this.byTable.get(tableId)?.get(id) : null;
    const prev = existing ? clone(existing) : null;
    const ctx = this.ctx();
    let data = cleanRecord(table, { ...(existing?.data || newRecordData(table)), ...input });
    for (const f of table.fields) {
      if (f.auto && !data[f.id]) data[f.id] = this.nextNumber(table, f);
      if (f.autoCode && isBlank(data[f.id])) data[f.id] = this.suggestCode(table, f, data);
    }
    const numbering = hooksFor(table)?.number;
    if (numbering && !data[numbering.field]) data[numbering.field] = numbering.next(this, table, data);
    data = computeRecord(table, data, ctx);
    const errors = validateRecord(table, data, ctx);
    for (const f of table.fields.filter((x) => x.unique)) {
      if (!errors[f.id] && findDuplicates(table, f.id, data, this.records(tableId), existing?.id).length) errors[f.id] = 'duplicate';
    }
    if (Object.keys(errors).length) return { ok: false, errors };

    if (!noRules) {
      const pre = await runRules(this, 'before_save', table, { id: existing?.id || '', data }, prev, depth);
      if (pre.blocked) return { ok: false, blocked: pre.blocked };
    }

    const t = this.now();
    const rec = existing
      ? Object.assign(existing, { data, updated: t, dirty: 1, deleted: false })
      : { id: id || uid(), table: tableId, data, created: t, updated: t, dirty: 1, by: by || null };
    this._put(rec);
    this._persistRecord(rec);
    this.emit({ type: 'record', table: tableId, id: rec.id });
    if (!noRules) await runRules(this, existing ? 'updated' : 'created', table, rec, prev, depth);
    return { ok: true, record: rec };
  }

  /**
   * Write a record of a system table (`_collect`: payments from the bank) that has no definition in the App builder:
   * no formulas, validation or rules; it syncs like any other record.
   */
  putSystemRecord(tableId, id, data) {
    const t = this.now();
    const cur = this.byTable.get(tableId)?.get(id);
    // always move forward in time, or the sync server (newest edit wins) would ignore this change
    const after = (prev) => (t > prev ? t : new Date(Date.parse(prev) + 1).toISOString());
    const rec = cur ? Object.assign(cur, { data, updated: after(cur.updated), dirty: 1, deleted: false }) : { id, table: tableId, data, created: t, updated: t, dirty: 1, by: null };
    this._put(rec);
    this._persistRecord(rec);
    this.emit({ type: 'record', table: tableId, id });
    return rec;
  }

  patchRecord(tableId, id, patch, opts = {}) {
    const rec = this.byTable.get(tableId)?.get(id);
    if (!rec) return Promise.resolve({ ok: false });
    return this.saveRecord(tableId, { ...rec.data, ...patch }, { ...opts, id });
  }

  async deleteRecord(tableId, id) {
    const rec = this.getRecord(tableId, id);
    if (!rec) return;
    const prev = clone(rec);
    rec.deleted = true; rec.updated = this.now(); rec.dirty = 1;
    this._persistRecord(rec);
    this.emit({ type: 'record', table: tableId, id });
    await runRules(this, 'deleted', this.table(tableId), prev, prev, 0);
  }
  async restoreRecord(tableId, id) {
    const rec = this.byTable.get(tableId)?.get(id);
    if (!rec?.deleted) return;
    rec.deleted = false; rec.updated = this.now(); rec.dirty = 1;
    this._persistRecord(rec);
    this.emit({ type: 'record', table: tableId, id });
    await runRules(this, 'created', this.table(tableId), rec, null, 0);
  }

  // ---- one-tap payment reminders -------------------------------------------------------------------
  /**
   * A WhatsApp reminder for a record that still has money due and a phone to send to, written from its latest data.
   * Returns null when there is nothing to collect or nobody to send it to. `table.remind.body` can override the text.
   */
  reminder(tableId, id) {
    const table = this.table(tableId), rec = this.getRecord(tableId, id);
    if (!table || !rec || !table.fields.some((f) => f.id === 'balance') || toNum(rec.data.balance) <= 0) return null;
    const phone = table.fields.find((f) => f.type === 'phone');
    const to = String((phone && rec.data[phone.id]) || '').trim();
    if (!to) return null;
    const body = renderTemplate(table.remind?.body
      || t('{{#if customer}}Hello {{customer.name}},{{else}}Hello,{{/if}} a gentle reminder: {{balance}} is pending for bill {{number}} dated {{date}}.{{#if business.upi}} Pay by UPI: {{business.upi}}{{/if}} — {{business.name}}'), { table, data: rec.data, ctx: this.ctx() });
    return { to, body, link: buildShareLink('whatsapp', to, '', body, this.settings.countryCode ?? '91'), last: this.meta.reminded?.[id] || null };
  }
  markReminded(id) {
    this.meta.reminded ||= {};
    this.meta.reminded[id] = this.now();
    const keys = Object.keys(this.meta.reminded);
    if (keys.length > 2000) for (const k of keys.slice(0, 500)) delete this.meta.reminded[k];
    this._persistMeta('reminded');
    this.emit({ type: 'reminded', id });
  }

  // ---- approvals -----------------------------------------------------------------------
  async setApproval(tableId, id, approval) {
    const rec = this.getRecord(tableId, id);
    if (!rec) return;
    rec.approval = approval; rec.updated = this.now(); rec.dirty = 1;
    this._persistRecord(rec);
    this.emit({ type: 'approval' });
  }
  pendingApprovals() {
    const out = [];
    for (const m of this.byTable.values()) for (const r of m.values()) if (!r.deleted && r.approval?.status === 'pending') out.push(r);
    return out.sort((a, b) => (a.approval.at < b.approval.at ? 1 : -1));
  }
  async decideApproval(tableId, id, status, by, note = '') {
    const rec = this.getRecord(tableId, id);
    if (!rec?.approval) return;
    rec.approval = { ...rec.approval, status, by: by || '', decidedAt: this.now(), decision: note };
    rec.updated = this.now(); rec.dirty = 1;
    this._persistRecord(rec);
    this.emit({ type: 'approval' });
    await runRules(this, status, this.table(tableId), rec, null, 0);
  }

  // ---- outbox (messages, alerts, webhooks) ---------------------------------------------------
  lastRun(key) { return this.meta.runs[key] || null; }
  markRun(key) {
    this.meta.runs[key] = todayStr();
    // keep the map small
    const keys = Object.keys(this.meta.runs);
    if (keys.length > 5000) for (const k of keys.slice(0, 1000)) delete this.meta.runs[k];
    this._persistMeta('runs');
  }

  queueOutbox(item) {
    const rec = this.getRecord(item.table, item.recordId);
    const dupe = [...this.outbox.values()].find((o) =>
      o.status === 'pending' && (o.key || o.ruleId) === (item.key || item.ruleId) && o.recordId === item.recordId && o.channel === item.channel);
    const holdMs = (item.holdMinutes || 0) * 60000;
    const dueAt = new Date(Date.now() + holdMs).toISOString();
    const entry = dupe
      ? Object.assign(dupe, { ...item, id: dupe.id, status: 'pending', created: this.now(), dueAt, snapshot: rec ? clone(rec.data) : dupe.snapshot })
      : { ...item, id: uid(), status: 'pending', created: this.now(), dueAt, snapshot: rec ? clone(rec.data) : null };
    this.outbox.set(entry.id, entry);
    this._queue(() => this.db.putOutbox(entry));
    this.emit({ type: 'outbox' });
    return entry;
  }
  listOutbox(pred = () => true) {
    return [...this.outbox.values()].filter(pred).sort((a, b) => (a.created < b.created ? 1 : -1));
  }
  pendingFor(table, recordId) {
    return this.listOutbox((o) => o.status === 'pending' && o.table === table && o.recordId === recordId && o.channel !== 'webhook');
  }
  /** Renders against the LATEST record data (falls back to the snapshot if the record is gone). */
  renderOutbox(item, override = {}) {
    const table = this.table(item.table);
    const live = this.getRecord(item.table, item.recordId);
    const data = live?.data || item.snapshot || {};
    const ctx = this.ctx();
    const r = (tpl) => (table ? renderTemplate(tpl, { table, data, ctx }) : tpl);
    const body = override.body ?? r(item.body), subject = r(item.subject), to = (override.to ?? r(item.to)).trim();
    const link = buildShareLink(item.channel, to, subject, body, this.settings.countryCode ?? '91');
    return { to, subject, body, link, missingRecipient: item.channel !== 'inapp' && item.channel !== 'webhook' && !to, due: item.dueAt <= new Date().toISOString() };
  }
  markSent(id) { const o = this.outbox.get(id); if (o) { o.status = 'sent'; o.sentAt = this.now(); this._queue(() => this.db.putOutbox(o)); this.emit({ type: 'outbox' }); } }
  dismissOutbox(id) { const o = this.outbox.get(id); if (o) { o.status = 'dismissed'; this._queue(() => this.db.putOutbox(o)); this.emit({ type: 'outbox' }); } }
  clearDoneOutbox() {
    for (const o of [...this.outbox.values()]) if (o.status !== 'pending') { this.outbox.delete(o.id); this._queue(() => this.db.delOutbox(o.id)); }
    this.emit({ type: 'outbox' });
  }
  badgeCount() {
    return this.listOutbox((o) => o.status === 'pending' && o.channel !== 'webhook').length + this.pendingApprovals().length
      + this.records('_collect').filter((r) => r.data.status === 'review').length;
  }

  /** POST queued webhooks (Zoho Flow, Zapier, Make, your own server). Fire-and-forget; retried when online. */
  async flushWebhooks(fetchFn = globalThis.fetch?.bind(globalThis)) {
    if (!fetchFn) return 0;
    let sent = 0;
    for (const o of this.listOutbox((x) => x.status === 'pending' && x.channel === 'webhook')) {
      const live = this.getRecord(o.table, o.recordId);
      const payload = { rule: o.ruleName, table: o.table, id: o.recordId, record: live?.data || o.snapshot };
      try {
        await fetchFn(o.url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
        this.markSent(o.id); sent++;
      } catch { /* offline: keep pending */ }
    }
    return sent;
  }

  runSchedule() { return runScheduled(this); }

  // ---- sync / backup helpers ---------------------------------------------------------------
  dirtyRecords() {
    const out = [];
    for (const m of this.byTable.values()) for (const r of m.values()) if (r.dirty) out.push(r);
    return out;
  }
  clearDirty(sent) {
    const changed = [];
    for (const s of sent) {
      const r = this.byTable.get(s.table)?.get(s.id);
      if (r && r.updated === s.updated) { delete r.dirty; changed.push(r); }
    }
    if (changed.length) this._queue(() => this.db.putRecords(changed));
  }
  /** Merge a record that arrived from the sync server. Newer timestamp wins; local unsynced edits win ties. */
  applyRemote(rec) {
    const cur = this.byTable.get(rec.table)?.get(rec.id);
    if (cur && cur.updated >= rec.updated) return false;
    const next = { ...rec }; delete next.dirty;
    this._put(next);
    this._persistRecord(next);
    this.emit({ type: 'record', table: rec.table, id: rec.id });
    return true;
  }
  exportAll() {
    const records = [];
    for (const m of this.byTable.values()) for (const r of m.values()) records.push(r);
    return { format: BACKUP_FORMAT, version: 1, exported: this.now(), app: this.app, counters: this.meta.counters, records };
  }
  async importAll(bk) {
    if (!BACKUP_FORMATS.includes(bk?.format) || !bk.app) throw new Error('Not a valid backup file');
    await this.db.wipe();
    this.byTable.clear(); this.outbox.clear();
    const device = this.meta.device;
    this.meta = { counters: bk.counters || {}, runs: {}, device };
    for (const k of ['counters', 'runs', 'device']) this._persistMeta(k);
    this.app = bk.app;
    this._persistMeta('app');
    for (const r of bk.records || []) { r.dirty = 1; this._put(r); }
    await this._queue(() => this.db.putRecords(bk.records || []));
    this._applyLocale();
    this.emit({ type: 'app' });
  }
  async wipeAll() {
    await this.db.wipe();
    this.byTable.clear(); this.outbox.clear(); this.app = null;
    this.meta = { counters: {}, runs: {}, device: this.meta.device };
    this._persistMeta('device');
    this.emit({ type: 'app' });
  }
}
