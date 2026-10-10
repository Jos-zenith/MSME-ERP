// Settings: business profile, language, security, backup, sync.
import { h, toast, confirmDialog, promptDialog, download, debounce } from '../ui/dom.js';
import { t, setLang, LANGS, getLang } from '../i18n.js';
import { icon } from '../ui/icons.js';
import { pageHeader, labeled, pill } from '../ui/bits.js';
import { qrSvg, upiLink } from '../print.js';
import { cryptoAvailable, setPin, lockEnabled, encryptJson, decryptJson } from '../security.js';
import { TEMPLATES } from '../templates/index.js';
import { usesGst, gstSettingsCard } from '../../gst/js/ui.js';
import { gstinProblem } from '../../gst/js/gst.js';
import { collectSetup, collectStats, openBills } from '../collect.js';
import { todayStr } from '../formula.js';
import { fmtMoney } from '../schema.js';

export const VERSION = '0.1.0';

export function applyTheme(mode) {
  const m = mode || localStorage.getItem('theme') || 'light';   // light by default: counters are brightly lit, dark screens glare
  document.documentElement.setAttribute('data-theme', m);   // 'auto' follows the device; dark only when chosen
}

export function settingsView(ctx) {
  const { store, sync } = ctx;
  const s = store.settings;
  const b = store.business;
  const save = debounce(() => store.touchApp(), 300);
  const text = (obj, key, opts = {}) => h('input', { value: obj[key] ?? '', ...opts, oninput: (e) => { obj[key] = e.target.value; save(); opts.after?.(); } });

  // ---- business
  const qrHost = h('div.qr-preview');
  const gst = usesGst(store);
  const gstinMsg = h('span.hint.bad', b.gstin ? gstinProblem(b.gstin) : '');
  const paintQr = () => {
    qrHost.replaceChildren();
    if (b.upi?.trim()) qrHost.append(qrSvg(upiLink({ vpa: b.upi.trim(), name: b.name }), 110), h('div.hint', t('Scan with any UPI app to test. This QR is printed on your invoices.')));
  };
  paintQr();
  const business = h('section.card', h('h3', t('Your business')),
    labeled(t('Business name'), text(b, 'name')),
    h('div.two', labeled(t('Phone (for alerts to yourself)'), text(b, 'phone', { type: 'tel' })), labeled(t('Email'), text(b, 'email', { type: 'email' }))),
    labeled(t('Address'), text(b, 'address')),
    h('div.two', gst ? h('span') : labeled(t('GSTIN (optional)'), text(b, 'gstin', { after: () => { gstinMsg.textContent = b.gstin ? gstinProblem(b.gstin) : ''; } }), gstinMsg), labeled(t('UPI ID for QR code (e.g. shop@upi)'), text(b, 'upi', { after: debounce(paintQr, 300), placeholder: 'yourshop@okhdfcbank' }))), qrHost);
  const gstCard = gst ? gstSettingsCard(store) : null;

  // ---- language & region
  const langSel = h('select', { 'aria-label': t('Language'), onchange: async (e) => { await setLang(e.target.value); s.lang = e.target.value; store.touchApp(); location.reload(); } },
    Object.entries(LANGS).map(([k, v]) => h('option', { value: k, selected: k === getLang() }, v)));
  const themeSel = h('select', { 'aria-label': t('Appearance'), onchange: (e) => { localStorage.setItem('theme', e.target.value); applyTheme(e.target.value); } },
    [['auto', t('Automatic')], ['light', t('Light')], ['dark', t('Dark')]].map(([k, v]) => h('option', { value: k, selected: (localStorage.getItem('theme') || 'light') === k }, v)));
  const region = h('section.card', h('h3', t('Language & region')),
    h('div.two', labeled(t('Language'), langSel), labeled(t('Appearance'), themeSel)),
    h('p.hint', t('Changing the language translates the app. Names you already created (fields, tables) stay as you wrote them: rename them in the App builder.')),
    h('div.two', labeled(t('Currency symbol'), text(s.currency ||= { symbol: '₹', locale: 'en-IN', code: 'INR' }, 'symbol', { maxlength: 4, after: () => store._applyLocale() })),
      labeled(t('Country calling code (for WhatsApp)'), text(s, 'countryCode', { inputmode: 'numeric', maxlength: 4 }))));

  // ---- team & security
  const secure = cryptoAvailable();
  const pinRow = (role, label) => {
    const inp = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, placeholder: '4–8 digits', autocomplete: 'off', 'aria-label': label });
    const has = () => !!store.meta.security?.[role];
    const st = h('span');
    const paintSt = () => st.replaceChildren(has() ? pill(t('on'), 'good') : pill(t('off'), 'muted'));
    paintSt();
    return h('div.pin-row', h('b', label), st, inp,
      h('button.btn.small', { onclick: async () => {
        if (!/^\d{4,8}$/.test(inp.value)) { toast(t('Use 4 to 8 digits.'), { kind: 'warn' }); return; }
        if (role === 'staff' && !store.meta.security?.owner) { toast(t('Set the owner PIN first.'), { kind: 'warn' }); return; }
        await setPin(store, role, inp.value); inp.value = ''; paintSt(); toast(t('PIN saved.'));
      } }, t('Set')),
      h('button.btn.small.ghost', { onclick: async () => { if (role === 'owner') await setPin(store, 'staff', ''); await setPin(store, role, ''); paintSt(); toast(t('PIN removed.')); } }, t('Remove')));
  };
  const lockMin = h('select', { 'aria-label': t('Lock automatically after'), onchange: (e) => { store.meta.security ||= {}; store.meta.security.autoLock = +e.target.value; store._persistMeta('security'); ctx.resetIdle?.(); } },
    [[0, t('Never')], [2, t('2 minutes')], [5, t('5 minutes')], [15, t('15 minutes')]].map(([v, l]) => h('option', { value: v, selected: (store.meta.security?.autoLock || 0) === v }, l)));
  const security = h('section.card', h('h3', t('Team & security')),
    labeled(t('Team members (comma separated, used for “Assigned to”)'), h('input', { value: (s.team || []).join(', '), oninput: (e) => { s.team = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); for (const tb of store.app.tables) for (const f of tb.fields) if (f.id === 'assignee' && f.type === 'select') f.options = s.team; save(); } })),
    secure ? h('div',
      pinRow('owner', t('Owner PIN')), pinRow('staff', t('Staff PIN')),
      labeled(t('Lock automatically after'), lockMin),
      h('p.hint', t('Staff can add and edit records but cannot delete, open the builder, see private dashboards, change settings or export data. This lock protects the app on a shared device; it does not encrypt what is stored, so also use your phone or laptop screen lock.')))
      : h('p.hint.bad', t('PIN lock needs a secure connection (https:// or localhost).')));

  // ---- backup
  const lastBackup = () => (store.meta.lastBackup ? new Date(store.meta.lastBackup).toLocaleString() : t('never'));
  const lastEl = h('b', lastBackup());
  const stamp = () => new Date().toISOString().slice(0, 10);
  const markBackup = () => { store.meta.lastBackup = new Date().toISOString(); store._persistMeta('lastBackup'); lastEl.textContent = lastBackup(); };
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': t('Choose a backup file') });
  const backup = h('section.card', h('h3', t('Backup & restore')),
    h('p', t('Last backup:'), ' ', lastEl),
    h('p.hint', t('Your data lives on this device. A backup file is a full copy you can keep on a pen drive, email to yourself or upload to Google Drive. Back up at least once a week.')),
    h('div.row',
      h('button.btn.primary', { onclick: () => { download(`shop-backup-${stamp()}.json`, JSON.stringify(store.exportAll())); markBackup(); } }, icon('download', { size: 15 }), t('Download backup')),
      secure ? h('button.btn', { onclick: async () => {
        const p = await promptDialog(t('Choose a passphrase. You will need it to restore. There is no way to recover it.'), '', { type: 'password' });
        if (!p) return;
        if (p.length < 6) { toast(t('Use at least 6 characters.'), { kind: 'warn' }); return; }
        download(`shop-backup-${stamp()}.enc.json`, JSON.stringify(await encryptJson(store.exportAll(), p))); markBackup();
      } }, icon('lock', { size: 15 }), t('Download encrypted backup')) : null),
    h('div.restore', labeled(t('Restore from a backup file (replaces everything on this device)'), fileIn),
      h('button.btn', { onclick: async () => {
        const f = fileIn.files[0];
        if (!f) { toast(t('Choose a backup file first.'), { kind: 'warn' }); return; }
        try {
          let data = JSON.parse(await f.text());
          if (data.format === 'msme-builder-encrypted') {
            const p = await promptDialog(t('Passphrase for this backup'), '', { type: 'password' });
            if (!p) return;
            data = await decryptJson(data, p);
          }
          if (!(await confirmDialog(t('This replaces ALL data on this device with the backup. Continue?'), { yes: t('Restore'), danger: true }))) return;
          await store.importAll(data);
          await store.flush();
          toast(t('Restored.'));
          location.hash = '#/'; location.reload();
        } catch (e) { toast(`${t('Could not restore')}: ${e.message}`, { kind: 'warn', ms: 7000 }); }
      } }, t('Restore'))));

  // ---- sync
  const cfg = store.meta.sync;
  const url = h('input', { value: cfg?.url || (location.protocol.startsWith('http') ? location.origin : ''), placeholder: 'https://shop.example.com', 'aria-label': t('Server address') });
  const ws = h('input', { value: cfg?.ws || '', placeholder: t('e.g. sharma-store'), autocomplete: 'off', 'aria-label': t('Workspace name') });
  const pass = h('input', { type: 'password', value: '', placeholder: cfg ? '••••••' : '', autocomplete: 'off', 'aria-label': t('Passphrase') });
  const mode = h('select', { 'aria-label': t('Which way') },
    h('option', { value: 'upload' }, t('This device has my shop: upload it')), h('option', { value: 'adopt' }, t('This is a new device: download my shop')));
  const status = h('div.sync-status');
  const paintStatus = () => {
    const st = sync.status;
    status.replaceChildren(pill({ off: t('Not connected'), idle: t('Connected'), syncing: t('Syncing…'), offline: t('Offline: will sync later'), error: t('Problem') }[st], st === 'idle' ? 'good' : st === 'error' ? 'bad' : 'muted'),
      sync.lastAt ? h('span.muted', ` ${t('Last sync')}: ${sync.lastAt.toLocaleTimeString()}`) : null, sync.error ? h('div.hint.bad', sync.error) : null);
  };
  paintStatus();
  const off = sync.on(paintStatus);
  ctx.onLeave?.(off);
  const syncCard = h('section.card', h('h3', t('Sync between devices')),
    h('p.hint', t('Optional. Everything works offline. If you run the small sync server (see README) your devices share data whenever they are online, and the server keeps daily backups.')),
    status,
    h('div.two', labeled(t('Server address'), url), labeled(t('Workspace name'), ws)),
    h('div.two', labeled(t('Passphrase (the same on every device)'), pass), !cfg ? labeled(t('Which way'), mode) : h('span')),
    labeled(t('Device tag (keeps invoice numbers unique across devices, e.g. A or B)'), text(s, 'deviceTag', { maxlength: 3 })),
    h('div.row',
      h('button.btn.primary', { onclick: async () => {
        if (!url.value.trim() || !ws.value.trim() || (!pass.value && !cfg)) { toast(t('Fill in the server, workspace and passphrase.'), { kind: 'warn' }); return; }
        if (mode.value === 'adopt' && !cfg && store.app && store.records(store.app.tables[0]?.id).length && !(await confirmDialog(t('This replaces the shop on this device with the one on the server. Continue?'), { danger: true, yes: t('Replace') }))) return;
        sync.configure({ url: url.value, ws: ws.value, token: pass.value || cfg.token, adopt: !cfg && mode.value === 'adopt' });
        const r = await sync.run();
        toast(r.error ? `${t('Sync problem')}: ${r.error}` : `${t('Synced')}: ↑${r.pushed ?? 0} ↓${r.pulled ?? 0}`, { kind: r.error ? 'warn' : '' });
        if (!r.error && mode.value === 'adopt') location.reload();
      } }, cfg ? t('Save & sync now') : t('Connect')),
      cfg ? h('button.btn', { onclick: async () => { const r = await sync.run(); toast(r.error ? `${t('Sync problem')}: ${r.error}` : `${t('Synced')}: ↑${r.pushed ?? 0} ↓${r.pulled ?? 0}`); } }, t('Sync now')) : null,
      cfg ? h('button.btn.ghost', { onclick: () => { sync.disconnect(); location.reload(); } }, t('Disconnect')) : null));

  // ---- Smart Collect
  const collectCard = collectSetup(store.app) ? smartCollectCard(store, sync, save) : null;

  // ---- data
  const usage = h('span.muted');
  navigator.storage?.estimate?.().then((e) => { if (e?.usage !== undefined) usage.textContent = `${(e.usage / 1048576).toFixed(1)} MB ${t('used')}`; });
  const tpl = TEMPLATES.find((x) => x.id === store.app.template);
  const data = h('section.card', h('h3', t('This device')), h('p', usage),
    h('div.row',
      navigator.storage?.persist ? h('button.btn', { onclick: async () => toast((await navigator.storage.persist()) ? t('Done: the browser will keep your data.') : t('The browser did not agree. Install the app to your home screen and try again.')) }, t('Keep my data safe from cleanup')) : null,
      tpl?.sample ? h('button.btn', { onclick: async () => { if (await confirmDialog(t('Add the example customers, items and bills?'), { yes: t('Add') })) { await tpl.sample(store, t); toast(t('Example data added.')); } } }, t('Add example data')) : null,
      h('button.btn.danger', { onclick: async () => {
        const word = await promptDialog(t('This erases EVERYTHING on this device. Type DELETE to confirm.'), '');
        if (word?.trim() !== 'DELETE') return;
        await store.wipeAll(); await store.flush(); location.hash = '#/'; location.reload();
      } }, t('Erase everything'))),
    h('p.hint', `${t('Version')} ${VERSION}`));

  return h('div.settings-page', pageHeader(t('Settings')), business, gstCard, collectCard, region, security, backup, syncCard, data);
}

