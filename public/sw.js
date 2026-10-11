// Service worker: makes the app open instantly and work with no internet after the first visit.
// The file list below is generated: run `npm run build:sw` after adding or renaming files (a test checks it).
const VERSION = '81e9396a44';
const PRECACHE = [
  "./",
  "./css/app.css",
  "./gst/js/gst.js",
  "./gst/js/hooks.js",
  "./gst/js/returns.js",
  "./gst/js/ui.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon.svg",
  "./index.html",
  "./js/analytics.js",
  "./js/collect.js",
  "./js/credit.js",
  "./js/csv.js",
  "./js/db.js",
  "./js/formula.js",
  "./js/i18n.js",
  "./js/lang/hi.js",
  "./js/lang/ta.js",
  "./js/lang/te.js",
  "./js/ledger.js",
  "./js/logic.js",
  "./js/main.js",
  "./js/print.js",
  "./js/protocol.js",
  "./js/rules.js",
  "./js/schema.js",
  "./js/security.js",
  "./js/store.js",
  "./js/sync.js",
  "./js/templates/common.js",
  "./js/templates/gst.js",
  "./js/templates/index.js",
  "./js/templates/retail.js",
  "./js/templates/service.js",
  "./js/ui/bits.js",
  "./js/ui/charts.js",
  "./js/ui/combobox.js",
  "./js/ui/conditions.js",
  "./js/ui/controls.js",
  "./js/ui/dom.js",
  "./js/ui/form.js",
  "./js/ui/icons.js",
  "./js/ui/lines.js",
  "./js/ui/scanner.js",
  "./js/vendor/qrcode.js",
  "./js/views/build.js",
  "./js/views/dashbuild.js",
  "./js/views/data.js",
  "./js/views/importer.js",
  "./js/views/inbox.js",
  "./js/views/onboarding.js",
  "./js/views/passport.js",
  "./js/views/payments.js",
  "./js/views/pos.js",
  "./js/views/reports.js",
  "./js/views/settings.js",
  "./js/views/workflows.js",
  "./manifest.webmanifest"
];

const CACHE = `vina-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => (k.startsWith('vina-') || k.startsWith('msme-builder-')) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // page loads: serve the app shell from cache so any #/route works offline
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((hit) => hit || fetch(req)).catch(() => caches.match('./index.html')),
    );
    return;
  }
  // everything else: cache first, refresh in the background (stale-while-revalidate)
  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || refresh;
    }),
  );
});
