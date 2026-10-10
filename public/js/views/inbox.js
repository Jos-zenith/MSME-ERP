// Messages to send, alerts, approvals and history.
import { h, debounce, confirmDialog } from '../ui/dom.js';
import { t } from '../i18n.js';
import { icon } from '../ui/icons.js';
import { pageHeader, tabs, sendCard, emptyState, CHANNEL_ICON, channelName } from '../ui/bits.js';
import { recordTitle } from '../schema.js';
import { paymentsPanel, paymentsAttention } from './payments.js';
import { collectOn } from '../collect.js';

export function inboxView(ctx, tab = 'messages') {
  const { store } = ctx;
  const host = h('div.inbox-body');
  const head = h('div');
  const paint = () => {
    const msgs = store.listOutbox((o) => o.status === 'pending' && o.channel !== 'inapp' && o.channel !== 'webhook');
    const alerts = store.listOutbox((o) => o.status === 'pending' && o.channel === 'inapp');
    const appr = store.pendingApprovals();
    head.replaceChildren(tabs([
      { id: 'messages', label: t('Messages'), badge: msgs.length },
      { id: 'alerts', label: t('Alerts'), badge: alerts.length },
      { id: 'approvals', label: t('Approvals'), badge: appr.length },
      collectOn(store) || tab === 'payments' ? { id: 'payments', label: t('Payments'), badge: paymentsAttention(store) } : null,
      { id: 'history', label: t('History') },
    ].filter(Boolean), tab, (id) => { location.hash = id === 'messages' ? '#/outbox' : `#/outbox/${id}`; }));
    host.replaceChildren();
    if (tab === 'payments') host.append(paymentsPanel(ctx));
    else if (tab === 'messages') {
      host.append(h('p.hint', t('These are ready to go. Nothing is sent until you tap the button, and each message is filled in from the latest bill or job when you send it.')));
      if (!msgs.length) host.append(emptyState('💬', t('No messages waiting'), t('When a bill is saved or a job is ready, the customer message appears here.')));
      msgs.forEach((m) => host.append(sendCard(store, m, { showRecordLink: true })));
    } else if (tab === 'alerts') {
      if (!alerts.length) host.append(emptyState('🔔', t('No alerts'), t('Low stock and late jobs will show up here.')));
      alerts.forEach((m) => host.append(sendCard(store, m, {})));
    } else if (tab === 'approvals') {
      if (!appr.length) host.append(emptyState('🖊️', t('Nothing to approve'), t('Big discounts and expensive jobs wait here for the owner.')));
      appr.forEach((r) => {
        const table = store.table(r.table);
        host.append(h('div.card.msg',
          h('div.msg-head', h('span.ic', '🖊️'), h('b', `${table.name}: `), h('a.link', { href: `#/t/${r.table}/${r.id}` }, recordTitle(table, r)), h('span.spacer'), h('time', new Date(r.approval.at).toLocaleString())),
          h('p', r.approval.note || r.approval.ruleName),
          ctx.role === 'owner'
            ? h('div.msg-actions',
              h('button.btn.primary', { onclick: () => store.decideApproval(r.table, r.id, 'approved', ctx.userName) }, icon('check', { size: 15 }), t('Approve')),
              h('button.btn', { onclick: () => store.decideApproval(r.table, r.id, 'rejected', ctx.userName) }, `✕ ${t('Reject')}`))
            : h('p.hint', t('Only the owner can approve.'))));
      });
    } else {
      const done = store.listOutbox((o) => o.status !== 'pending' && o.channel !== 'webhook').slice(0, 60);
      if (!done.length) host.append(emptyState('🗂️', t('No history yet'), ''));
      else {
        host.append(h('div.row', h('button.btn.small', { onclick: async () => { if (await confirmDialog(t('Clear the history?'), { yes: t('Clear'), danger: true })) store.clearDoneOutbox(); } }, t('Clear history'))),
          h('ul.history', done.map((o) => h('li', h('span.ic', CHANNEL_ICON[o.channel]), h('b', o.ruleName || channelName(o.channel)),
            h('span.muted', ` ${o.status === 'sent' ? t('Sent') : t('Skipped')} · ${new Date(o.sentAt || o.created).toLocaleString()}`)))));
      }
    }
  };
  paint();
  ctx.watch(debounce((e) => { if (e.type === 'outbox' || e.type === 'approval' || e.type === 'record') paint(); }, 60));
  return h('div.inbox', pageHeader(t('Messages & approvals')), head, host);
}
