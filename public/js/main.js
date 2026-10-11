// App shell: boot, routing, navigation, lock screen, global shortcuts, offline indicator.
import { Store } from './store.js';
import { bestDb } from './db.js';
import { Sync } from './sync.js';
import { t, setLang, LANGS, getLang } from './i18n.js';
import { h, modal, toast, $ } from './ui/dom.js';
import { lockEnabled, checkPin } from './security.js';
import { homeView, listView, formView, recordView, printView } from './views/data.js';
import { inboxView } from './views/inbox.js';
import { dashboardsView } from './views/reports.js';
import { buildHome, tableDesigner } from './views/build.js';
import { ruleEditor } from './views/workflows.js';
import { dashEditor } from './views/dashbuild.js';
import { settingsView, applyTheme } from './views/settings.js';
import { onboardingView } from './views/onboarding.js';
import { posView, posTable } from './views/pos.js';
import { emptyState } from './ui/bits.js';
import { canSee } from './views/data.js';
import { gstReturnsView, usesGst } from '../gst/js/ui.js';
import { upgradeCounter, upgradeStock } from './templates/common.js';
import { upgradeCollect, reconcileAll, collectSetup, COLLECT_TABLE } from './collect.js';
import { passportView } from './views/passport.js';
import { fmtMoney } from './schema.js';
import { icon, iconFor } from './ui/icons.js';
import { combobox } from './ui/combobox.js';
import { searchRecords, recordLabel } from './schema.js';

const store = new Store({ db: bestDb() });
const sync = new Sync(store);
const state = { role: 'owner', unsubs: [], destroy: null, bannerDismissed: false, installEvt: null, idleTimer: null };
const root = document.getElementById('app');
let main, nav, topbar, banner;

// ---- routes ----------------------------------------------------------------------------------------------------
const ownerOnly = (fn) => (ctx, ...a) => (ctx.role === 'owner' ? fn(ctx, ...a) : emptyState('🔒', t('Only the owner can open this'), '', h('a.btn', { href: '#/' }, t('Home'))));
const ROUTES = [
  [/^\/$/, (c) => (c.role === 'staff' && posTable(store) ? posView(c) : homeView(c))],   // a cashier starts at the counter, not on charts
  [/^\/pos$/, (c) => posView(c)],
  [/^\/t\/([^/]+)\/new$/, (c, id) => formView(c, id)],
  [/^\/t\/([^/]+)\/([^/]+)\/edit$/, (c, id, rid) => formView(c, id, rid)],
  [/^\/t\/([^/]+)\/([^/]+)\/print$/, (c, id, rid) => printView(c, id, rid, c.query)],
  [/^\/t\/([^/]+)\/([^/]+)$/, (c, id, rid) => recordView(c, id, rid, c.query)],
  [/^\/t\/([^/]+)$/, (c, id) => listView(c, id)],
  [/^\/outbox(?:\/(\w+))?$/, (c, tab) => inboxView(c, tab || 'messages')],
  [/^\/reports(?:\/([^/]+))?$/, (c, id) => dashboardsView(c, id)],
  [/^\/gst(?:\/(gstr1|gstr3b|dues))?$/, ownerOnly((c, tab) => gstReturnsView(c, tab || 'gstr1'))],
  [/^\/build$/, ownerOnly((c) => buildHome(c, 'tables'))],
  [/^\/build\/(rules|dashboards)$/, ownerOnly((c, tab) => buildHome(c, tab))],
  [/^\/build\/t\/([^/]+)$/, ownerOnly((c, id) => tableDesigner(c, id))],
  [/^\/build\/rules\/([^/]+)$/, ownerOnly((c, id) => ruleEditor(c, id))],
  [/^\/build\/d\/([^/]+)$/, ownerOnly((c, id) => dashEditor(c, id))],
  [/^\/credit$/, ownerOnly((c) => passportView(c))],
  [/^\/settings$/, ownerOnly((c) => settingsView(c))],
];

function makeCtx(query) {
  return {
    store, sync, query, role: state.role, userName: state.role === 'owner' ? t('Owner') : t('Staff'),
    watch: (fn) => { state.unsubs.push(store.on(fn)); },
    onLeave: (fn) => state.unsubs.push(fn),
    resetIdle,
  };
}

