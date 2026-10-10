// Small shared UI pieces.
import { h } from './dom.js';
import { t } from '../i18n.js';
import { buildShareLink } from '../store.js';
import { toast } from './dom.js';
import { icon, iconFor } from './icons.js';

/**
 * Page title row. `title` is text, or { title, icon, crumb: {href, label}, sub, after } for an icon, a breadcrumb
 * above the title, a line under it and something next to it (e.g. the status). Actions sit on the right.
 */
export function pageHeader(title, ...actions) {
  const o = title && typeof title === 'object' && !(title instanceof Node) && !Array.isArray(title) ? title : { title };
  return h('div.page-head',
    h('div.page-title',
      o.icon ? h('span.page-ic', o.icon) : null,
      h('div.page-title-txt',
        o.crumb ? h('a.crumb', { href: o.crumb.href }, o.crumb.label) : null,
        h('div.page-h1', h('h1', o.title), o.after || null),
        o.sub ? h('div.page-sub', o.sub) : null)),
    h('div.page-actions', actions));
}

/** Status chip; the tone's colour (and a dot) carries the meaning, the text says it. */
export const pill = (text, tone = 'muted') => h('span.pill', { dataset: { tone } }, text);

export const emptyState = (icon, title, text, ...actions) =>
  h('div.empty', h('div.empty-ic', typeof icon === 'string' ? iconFor(icon, { size: 26 }) : icon), h('h3', title), text ? h('p', text) : null, h('div.empty-actions', actions));

export const labeled = (label, control, hint) =>
  h('label.field', h('span.lbl', label), control, hint ? h('span.hint', hint) : null);

export function tabs(items, active, onPick) {
  return h('div.tabs', { role: 'tablist' }, items.map((it) =>
    h('button', { role: 'tab', 'aria-selected': String(it.id === active), class: it.id === active ? 'tab active' : 'tab', onclick: () => onPick(it.id) },
      it.label, it.badge ? h('span.badge', String(it.badge)) : null)));
}

/**
 * "💬 Remind" for a bill with money still due: opens WhatsApp with the reminder written from the bill's latest balance.
 * Nothing is sent until the person taps Send in WhatsApp. Shows when the last reminder went out.
 */
export function remindButton(store, tableId, id, { small = false } = {}) {
  const r = store.reminder?.(tableId, id);
  if (!r) return null;
  const days = r.last ? Math.floor((Date.now() - new Date(r.last).getTime()) / 86400000) : null;
  const when = days === null ? '' : days < 1 ? t('today') : t('{n}d ago', { n: days });
  return h('button.btn.remind', {
    type: 'button', class: small ? 'small' : '',
    title: r.last ? `${t('Last reminded')}: ${when}` : t('Send a payment reminder on WhatsApp'),
    onclick: (e) => { e.stopPropagation(); window.open(r.link, '_blank', 'noopener'); store.markReminded(id); toast(t('WhatsApp opened with the reminder. Tap Send there.')); },
  }, icon('message', { size: 15 }), t('Remind'), when ? h('span.remind-ago', when) : null);
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
      h('div.msg-head', h('span.ic', icon('bell', { size: 16 })), h('b', item.ruleName || t('Alert')), h('span.spacer'), h('time', new Date(item.created).toLocaleString())),
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
    h('div.msg-head', h('span.ic', icon(item.channel === 'webhook' || item.channel === 'email' ? 'send' : 'message', { size: 16 })), h('b', item.ruleName || channelName(item.channel)),
      showRecordLink && rec ? h('a.link', { href: `#/t/${item.table}/${item.recordId}` }, recTitle) : null,
      h('span.spacer'), h('time', new Date(item.created).toLocaleString())),
    h('label.field.inline', h('span.lbl', t('To')), to),
    item.channel === 'email' && r.subject ? h('div.hint', `${t('Subject')}: ${r.subject}`) : null,
    body, hold,
    h('div.msg-actions',
      h('button.btn.primary', { onclick: send }, icon('send', { size: 15 }), `${t('Send on')} ${channelName(item.channel)}`),
      h('button.btn.ghost', { onclick: () => { store.dismissOutbox(item.id); onDone?.(); } }, t('Skip'))));
}
