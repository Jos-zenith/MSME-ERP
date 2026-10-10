// Offline-first sync. Everything is saved on the device first; when a connection exists, changes are exchanged with
// your own sync server (server/server.js). Conflict rule: per record, the most recent edit wins.
// Config lives in store.meta.sync = { url, ws, token, since, enabled }.

export class Sync {
  constructor(store, { fetchFn = globalThis.fetch?.bind(globalThis), pushDelay = 800 } = {}) {
    this.store = store;
    this.fetch = fetchFn;
    this.status = 'off';   // off | idle | syncing | offline | error
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

  configure({ url, ws, token, adopt = false }) {
    url = String(url).trim().replace(/\/+$/, '');
    this.store.meta.sync = { url, ws: ws.trim(), token, since: 0, enabled: true, ...(adopt ? { adopt: true } : {}) };
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
    if (!cfg?.enabled || !this.fetch || this._liveCtl) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    clearTimeout(this._liveRetry);
    const ctl = this._liveCtl = new AbortController();
    try {
      const res = await this.fetch(`${cfg.url}/api/live`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ws: cfg.ws, token: cfg.token }), signal: ctl.signal, cache: 'no-store',
      });
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
    if (wasMine && !ctl.signal.aborted && this.config?.enabled) {
      this._liveRetry = setTimeout(() => this.connectLive(), this._liveBackoff);
      this._liveBackoff = Math.min(this._liveBackoff * 2, 30000);
    }
  }
  stopLive() {
    clearTimeout(this._liveRetry);
    this._liveCtl?.abort(); this._liveCtl = null;
    if (this.live) { this.live = false; this._emit(); }
  }

  // ---- Smart Collect: the payment webhook lives on the sync server --------------------------------------------------------
  async _post(path, extra = {}) {
    const cfg = this.config;
    if (!cfg?.enabled || !this.fetch) throw new Error('Connect this device to the sync server first (Settings → Sync)');
    const res = await this.fetch(`${cfg.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ws: cfg.ws, token: cfg.token, ...extra }) });
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

  async run() {
    const cfg = this.config;
    if (!cfg?.enabled || !this.fetch) return { skipped: true };
    if (this.running) { this._again = true; return { skipped: true }; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { this._set('offline'); return { skipped: true }; }
    this.running = true;
    this._set('syncing');
    try {
      const store = this.store;
      const adopting = !!cfg.adopt;
      const dirty = cfg.adopt ? [] : store.dirtyRecords();
      const appDirty = !!store.meta.appDirty;
      const body = {
        ws: cfg.ws, token: cfg.token, since: cfg.since || 0,
        records: dirty.map(({ id, table, data, created, updated, deleted, approval, by }) => ({ id, table, data, created, updated, deleted: !!deleted, approval, by })),
        appUpdated: store.app?.updated || '',
        app: !cfg.adopt && (appDirty || !cfg.since) ? store.app : null,
      };
      const res = await this.fetch(`${cfg.url}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 401 || res.status === 403) throw new Error('The server did not accept the workspace name / passphrase');
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
      delete cfg.adopt;
      store._persistMeta('sync');
      this.lastAt = new Date();
      this._set('idle');
      return { pushed: dirty.length, pulled };
    } catch (e) {
      const offline = e instanceof TypeError; // fetch failed: no network / server unreachable
      this._set(offline ? 'offline' : 'error', offline ? '' : e.message);
      return { error: e.message };
    } finally {
      this.running = false;
      // something changed while we were busy (a live notice or a local save): go round once more
      if (this._again) { this._again = false; if (this.status === 'idle') queueMicrotask(() => this.run()); }
    }
  }
}
