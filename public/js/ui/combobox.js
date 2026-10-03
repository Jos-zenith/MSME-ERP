// Accessible type-ahead picker used for every "link to another table" field (customers, items, ...).
//
// Keyboard contract (this is what fixes "you can't just press Enter to select an item code"):
//   type text   -> the best match is highlighted automatically (an exact code/barcode match is always first)
//   Enter       -> picks the highlighted match. No mouse needed.
//   Tab         -> also picks it (if you typed something) and moves on
//   ↑ / ↓       -> change the highlighted match      Esc -> close, keep the previous value
import { h } from './dom.js';
import { t } from '../i18n.js';

let uidn = 0;

/**
 * options: {
 *   getOptions(query) -> [{id,label,sub?}], labelOf(id) -> string, value, placeholder,
 *   onChange(id, option), onPick?(option)          // onPick fires after a pick (used to advance focus)
 *   onCreate?(query)                               // Enter with no match / "+ Add" row
 *   createLabel?(query) -> string, clearOnPick?, ariaLabel?, className?
 * }
 */
export function combobox(opts) {
  const uid = `cb${++uidn}`;
  let value = opts.value || '';
  let items = [];
  let active = -1;
  let open = false;
  let typed = false;
  let list;

  const input = h('input.cb-input', {
    type: 'text', role: 'combobox', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${uid}-list`,
    placeholder: opts.placeholder || '', 'aria-label': opts.ariaLabel || opts.placeholder || '',
  });
  input.value = value ? opts.labelOf(value) : '';
  const el = h('div.cb', { class: opts.className }, input);

  function position() {
    if (!list) return;
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const maxH = Math.max(140, Math.min(320, below > 200 ? below - 12 : r.top - 12));
    Object.assign(list.style, { left: `${Math.min(r.left, window.innerWidth - 280)}px`, minWidth: `${Math.max(r.width, 260)}px`, maxHeight: `${maxH}px` });
    if (below > 200 || below > r.top) list.style.top = `${r.bottom + 2}px`, list.style.bottom = 'auto';
    else list.style.bottom = `${window.innerHeight - r.top + 2}px`, list.style.top = 'auto';
  }

  function render() {
    if (!list) {
      list = h('ul.cb-list', { id: `${uid}-list`, role: 'listbox' });
      list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
      document.body.append(list);
      window.addEventListener('scroll', position, true);
      window.addEventListener('resize', position);
    }
    list.replaceChildren();
    items.forEach((o, i) => {
      list.append(h('li.cb-opt', {
        id: `${uid}-o${i}`, role: 'option', 'aria-selected': String(i === active), class: i === active ? 'active' : '',
        onmousedown: () => pick(o), onmousemove: () => { if (active !== i) { active = i; paint(); } },
      }, h('span.cb-main', o.label), o.sub ? h('span.cb-sub', o.sub) : null));
    });
    const q = input.value.trim();
    if (opts.onCreate && q) {
      list.append(h('li.cb-opt.cb-create', { role: 'option', onmousedown: () => create(q) }, `＋ ${opts.createLabel ? opts.createLabel(q) : t('Add "{q}"', { q })}`));
    }
    if (!items.length && !(opts.onCreate && q)) list.append(h('li.cb-empty', t('No match')));
    position();
  }
  function paint() {
    if (!list) return;
    [...list.querySelectorAll('.cb-opt:not(.cb-create)')].forEach((li, i) => {
      li.classList.toggle('active', i === active);
      li.setAttribute('aria-selected', String(i === active));
      if (i === active) li.scrollIntoView({ block: 'nearest' });
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', `${uid}-o${active}`); else input.removeAttribute('aria-activedescendant');
  }
  function show() {
    open = true;
    input.setAttribute('aria-expanded', 'true');
    items = opts.getOptions(typed ? input.value : '');
    active = items.length ? 0 : -1;
    render(); paint();
  }
  function hide() {
    open = false; typed = false;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    if (list) {
      list.remove(); list = null;
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    }
  }
  function pick(o, advance = true) {
    value = o.id;
    hide();
    input.value = opts.clearOnPick ? '' : o.label;
    opts.onChange?.(o.id, o);
    if (advance) opts.onPick?.(o);   // Tab moves focus itself, so it skips onPick
  }
  function create(q) { hide(); opts.onCreate(q, (id) => api.set(id)); }

  input.addEventListener('focus', () => { input.select(); });
  input.addEventListener('input', () => { typed = true; show(); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { typed = false; show(); return; }
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (e.key === 'Enter') {
      if (open && items.length && active >= 0) {
        e.preventDefault(); e.stopPropagation();
        pick(items[active]);
      } else if (open && opts.onCreate && input.value.trim()) {
        e.preventDefault(); e.stopPropagation();
        create(input.value.trim());
      }
      // otherwise let Enter bubble (e.g. "empty item cell + Enter" leaves the item grid)
    } else if (e.key === 'Tab') {
      if (open && typed && items.length && active >= 0) pick(items[active], false);
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); hide(); input.value = value && !opts.clearOnPick ? opts.labelOf(value) : ''; }
    }
  });
  input.addEventListener('blur', () => {
    hide();
    const txt = input.value.trim();
    if (!txt && value && !opts.clearOnPick) { value = ''; opts.onChange?.('', null); }   // user emptied the box
    else if (opts.clearOnPick) input.value = '';
    else input.value = value ? opts.labelOf(value) : '';                                   // discard half-typed text
  });

  const api = {
    el, input,
    focus() { input.focus(); },
    get value() { return value; },
    set(id) { value = id || ''; if (!open) input.value = value ? opts.labelOf(value) : ''; },
    destroy() { hide(); },
  };
  return api;
}