function route() {
  state.unsubs.forEach((f) => f()); state.unsubs = [];
  try { state.destroy?.(); } catch (e) { console.error(e); }
  state.destroy = null;
  document.querySelectorAll('.cb-list, .chart-tip').forEach((x) => x.remove());
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  let el = null;
  for (const [re, fn] of ROUTES) {
    const m = re.exec(path);
    if (!m) continue;
    try {
      const out = fn(makeCtx(query), ...m.slice(1).map(decodeURIComponent));
      if (out && out.el && !(out instanceof Node)) { el = out.el; state.destroy = out.destroy; } else el = out;
    } catch (e) {
      console.error(e);
      el = emptyState('⚠️', t('Something went wrong'), String(e.message || e), h('button.btn', { onclick: () => location.reload() }, t('Reload')));
    }
    break;
  }
  el ||= emptyState('❓', t('Page not found'), '', h('a.btn', { href: '#/' }, t('Home')));
  main.replaceChildren(el);
  main.scrollTop = 0; window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
  paintNav(path);
  paintBanner(path);
  document.getElementById('nav-toggle')?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('nav-open');
}

// ---- shell -------------------------------------------------------------------------------------------------------
function navItem(href, ic, label, { badge, id } = {}) {
  return h('a.nav-item', { href, dataset: { href }, id, title: label }, ic, h('span.lbl', label), badge ? h('span.badge', String(badge)) : null);
}
const navBtn = (ic, label, onclick, cls = '') => h('button.nav-item.nav-btn', { type: 'button', class: cls, onclick, title: label }, icon(ic), h('span.lbl', label));
function paintNav(path = (location.hash.slice(1) || '/').split('?')[0]) {
  if (!nav) return;
  const owner = state.role === 'owner';
  const boards = (store.app.dashboards || []).filter((d) => !d.ownerOnly || owner);
  nav.replaceChildren(
    navItem('#/', icon(owner ? 'home' : 'scan'), owner ? t('Home') : t('Billing counter')),
    owner && posTable(store) ? navItem('#/pos', icon('scan'), t('Billing counter')) : null,
    h('div.nav-sec', t('My data')),
    store.app.tables.filter((tb) => canSee({ role: state.role }, tb)).map((tb) => navItem(`#/t/${tb.id}`, iconFor(tb.icon), tb.name)),
    h('div.nav-sec', t('Insights')),
    boards.length ? navItem('#/reports', icon('chart'), t('Reports')) : null,
    owner && usesGst(store) ? navItem('#/gst', icon('calculator'), t('GST returns')) : null,
    owner && collectSetup(store.app) ? navItem('#/credit', icon('trend'), t('Credit passport')) : null,
    navItem('#/outbox', icon('inbox'), t('Messages & approvals'), { badge: store.badgeCount() }),
    owner ? [h('div.nav-sec', t('Owner')), navItem('#/build', icon('grid'), t('App builder')), navItem('#/settings', icon('settings'), t('Settings'))] : null,
    h('div.nav-foot',
      state.installEvt ? navBtn('download', t('Install app'), async () => { state.installEvt.prompt(); await state.installEvt.userChoice; state.installEvt = null; paintNav(); }) : null,
      owner ? navBtn('handover', t('Hand over to staff'), handOver, 'handover') : null,
      lockEnabled(store) ? navBtn('lock', t('Lock'), () => lock()) : null));
  nav.querySelector('.handover')?.setAttribute('title', t('Lock the owner screens and open the counter view for staff'));
  // highlight the deepest matching item
  const items = [...nav.querySelectorAll('a.nav-item')];
  let best = null;
  for (const it of items) {
    const p = it.dataset.href.slice(1);
    if ((p === '/' ? path === '/' : path === p || path.startsWith(p + '/')) && (!best || p.length > best.dataset.href.length)) best = it;
  }
  best?.classList.add('active'); best?.setAttribute('aria-current', 'page');
}

