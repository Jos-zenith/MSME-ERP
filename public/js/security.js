// Simple, honest security for a small shop: an optional app lock (owner PIN / staff PIN) and passphrase-encrypted
// backups. PINs are stored as salted PBKDF2 hashes, never in plain text.
//
// NOTE: the lock keeps casual users out of the app on a shared device. It does not encrypt the data stored in the
// browser: use the device's own screen lock / disk encryption for that, and encrypted backups for copies.
const enc = new TextEncoder();
const dec = new TextDecoder();

export const cryptoAvailable = () => !!globalThis.crypto?.subtle;

export const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFrom(pass, salt, usage, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey', 'deriveBits']);
  return usage === 'bits'
    ? crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, 256)
    : crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, usage);
}

// ---- app lock ---------------------------------------------------------------------------------------
export async function hashPin(pin, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const bits = await keyFrom(pin, salt, 'bits', 100000);
  return { salt: b64(salt), hash: b64(bits) };
}
export const lockEnabled = (store) => !!(store.meta.security?.owner || store.meta.security?.staff);

/** Returns 'owner' | 'staff' | null */
export async function checkPin(store, pin) {
  const sec = store.meta.security || {};
  for (const role of ['owner', 'staff']) {
    if (!sec[role]) continue;
    const { hash } = await hashPin(pin, sec[role].salt);
    if (hash === sec[role].hash) return role;
  }
  return null;
}
export async function setPin(store, role, pin) {
  store.meta.security ||= {};
  if (!pin) delete store.meta.security[role];
  else store.meta.security[role] = await hashPin(pin);
  store._persistMeta('security');
}

// Encrypted backups made before the rename to Vina say 'msme-builder-encrypted' and still open.
export const ENCRYPTED_FORMAT = 'vina-encrypted';
export const ENCRYPTED_FORMATS = [ENCRYPTED_FORMAT, 'msme-builder-encrypted'];

// ---- encrypted backups ------------------------------------------------------------------------------------
export async function encryptJson(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 250000;
  const key = await keyFrom(pass, salt, ['encrypt'], iterations);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { format: ENCRYPTED_FORMAT, version: 1, iterations, salt: b64(salt), iv: b64(iv), data: b64(data) };
}
export async function decryptJson(box, pass) {
  const key = await keyFrom(pass, unb64(box.salt), ['decrypt'], box.iterations || 250000);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
    return JSON.parse(dec.decode(plain));
  } catch { throw new Error('Wrong passphrase, or the file is damaged'); }
}
