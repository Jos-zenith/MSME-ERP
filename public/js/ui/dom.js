// Minimal DOM helpers (no framework: keeps the app small and fast on entry-level phones).
import { t } from '../i18n.js';

// Make element.append / prepend / replaceChildren behave like h(): arrays are flattened and null / undefined / false
// are skipped (natively they would print "null" or "[object HTMLDivElement],…"). Every view relies on this.
const flatKids = (kids) => kids.flat(Infinity)
  .filter((k) => k !== null && k !== undefined && k !== false)
  .map((k) => (k instanceof Node ? k : String(k)));
for (const method of ['append', 'prepend', 'replaceChildren']) {
  const native = Element.prototype[method];
  Element.prototype[method] = function patched(...kids) { return native.apply(this, flatKids(kids)); };
}

const SPLIT = /([.#]?[^.#]+)/g;
const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'readOnly', 'hidden', 'tabIndex', 'disabled', 'multiple', 'indeterminate']);

/** h('div.card#id', {onclick}, child, [children], 'text') */
export function h(tag, props, ...kids) {
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  const parts = tag.match(SPLIT) || ['div'];
  let name = 'div';
  const classes = [];
  let id = '';
  for (const p of parts) {
    if (p[0] === '.') classes.push(p.slice(1));
    else if (p[0] === '#') id = p.slice(1);
    else name = p;
  }
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(' ');
  if (id) el.id = id;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'ref') v(el);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- toast ------------------------------------------------------------------------------
let toastHost;
export function toast(message, { action, ms = 4500, kind = '' } = {}) {
  toastHost ||= document.body.appendChild(h('div#toasts', { role: 'status', 'aria-live': 'polite' }));
  const el = h('div.toast', { class: kind }, h('span', message));
  if (action) el.append(h('button.link', { onclick: () => { action.fn(); el.remove(); } }, action.label));
  toastHost.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---- modal --------------------------------------------------------------------------------
export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const prevFocus = document.activeElement;
  const overlay = h('div.overlay');
  const box = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '', class: wide ? 'wide' : '' });
  const close = (result) => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    prevFocus?.focus?.();
    onClose?.(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { if (document.querySelector('.cb-list')) return; e.stopPropagation(); close(null); }
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = $$('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])', box).filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  box.append(
    h('div.modal-head', h('h2', title || ''), h('button.icon-btn', { 'aria-label': t('Close'), onclick: () => close(null) }, '✕')),
    h('div.modal-body', body),
  );
  if (actions.length) box.append(h('div.modal-foot', actions.map((a) => h('button', { class: a.primary ? 'btn primary' : a.danger ? 'btn danger' : 'btn', onclick: () => { if (a.fn) a.fn(close); else close(a.value); } }, a.label))));
  overlay.append(box);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  (box.querySelector('[autofocus], input:not([type=hidden]), select, textarea') || box.querySelector('.btn.primary') || box).focus?.();
  return { close, el: box };
}

export function confirmDialog(message, { yes = t('Yes'), no = t('Cancel'), danger = false, title } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title: title || t('Please confirm'), body: h('p.pre', message), onClose: () => fin(false),
      actions: [{ label: no, value: false }, { label: yes, primary: !danger, danger, fn: (close) => { fin(true); close(true); } }],
    });
  });
}

export function promptDialog(label, value = '', { title, type = 'text' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type, value, autofocus: true });
    let done = false;
    const m = modal({
      title: title || label, body: h('label.field', h('span.lbl', label), input), onClose: (r) => { if (!done) { done = true; resolve(null); } },
      actions: [{ label: t('Cancel'), value: null }, { label: t('OK'), primary: true, fn: (close) => { done = true; resolve(input.value); close(); } }],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done = true; resolve(input.value); m.close(); } });
  });
}

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const debounce = (fn, ms = 150) => { let id; return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); }; };
