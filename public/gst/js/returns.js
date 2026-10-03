// GST returns and reports built from the saved invoices. Pure functions over plain data.
//
// INDICATIVE: use the output to prepare your return, then validate the JSON in the GST portal's offline tool before
// filing. Formats and thresholds change; the constants below are the places to update.
import {
  r2, docOf, stateCodeOf, gstDate, fpOf, uqcOf, validateGstin, B2CL_LIMIT, NUMBER_RE, DOC, gstinProblem,
} from './gst.js';
import { toNum, todayStr, daysBetween } from '../../js/formula.js';
import { t } from '../../js/i18n.js';

export const GSTR1_JSON_VERSION = 'GST3.1.6';     // offline-tool schema version written into the file
const sum = (arr, f) => r2(arr.reduce((s, x) => s + toNum(f(x)), 0));
export const periodRange = (ym) => ({ from: `${ym}-01`, to: `${ym}-31` });
export const inRange = (d, from, to) => !!d.date && d.date >= from && d.date <= to;

/** How does one document count in the returns? */
function classify(d, business, limit) {
  const cfg = docOf(d.doc_type);
  const reg = validateGstin(d.bill_gstin).ok;
  const exp = !!d.export_type && !d.sez;
  const inter = d.tax_mode === 'inter' || d.tax_mode === 'zero';
  const bizState = stateCodeOf(business.gstin) || stateCodeOf(business.state);
  const pos = stateCodeOf(d.pos) || (exp ? '96' : bizState);
  return { cfg, reg, exp, sez: !!d.sez, inter, pos, note: !!cfg.note, big: Math.abs(toNum(d.total)) > limit };
}

