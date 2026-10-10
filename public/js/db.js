// Storage adapters. The app talks to a tiny interface so it can run on IndexedDB in the browser
// and on plain memory in tests:
//   load() -> {meta, records, outbox}, putMeta(k,v), putRecords([...]), putOutbox(item), delOutbox(id), wipe()

export function memoryDb() {
  const meta = new Map(), records = new Map(), outbox = new Map();
  return {
    kind: 'memory',
    async load() {
      return {
        meta: Object.fromEntries([...meta].map(([k, v]) => [k, structuredClone(v)])),
        records: [...records.values()].map((r) => structuredClone(r)),
        outbox: [...outbox.values()].map((r) => structuredClone(r)),
      };
    },
    async putMeta(k, v) { meta.set(k, structuredClone(v)); },
    async putRecords(list) { for (const r of list) records.set(r.id, structuredClone(r)); },
    async putOutbox(item) { outbox.set(item.id, structuredClone(item)); },
    async delOutbox(id) { outbox.delete(id); },
    async wipe() { meta.clear(); records.clear(); outbox.clear(); },
  };
}

// The on-device database keeps the name it had before the app was renamed to Vina: a new name would open an empty
// database and hide every existing shop's records. It is never shown to anyone.
export function idbDb(name = 'msme-builder') {
  let dbp;
  const open = () => (dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('meta');
      db.createObjectStore('records', { keyPath: 'id' });
      db.createObjectStore('outbox', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const tx = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then((v) => { out = v; }, reject);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  const all = (store) => new Promise((res, rej) => { const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    kind: 'indexeddb',
    async load() {
      return tx(['meta', 'records', 'outbox'], 'readonly', async (t) => {
        const meta = {};
        await new Promise((res, rej) => {
          const c = t.objectStore('meta').openCursor();
          c.onsuccess = () => { const cur = c.result; if (cur) { meta[cur.key] = cur.value; cur.continue(); } else res(); };
          c.onerror = () => rej(c.error);
        });
        return { meta, records: await all(t.objectStore('records')), outbox: await all(t.objectStore('outbox')) };
      });
    },
    putMeta: (k, v) => tx(['meta'], 'readwrite', (t) => { t.objectStore('meta').put(v, k); }),
    putRecords: (list) => tx(['records'], 'readwrite', (t) => { const s = t.objectStore('records'); for (const r of list) s.put(r); }),
    putOutbox: (item) => tx(['outbox'], 'readwrite', (t) => { t.objectStore('outbox').put(item); }),
    delOutbox: (id) => tx(['outbox'], 'readwrite', (t) => { t.objectStore('outbox').delete(id); }),
    wipe: () => tx(['meta', 'records', 'outbox'], 'readwrite', (t) => { for (const s of ['meta', 'records', 'outbox']) t.objectStore(s).clear(); }),
  };
}

/** IndexedDB when available, otherwise memory (private windows on some browsers). */
export function bestDb() {
  try { if (typeof indexedDB !== 'undefined') return idbDb(); } catch { /* fall through */ }
  return memoryDb();
}
