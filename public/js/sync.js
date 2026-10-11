// Offline-first sync. Everything is saved on the device first; when a connection exists, changes are exchanged with
// your own sync server (server/server.js). Records merge on the server and on each device (ledger.js).
// Config lives in store.meta.sync = { url, ws, token, since, enabled }, plus for the first run `adopt` (download the
// shop) or `create` + `setupCode` (make a new workspace), `refused` once the server turned the passphrase down (no more
// automatic tries until someone types it again) and `weak` (works, but would not be accepted for a new workspace).
import { SYNC_PROTOCOL } from './protocol.js';

const REFUSED = 'The server did not accept the workspace name / passphrase';
/** The server refused this app's sync protocol (protocol.js): 426 = update this app, 409 = update the server. */
const incompatible = (status) => (status === 426 ? 'app' : status === 409 ? 'server' : null);

export class Sync {
  constructor(store, { fetchFn = globalThis.fetch?.bind(globalThis), pushDelay = 800, protocol = SYNC_PROTOCOL } = {}) {
    this.store = store;
    this.fetch = fetchFn;
    this.protocol = protocol;
    this.needs = null;     // 'app' | 'server' while the server refuses this app's sync protocol
    this.status = 'off';   // off | idle | syncing | offline | error | update
    this.error = '';
    this.lastAt = null;
    this.live = false;     // true while the server's change feed is connected: other devices' edits arrive in ~1 s
    this.listeners = new Set();
    this.timer = null;
    this._debounce = null;
    this._pushDelay = pushDelay;
    this._liveCtl = null;
    this._liveRetry = null;
    this._liveBackoff = 1000;
  }
  get config() { return this.store.meta.sync || null; }
  /** Local changes not yet confirmed by the server. */
  get pending() { return this.config?.enabled ? this.store.dirtyRecords().length : 0; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn(this); }
  _set(status, error = '') { this.status = status; this.error = error; this._emit(); }

  configure({ url, ws, token, adopt = false, create = false, setupCode = '' }) {
    url = String(url).trim().replace(/\/+$/, '');
    this.store.meta.sync = { url, ws: ws.trim(), token, since: 0, enabled: true, ...(adopt ? { adopt: true } : create ? { create: true, setupCode: String(setupCode).trim() } : {}) };
    this.store._persistMeta('sync');
    if (this.timer) { this.stopLive(); this.connectLive(); }
  }
  disconnect() { this.stopLive(); delete this.store.meta.sync; this.store._persistMeta('sync'); this._set('off'); }

