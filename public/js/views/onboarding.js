// First run: language -> business -> starter template. Three short steps; everything can be changed later.
import { h, toast } from '../ui/dom.js';
import { t, setLang, LANGS, getLang } from '../i18n.js';
import { labeled } from '../ui/bits.js';
import { TEMPLATES, buildTemplate } from '../templates/index.js';
import { validateGstin, gstinProblem, stateLabel } from '../../gst/js/gst.js';

export function onboardingView({ store, sync, onDone }) {
  const state = { step: 0, name: '', phone: '', upi: '', gstin: '', tpl: 'retail', sample: true };
  const root = h('div.onboard');
  const card = h('div.onboard-card');
  root.append(card);

  const dots = () => h('div.steps', [0, 1, 2].map((i) => h('span', { class: i === state.step ? 'dot on' : 'dot' })));

  async function finish() {
    const g = validateGstin(state.gstin);
    const app = buildTemplate(state.tpl, t, { businessName: state.name.trim() || undefined, phone: state.phone.trim(), upi: state.upi.trim(), lang: getLang(), gstin: g.ok ? g.gstin : '' });
    store.setApp(app);
    const tpl = TEMPLATES.find((x) => x.id === state.tpl);
    if (state.sample && tpl.sample) { await tpl.sample(store, t); store.meta.tips = true; store._persistMeta('tips'); }
    await store.flush();
    onDone();
  }

  function paint() {
    card.replaceChildren();
    if (state.step === 0) {
      card.append(dots(), h('h1', '👋 ' + t('Welcome')), h('p', t('Choose your language')),
        h('div.lang-grid', Object.entries(LANGS).map(([code, name]) => h('button.btn.big', { class: getLang() === code ? 'primary' : '', onclick: async () => { await setLang(code); state.step = 1; paint(); } }, name))),
        h('p.hint', t('Set up in under a minute. Works without internet. You can change everything later.')),
        h('button.link', { onclick: () => { state.step = 'join'; paint(); } }, t('I already use this on another device')));
    } else if (state.step === 1) {
      const name = h('input', { value: state.name, placeholder: t('e.g. Sharma General Store'), autofocus: true, oninput: (e) => { state.name = e.target.value; } });
      const phone = h('input', { type: 'tel', value: state.phone, placeholder: '98765 43210', oninput: (e) => { state.phone = e.target.value; } });
      const upi = h('input', { value: state.upi, placeholder: 'yourshop@okhdfcbank', oninput: (e) => { state.upi = e.target.value; } });
      const next = () => { state.step = 2; paint(); };
      card.append(dots(), h('h1', t('Your business')),
        labeled(t('Business name'), name), labeled(t('Your phone (for low-stock alerts)'), phone), labeled(t('UPI ID for payment QR codes (optional)'), upi),
        h('div.row', h('button.btn.ghost', { onclick: () => { state.step = 0; paint(); } }, t('Back')), h('button.btn.primary', { onclick: next }, t('Next'))));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') next(); }, { once: true });
      name.focus();
    } else if (state.step === 2) {
      const sample = h('input', { type: 'checkbox', checked: state.sample, onchange: (e) => { state.sample = e.target.checked; } });
      const tpl = TEMPLATES.find((x) => x.id === state.tpl);
      const start = h('button.btn.primary', { onclick: async (e) => { e.target.disabled = true; await finish(); } }, t('Start'));
      // GST billing needs the shop's own GSTIN: it tells us the state, so CGST + SGST vs IGST is never guessed
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
        queueMicrotask(() => inp.focus());
      }
      card.append(dots(), h('h1', t('What do you want to manage?')),
        h('div.tpl-grid', TEMPLATES.map((x) => h('button.card.tile', { class: state.tpl === x.id ? 'sel' : '', dataset: { tpl: x.id }, onclick: () => { state.tpl = x.id; paint(); } },
          h('div.tile-ic', x.icon), h('h3', t(x.title)), h('p.muted', t(x.desc))))),
        gstBox,
        h('label.check', sample, ` ${t('Add example data so I can try it out')}`),
        h('div.row', h('button.btn.ghost', { onclick: () => { state.step = 1; paint(); } }, t('Back')), start));
    } else {
      const url = h('input', { value: location.protocol.startsWith('http') ? location.origin : '', placeholder: 'https://…' });
      const ws = h('input', { placeholder: t('Workspace name') });
      const pass = h('input', { type: 'password', placeholder: t('Passphrase') });
      const msg = h('div.hint');
      card.append(h('h1', t('Join your shop')), h('p', t('Enter the details you used on your other device.')), labeled(t('Server address'), url), labeled(t('Workspace name'), ws), labeled(t('Passphrase'), pass), msg,
        h('div.row', h('button.btn.ghost', { onclick: () => { state.step = 0; paint(); } }, t('Back')),
          h('button.btn.primary', { onclick: async () => {
            msg.textContent = t('Connecting…');
            sync.configure({ url: url.value, ws: ws.value, token: pass.value, adopt: true });
            const r = await sync.run();
            if (r.error || !store.app) { msg.textContent = r.error || t('That workspace is empty. Set up your shop on the first device first.'); msg.className = 'hint bad'; sync.disconnect(); return; }
            onDone();
          } }, t('Join'))));
    }
  }
  paint();
  return root;
}
export { toast };
