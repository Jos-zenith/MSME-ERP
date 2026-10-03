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
import { emptyState } from './ui/bits.js';

const store = new Store({ db: bestDb() });
const sync = new Sync(store);
const state = { role: 'owner', unsubs: [], destroy: null, bannerDismissed: false, installEvt: null, idleTimer: null };
const root = document.getElementById('app');
let main, nav, topbar, banner;

// ---- routes ----------------------------------------------------------------------------------------------------
const ownerOnly = (fn) => (ctx, ...a) => (ctx.role === 'owner' ? fn(ctx, ...a) : emptyState('🔒', t('Only the owner can open this'), '', h('a.btn', { href: '#/' }, t('Home'))));
const ROUTES = [
  [/^\/$/, (c) => homeView(c)],
  [/^\/t\/([^/]+)\/new$/, (c, id) => formView(c, id)],
  [/^\/t\/([^/]+)\/([^/]+)\/edit$/, (c, id, rid) => formView(c, id, rid)],
  [/^\/t\/([^/]+)\/([^/]+)\/print$/, (c, id, rid) => printView(c, id, rid, c.query)],
  [/^\/t\/([^/]+)\/([^/]+)$/, (c, id, rid) => recordView(c, id, rid, c.query)],
  [/^\/t\/([^/]+)$/, (c, id) => listView(c, id)],
  [/^\/outbox(?:\/(\w+))?$/, (c, tab) => inboxView(c, tab || 'messages')],
  [/^\/reports(?:\/([^/]+))?$/, (c, id) => dashboardsView(c, id)],
  [/^\/build$/, ownerOnly((c) => buildHome(c, 'tables'))],
  [/^\/build\/(rules|dashboards)$/, ownerOnly((c, tab) => buildHome(c, tab))],
  [/^\/build\/t\/([^/]+)$/, ownerOnly((c, id) => tableDesigner(c, id))],
  [/^\/build\/rules\/([^/]+)$/, ownerOnly((c, id) => ruleEditor(c, id))],
  [/^\/build\/d\/([^/]+)$/, ownerOnly((c, id) => dashEditor(c, id))],
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
function navItem(href, icon, label, { badge, id } = {}) {
  return h('a.nav-item', { href, dataset: { href }, id }, h('span.ic', icon), h('span.lbl', label), badge ? h('span.badge', String(badge)) : null);
}
function paintNav(path = (location.hash.slice(1) || '/').split('?')[0]) {
  if (!nav) return;
  const owner = state.role === 'owner';
  const boards = (store.app.dashboards || []).filter((d) => !d.ownerOnly || owner);
  nav.replaceChildren(
    navItem('#/', '🏠', t('Home')),
    h('div.nav-sec', t('My data')),
    store.app.tables.map((tb) => navItem(`#/t/${tb.id}`, tb.icon || '📄', tb.name)),
    h('div.nav-sec', t('Insights')),
    boards.length ? navItem('#/reports', '📊', t('Reports')) : null,
    navItem('#/outbox', '💬', t('Messages & approvals'), { badge: store.badgeCount() }),
    owner ? [h('div.nav-sec', t('Owner')), navItem('#/build', '🧱', t('App builder')), navItem('#/settings', '⚙️', t('Settings'))] : null,
    h('div.nav-foot',
      state.installEvt ? h('button.btn.small.block', { onclick: async () => { state.installEvt.prompt(); await state.installEvt.userChoice; state.installEvt = null; paintNav(); } }, `⬇ ${t('Install app')}`) : null,
      lockEnabled(store) ? h('button.btn.small.block.ghost', { onclick: () => lock() }, `🔒 ${t('Lock')}`) : null,
      h('button.btn.small.block.ghost', { onclick: showShortcuts }, `⌨ ${t('Keyboard shortcuts')}`)));
  // highlight the deepest matching item
  const items = [...nav.querySelectorAll('.nav-item')];
  let best = null;
  for (const it of items) {
    const p = it.dataset.href.slice(1);
    if ((p === '/' ? path === '/' : path === p || path.startsWith(p + '/')) && (!best || p.length > best.dataset.href.length)) best = it;
  }
  best?.classList.add('active'); best?.setAttribute('aria-current', 'page');
}

const netPill = h('span.pill.net', { role: 'status' });
function paintNet() {
  const off = navigator.onLine === false;
  const st = sync.status;
  netPill.dataset.tone = off ? 'warn' : st === 'error' ? 'bad' : st === 'idle' ? 'good' : 'muted';
  netPill.textContent = off ? `⚡ ${t('Offline: saved on this device')}` : st === 'syncing' ? `↻ ${t('Syncing…')}` : st === 'error' ? `⚠ ${t('Sync problem')}` : st === 'idle' ? `✓ ${t('Synced')}` : '';
  netPill.hidden = !netPill.textContent;
}

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
    items.push(h('div.banner.ok', h('span', `💡 ${t('Tips: press N for a new record · Enter moves to the next field · in a bill, Enter after the quantity adds the next item · Ctrl+S saves · press ? for all shortcuts.')}`),
      h('button.btn.small', { onclick: () => { delete store.meta.tips; store._persistMeta('tips'); paintBanner(path); } }, t('Got it'))));
  }
  if (total > 0 && last > due * 86400000 && !state.bannerDismissed && !store.meta.sync?.enabled) {
    items.push(h('div.banner.warn', h('span', `🛟 ${t('Back up your data')} — ${store.meta.lastBackup ? t('last backup {d} days ago', { d: Math.floor(last / 86400000) }) : t('you have never made a backup')}.`),
      h('a.btn.small.primary', { href: '#/settings' }, t('Back up now')), h('button.btn.small.ghost', { onclick: () => { state.bannerDismissed = true; paintBanner(path); } }, t('Later'))));
  }
  if (items.length) { banner.append(...items); banner.hidden = false; }
}

