#!/usr/bin/env node
// Checks a deployed sync server from the outside, the way the app's pages and a payment provider will reach it.
//
//   node scripts/check-deploy.mjs --sync https://sync.example.com --app https://vina-shop.vercel.app
//
// Read-only: it sends only requests that are refused (made-up workspace, no signature), so nothing on the server
// changes. Exit code 1 if anything that would break the app or weaken the server is found.
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const sync = String(args.sync || '').replace(/\/+$/, '');
const app = String(args.app || '').replace(/\/+$/, '');
if (!sync || !app) { console.error('usage: node scripts/check-deploy.mjs --sync <sync server URL> --app <URL the app is served from>'); process.exit(2); }

const results = [];
const check = (ok, what, detail = '') => { results.push({ ok, what, detail }); console.log(`${ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL'}  ${what}${detail ? `\n      ${detail}` : ''}`); };
const appOrigin = new URL(app).origin;
const sameOrigin = new URL(sync).origin === appOrigin;
const probe = { ws: 'deploy-check-probe', token: 'not-a-real-passphrase', protocol: 4 };
const req = async (path, { method = 'POST', origin, body = probe, headers = {} } = {}) => {
  try {
    const r = await fetch(`${sync}${path}`, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, acao: r.headers.get('access-control-allow-origin'), json };
  } catch (e) { return { status: 0, error: e.cause?.code || e.message }; }
};

console.log(`Sync server: ${sync}\nApp origin:  ${appOrigin}${sameOrigin ? ' (same origin: no CORS needed)' : ' (another origin: needs CORS_ORIGIN on the server)'}\n`);

// 1. reachable, over https
const health = await req('/api/health', { method: 'GET' });
check(health.status === 200, 'the sync server answers /api/health', health.status ? `HTTP ${health.status}` : health.error);
check(new URL(sync).protocol === 'https:' ? true : (/^(localhost|127\.)/.test(new URL(sync).hostname) ? 'warn' : false),
  'the sync server is reached over https (passphrases and payment webhooks travel to it)', new URL(sync).protocol);

// 2. the app's own origin may use the API
if (!sameOrigin) {
  const pre = await req('/api/sync', { method: 'OPTIONS', origin: appOrigin, headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  check(pre.status === 204 && pre.acao === appOrigin, 'the app origin passes the browser preflight',
    pre.acao === '*' ? 'allowed with *: works, but any web site may call the API; list the app origin in CORS_ORIGIN instead'
      : pre.status === 204 && pre.acao === appOrigin ? ''
        : `HTTP ${pre.status}, Access-Control-Allow-Origin: ${pre.acao ?? '(none)'}  -> set CORS_ORIGIN=${appOrigin} on the sync server`);
  if (pre.acao === '*') results.at(-1).ok = 'warn';
}
const fromApp = await req('/api/sync', { origin: appOrigin });
check(fromApp.status === 403 && /passphrase/i.test(fromApp.json?.error || ''), 'a request from the app origin reaches the passphrase check',
  `HTTP ${fromApp.status}: ${fromApp.json?.error || fromApp.error || ''}`);

// 3. other web sites may not
const stranger = 'https://deploy-check.invalid';
const other = await req('/api/sync', { method: 'OPTIONS', origin: stranger, headers: { 'Access-Control-Request-Method': 'POST' } });
check(other.status === 403 && !other.acao ? true : other.acao === '*' ? 'warn' : false, 'another web site is refused',
  `HTTP ${other.status}, Access-Control-Allow-Origin: ${other.acao ?? '(none)'}`);
const previewLike = appOrigin.replace(/^(https?:\/\/)([^.]+)/, '$1$2-git-preview');
if (previewLike !== appOrigin) {
  const pv = await req('/api/sync', { method: 'OPTIONS', origin: previewLike, headers: { 'Access-Control-Request-Method': 'POST' } });
  check(pv.acao ? 'warn' : true, 'a preview-style address of the app is not allowed by accident', `${previewLike}: ${pv.acao ? `allowed (${pv.acao})` : 'refused'}. Previews need their own CORS_ORIGIN entry if they should sync`);
}

// 4. protocol gate, webhook path, sandbox
const old = await req('/api/sync', { body: { ws: probe.ws, token: probe.token } });
check(old.status === 426, 'apps without a sync protocol are told to update (426)', `HTTP ${old.status}`);
const hook = await req(`/api/collect/hook/${'0'.repeat(24)}`, { body: { status: 'SUCCESS' } });
check(hook.status === 404 || hook.status === 401, 'the payment webhook path is reachable without a browser Origin (unknown hook -> 404)', `HTTP ${hook.status}`);
const sim = await req('/api/collect/simulate', { body: { ...probe, amount: 1 } });
const sandboxOff = /turned off/i.test(sim.json?.error || '');
check(sandboxOff ? true : 'warn', 'sandbox payments are off (COLLECT_SANDBOX=false) for a live shop',
  sandboxOff ? '' : 'the simulator is enabled: fine for demos, turn it off before real payments');

const failed = results.filter((r) => r.ok === false).length, warned = results.filter((r) => r.ok === 'warn').length;
console.log(`\n${results.length - failed - warned} passed, ${warned} warnings, ${failed} failed`);
process.exit(failed ? 1 : 0);