  start() {
    if (this.timer) return;
    this._set(this.config?.enabled ? 'idle' : 'off');
    // the live feed does the real work; this slow poll is only a safety net if the feed is blocked by a proxy
    this.timer = setInterval(() => { if (!this.live) this.run(); }, 60000);
    globalThis.addEventListener?.('online', () => { this.run(); this.connectLive(); });
    globalThis.addEventListener?.('offline', () => { this.stopLive(); if (this.config?.enabled) this._set('offline'); });
    // push soon after any local change (short debounce so a burst of edits travels as one request)
    this.store.on((e) => {
      if (e.type !== 'record' && e.type !== 'app') return;
      this._emit();
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.run(), this._pushDelay);
    });
    this.connectLive();
  }

  /** Hold a streaming request open; the server writes `data: {"seq":n}` whenever any device saves something. */
  async connectLive() {
    const cfg = this.config;
    // not before the first sync: that one creates the workspace or downloads the shop (and a refusal must come from it)
    if (!cfg?.enabled || cfg.refused || cfg.create || cfg.adopt || !this.fetch || this._liveCtl) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    clearTimeout(this._liveRetry);
    const ctl = this._liveCtl = new AbortController();
    try {
      const res = await this.fetch(`${cfg.url}/api/live`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ws: cfg.ws, token: cfg.token, protocol: this.protocol }), signal: ctl.signal, cache: 'no-store',
      });
      if (incompatible(res.status)) { await this._incompatible(res); throw new Error('incompatible'); }
      if (res.status === 403) { this._refuse(REFUSED); throw new Error('refused'); }
      if (!res.ok || !res.body?.getReader) throw new Error(`live ${res.status}`);
      this.live = true; this._liveBackoff = 1000; this._emit();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const msg = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = msg.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const { seq } = JSON.parse(line.slice(5));
          if (seq > (this.config?.since || 0)) this.run();
        }
      }
    } catch { /* aborted, offline or server without the feed: fall through to retry */ }
    const wasMine = this._liveCtl === ctl;
    if (wasMine) this._liveCtl = null;
    if (this.live) { this.live = false; this._emit(); }
    if (wasMine && !ctl.signal.aborted && this.config?.enabled && !this.config.refused && this.needs !== 'app') {
      this._liveRetry = setTimeout(() => this.connectLive(), this._liveBackoff);
      this._liveBackoff = Math.min(this._liveBackoff * 2, 30000);
    }
  }
  stopLive() {
    clearTimeout(this._liveRetry);
    this._liveCtl?.abort(); this._liveCtl = null;
    if (this.live) { this.live = false; this._emit(); }
  }

  /**
   * The server refuses this app's sync protocol. Nothing was sent or changed, and nothing here is touched: every
   * record still waiting stays waiting, and goes up once the app (or the server) is updated.
   */
  async _incompatible(res) {
    const out = await res.json().catch(() => ({}));
    this.needs = incompatible(res.status);
    this.stopLive();
    this._set('update', out.error || (this.needs === 'app' ? 'Update to keep syncing' : 'The sync server needs an update'));
    return Object.assign(new Error(this.error), { shown: true });
  }

  /** The server turned the passphrase down: stop trying by ourselves (each try would count as a guess) until it is typed again. */
  _refuse(message) {
    const cfg = this.config;
    if (cfg && !cfg.refused) { cfg.refused = true; this.store._persistMeta('sync'); }
    this.stopLive();
    this._set('error', message);
  }

  /**
   * Change the workspace passphrase for every device (a phone was lost, someone left). This device keeps working; the
   * others stop syncing until the new passphrase is typed on them.
   */
  async changePassphrase(newToken) {
    await this._post('/api/passphrase', { newToken });
    this.config.token = newToken;
    delete this.config.weak;
    this.store._persistMeta('sync');
    if (this.timer) { this.stopLive(); this.connectLive(); }
    this._emit();
  }

  // ---- Smart Collect: the payment webhook lives on the sync server --------------------------------------------------------
  async _post(path, extra = {}) {
    const cfg = this.config;
    if (!cfg?.enabled || !this.fetch) throw new Error('Connect this device to the sync server first (Settings → Sync)');
    const res = await this.fetch(`${cfg.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ws: cfg.ws, token: cfg.token, protocol: this.protocol, ...extra }) });
    if (incompatible(res.status)) throw await this._incompatible(res);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `Server error ${res.status}`);
    return out;
  }
  /** Webhook address + signing secret to paste into the payment provider's dashboard. */
  async collectSetup({ rotate = false } = {}) {
    const out = await this._post('/api/collect/setup', { rotate });
    return { ...out, hookUrl: `${this.config.url}${out.hookPath}` };
  }
  /** Sandbox only: the server pretends the bank confirmed a UPI payment (same path a real one takes). */
  simulatePayment({ amount, ref = '', vpa = '', name = '', phone = '', utr } = {}) {
    return this._post('/api/collect/simulate', { amount, ref, vpa, name, phone, utr });
  }

  /**
   * Exchange changes with the server. Called while a sync is under way (a live notice, a save, "Sync now"), it waits
   * for that one and then goes round once more, so what it returns includes everything up to the moment it was called.
   */
  run() {
    if (this._current) return (this._next ||= this._current.then(() => { this._next = null; return this.run(); }));
    this._current = this._runOnce().finally(() => { this._current = null; });
    return this._current;
  }

  async _runOnce() {
    const cfg = this.config;
    if (!cfg?.enabled || !this.fetch) return { skipped: true };
    if (cfg.refused) return { error: this.error || REFUSED };
    // this app is too old for the server: no point asking again until it is updated (a reload loads the new version)
    if (this.needs === 'app') return { error: this.error };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { this._set('offline'); return { skipped: true }; }
    this._set('syncing');
    try {
      const store = this.store;
      const adopting = !!cfg.adopt;
      const dirty = cfg.adopt ? [] : store.dirtyRecords();
      const appDirty = !!store.meta.appDirty;
      const body = {
        ws: cfg.ws, token: cfg.token, protocol: this.protocol, since: cfg.since || 0,
        records: dirty.map(({ id, table, data, created, updated, deleted, approval, by, vv }) => ({ id, table, data, created, updated, deleted: !!deleted, approval, by, vv })),
        appUpdated: store.app?.updated || '',
        app: !cfg.adopt && (appDirty || !cfg.since) ? store.app : null,
        ...(cfg.create ? { create: true, setupCode: cfg.setupCode || '' } : {}),
      };
      const res = await this.fetch(`${cfg.url}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (incompatible(res.status)) throw await this._incompatible(res);
      this.needs = null;
      if (res.status === 401 || res.status === 403 || res.status === 400) {
        const why = (await res.json().catch(() => ({}))).error;
        const msg = res.status === 403 && (!why || /passphrase/.test(why)) ? REFUSED : why || REFUSED;
        this._refuse(msg);
        throw Object.assign(new Error(msg), { shown: true });
      }
      if (res.status === 429) throw new Error('Too many attempts. Wait a minute and try again');
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const out = await res.json();
      // things we sent are now safe on the server
      store.clearDirty(dirty);
      if (appDirty && !out.app) { store.meta.appDirty = false; store._persistMeta('appDirty'); }
      let pulled = 0;
      for (const r of out.records || []) if (store.applyRemote(r)) pulled++;
      if (out.app && (adopting || !store.app || out.app.updated > store.app.updated)) { store.setApp(out.app, { fromSync: true }); store.meta.appDirty = false; store._persistMeta('appDirty'); }
      cfg.since = out.seq;
      const first = !!(cfg.adopt || cfg.create);
      delete cfg.adopt; delete cfg.create; delete cfg.setupCode;   // the setup code is only for creating the workspace
      if (out.weak) cfg.weak = true; else delete cfg.weak;
      store._persistMeta('sync');
      this.lastAt = new Date();
      this._set('idle');
      if (first && this.timer) this.connectLive();
      return { pushed: dirty.length, pulled };
    } catch (e) {
      const offline = e instanceof TypeError; // fetch failed: no network / server unreachable
      if (!e.shown) this._set(offline ? 'offline' : 'error', offline ? '' : e.message);
      return { error: e.message };
    }
  }
}
