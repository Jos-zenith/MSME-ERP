// Printable / shareable documents (invoice, job sheet) + UPI QR code.
// A UPI QR can be printed on ANY invoice straight away: there is no "make a sale order first" step.
import qrcode from './vendor/qrcode.js';
import { h } from './ui/dom.js';
import { t } from './i18n.js';
import { formatValue, fmtMoney, fmtDate, isBlank, recordLabel, fieldOf } from './schema.js';
import { toNum } from './formula.js';

export function upiLink({ vpa, name, amount, note }) {
  const q = new URLSearchParams();
  q.set('pa', vpa);
  if (name) q.set('pn', name);
  if (amount > 0) q.set('am', (Math.round(amount * 100) / 100).toFixed(2));
  q.set('cu', 'INR');
  if (note) q.set('tn', note);
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
}

/** Returns an <svg> element for `text`. Uses one path so it is small and prints crisply. */
export function qrSvg(text, size = 160) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), margin = 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + margin * 2} ${n + margin * 2}`);
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'UPI payment QR code');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#fff');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d); p.setAttribute('fill', '#000');
  svg.append(bg, p);
  return svg;
}

/** The "pay now" QR for a record, or null if there is nothing to collect / no UPI id is set. */
export function paymentQr(store, table, rec, size = 150) {
  const cfg = table.print;
  const vpa = (store.business.upi || '').trim();
  if (!cfg?.qr || !vpa) return null;
  const due = toNum(rec.data.balance ?? rec.data.total);
  if (due <= 0) return null;
  const link = upiLink({ vpa, name: store.business.name, amount: due, note: rec.data[cfg.number] || '' });
  return { svg: qrSvg(link, size), amount: due, vpa, link };
}

export function buildDocument(store, table, rec, { paper = 'a4' } = {}) {
  const cfg = table.print || {};
  const ctx = store.ctx();
  const d = rec.data;
  const b = store.business;
  const field = (id) => fieldOf(table, id);
  const linesField = field(cfg.lines);
  const party = field(cfg.party);
  const partyRec = party && d[party.id] ? ctx.getRecord(party.ref, d[party.id]) : null;
  const partyTable = party ? store.table(party.ref) : null;
  const val = (f, v) => formatValue(f, v, ctx);

  const cols = (cfg.columns || []).map((id) => linesField?.columns.find((c) => c.id === id)).filter(Boolean);
  const rows = (d[cfg.lines] || []);
  const totals = (cfg.totals || []).map(field).filter(Boolean)
    .filter((f) => !(f.id === 'discount' && !toNum(d[f.id])) && !(f.id === 'tax_total' && !toNum(d[f.id])));
  const balanceDue = 'balance' in d ? toNum(d.balance) : 0;
  const qr = paymentQr(store, table, rec, paper === 'thermal' ? 130 : 150);

  return h('div.doc', { class: `paper-${paper}` },
    h('div.doc-head',
      h('div.doc-biz', h('h1', b.name || store.app.name),
        b.address ? h('div', b.address) : null,
        b.phone ? h('div', `${t('Phone')}: ${b.phone}`) : null,
        b.gstin ? h('div', `GSTIN: ${b.gstin}`) : null),
      h('div.doc-title', h('h2', cfg.title || table.name),
        h('div', `${t('No.')} ${d[cfg.number] || ''}`),
        cfg.date ? h('div', fmtDate(d[cfg.date])) : null)),
    party ? h('div.doc-party', h('span.k', `${t('Bill to')}: `),
      h('b', partyRec && partyTable ? (partyRec.data[partyTable.titleField] || '') : t('Walk-in customer')),
      d[cfg.partyPhone] ? h('span', ` · ${d[cfg.partyPhone]}`) : null) : null,
    linesField ? h('table.doc-lines',
      h('thead', h('tr', h('th', '#'), cols.map((c) => h('th', { class: c.type === 'money' || c.type === 'number' ? 'num' : '' }, c.id === 'desc' ? t('Item') : c.label)))),
      h('tbody', rows.map((r, i) => h('tr', h('td', String(i + 1)), cols.map((c) => h('td', { class: c.type === 'money' || c.type === 'number' ? 'num' : '' },
        c.id === 'desc' && isBlank(r.desc) ? val(linesField.columns[0], r[linesField.columns[0].id]) : val(c, r[c.id]))))))) : null,
    h('div.doc-foot',
      h('div.doc-pay',
        qr ? [h('div.qr', qr.svg), h('div.qr-cap', h('b', `${t('Scan to pay')} ${fmtMoney(qr.amount)}`), h('div', qr.vpa))] : null,
        !qr && 'balance' in d && balanceDue <= 0 ? h('div.stamp', t('PAID')) : null,
        cfg.notes && d[cfg.notes] ? h('div.doc-notes', h('b', `${field(cfg.notes).label}: `), String(d[cfg.notes])) : null),
      h('table.doc-totals', h('tbody', totals.map((f) => h('tr', { class: f.big || f.id === 'total' ? 'grand' : '' }, h('td', f.label), h('td.num', val(f, d[f.id]))))))),
    h('div.doc-thanks', t('Thank you for your business!')));
}
export { recordLabel };
