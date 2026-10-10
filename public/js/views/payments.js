// "Payments" tab of Messages & approvals: bank-confirmed UPI payments that need the owner, UPI payments someone marked
// as received that the bank never confirmed, and what Smart Collect matched by itself.
import { h, modal, toast } from '../ui/dom.js';
import { t } from '../i18n.js';
import { icon } from '../ui/icons.js';
import { emptyState, pill } from '../ui/bits.js';
import { fmtMoney, fmtDate } from '../schema.js';
import { toNum } from '../formula.js';
import { collectOn, collectSetup, openBills, paymentsToReview, unverifiedUpi, settleManually, ignorePayment, COLLECT_TABLE } from '../collect.js';

/** Count for the tab badge and the home screen. */
export const paymentsAttention = (store) => paymentsToReview(store).length + unverifiedUpi(store).length;

const when = (iso) => { try { return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const payer = (d) => [d.name, d.vpa || d.phone].filter(Boolean).join(' · ') || t('Unknown payer');

export function paymentsPanel(ctx) {
  const { store } = ctx;
  const cfg = collectSetup(store.app);
  if (!cfg) return emptyState('💳', t('No bills table'), '');
  const owner = ctx.role === 'owner';
  const bills = new Map(openBills(store, cfg).map((b) => [b.id, b]));
  const billNo = (id) => bills.get(id)?.number || '—';
  const review = paymentsToReview(store);
  const unverified = unverifiedUpi(store);
  const done = store.records(COLLECT_TABLE).filter((r) => r.data.status === 'matched' || r.data.status === 'ignored')
    .sort((a, b) => String(b.data.matchedAt || '').localeCompare(String(a.data.matchedAt || ''))).slice(0, 20);
  const out = h('div.pay-panel');

  if (!collectOn(store) && !review.length && !done.length) {
    out.append(h('div.banner', h('span', t('Turn on Smart Collect in Settings: UPI payments then mark bills paid by themselves, with the bank’s reference.')),
      owner ? h('a.btn.small', { href: '#/settings' }, t('Settings')) : null));
  }

  // ---- 1. bank-confirmed money that needs a decision ----------------------------------------------------------------------
  out.append(h('h3.pay-h', t('Payments to match'), review.length ? h('span.badge', String(review.length)) : null));
  if (!review.length) out.append(h('p.muted', t('Nothing waiting. Payments that match a bill are recorded by themselves.')));
  for (const ev of review) {
    const d = ev.data;
    const s = d.suggestion;
    out.append(h('div.card.msg.pay-card',
      h('div.msg-head', h('span.ic', icon('wallet', { size: 16 })), h('b', fmtMoney(d.amount)), h('span', payer(d)), h('span.spacer'), h('time', when(d.at))),
      h('div.hint', `UTR ${d.utr}${d.source === 'sandbox' ? ` · ${t('sandbox')}` : ''}`),
      s ? h('p', `${t('Suggested')}: `, s.allocations.map((a, i) => [i ? ', ' : '', h('a.link', { href: `#/t/${cfg.table.id}/${a.id}` }, billNo(a.id)), ` ${fmtMoney(a.amount)}`]),
        s.unapplied ? ` · ${t('{amount} left over (advance)', { amount: fmtMoney(s.unapplied) })}` : '')
        : h('p', t('No bill matches this payment.')),
      owner ? h('div.msg-actions',
        s ? h('button.btn.primary', { onclick: async () => { await settleManually(store, ev.id, s.allocations); toast(t('Payment recorded.')); } }, icon('check', { size: 15 }), t('Apply')) : null,
        h('button.btn', { onclick: () => pickBill(store, cfg, ev) }, t('Choose bill…')),
        h('button.btn.ghost', { onclick: () => { ignorePayment(store, ev.id, 'not a sale'); toast(t('Marked as not a sale.')); } }, t('Not a sale')))
        : h('p.hint', t('Only the owner can match payments.'))));
  }

  // ---- 2. "paid by UPI" without the bank's word: check before trusting a screenshot -----------------------------------------
  if (collectOn(store)) {
    out.append(h('h3.pay-h', t('Marked UPI, not confirmed by the bank'), unverified.length ? h('span.badge', String(unverified.length)) : null));
    if (!unverified.length) out.append(h('p.muted', t('Every UPI payment marked received has been confirmed by the bank.')));
    else {
      out.append(h('p.hint', t('These bills were marked “paid by UPI” but no bank confirmation has arrived. If the customer only showed a screenshot, check your bank app.')));
      out.append(h('div.table-wrap', h('table.data.compact',
        h('thead', h('tr', h('th', t('Bill')), h('th', t('Date')), h('th.num', t('Amount')), h('th', t('By')))),
        h('tbody', unverified.map((u) => h('tr', h('td', h('a', { href: `#/t/${cfg.table.id}/${u.id}` }, u.number)), h('td', fmtDate(u.date)),
          h('td.num', fmtMoney(u.amount)), h('td', u.by === 'staff' ? t('Staff') : u.by === 'owner' ? t('Owner') : '—')))))));
    }
  }

  // ---- 3. what happened -------------------------------------------------------------------------------------------------------------
  if (done.length) {
    out.append(h('h3.pay-h', t('Recently confirmed')),
      h('ul.history', done.map((ev) => {
        const d = ev.data;
        const tag = d.status === 'ignored' ? pill(t('Not a sale'), 'muted') : d.by === 'auto' ? pill(d.how === 'verify' ? t('Verified') : t('Automatic'), 'good') : pill(t('By hand'), 'info');
        return h('li', h('b', fmtMoney(d.amount)), ' ', tag, ' ',
          (d.allocations || []).map((a, i) => [i ? ', ' : '', h('a.link', { href: `#/t/${cfg.table.id}/${a.id}` }, store.getRecord(cfg.table.id, a.id)?.data.number || '—')]),
          h('span.muted', ` · UTR ${d.utr} · ${when(d.matchedAt || d.at)}`));
      })));
  }
  return out;
}

/** Owner puts a payment against one open bill (the rest, if any, stays as an advance). */
function pickBill(store, cfg, ev) {
  const amount = toNum(ev.data.amount);
  const open = openBills(store, cfg).filter((b) => b.balance > 0.004 && !b.cancelled)
    .sort((a, b) => Math.abs(a.balance - amount) - Math.abs(b.balance - amount) || (b.date || '').localeCompare(a.date || ''));
  if (!open.length) { toast(t('There are no unpaid bills.'), { kind: 'warn' }); return; }
  const sel = h('select', { 'aria-label': t('Bill') }, open.slice(0, 200).map((b) => h('option', { value: b.id }, `${b.number} · ${fmtDate(b.date)} · ${t('due')} ${fmtMoney(b.balance)}`)));
  modal({
    title: `${t('Match')} ${fmtMoney(amount)}`,
    body: h('div', h('p.hint', t('Bills closest to this amount are first.')), sel),
    actions: [{ label: t('Cancel'), value: null }, { label: t('Record payment'), primary: true, fn: async (close) => {
      const b = open.find((x) => x.id === sel.value);
      await settleManually(store, ev.id, [{ id: b.id, amount: Math.min(amount, b.balance) }]);
      close(); toast(t('Payment recorded.'));
    } }],
  });
}