/**
 * Smart Collect: UPI payments confirmed by the bank mark bills paid by themselves. Needs a UPI id that belongs to a
 * collections account (Decentro or another provider), and the sync server, which receives the provider's webhook.
 */
function smartCollectCard(store, sync, save) {
  const s = store.settings;
  const c = s.collect ||= { enabled: false, sandbox: true, provider: 'decentro' };
  const status = h('div.collect-status');
  const hookBox = h('div.collect-hook');
  const stats = collectStats(store);
  const needs = [];
  if (!String(store.business.upi || '').trim()) needs.push(t('a UPI ID above (the one your payment provider gave you)'));
  if (!store.meta.sync?.enabled) needs.push(t('sync turned on (below): the bank’s confirmation reaches your devices through it'));
  const paint = () => {
    status.replaceChildren(
      c.enabled ? pill(t('on'), 'good') : pill(t('off'), 'muted'),
      c.enabled ? h('span.muted', ` ${t('Last 30 days')}: ${t('{n} payments matched by themselves', { n: stats.auto })} (${fmtMoney(stats.autoAmount)})${stats.total ? ` · ${Math.round(stats.autoRate * 100)}% ${t('automatic')}` : ''}`) : null);
  };
  paint();
  const toggle = h('input', { type: 'checkbox', checked: !!c.enabled, onchange: (e) => {
    c.enabled = e.target.checked;
    if (c.enabled && !c.since) c.since = todayStr();   // only UPI rows from today on are checked against the bank
    save(); paint();
  } });
  const showHook = async (rotate = false) => {
    try {
      const r = await sync.collectSetup({ rotate });
      const copy = (v) => h('button.btn.small', { onclick: async () => { try { await navigator.clipboard.writeText(v); toast(t('Copied.')); } catch { toast(v, { ms: 15000 }); } } }, t('Copy'));
      hookBox.replaceChildren(
        labeled(t('Webhook URL (paste into your provider’s dashboard)'), h('div.row', h('code.collect-code', r.hookUrl), copy(r.hookUrl))),
        labeled(t('Signing secret (HMAC-SHA256 of the request body, sent in X-Signature)'), h('div.row', h('code.collect-code', r.secret), copy(r.secret))),
        h('p.hint', t('The server must be reachable from the internet over https for the provider to call it (Caddy, nginx or a Cloudflare Tunnel in front of it). Keep the secret private; rotating it retires the old URL.')),
        h('div.row', h('button.btn.small.ghost', { onclick: async () => { if (await confirmDialog(t('Make a new URL and secret? The old ones stop working.'), { danger: true, yes: t('Rotate') })) showHook(true); } }, t('Rotate secret')),
          r.sandbox ? pill(t('sandbox payments allowed on this server'), 'info') : null));
    } catch (e) { toast(e.message, { kind: 'warn', ms: 7000 }); }
  };
  const simulate = async () => {
    const open = openBills(store).filter((b) => b.balance > 0.004).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const pick = open[0];
    const amt = await promptDialog(pick ? t('Amount the customer pays (for bill {n})', { n: pick.number }) : t('Amount the customer pays'), pick ? String(pick.balance) : '100');
    if (!amt) return;
    try {
      await sync.simulatePayment({ amount: Number(amt), ref: pick?.ref || '', name: t('Sandbox customer') });
      toast(t('Sent. The bank’s confirmation arrives in a second or two.'));
    } catch (e) { toast(e.message, { kind: 'warn', ms: 7000 }); }
  };
  return h('section.card.collect-card', h('h3', t('Smart Collect: UPI that marks bills paid')), status,
    h('p.hint', t('Every bill’s QR carries its own reference. When the customer pays, your payment provider (for example Decentro) tells your sync server, and the bill is marked paid by itself with the bank’s UTR, on every device. No screenshots to check, no matching by hand. Billing still works offline; only the confirmation needs the internet.')),
    needs.length ? h('div.banner.warn', h('span', `${t('Needs')}: ${needs.join('; ')}.`)) : null,
    h('label.check', toggle, ` ${t('Turn on Smart Collect')}`),
    h('label.check', h('input', { type: 'checkbox', checked: !!c.sandbox, onchange: (e) => { c.sandbox = e.target.checked; save(); } }), ` ${t('Sandbox: show “Simulate payment” buttons (for trying it out and demos)')}`),
    h('div.row',
      h('button.btn', { disabled: !store.meta.sync?.enabled, onclick: () => showHook() }, t('Show webhook URL & secret')),
      c.sandbox ? h('button.btn', { disabled: !store.meta.sync?.enabled, onclick: simulate }, t('Simulate a payment')) : null,
      h('a.btn.ghost', { href: '#/outbox/payments' }, t('Payments to check'))),
    hookBox);
}
