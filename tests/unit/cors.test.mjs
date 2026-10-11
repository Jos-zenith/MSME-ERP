// CORS: by default the API answers only pages served by this same server. Other web origins must be listed in
// CORS_ORIGIN; they are refused by the server itself (not only by the browser), and never get a wildcard by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SYNC_PROTOCOL } from '../../public/js/protocol.js';

async function server(cors) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-cors-'));
  if (cors === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = cors;
  const mod = await import(`../../server/server.js?cors=${Date.now()}${Math.random()}`);
  const srv = await mod.start(0, '127.0.0.1');
  const port = srv.address().port;
  return { url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) };
}
const call = (url, p, origin, { method = 'POST', body = { ws: 'nobody-here', token: 'whatever-pass', protocol: SYNC_PROTOCOL } } = {}) => fetch(`${url}${p}`, {
  method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } : {}) },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});

test('default: same origin only; another site is refused by the server, with no CORS headers, preflight included', async () => {
  const s = await server(undefined);
  try {
    const evil = 'https://evil.example';
    for (const [p, method] of [['/api/sync', 'POST'], ['/api/export', 'POST'], ['/api/live', 'POST'], ['/api/sync', 'OPTIONS'], ['/api/health', 'GET']]) {
      const r = await call(s.url, p, evil, { method });
      assert.equal(r.status, 403, `${method} ${p} from another site`);
      assert.equal(r.headers.get('access-control-allow-origin'), null, `${method} ${p}: no CORS header`);
      await r.body?.cancel();
    }
    // the app's own pages (same origin) and non-browser callers (no Origin: the payment provider, scripts) still work
    const same = await call(s.url, '/api/sync', s.url);
    assert.equal(same.status, 403, 'reaches the passphrase check (unknown workspace), not blocked by origin');
    assert.match((await same.json()).error, /passphrase/);
    assert.equal(same.headers.get('access-control-allow-origin'), null, 'same origin needs no CORS header');
    const noOrigin = await call(s.url, '/api/sync', null);
    assert.match((await noOrigin.json()).error, /passphrase/);
    // a look-alike of this server's address is not this server
    const lookalike = await call(s.url, '/api/sync', `http://${s.host}.evil.example`);
    assert.equal(lookalike.status, 403);
    assert.match((await lookalike.json()).error, /origin/i);
  } finally { await s.close(); }
});

test('CORS_ORIGIN lists the other sites allowed: exact match, echoed (never *), everything else refused', async () => {
  const s = await server('https://vina-shop.example, https://staff.vina-shop.example');
  try {
    const ok = await call(s.url, '/api/sync', 'https://vina-shop.example', { method: 'OPTIONS' });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://vina-shop.example');
    assert.match(ok.headers.get('vary') || '', /Origin/);
    const post = await call(s.url, '/api/sync', 'https://staff.vina-shop.example');
    assert.equal(post.headers.get('access-control-allow-origin'), 'https://staff.vina-shop.example');
    assert.match((await post.json()).error, /passphrase/, 'an allowed site reaches the normal checks');
    for (const o of ['https://evil.example', 'http://vina-shop.example', 'https://vina-shop.example.evil.example']) {
      const r = await call(s.url, '/api/sync', o, { method: 'OPTIONS' });
      assert.equal(r.status, 403, o);
      assert.equal(r.headers.get('access-control-allow-origin'), null, o);
    }
  } finally { await s.close(); }
});

test('a wildcard only when configured on purpose', async () => {
  const s = await server('*');
  try {
    const r = await call(s.url, '/api/sync', 'https://anywhere.example', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  } finally { await s.close(); delete process.env.CORS_ORIGIN; }
});