// Connection status, always visible: tells staff at a glance whether what they type is reaching the other devices.
const netPill = h('span.net', { role: 'status', 'aria-live': 'polite' });
const ago = (d) => {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  return s < 10 ? t('just now') : s < 60 ? t('{n} s ago', { n: s }) : s < 3600 ? t('{n} min ago', { n: Math.floor(s / 60) }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
function paintNet() {
  const off = navigator.onLine === false;
  const on = !!sync.config?.enabled;
  const st = sync.status;
  const waiting = sync.pending;
  let tone = '', text = '', tip = '';
  if (off) {
    tone = 'warn';
    text = waiting ? t('Offline · {n} to sync', { n: waiting }) : t('Offline: saved on this device');
    tip = t('Everything is saved on this device and will sync when the internet is back.');
  } else if (!on) {
    netPill.hidden = true; return;
  } else if (st === 'error') {
    tone = 'bad'; text = t('Sync problem'); tip = sync.error;
  } else if (st === 'syncing' || waiting) {
    tone = 'busy'; text = waiting ? t('Syncing {n}…', { n: waiting }) : t('Syncing…');
  } else if (sync.live) {
    tone = 'live'; text = t('Live');
    tip = `${t('Connected. Changes from other devices appear here instantly.')}${sync.lastAt ? ` ${t('Last sync')}: ${ago(sync.lastAt)}` : ''}`;
  } else {
    tone = 'good'; text = sync.lastAt ? `${t('Synced')} ${ago(sync.lastAt)}` : t('Synced');
  }
  netPill.hidden = false;
  netPill.dataset.tone = tone;
  netPill.title = tip;
  netPill.replaceChildren(h('i.net-dot', { 'aria-hidden': 'true' }), h('span.net-txt', text));
}
setInterval(() => { if (!netPill.hidden) paintNet(); }, 15000);

function paintBanner(path) {
  banner.replaceChildren();
  banner.hidden = true;
  if (state.role !== 'owner') return;
  const total = store.app.tables.reduce((n, tb) => n + store.count(tb.id), 0);
  // nag after 7 days without a backup, or 3 days after first use if there has never been one
  const anchor = store.meta.lastBackup || store.meta.firstRun;
  const last = anchor ? Date.now() - new Date(anchor).getTime() : 0;
  const due = store.meta.lastBackup ? 7 : 3;
  const items = [];
  if (path === '/' && store.meta.tips) {
    // one slim line, not a paragraph: it sits above the sales numbers on small counter screens
    const key = (k, label) => h('span.tip-key', h('kbd', k), label);
    items.push(h('div.banner.tip', h('span.tip-keys', '💡', key('N', t('new bill')), key('Enter', t('next field')), key('Ctrl+S', t('save')), key('?', t('all shortcuts'))),
      h('button.icon-btn.tip-x', { 'aria-label': t('Got it'), title: t('Got it'), onclick: () => { delete store.meta.tips; store._persistMeta('tips'); paintBanner(path); } }, '✕')));
  }
  if (total > 0 && last > due * 86400000 && !state.bannerDismissed && !store.meta.sync?.enabled) {
    items.push(h('div.banner.warn', h('span', `🛟 ${t('Back up your data')} — ${store.meta.lastBackup ? t('last backup {d} days ago', { d: Math.floor(last / 86400000) }) : t('you have never made a backup')}.`),
      h('a.btn.small.primary', { href: '#/settings' }, t('Back up now')), h('button.btn.small.ghost', { onclick: () => { state.bannerDismissed = true; paintBanner(path); } }, t('Later'))));
  }
  if (items.length) { banner.append(...items); banner.hidden = false; }
}

function buildShell() {
  const businessName = () => store.business.name || store.app.name;
  const quick = store.app.tables.find((x) => x.quick && store.canAddTo(x.id));
  const who = state.role === 'owner' ? t('Owner') : t('Staff');
  topbar = h('header.topbar',
    h('button.icon-btn#nav-toggle', { 'aria-label': t('Menu'), 'aria-expanded': 'false', onclick: () => { const o = document.body.classList.toggle('nav-open'); $('#nav-toggle').setAttribute('aria-expanded', String(o)); } }, icon('menu', { size: 20 })),
    h('a.brand', { href: '#/' }, h('span.logo', icon('logo', { size: 16 })), h('b', businessName())),
    globalSearch(),
    h('span.spacer'), netPill,
    quick ? h('a.btn.primary.small.top-new', { href: posTable(store) ? '#/pos' : `#/t/${quick.id}/new`, title: `${t('New bill')} (N)` }, icon('plus', { size: 16 }), h('span.top-new-lbl', t('New'))) : null,
    h('button.icon-btn.top-help', { type: 'button', 'aria-label': t('Keyboard shortcuts'), title: `${t('Keyboard shortcuts')} (?)`, onclick: showShortcuts }, icon('help', { size: 20 })),
    h('a.icon-btn.bell', { href: '#/outbox', 'aria-label': t('Messages & approvals'), title: t('Messages & approvals') }, icon('bell', { size: 20 }), h('span.badge#bell-badge')),
    h('span.who', { title: `${businessName()} · ${who}` }, h('span.avatar', (businessName() || '?').trim().slice(0, 1).toUpperCase()), h('span.who-txt', h('b', businessName()), h('small', who))));
  nav = h('nav.sidebar', { 'aria-label': t('Main') });
  banner = h('div.banners', { hidden: true });
  main = h('main#view', { tabindex: '-1' });
  root.replaceChildren(topbar, h('div.layout', nav, h('div.content', banner, main)), h('div.scrim', { onclick: () => document.body.classList.remove('nav-open') }));
  paintBadge(); paintNet();
}
/** Find any record from anywhere: invoice number, customer name or phone, item code… (first few hits per table). */
function globalSearch() {
  const role = { role: state.role };
  const cb = combobox({
    clearOnPick: true, className: 'gsearch', ariaLabel: t('Search'), placeholder: t('Search bills, customers, items…'),
    getOptions: (q) => {
      if (!q.trim()) return [];
      return store.app.tables.filter((tb) => canSee(role, tb)).flatMap((tb) => searchRecords(tb, store.records(tb.id), q, 3)
        .map((r) => ({ id: `${tb.id}/${r.id}`, label: recordLabel(tb, r), sub: tb.name }))).slice(0, 12);
    },
    labelOf: () => '',
    onPick: (o) => { location.hash = `#/t/${o.id}`; },
  });
  return h('div.top-search', icon('search', { size: 16 }), cb.el);
}
function paintBadge() { const b = $('#bell-badge'); if (b) { const n = store.badgeCount(); b.textContent = n ? String(n) : ''; b.hidden = !n; } }

// ---- lock screen -------------------------------------------------------------------------------------------------
function lock() {
  clearTimeout(state.idleTimer);
  showLock(() => { route(); paintNav(); buildShellIfNeeded(); resetIdle(); });
}
/** Counter view for a cashier: needs a staff PIN (to get in) and an owner PIN (so the cashier cannot get back out). */
function handOver() {
  const sec = store.meta.security || {};
  if (!sec.owner || !sec.staff) {
    toast(t('Set an owner PIN and a staff PIN first (Settings → Team & security). Staff unlock with theirs and only see billing.'), { kind: 'warn', ms: 8000 });
    location.hash = '#/settings';
    return;
  }
  lock();
}
function buildShellIfNeeded() { if (!topbar?.isConnected) { buildShell(); route(); } }
function showLock(onOk) {
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, 'aria-label': t('PIN'), autofocus: true });
  const msg = h('div.hint.bad', { role: 'alert' });
  const go = async () => {
    const role = await checkPin(store, pin.value);
    if (!role) { msg.textContent = t('Wrong PIN'); pin.value = ''; pin.focus(); return; }
    state.role = role; store.currentUser = role;
    overlay.remove(); buildShell(); onOk();
  };
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const overlay = h('div.lock', h('div.lock-card', h('div.lock-ic', icon('lock', { size: 26 })), h('h2', store.business.name || store.app?.name || ''), h('p', t('Enter your PIN')), pin, msg, h('button.btn.primary', { onclick: go }, t('Unlock'))));
  document.body.append(overlay);
  root.replaceChildren();
  pin.focus();
}
function resetIdle() {
  clearTimeout(state.idleTimer);
  const mins = store.meta.security?.autoLock;
  if (mins && lockEnabled(store)) state.idleTimer = setTimeout(lock, mins * 60000);
}