/** rate -> { txval, iamt, camt, samt, csamt } for one document (UTGST is reported in the SGST column). */
function byRate(d, sign = 1) {
  const m = new Map();
  for (const r of d.items || []) {
    const rt = toNum(r.gst);
    if (!m.has(rt)) m.set(rt, { rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
    const x = m.get(rt);
    x.txval += sign * toNum(r.taxable); x.iamt += sign * toNum(r.igst); x.camt += sign * toNum(r.cgst);
    x.samt += sign * toNum(r.sgst); x.csamt += sign * toNum(r.cess);
  }
  return [...m.values()].map((x) => ({ ...x, txval: r2(x.txval), iamt: r2(x.iamt), camt: r2(x.camt), samt: r2(x.samt), csamt: r2(x.csamt) }));
}
const itms = (rates) => rates.map((x, i) => ({ num: i + 1, itm_det: { rt: x.rt, txval: x.txval, iamt: x.iamt, camt: x.camt, samt: x.samt, csamt: x.csamt } }));
const invVal = (d) => r2(toNum(d.total) - toNum(d.round_off));   // value that reconciles with the per-rate amounts

// ---- GSTR-1 ------------------------------------------------------------------------------------------------------------
export function gstr1(allDocs, { business = {}, period, settings = {} }) {
  const limit = settings.gst?.b2cl_limit ?? B2CL_LIMIT;
  const { from, to } = periodRange(period);
  const docs = allDocs.filter((d) => inRange(d, from, to));
  const live = docs.filter((d) => !d.cancelled && docOf(d.doc_type).taxDoc);
  const warnings = [];
  const S = { b2b: new Map(), b2cl: new Map(), b2cs: new Map(), cdnr: new Map(), cdnur: [], exp: new Map(), nil: new Map() };

  for (const d of live) {
    const c = classify(d, business, limit);
    const cfg = c.cfg;
    const sign = cfg.sign;                                              // credit notes reduce
    if (d.tax_mode === 'unknown') warnings.push(t('{n}: cannot tell CGST/SGST from IGST (place of supply missing).', { n: d.number }));
    if (d.bill_gstin && !c.reg) warnings.push(t('{n}: the customer GSTIN is not valid, so it is reported as an unregistered sale.', { n: d.number }));
    if (!NUMBER_RE.test(d.number || '')) warnings.push(t('{n}: invoice numbers must be 16 characters or fewer (letters, digits, / and -).', { n: d.number }));

    // Bill of Supply / no-tax documents -> Table 8 (nil rated, exempt, non-GST)
    if (d.tax_mode === 'none') {
      const sply = `${c.inter ? 'INTR' : 'INTRA'}${c.reg ? 'B2B' : 'B2C'}`;   // INTRB2B, INTRB2C, INTRAB2B, INTRAB2C
      const x = S.nil.get(sply) || { sply_ty: sply, expt_amt: 0, nil_amt: 0, ngsup_amt: 0 };
      x.nil_amt = r2(x.nil_amt + sign * toNum(d.taxable));
      S.nil.set(sply, x);
      continue;
    }
    const rates = byRate(d, 1);
    if (c.note) {
      const note = { nt_num: d.number, nt_dt: gstDate(d.date), ntty: DOC[d.doc_type].key === 'CN' ? 'C' : 'D', val: invVal(d), pos: c.pos, rchrg: d.reverse_charge ? 'Y' : 'N', inv_typ: c.sez ? (d.export_type === 'LUT' ? 'SEWOP' : 'SEWP') : 'R', itms: itms(rates) };
      if (c.reg) {
        if (!S.cdnr.has(d.bill_gstin)) S.cdnr.set(d.bill_gstin, { ctin: d.bill_gstin, nt: [] });
        S.cdnr.get(d.bill_gstin).nt.push(note);
      } else if (c.inter && c.big) {
        S.cdnur.push({ typ: 'B2CL', ntty: note.ntty, nt_num: note.nt_num, nt_dt: note.nt_dt, val: note.val, pos: c.pos, itms: note.itms });
      } else {
        addB2cs(S.b2cs, c, byRate(d, sign));                            // net it off against the small unregistered sales
      }
      continue;
    }
    if (c.exp) {
      const k = d.export_type === 'LUT' ? 'WOPAY' : 'WPAY';
      if (!S.exp.has(k)) S.exp.set(k, { exp_typ: k, inv: [] });
      S.exp.get(k).inv.push({ inum: d.number, idt: gstDate(d.date), val: invVal(d), itms: rates.map((x) => ({ txval: x.txval, rt: x.rt, iamt: x.iamt, csamt: x.csamt })) });
    } else if (c.reg) {
      if (!S.b2b.has(d.bill_gstin)) S.b2b.set(d.bill_gstin, { ctin: d.bill_gstin, inv: [] });
      S.b2b.get(d.bill_gstin).inv.push({ inum: d.number, idt: gstDate(d.date), val: invVal(d), pos: c.pos, rchrg: d.reverse_charge ? 'Y' : 'N', inv_typ: c.sez ? (d.export_type === 'LUT' ? 'SEWOP' : 'SEWP') : 'R', itms: itms(rates) });
    } else if (c.inter && c.big) {
      if (!S.b2cl.has(c.pos)) S.b2cl.set(c.pos, { pos: c.pos, inv: [] });
      S.b2cl.get(c.pos).inv.push({ inum: d.number, idt: gstDate(d.date), val: invVal(d), itms: rates.map((x, i) => ({ num: i + 1, itm_det: { rt: x.rt, txval: x.txval, iamt: x.iamt, csamt: x.csamt } })) });
    } else {
      addB2cs(S.b2cs, c, byRate(d, sign));
    }
  }

  // Table 12: HSN summary (net of credit notes). Lines without an HSN cannot be reported, so warn.
  const hsn = new Map();
  let noHsn = 0;
  for (const d of live) {
    const sign = docOf(d.doc_type).sign;
    for (const r of d.items || []) {
      const code = String(r.hsn || '').replace(/\s/g, '');
      if (!code) { noHsn++; continue; }
      const uqc = r.uqc || uqcOf(r.unit);
      const key = `${code}|${uqc}|${toNum(r.gst)}`;
      const x = hsn.get(key) || { hsn_sc: code, desc: r.desc || '', uqc, qty: 0, rt: toNum(r.gst), val: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      x.qty += sign * toNum(r.qty); x.txval += sign * toNum(r.taxable); x.iamt += sign * toNum(r.igst); x.camt += sign * toNum(r.cgst);
      x.samt += sign * toNum(r.sgst); x.csamt += sign * toNum(r.cess);
      x.val += sign * toNum(r.amount);
      hsn.set(key, x);
    }
  }
  if (noHsn) warnings.push(t('{n} item line(s) have no HSN/SAC code and are left out of the HSN summary.', { n: noHsn }));
  const hsnRows = [...hsn.values()].map((x, i) => ({ num: i + 1, ...x, qty: r2(x.qty), val: r2(x.val), txval: r2(x.txval), iamt: r2(x.iamt), camt: r2(x.camt), samt: r2(x.samt), csamt: r2(x.csamt) }));

  // Table 13: documents issued, including cancelled ones (they must still be counted).
  const docSummary = [];
  for (const type of Object.keys(DOC)) {
    const cfg = DOC[type];
    if (!cfg.taxDoc && type !== 'Delivery Challan') continue;
    const series = docs.filter((d) => d.doc_type === type && d.number).sort((a, b) => (a.number < b.number ? -1 : 1));
    if (!series.length) continue;
    const cancelled = series.filter((d) => d.cancelled).length;
    docSummary.push({ type, portal: cfg.portal, from: series[0].number, to: series[series.length - 1].number, totnum: series.length, cancel: cancelled, net_issue: series.length - cancelled, gaps: sequenceGaps(series.map((d) => d.number)) });
    const gaps = sequenceGaps(series.map((d) => d.number));
    if (gaps.length) warnings.push(t('{type}: number(s) missing in the series: {list}. Every number must be accounted for (issued or cancelled).', { type, list: gaps.slice(0, 6).join(', ') }));
  }

  const sections = {
    b2b: [...S.b2b.values()], b2cl: [...S.b2cl.values()], b2cs: [...S.b2cs.values()].filter((x) => x.txval || x.iamt || x.camt || x.samt || x.csamt),
    cdnr: [...S.cdnr.values()], cdnur: S.cdnur, exp: [...S.exp.values()], nil: [...S.nil.values()], hsn: hsnRows, docs: docSummary,
  };
  return { period, fp: fpOf(period), gstin: business.gstin || '', sections, totals: totalsOf(live, business, limit), warnings: [...new Set(warnings)], invoiceCount: live.length };
}

function addB2cs(map, c, rates) {
  const ply = c.inter ? 'INTER' : 'INTRA';
  for (const x of rates) {
    const key = `${ply}|${c.pos}|${x.rt}`;
    const cur = map.get(key) || { sply_ty: ply, rt: x.rt, typ: 'OE', pos: c.pos, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    for (const k of ['txval', 'iamt', 'camt', 'samt', 'csamt']) cur[k] = r2(cur[k] + x[k]);
    map.set(key, cur);
  }
}

/** Numbers with a trailing sequence that skip a value, e.g. INV/26-27/0001, 0002, 0004 -> ["INV/26-27/0003"]. */
export function sequenceGaps(numbers) {
  const parsed = numbers.map((n) => { const m = /^(.*?)(\d+)$/.exec(n); return m ? { p: m[1], s: +m[2], w: m[2].length } : null; }).filter(Boolean);
  const out = [];
  const groups = new Map();
  for (const x of parsed) { if (!groups.has(x.p)) groups.set(x.p, []); groups.get(x.p).push(x); }
  for (const [p, list] of groups) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 1; i < list.length; i++) for (let s = list[i - 1].s + 1; s < list[i].s && out.length < 50; s++) out.push(`${p}${String(s).padStart(list[i].w, '0')}`);
  }
  return out;
}

function totalsOf(live, business, limit) {
  const T = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, value: 0 };
  for (const d of live) {
    if (d.tax_mode === 'unknown') continue;
    const s = docOf(d.doc_type).sign;
    T.taxable += s * toNum(d.taxable); T.igst += s * toNum(d.igst); T.cgst += s * toNum(d.cgst); T.sgst += s * toNum(d.sgst);
    T.cess += s * toNum(d.cess); T.value += s * toNum(d.total);
  }
  for (const k of Object.keys(T)) T[k] = r2(T[k]);
  return T;
}

/** The file for the GST portal's offline tool (upload after validating there). */
export function gstr1Json(g, { gt = 0, curGt = 0 } = {}) {
  const s = g.sections;
  const nz = (a) => (a.length ? a : undefined);
  const nilRows = s.nil.length ? { inv: s.nil.map((x) => ({ ...x })) } : undefined;
  const out = {
    gstin: g.gstin, fp: g.fp, gt, cur_gt: curGt, version: GSTR1_JSON_VERSION, hash: 'hash',
    b2b: s.b2b, b2cs: s.b2cs,
    b2cl: nz(s.b2cl), cdnr: nz(s.cdnr), cdnur: nz(s.cdnur), exp: nz(s.exp), nil: nilRows,
    hsn: { data: s.hsn.map(({ num, hsn_sc, desc, uqc, qty, rt, val, txval, iamt, camt, samt, csamt }) => ({ num, hsn_sc, desc, uqc, qty, rt, val, txval, iamt, camt, samt, csamt })) },
    doc_issue: { doc_det: s.docs.map((x) => ({ doc_num: x.portal, docs: [{ num: 1, from: x.from, to: x.to, totnum: x.totnum, cancel: x.cancel, net_issue: x.net_issue }] })) },
  };
  return JSON.parse(JSON.stringify(out));            // drops undefined sections
}

/** Flat tables (for the screen and for CSV) */
export function gstr1Tables(g) {
  const s = g.sections, T = [];
  const rows = (arr, f) => arr.flatMap(f);
  T.push({ id: 'b2b', title: 'B2B invoices', head: ['GSTIN', 'Invoice no.', 'Date', 'Value', 'Place of supply', 'Reverse charge', 'Rate %', 'Taxable', 'IGST', 'CGST', 'SGST/UTGST', 'Cess'],
    rows: rows(s.b2b, (c) => c.inv.flatMap((v) => v.itms.map((i) => [c.ctin, v.inum, v.idt, v.val, v.pos, v.rchrg, i.itm_det.rt, i.itm_det.txval, i.itm_det.iamt, i.itm_det.camt, i.itm_det.samt, i.itm_det.csamt]))) });
  T.push({ id: 'b2cl', title: 'B2C large (inter-state)', head: ['Place of supply', 'Invoice no.', 'Date', 'Value', 'Rate %', 'Taxable', 'IGST', 'Cess'],
    rows: rows(s.b2cl, (c) => c.inv.flatMap((v) => v.itms.map((i) => [c.pos, v.inum, v.idt, v.val, i.itm_det.rt, i.itm_det.txval, i.itm_det.iamt, i.itm_det.csamt]))) });
  T.push({ id: 'b2cs', title: 'B2C small (by place of supply and rate)', head: ['Supply', 'Place of supply', 'Rate %', 'Taxable', 'IGST', 'CGST', 'SGST/UTGST', 'Cess'],
    rows: s.b2cs.map((x) => [x.sply_ty, x.pos, x.rt, x.txval, x.iamt, x.camt, x.samt, x.csamt]) });
  T.push({ id: 'cdnr', title: 'Credit / debit notes (registered)', head: ['GSTIN', 'Note no.', 'Date', 'Type', 'Value', 'Rate %', 'Taxable', 'IGST', 'CGST', 'SGST/UTGST', 'Cess'],
    rows: rows(s.cdnr, (c) => c.nt.flatMap((v) => v.itms.map((i) => [c.ctin, v.nt_num, v.nt_dt, v.ntty, v.val, i.itm_det.rt, i.itm_det.txval, i.itm_det.iamt, i.itm_det.camt, i.itm_det.samt, i.itm_det.csamt]))) });
  T.push({ id: 'exp', title: 'Exports', head: ['Type', 'Invoice no.', 'Date', 'Value', 'Rate %', 'Taxable', 'IGST'],
    rows: rows(s.exp, (c) => c.inv.flatMap((v) => v.itms.map((i) => [c.exp_typ, v.inum, v.idt, v.val, i.rt, i.txval, i.iamt]))) });
  T.push({ id: 'nil', title: 'Nil rated / exempt (Bill of Supply)', head: ['Supply', 'Nil rated', 'Exempt', 'Non-GST'], rows: s.nil.map((x) => [x.sply_ty, x.nil_amt, x.expt_amt, x.ngsup_amt]) });
  T.push({ id: 'hsn', title: 'HSN summary', head: ['HSN/SAC', 'Description', 'UQC', 'Qty', 'Rate %', 'Value', 'Taxable', 'IGST', 'CGST', 'SGST/UTGST', 'Cess'],
    rows: s.hsn.map((x) => [x.hsn_sc, x.desc, x.uqc, x.qty, x.rt, x.val, x.txval, x.iamt, x.camt, x.samt, x.csamt]) });
  T.push({ id: 'docs', title: 'Documents issued', head: ['Document', 'From', 'To', 'Total', 'Cancelled', 'Net issued'], rows: s.docs.map((x) => [x.type, x.from, x.to, x.totnum, x.cancel, x.net_issue]) });
  return T.filter((x) => x.rows.length);
}

// ---- GSTR-3B (summary) ------------------------------------------------------------------------------------------------------------
export function gstr3b(allDocs, purchases, { business = {}, period, settings = {} }) {
  const { from, to } = periodRange(period);
  const live = allDocs.filter((d) => inRange(d, from, to) && !d.cancelled && docOf(d.doc_type).taxDoc);
  const A = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
  const a = A(), b = A(), c = { taxable: 0 }, d31 = A(), unreg = new Map();
  for (const d of live) {
    const s = docOf(d.doc_type).sign;
    const isExp = !!d.export_type || !!d.sez;
    for (const r of d.items || []) {
      const v = { taxable: s * toNum(r.taxable), igst: s * toNum(r.igst), cgst: s * toNum(r.cgst), sgst: s * toNum(r.sgst), cess: s * toNum(r.cess) };
      if (d.tax_mode === 'none' || (toNum(r.gst) === 0 && !isExp)) { c.taxable += v.taxable; continue; }   // nil rated / exempt
      const bucket = isExp ? b : a;
      for (const k of Object.keys(v)) bucket[k] += v[k];
      if (!isExp && d.tax_mode === 'inter' && !validateGstin(d.bill_gstin).ok) {                          // 3.2
        const pos = stateCodeOf(d.pos);
        const u = unreg.get(pos) || { pos, taxable: 0, igst: 0 };
        u.taxable += v.taxable; u.igst += v.igst; unreg.set(pos, u);
      }
    }
  }
  const P = purchases.filter((p) => inRange(p, from, to));
  for (const p of P.filter((x) => x.rcm)) { d31.taxable += toNum(p.taxable); d31.igst += toNum(p.igst); d31.cgst += toNum(p.cgst); d31.sgst += toNum(p.sgst); d31.cess += toNum(p.cess); }
  const itc = P.filter((p) => p.itc_eligible !== false).reduce((x, p) => ({ igst: x.igst + toNum(p.igst), cgst: x.cgst + toNum(p.cgst), sgst: x.sgst + toNum(p.sgst), cess: x.cess + toNum(p.cess) }), { igst: 0, cgst: 0, sgst: 0, cess: 0 });
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
  const liab = { igst: a.igst + b.igst + d31.igst, cgst: a.cgst + d31.cgst, sgst: a.sgst + d31.sgst, cess: a.cess + b.cess + d31.cess };
  const setoff = setOffItc(round(liab), round(itc));
  return {
    period, out_taxable: round(a), zero_rated: round(b), nil_exempt: r2(c.taxable), rcm_inward: round(d31),
    unregistered_inter: [...unreg.values()].map((u) => ({ pos: u.pos, taxable: r2(u.taxable), igst: r2(u.igst) })),
    itc: round(itc), liability: round(liab), ...setoff, purchases: P.length,
  };
}

/**
 * Sets input tax credit against liability in the order the law prescribes:
 * IGST credit -> IGST, then CGST, then SGST; CGST credit -> CGST, then IGST; SGST credit -> SGST, then IGST (never CGST<->SGST).
 */
export function setOffItc(liab, itc) {
  const L = { ...liab }, C = { ...itc };
  const use = (from, to) => { const x = Math.min(C[from], L[to]); L[to] = r2(L[to] - x); C[from] = r2(C[from] - x); };
  use('igst', 'igst'); use('igst', 'cgst'); use('igst', 'sgst');
  use('cgst', 'cgst'); use('cgst', 'igst');
  use('sgst', 'sgst'); use('sgst', 'igst');
  use('cess', 'cess');
  return { cash_payable: L, itc_carry_forward: C, cash_total: r2(L.igst + L.cgst + L.sgst + L.cess) };
}

// ---- receivables ----------------------------------------------------------------------------------------------------------------------
export const AGE_BUCKETS = ['Not due', '1-30 days', '31-60 days', '61-90 days', 'Over 90 days'];
export function outstanding(allDocs, asOf = todayStr()) {
  const open = allDocs.filter((d) => !d.cancelled && docOf(d.doc_type).payable && toNum(d.balance) > 0.004);
  const parties = new Map();
  for (const d of open) {
    const key = d.bill_gstin || d.bill_name || '—';
    const p = parties.get(key) || { key, name: d.bill_name || t('Walk-in customer'), gstin: d.bill_gstin || '', total: 0, buckets: [0, 0, 0, 0, 0], invoices: [] };
    const late = daysBetween(asOf, d.due_date || d.date) ?? 0;
    const i = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4;
    p.buckets[i] = r2(p.buckets[i] + toNum(d.balance)); p.total = r2(p.total + toNum(d.balance));
    p.invoices.push({ number: d.number, date: d.date, due: d.due_date || '', balance: toNum(d.balance), late: Math.max(0, late) });
    parties.set(key, p);
  }
  const rows = [...parties.values()].sort((x, y) => y.total - x.total);
  return { rows, total: r2(rows.reduce((s, p) => s + p.total, 0)), buckets: AGE_BUCKETS.map((_, i) => r2(rows.reduce((s, p) => s + p.buckets[i], 0))) };
}

// ---- e-way bill -------------------------------------------------------------------------------------------------------------------------------
export const EWAY_LIMIT = 50000;                         // consignment value above which an e-way bill is normally needed for goods
const pinOf = (s) => { const m = /\b(\d{6})\b/.exec(String(s || '')); return m ? Number(m[1]) : 0; };
/** NIC e-way bill bulk-upload JSON for one invoice. Throws with a readable message if something mandatory is missing. */
export function ewayBillJson(d, business, opts = {}) {
  const fromCode = stateCodeOf(business.gstin) || stateCodeOf(business.state);
  const toCode = stateCodeOf(d.pos) || stateCodeOf(d.bill_gstin);
  const fromPin = Number(String(business.pincode || '').replace(/\D/g, '')) || pinOf(business.address);
  const toPin = Number(String(opts.toPincode || '').replace(/\D/g, '')) || pinOf(d.bill_address);
  const missing = [];
  if (!business.gstin) missing.push(t('your GSTIN'));
  if (!fromPin) missing.push(t('your PIN code'));
  if (!toPin) missing.push(t('the customer’s PIN code'));
  if (!toCode) missing.push(t('the place of supply'));
  if (!(opts.distance >= 1)) missing.push(t('the distance in km'));
  if (missing.length) throw new Error(`${t('Cannot make the e-way bill yet. Missing:')} ${missing.join(', ')}`);
  const items = (d.items || []).map((r, i) => ({
    itemNo: i + 1, productName: r.desc || '', productDesc: r.desc || '', hsnCode: Number(String(r.hsn || '').replace(/\D/g, '')) || 0,
    quantity: toNum(r.qty), qtyUnit: r.uqc || uqcOf(r.unit), taxableAmount: r2(r.taxable),
    cgstRate: d.tax_mode === 'intra' || d.tax_mode === 'utgst' ? toNum(r.gst) / 2 : 0, sgstRate: d.tax_mode === 'intra' || d.tax_mode === 'utgst' ? toNum(r.gst) / 2 : 0,
    igstRate: d.tax_mode === 'inter' ? toNum(r.gst) : 0, cessRate: toNum(r.cess_pct),
  }));
  return {
    version: '1.0.1221',
    billLists: [{
      userGstin: business.gstin, supplyType: 'O', subSupplyType: 1, docType: d.doc_type === 'Delivery Challan' ? 'CHL' : 'INV',
      docNo: d.number, docDate: gstDate(d.date).replace(/-/g, '/'),
      fromGstin: business.gstin, fromTrdName: business.legal_name || business.name || '', fromAddr1: String(business.address || '').slice(0, 120), fromPlace: business.city || '',
      fromPincode: fromPin, fromStateCode: Number(fromCode) || 0, actFromStateCode: Number(fromCode) || 0,
      toGstin: validateGstin(d.bill_gstin).ok ? d.bill_gstin : 'URP', toTrdName: d.bill_name || '', toAddr1: String(d.bill_address || '').slice(0, 120), toPlace: opts.toPlace || '',
      toPincode: toPin, toStateCode: Number(toCode) || 0, actToStateCode: Number(toCode) || 0, transactionType: 1,
      totalValue: r2(d.taxable), cgstValue: r2(d.cgst), sgstValue: r2(d.sgst), igstValue: r2(d.igst), cessValue: r2(d.cess), totInvValue: r2(d.total),
      transMode: opts.mode || 1, transDistance: Math.round(opts.distance), transporterName: opts.transporterName || '', transporterId: opts.transporterId || '',
      transDocNo: opts.transDocNo || '', vehicleNo: String(opts.vehicleNo || '').replace(/\s/g, '').toUpperCase(), vehicleType: 'R', itemList: items,
    }],
  };
}
export { gstinProblem };
