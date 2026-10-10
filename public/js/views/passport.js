// Credit passport screen: the readiness score, what moves it, the indicative limit, and a consented export.
// The numbers come from credit.js; this file only words and draws them.
import { h, download, debounce } from '../ui/dom.js';
import { t } from '../i18n.js';
import { pageHeader, pill, emptyState } from '../ui/bits.js';
import { fmtMoney, fmtDate } from '../schema.js';
import { chartWithTable } from '../ui/charts.js';
import { icon } from '../ui/icons.js';
import { creditPassport, passportExport } from '../credit.js';
import { collectOn } from '../collect.js';

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const BAND = { strong: ['Strong', 'good'], good: ['Good', 'good'], fair: ['Fair', 'warn'], building: ['Building', 'muted'] };
const monthLabel = (ym) => { try { return new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`)); } catch { return ym; } };

/** How each factor is named, shown and improved. */
function factorText(f, p, store) {
  const m = p.metrics;
  switch (f.id) {
    case 'history': return [t('Trading history'), t('{n} full months', { n: m.historyMonths }), t('Keep billing every sale here. Lenders look for 6 to 12 months of history.')];
    case 'stability': return [t('Steady sales'), m.cv === null ? t('needs 3 months') : t('{p} swing month to month', { p: pct(m.cv) }), t('Bill every sale, small cash ones too, so your months show your real business.')];
    case 'growth': return [t('Sales growth'), m.growth === null ? t('needs 6 months') : `${m.growth >= 0 ? '+' : ''}${pct(m.growth)} ${t('last 3 months vs the 3 before')}`,
      m.growth === null ? t('Growth is measured once there are 6 months of bills.') : t('Lenders like rising sales: repeat customers, a wider range and regular stock keep months growing.')];
    case 'digital': return [t('Money received digitally'), pct(m.digitalShare), collectOn(store)
      ? t('Ask customers to pay by UPI. Every Smart Collect payment carries the bank’s UTR, which a lender can verify.')
      : t('Ask customers to pay by UPI, and turn on Smart Collect (Settings) so each payment carries the bank’s UTR.')];
    case 'speed': return [t('Collection speed'), m.dso === null ? '—' : t('{n} days to collect, on average', { n: Math.round(m.dso) }), t('Set due dates on credit bills and send the one-tap WhatsApp reminder. Old dues are the first thing a lender discounts.')];
    case 'overdue': return [t('Overdue dues'), `${pct(m.overdueShare)} ${t('of what you are owed')}`, t('Collect overdue bills first: open Receivables on the home screen.')];
    case 'concentration': return [t('Customer spread'), m.customers90 ? t('biggest customer: {p} of sales', { p: pct(m.topShare) }) : t('mostly walk-in customers'), t('Relying on one buyer is a risk lenders price in. More regular customers help.')];
    case 'identity': return [t('GST registration'), m.gstinOk ? t('Valid GSTIN') : t('Not added'), t('Add your GSTIN in Settings. Not registered? A free Udyam registration also helps with bank loans.')];
    default: return [f.id, '', ''];
  }
}

export function passportView(ctx) {
  const { store } = ctx;
  const el = h('div.passport');
  const paint = () => {
    const p = creditPassport(store);
    if (!p) { el.replaceChildren(emptyState('📄', t('No bills table'), t('The credit passport reads a table that keeps payments and a balance, like Sales invoices.'))); return; }
    const [bandLabel, tone] = BAND[p.band];
    const m = p.metrics;
    const exportBtn = h('button.btn.primary', { onclick: () => download(`credit-passport-${p.today}.json`, JSON.stringify(passportExport(p, store.business), null, 2)) },
      icon('download', { size: 15 }), t('Download passport'));
    const factorsById = Object.fromEntries(p.factors.map((f) => [f.id, f]));

    el.replaceChildren(
      pageHeader({ title: t('Credit passport'), icon: icon('trend', { size: 20 }), sub: t('How ready your business looks to a lender, read from your own bills. Updated as you bill.') },
        h('button.btn', { onclick: () => window.print() }, icon('printer', { size: 15 }), t('Print')), exportBtn),
      !p.ready ? h('div.banner.warn', h('span', t('Early picture: lenders usually want at least 3 full months of bills. You have {n}.', { n: m.historyMonths }))) : null,

      h('div.pp-top',
        h('section.card.pp-score',
          h('div.kpi-label', t('Readiness score')),
          h('div.pp-score-v', h('b', String(p.score)), h('span.muted', '/100'), pill(t(bandLabel), tone)),
          h('div.pp-meter', { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p.score, 'aria-label': t('Readiness score') },
            h('span', { style: { width: `${p.score}%` } }), [40, 60, 75].map((x) => h('i', { style: { left: `${x}%` } }))),
          h('div.pp-scale', h('span', t('Building')), h('span', t('Fair')), h('span', t('Good')), h('span', t('Strong')))),
        h('section.card.pp-limit',
          h('div.kpi-label', t('Indicative working-capital limit')),
          h('div.kpi-value', p.limit.indicative > 0 ? fmtMoney(p.limit.indicative) : '—'),
          h('div.kpi-sub', t('{share} of yearly sales ({annual}{proj}), the norm banks use for small businesses, × {f} for a “{band}” score.', {
            share: pct(p.limit.share), annual: fmtMoney(p.limit.annual), proj: p.limit.projected ? `, ${t('projected')}` : '', f: p.limit.factor, band: t(bandLabel),
          }))),
        h('section.card.pp-limit',
          h('div.kpi-label', t('Invoices you could get paid early on')),
          h('div.kpi-value', p.invoiceFinance.amount > 0 ? fmtMoney(p.invoiceFinance.amount) : '—'),
          h('div.kpi-sub', p.invoiceFinance.count
            ? t('{n} unpaid bills to GST-registered businesses, under 90 days late. Bills like these can be discounted (for example on TReDS).', { n: p.invoiceFinance.count })
            : t('Unpaid bills to GST-registered businesses show here. They can be discounted for cash before the buyer pays.')))),

      p.improve.length ? h('section.card.pp-improve', h('h3', t('What would help most')),
        h('ol', p.improve.map((id) => {
          const f = factorsById[id];
          const [label, value, tip] = factorText(f, p, store);
          return h('li', h('div', h('b', label), h('span.muted', ` · ${value}`), h('span.pp-gain', `+${f.gap} ${t('points possible')}`)), h('p', tip));
        }))) : null,

      h('section.card', h('h3', t('What the score is made of')),
        h('div.table-wrap', h('table.data.pp-factors',
          h('thead', h('tr', h('th', t('Factor')), h('th', t('Your shop')), h('th.num', t('Points')), h('th', h('span.sr', t('Share of points'))))),
          h('tbody', p.factors.map((f) => {
            const [label, value] = factorText(f, p, store);
            return h('tr', h('td', { dataset: { label: t('Factor') } }, h('b', label)), h('td', { dataset: { label: t('Your shop') } }, value),
              h('td.num', { dataset: { label: t('Points') } }, `${f.points} / ${f.max}`),
              h('td', { 'aria-hidden': 'true' }, h('span.pp-bar', h('span', { style: { width: `${(f.points / f.max) * 100}%` } }))));
          }))))),

      h('div.pp-two',
        h('section.card', h('h3', t('Sales by month')),
          chartWithTable({ fmt: 'money', isDate: true, series: p.monthly.map((x) => ({ key: x.month, label: monthLabel(x.month), value: Math.max(0, x.sales) })) }, t('Sales by month'))),
        h('section.card', h('h3', t('Money received')),
          h('div.table-wrap', h('table.data.compact',
            h('thead', h('tr', h('th', t('Month')), h('th.num', t('Received')), h('th.num', t('Digital')), h('th.num', t('Bank-confirmed')))),
            h('tbody', p.monthly.slice(-6).map((x) => h('tr', h('td', monthLabel(x.month)), h('td.num', fmtMoney(x.collected)),
              h('td.num', x.collected ? pct(x.digital / x.collected) : '—'), h('td.num', x.digital ? pct(x.verified / x.digital) : '—')))))),
          h('p.hint', t('Bank-confirmed: UPI payments that arrived with the bank’s UTR through Smart Collect. These are the strongest evidence for a lender.')))),

      h('section.card.pp-share', h('h3', t('Sharing it')),
        h('p', t('The download holds monthly totals and ratios only: no customer names, phone numbers or bills. It says what it is for and until when. Share it only with a lender you chose.')),
        h('p.hint', `${t('Indicative only: not a credit score and not a loan offer. Lenders decide with their own checks (bank statements, GST returns, credit bureau).')} ${t('Calculated on')} ${fmtDate(p.today)}.`)));
  };
  paint();
  ctx.watch(debounce((e) => { if (e.type === 'record' || e.type === 'app') paint(); }, 200));
  return el;
}