// ---- shortcuts ---------------------------------------------------------------------------------------------------
function showShortcuts() {
  const row = (k, d) => h('tr', h('td', h('kbd', k)), h('td', d));
  modal({ title: t('Keyboard shortcuts'), body: h('div',
    h('h4', t('Anywhere')), h('table.plain', h('tbody', row('N', t('New record (in the list you are viewing; a new bill from the home screen)')), row('/', t('Search')), row('?', t('This help')))),
    h('h4', t('In a form')), h('table.plain', h('tbody', row('Enter', t('Go to the next field')), row('Ctrl + S', t('Save')), row('Ctrl + Enter', t('Save and print / share')),
      row('Enter (empty scan bar)', t('Go to Save: Enter again saves the bill')))),
    posTable(store) ? [h('h4', t('Billing counter')), h('table.plain', h('tbody',
      row('F1 / F2 / F3', t('Paid by Cash / UPI / Card')), row('F4', t('Discount')), row('F8', t('Customer')), row('F9', t('Credit (needs a customer)')),
      row('Enter (empty scan bar)', t('Save the bill (and print)')), row('Esc', t('Clear the bill'))))] : null,
    h('h4', t('Item lines (bills, purchases)')), h('table.plain', h('tbody',
      row('Type code + Enter', t('Pick the highlighted item')), row('↑ ↓', t('Change the highlighted item')), row('Enter (after quantity)', t('Next row appears automatically')),
      row('Alt + N  /  Insert', t('Add a row below')), row('Alt + D  /  Ctrl + Delete', t('Delete this row')), row('Quick entry: CODE*3 + Enter', t('Add 3 of that item')))),
  ) });
}
document.addEventListener('keydown', (e) => {
  const el = e.target;
  const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.overlay, .lock')) return;
  if (e.key === '?') { e.preventDefault(); showShortcuts(); }
  else if (e.key === '/') { const s = $('#view .search') || $('.gsearch input'); if (s) { e.preventDefault(); s.focus(); } }
  else if (e.key === 'n' || e.key === 'N') {
    // in a list: a new one of those; anywhere else (the home screen included): a new bill, no mouse needed
    const m = /^#\/t\/([^/?]+)(?:\/|$|\?)/.exec(location.hash);
    const here = m && store.table(m[1]);
    const pos = posTable(store);
    const tb = (here && store.canAddTo(here.id) ? here : null) || store.app?.tables.find((x) => x.quick && store.canAddTo(x.id)) || store.app?.tables[0];
    if (tb && !location.hash.includes('/build')) {
      e.preventDefault();
      location.hash = pos && (!here || here.id === pos) ? '#/pos' : `#/t/${tb.id}/new`;   // a bill: the counter; anything else: its form
      // the shortcut has been learnt: retire the tips strip after a few uses
      if (store.meta.tips && (store.meta.tips = (+store.meta.tips || 1) + 1) > 3) delete store.meta.tips;
      store._persistMeta('tips');
    }
  }
});
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (state.idleTimer) resetIdle(); }, { passive: true }));

