// Camera barcode scanning for phones without a USB / Bluetooth scanner. Uses the browser's built-in BarcodeDetector
// (Chrome and Edge on Android, ChromeOS, macOS), so it adds nothing to the download; the button is hidden elsewhere.
// Keeps scanning until "Done": every new code is handed to onCode(), the same code is ignored for 1.5 s.
import { h, modal } from './dom.js';
import { t } from '../i18n.js';

export const cameraScanSupported = () =>
  typeof globalThis.BarcodeDetector === 'function' && !!globalThis.navigator?.mediaDevices?.getUserMedia && globalThis.isSecureContext !== false;

/** onCode(code) -> { label } when it was used, or { unknown: true, add?: () => void } */
export function openScanner({ title, onCode }) {
  const video = h('video.scan-video', { playsinline: true, muted: true, autoplay: true });
  const status = h('div.hint', { role: 'status' }, t('Point the camera at a barcode'));
  const log = h('ul.scan-log', { 'aria-live': 'polite' });
  let stream = null, timer = 0, stopped = false;
  const stop = () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((tr) => tr.stop()); };
  const m = modal({
    title, onClose: stop,
    body: h('div.scan', h('div.scan-frame', video, h('div.scan-line')), status, log),
    actions: [{ label: t('Done'), primary: true, value: null }],
  });

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      status.className = 'hint bad';
      status.textContent = `${t('The camera could not be opened')}: ${e.message}`;
      return;
    }
    if (stopped) { stop(); return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    let detector;
    try {
      const formats = await globalThis.BarcodeDetector.getSupportedFormats?.().catch(() => null);
      detector = new globalThis.BarcodeDetector(formats?.length ? { formats } : undefined);
    } catch (e) { status.textContent = e.message; return; }
    const seen = new Map();
    const tick = async () => {
      if (stopped) return;
      try {
        for (const c of await detector.detect(video)) {
          const code = String(c.rawValue || '').trim(), now = Date.now();
          if (!code || now - (seen.get(code) || 0) < 1500) continue;
          seen.set(code, now);
          const r = onCode(code) || {};
          globalThis.navigator.vibrate?.(r.unknown ? [40, 60, 40] : 60);
          log.prepend(r.unknown
            ? h('li.bad', `✕ ${code} — ${t('not in your items')} `, r.add ? h('button.btn.small', { type: 'button', onclick: () => { m.close(); r.add(); } }, `＋ ${t('Add item')}`) : null)
            : h('li', `✓ ${r.label || code}`));
        }
      } catch { /* a frame that could not be read: try the next one */ }
      timer = setTimeout(tick, 200);
    };
    tick();
  })();
  return m;
}
