// Offline-first sync. Everything is saved on the device first; when a connection exists, changes are exchanged with
// your own sync server (server/server.js). Conflict rule: per record, the most recent edit wins.
// Config lives in store.meta.sync = { url, ws, token, since, enabled }.

export class Sync {
  constructor(store, { fetchFn = globalThis.fetch?.bind(globalThis) } = {}) {
    this.store = store;
    this.fetch = fetchFn;
    this.status = 'off';   // off | idle | syncing | offline | error
    this.error = '';
    this.lastAt = null;
    this.listeners = new Set();
    this.timer = null;
    this._debounce = null;
  }
  get config() { return this.store.meta.sync || null; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _set(status, error = '') { this.status = status; this.error = error; for (const fn of this.listeners) fn(this); }

  configure({ url, ws, token }) {
    url = String(url).trim().replace(/\/+$/, '');
    this.store.meta.sync = { url, ws: ws.trim(), token, since: 0, enabled: true };
    this.store._persistMeta('sync');
  }
  disconnect() { delete this.store.meta.sync; this.store._persistMeta('sync'); this._set('off'); }

  start() {
    if (this.timer) return;
    this._set(this.config?.enabled ? 'idle' : 'off');
    this.timer = setInterval(() => this.run(), 60000);
    globalThis.addEventListener?.('online', () => this.run());
    globalThis.addEventListener?.('offline', () => this.config?.enabled && this._set('offline'));
    // push soon after any local change
    this.store.on((e) => { if (e.type === 'record' || e.type === 'app') { clearTimeout(this._debounce); this._debounce = setTimeout(() => this.run(), 4000); } });
  }

  async run() {
    const cfg = this.config;
    if (!cfg?.enabled || !this.fetch) return { skipped: true };
    if (this.running) return { skipped: true };
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
    } finally { this.running = false; }
  }
}
