// First run: one screen, one optional question. The language is detected (chips switch it), the shop starts as a
// billing counter with a few example items, and the first bill is guided (pos.js). Everything else is asked when it is
// first needed: the UPI ID at the counter, the phone for alerts and a second device from the getting-started list.
import { h, toast } from '../ui/dom.js';
import { t, setLang, LANGS, getLang } from '../i18n.js';
import { labeled } from '../ui/bits.js';
import { icon } from '../ui/icons.js';
import { TEMPLATES, buildTemplate } from '../templates/index.js';
import { validateGstin, gstinProblem, stateLabel } from '../../gst/js/gst.js';
import { posTable } from './pos.js';

export function onboardingView({ store, sync, onDone }) {
  const state = { mode: 'start', name: '', gstin: '', tpl: 'retail', sample: true, more: false };
  const root = h('div.onboard');
  const card = h('div.onboard-card');
  root.append(card);

  async function finish() {
    const g = validateGstin(state.gstin);
    store.setApp(buildTemplate(state.tpl, t, { businessName: state.name.trim() || undefined, lang: getLang(), gstin: g.ok ? g.gstin : '' }));
    const tpl = TEMPLATES.find((x) => x.id === state.tpl);
    if (state.sample && tpl.sample) { await tpl.sample(store, t); store.meta.tips = true; store._persistMeta('tips'); }
    // straight to the counter for a guided first bill; businesses without one start on the home screen
    const counter = posTable(store);
    store.meta.guide = { at: store.now(), step: counter ? 'first-bill' : 'explore' };
    store._persistMeta('guide');
    await store.flush();
    location.hash = counter ? '#/pos' : '#/';
    onDone();
  }

  const langChips = () => h('div.lang-grid.lang-chips', { role: 'group', 'aria-label': t('Language') },
    Object.entries(LANGS).map(([code, name]) => h('button', { type: 'button', class: getLang() === code ? 'chip on' : 'chip', 'aria-pressed': String(getLang() === code),
      onclick: async () => { await setLang(code); paint(); } }, name)));

  function paint() {
    card.replaceChildren();
    if (state.mode === 'join') return paintJoin();
    const tpl = TEMPLATES.find((x) => x.id === state.tpl);
    const start = h('button.btn.primary.big.onboard-start', { type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; await finish(); } },
      t('Start billing'), icon('chevron', { size: 18 }));
    const name = h('input', { name: 'shop', value: state.name, placeholder: t('e.g. Sharma General Store'), autocomplete: 'organization', 'aria-label': t('Shop name'),
      oninput: (e) => { state.name = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter' && !start.disabled) start.click(); } });

    // GST invoices need the shop's own GSTIN: it decides CGST + SGST vs IGST, so it is never guessed
    let gstBox = null;
    if (tpl?.needsGstin) {
      const read = h('div.hint', { role: 'status' });
      const check = () => {
        const g = validateGstin(state.gstin);
        start.disabled = !g.ok;
        read.className = g.ok ? 'hint good' : 'hint';
        read.textContent = g.ok ? `✓ ${stateLabel(g.stateCode).replace(/^\d+ - /, '')} · PAN ${g.pan}`
          : state.gstin.trim().length >= 15 ? gstinProblem(state.gstin) : t('15 characters, e.g. 27AAPFU0939F1ZV. Your state is read from it.');
      };
      const inp = h('input.gstin-input', { value: state.gstin, maxlength: 18, autocapitalize: 'characters', spellcheck: 'false', 'aria-label': t('Your GSTIN'), placeholder: '27AAPFU0939F1ZV',
        oninput: (e) => { state.gstin = e.target.value; check(); } });
      gstBox = h('div.gst-box', labeled(t('Your GSTIN'), inp), read);
      check();
    }

    const more = state.more ? h('div.onboard-more-box',
      h('div.tpl-grid.tpl-compact', TEMPLATES.map((x) => h('button.card.tile', { type: 'button', class: state.tpl === x.id ? 'sel' : '', dataset: { tpl: x.id }, 'aria-pressed': String(state.tpl === x.id),
        onclick: () => { state.tpl = x.id; paint(); } }, h('span.tile-ic', x.icon), h('span.tile-txt', h('b', t(x.title)), h('small.muted', t(x.desc)))))),
      h('label.check', h('input', { type: 'checkbox', checked: state.sample, onchange: (e) => { state.sample = e.target.checked; paint(); } }), ` ${t('Add example data so I can try it out')}`)) : null;

    card.append(
      h('div.onboard-top', h('span.onboard-brand', h('span.logo', icon('logo', { size: 16 })), h('b', 'Vina')), langChips()),
      h('h1', t('Start billing in 10 seconds')),
      h('p.onboard-lead', t('Bills, stock, GST and UPI for your shop. Works offline, no sign-up.')),
      labeled(t('Shop name'), name, t('Optional. You can change it any time.')),
      gstBox,
      start,
      h('p.hint.onboard-note', state.sample
        ? `${tpl?.icon || ''} ${t(tpl?.title || '')} · ${t('with a few example items and bills to try it right away')}`
        : `${tpl?.icon || ''} ${t(tpl?.title || '')}`),
      more,
      h('div.onboard-links',
        h('button.link.onboard-more', { type: 'button', 'aria-expanded': String(state.more), onclick: () => { state.more = !state.more; paint(); } },
          state.more ? t('Fewer options') : t('Not a shop? More options')),
        h('button.link', { type: 'button', onclick: () => { state.mode = 'join'; paint(); } }, t('I already use this on another device'))));
    queueMicrotask(() => (tpl?.needsGstin ? card.querySelector('.gstin-input') : name)?.focus());
  }

  function paintJoin() {
    const url = h('input', { value: location.protocol.startsWith('http') ? location.origin : '', placeholder: 'https://…' });
    const ws = h('input', { placeholder: t('Workspace name') });
    const pass = h('input', { type: 'password', placeholder: t('Passphrase') });
    const msg = h('div.hint');
    card.append(h('div.onboard-top', h('span.onboard-brand', h('span.logo', icon('logo', { size: 16 })), h('b', 'Vina')), langChips()),
      h('h1', t('Join your shop')), h('p', t('Enter the details you used on your other device.')), labeled(t('Server address'), url), labeled(t('Workspace name'), ws), labeled(t('Passphrase'), pass), msg,
      h('div.row', h('button.btn.ghost', { onclick: () => { state.mode = 'start'; paint(); } }, t('Back')),
        h('button.btn.primary', { onclick: async () => {
          msg.textContent = t('Connecting…');
          sync.configure({ url: url.value, ws: ws.value, token: pass.value, adopt: true });
          const r = await sync.run();
          if (r.error || !store.app) { msg.textContent = r.error || t('That workspace is empty. Set up your shop on the first device first.'); msg.className = 'hint bad'; sync.disconnect(); return; }
          onDone();
        } }, t('Join'))));
  }
  paint();
  return root;
}
export { toast };