// ---- boot -----------------------------------------------------------------------------------------------------------
async function afterStart() {
  store.currentUser = state.role;
  buildShell();
  route();
  resetIdle();
  const tick = async () => {
    const n = await store.runSchedule();
    store.flushWebhooks();
    return n;
  };
  tick();
  setInterval(tick, 3600000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { tick(); sync.run(); } });
  window.addEventListener('online', () => { paintNet(); store.flushWebhooks(); });
  window.addEventListener('offline', paintNet);
  sync.on(paintNet);
  store.on((e) => {
    paintBadge();
    if (e.type === 'outbox' || e.type === 'approval' || e.type === 'app') paintNav();
  });
  window.addEventListener('hashchange', route);
  startCollect();
}

// ---- Smart Collect: match bank-confirmed UPI payments to bills as soon as they arrive (on any device) ----------------
function startCollect() {
  let busy = false, again = false, timer = null;
  const run = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try { await reconcileAll(store); } catch (e) { console.error('collect', e); } finally {
      busy = false;
      if (again) { again = false; soon(); }
    }
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
  store.on((e) => {
    if (e.type === 'record' && (e.table === COLLECT_TABLE || e.table === collectSetup(store.app)?.table.id)) soon();
    if (e.type === 'collected') {
      const what = e.bills.filter(Boolean).join(', ');
      toast(e.verified ? `✓ ${t('Bank confirmed {amount} by UPI', { amount: fmtMoney(e.amount) })}${what ? ` · ${what}` : ''}`
        : `✓ ${t('{amount} received by UPI', { amount: fmtMoney(e.amount) })}${what ? ` · ${what} ${t('marked paid')}` : ''}`, { ms: 7000 });
    }
  });
  soon();
}

function begin() {
  if (lockEnabled(store)) showLock(afterStart);
  else afterStart();
}

async function boot() {
  const hasApp = await store.init();
  if (hasApp) store.migrateAccess();
  const saved = store.settings.lang || localStorage.getItem('lang') || (navigator.language || 'en').slice(0, 2);
  await setLang(LANGS[saved] ? saved : 'en');
  if (hasApp && upgradeCounter(store.app, t)) store.setApp(store.app);   // after setLang: new titles in the shop's language
  if (hasApp && upgradeCollect(store.app, t)) store.setApp(store.app);
  if (hasApp && upgradeStock(store.app, t)) store.setApp(store.app);    // stock as movements, so it merges across devices
  applyTheme();
  sync.start();
  registerSW();
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvt = e; if (nav) paintNav(); });
  window.__app = { store, sync, state };   // handy for support and automated tests
  if (!hasApp) {
    root.replaceChildren(onboardingView({ store, sync, onDone: () => { localStorage.setItem('lang', getLang()); begin(); } }));
  } else begin();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) toast(t('A new version is ready.'), { action: { label: t('Reload'), fn: () => location.reload() }, ms: 20000 });
      });
    });
  }).catch(() => { /* offline install needs https or localhost; the app still works online */ });
}

boot().catch((e) => {
  console.error(e);
  root.replaceChildren(emptyState('⚠️', 'Could not start', String(e.message || e)));
});
