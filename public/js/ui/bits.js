// Small shared UI pieces.
import { h } from './dom.js';
import { t } from '../i18n.js';
import { buildShareLink } from '../store.js';
import { toast } from './dom.js';

export const pageHeader = (title, ...actions) =>
  h('div.page-head', h('h1', title), h('div.page-actions', actions));

export const pill = (text, tone = 'muted') => h('span.pill', { dataset: { tone } }, tone === 'good' ? '✓ ' : tone === 'bad' ? '● ' : tone === 'warn' ? '◐ ' : '', text);

export const emptyState = (icon, title, text, ...actions) =>
  h('div.empty', h('div.empty-ic', icon), h('h3', title), text ? h('p', text) : null, h('div.empty-actions', actions));

export const labeled = (label, control, hint) =>
  h('label.field', h('span.lbl', label), control, hint ? h('span.hint', hint) : null);

export function tabs(items, active, onPick) {
  return h('div.tabs', { role: 'tablist' }, items.map((it) =>
    h('button', { role: 'tab', 'aria-selected': String(it.id === active), class: it.id === active ? 'tab active' : 'tab', onclick: () => onPick(it.id) },
      it.label, it.badge ? h('span.badge', String(it.badge)) : null)));
}

export const CHANNEL_ICON = { whatsapp: '💬', sms: '✉️', email: '📧', inapp: '🔔', webhook: '🔗' };
export const channelName = (c) => ({ whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', inapp: t('Alert'), webhook: 'Webhook' })[c] || c;

/**
 * One message waiting to be sent. Nothing leaves the device until you tap the button, and the text is built
 * from the record's LATEST data at this moment (so it can never announce a balance that was already paid).
 */
export function sendCard(store, item, { onDone, showRecordLink = false } = {}) {
  const r = store.renderOutbox(item);
  const table = store.table(item.table);
  const rec = store.getRecord(item.table, item.recordId);
  const recTitle = rec && table ? (rec.data[table.titleField] || '') : '';

  if (item.channel === 'inapp') {
    return h('div.card.msg.alert-card',
      h('div.msg-head', h('span.ic', CHANNEL_ICON.inapp), h('b', item.ruleName || t('Alert')), h('span.spacer'), h('time', new Date(item.created).toLocaleString())),
      h('p.pre', r.body),
      h('div.msg-actions',
        rec ? h('a.btn.small', { href: `#/t/${item.table}/${item.recordId}` }, `${t('Open')} ${recTitle}`) : null,
        h('button.btn.small', { onclick: () => { store.dismissOutbox(item.id); onDone?.(); } }, t('Done'))));
  }

  const to = h('input', { type: 'tel', value: r.to, placeholder: item.channel === 'email' ? 'name@example.com' : t('Phone number'), 'aria-label': t('Send to') });
  if (item.channel === 'email') to.type = 'email';
  const body = h('textarea', { rows: 5, 'aria-label': t('Message') });
  body.value = r.body;
  const hold = !r.due ? h('div.hint', `${t('Held until')} ${new Date(item.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`) : null;

  const send = () => {
    if (!to.value.trim()) { to.focus(); toast(t('Add a phone number first.'), { kind: 'warn' }); return; }
    const link = buildShareLink(item.channel, to.value, r.subject, body.value, store.settings.countryCode ?? '91');
    if (item.channel === 'whatsapp') window.open(link, '_blank', 'noopener');
    else window.location.href = link;
    store.markSent(item.id);
    onDone?.();
  };
  return h('div.card.msg',
    h('div.msg-head', h('span.ic', CHANNEL_ICON[item.channel]), h('b', item.ruleName || channelName(item.channel)),
      showRecordLink && rec ? h('a.link', { href: `#/t/${item.table}/${item.recordId}` }, recTitle) : null,
      h('span.spacer'), h('time', new Date(item.created).toLocaleString())),
    h('label.field.inline', h('span.lbl', t('To')), to),
    item.channel === 'email' && r.subject ? h('div.hint', `${t('Subject')}: ${r.subject}`) : null,
    body, hold,
    h('div.msg-actions',
      h('button.btn.primary', { onclick: send }, `${CHANNEL_ICON[item.channel]} ${t('Send on')} ${channelName(item.channel)}`),
      h('button.btn.ghost', { onclick: () => { store.dismissOutbox(item.id); onDone?.(); } }, t('Skip'))));
}