function buildShell() {
  const businessName = () => store.business.name || store.app.name;
  topbar = h('header.topbar',
    h('button.icon-btn#nav-toggle', { 'aria-label': t('Menu'), 'aria-expanded': 'false', onclick: () => { const o = document.body.classList.toggle('nav-open'); $('#nav-toggle').setAttribute('aria-expanded', String(o)); } }, '☰'),
    h('a.brand', { href: '#/' }, h('span.logo', '▦'), h('b', businessName())),
    h('span.spacer'), netPill,
    h('a.icon-btn.bell', { href: '#/outbox', 'aria-label': t('Messages & approvals'), title: t('Messages & approvals') }, '🔔', h('span.badge#bell-badge')),
    state.role === 'staff' ? h('span.pill', { dataset: { tone: 'info' } }, t('Staff')) : null);
  nav = h('nav.sidebar', { 'aria-label': t('Main') });
  banner = h('div.banners', { hidden: true });
  main = h('main#view', { tabindex: '-1' });
  root.replaceChildren(topbar, h('div.layout', nav, h('div.content', banner, main)), h('div.scrim', { onclick: () => document.body.classList.remove('nav-open') }));
  paintBadge(); paintNet();
}
function paintBadge() { const b = $('#bell-badge'); if (b) { const n = store.badgeCount(); b.textContent = n ? String(n) : ''; b.hidden = !n; } }

// ---- lock screen -------------------------------------------------------------------------------------------------
function lock() {
  clearTimeout(state.idleTimer);
  showLock(() => { route(); paintNav(); buildShellIfNeeded(); resetIdle(); });
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
  const overlay = h('div.lock', h('div.lock-card', h('h1', '🔒'), h('h2', store.business.name || store.app?.name || ''), h('p', t('Enter your PIN')), pin, msg, h('button.btn.primary', { onclick: go }, t('Unlock'))));
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
    h('h4', t('Anywhere')), h('table.plain', h('tbody', row('N', t('New record (in the list you are viewing)')), row('/', t('Search')), row('?', t('This help')))),
    h('h4', t('In a form')), h('table.plain', h('tbody', row('Enter', t('Go to the next field')), row('Ctrl + S', t('Save')), row('Ctrl + Enter', t('Save and print / share')))),
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
  else if (e.key === '/') { const s = $('.search'); if (s) { e.preventDefault(); s.focus(); } }
  else if (e.key === 'n' || e.key === 'N') {
    const m = /^#\/t\/([^/?]+)(?:\/|$|\?)/.exec(location.hash);
    const tb = (m && store.table(m[1])) || store.app?.tables.find((x) => x.quick) || store.app?.tables[0];
    if (tb && !location.hash.includes('/build')) { e.preventDefault(); location.hash = `#/t/${tb.id}/new`; }
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
}

function begin() {
  if (lockEnabled(store)) showLock(afterStart);
  else afterStart();
}

async function boot() {
  const hasApp = await store.init();
  const saved = store.settings.lang || localStorage.getItem('lang') || (navigator.language || 'en').slice(0, 2);
  await setLang(LANGS[saved] ? saved : 'en');
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
