// Printable / shareable documents (invoice, job sheet) + UPI QR code.
// A UPI QR can be printed on ANY invoice straight away: there is no "make a sale order first" step.
import qrcode from './vendor/qrcode.js';
import { h } from './ui/dom.js';
import { t } from './i18n.js';
import { formatValue, fmtMoney, fmtDate, isBlank, recordLabel, fieldOf } from './schema.js';
import { toNum } from './formula.js';
import { amountInWords, docOf, r2 } from '../gst/js/gst.js';
import { collectOn, refFor, upiLink } from './collect.js';

export { upiLink };

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
  const ref = collectOn(store) && rec.id ? refFor(rec.id) : '';
  const link = upiLink({ vpa, name: store.business.name, amount: due, note: rec.data[cfg.number] || '', ref });
  return { svg: qrSvg(link, size), amount: due, vpa, link, ref };
}

export function buildDocument(store, table, rec, { paper = 'a4' } = {}) {
  const cfg = table.print || {};
  if (cfg.gst) return gstDocument(store, table, rec, { paper });
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

/** A GST tax invoice / bill of supply / credit note laid out the way Rule 46 asks for. */
function gstDocument(store, table, rec, { paper }) {
  const cfg = table.print;
  const ctx = store.ctx();
  const d = rec.data;
  const b = store.business;
  const doc = docOf(d.doc_type);
  const field = (id) => fieldOf(table, id);
  const linesField = field(cfg.lines);
  const cols = (cfg.columns || []).map((id) => linesField?.columns.find((c) => c.id === id)).filter(Boolean);
  const rows = d[cfg.lines] || [];
  const val = (f, v) => formatValue(f, v, ctx);
  const money = (v) => fmtMoney(v);
  const split = d.tax_mode === 'intra' || d.tax_mode === 'utgst';
  const inter = d.tax_mode === 'inter';
  const qr = doc.payable ? paymentQr(store, table, rec, paper === 'thermal' ? 130 : 150) : null;

  // tax breakup by rate: what an auditor (and the customer's accountant) looks for
  const byRate = new Map();
  for (const r of rows) {
    const k = toNum(r.gst);
    const x = byRate.get(k) || { rate: k, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
    for (const f of ['taxable', 'cgst', 'sgst', 'igst', 'cess']) x[f] = r2(x[f] + toNum(r[f]));
    byRate.set(k, x);
  }
  const hasCess = toNum(d.cess) > 0;
  const taxHead = [t('GST %'), t('Taxable'), ...(split ? ['CGST', d.tax_mode === 'utgst' ? 'UTGST' : 'SGST'] : []), ...(inter ? ['IGST'] : []), ...(hasCess ? [t('Cess')] : [])];
  const taxRow = (x) => [`${x.rate}%`, money(x.taxable), ...(split ? [money(x.cgst), money(x.sgst)] : []), ...(inter ? [money(x.igst)] : []), ...(hasCess ? [money(x.cess)] : [])];
  const totals = (cfg.totals || []).map(field).filter(Boolean).filter((f) => f.id === 'total' || f.id === 'taxable' || toNum(d[f.id]) !== 0)
    .filter((f) => doc.payable || !['paid', 'balance'].includes(f.id));

  return h('div.doc.doc-gst', { class: `paper-${paper}` },
    h('div.doc-head',
      h('div.doc-biz', h('h1', b.name || store.app.name),
        b.address ? h('div', b.address) : null,
        b.phone ? h('div', `${t('Phone')}: ${b.phone}`) : null,
        b.gstin ? h('div', h('b', `GSTIN: ${b.gstin}`)) : null,
        b.state ? h('div', `${t('State')}: ${b.state}`) : null),
      h('div.doc-title', h('h2', d.cancelled ? `${doc.title} (${t('CANCELLED')})` : doc.title),
        h('div', `${t('No.')} ${d[cfg.number] || ''}`),
        h('div', fmtDate(d[cfg.date])),
        d.pos ? h('div', `${t('Place of supply')}: ${d.pos}`) : null,
        doc.tax ? h('div', `${t('Reverse charge')}: ${d.reverse_charge ? t('Yes') : t('No')}`) : null,
        d.ref_note ? h('div', `${t('Against')}: ${d.ref_note}`) : null)),
    h('div.doc-party',
      h('div.k', t('Bill to')),
      h('b', d.bill_name || t('Walk-in customer')),
      d.bill_address ? h('div', d.bill_address) : null,
      d.bill_gstin ? h('div', `GSTIN: ${d.bill_gstin}`) : null,
      d[cfg.partyPhone] ? h('div', `${t('Phone')}: ${d[cfg.partyPhone]}`) : null),
    h('table.doc-lines',
      h('thead', h('tr', h('th', '#'), cols.map((c) => h('th', { class: c.type === 'money' || c.type === 'number' || c.id === 'gst' ? 'num' : '' }, c.id === 'desc' ? t('Item') : c.label)))),
      h('tbody', rows.map((r, i) => h('tr', h('td', String(i + 1)), cols.map((c) => h('td', { class: c.type === 'money' || c.type === 'number' || c.id === 'gst' ? 'num' : '' },
        c.id === 'gst' ? `${toNum(r.gst)}%` : c.id === 'desc' && isBlank(r.desc) ? val(linesField.columns[0], r[linesField.columns[0].id]) : val(c, r[c.id]))))))),
    doc.tax && byRate.size && (split || inter) ? h('table.doc-taxes',
      h('thead', h('tr', taxHead.map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', [...byRate.values()].sort((a, c) => a.rate - c.rate).map((x) => h('tr', taxRow(x).map((v, i) => h('td', { class: i ? 'num' : '' }, v)))))) : null,
    h('div.doc-foot',
      h('div.doc-pay',
        h('div.doc-words', h('b', `${t('Amount in words')}: `), amountInWords(toNum(d.total))),
        qr ? [h('div.qr', qr.svg), h('div.qr-cap', h('b', `${t('Scan to pay')} ${fmtMoney(qr.amount)}`), h('div', qr.vpa))] : null,
        !qr && doc.payable && toNum(d.balance) <= 0 && toNum(d.total) > 0 ? h('div.stamp', t('PAID')) : null,
        cfg.notes && d[cfg.notes] ? h('div.doc-notes', h('b', `${field(cfg.notes).label}: `), String(d[cfg.notes])) : null),
      h('table.doc-totals', h('tbody', totals.map((f) => h('tr', { class: f.id === 'total' ? 'grand' : '' }, h('td', f.label), h('td.num', val(f, d[f.id]))))))),
    h('div.doc-sign', h('div', `${t('For')} ${b.name || store.app.name}`), h('div.sign-line', t('Authorised signatory'))),
    h('div.doc-thanks', t('Thank you for your business!')));
}
