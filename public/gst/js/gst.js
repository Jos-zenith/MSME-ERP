// GST domain logic: pure functions, no DOM, no storage. Everything money-related lives here so it can be tested hard.
//
// Not tax advice. Rates, thresholds and portal formats change; every threshold here is a named constant or a setting,
// and the GST portal / your CA is the authority. Design informed by studying the MIT-licensed Free-GST-Billing-Software
// project's public changelog of pitfalls; no code was copied.
import { round, toNum, toDate, addDays } from '../../js/formula.js';
import { t } from '../../js/i18n.js';

export const r2 = (n) => round(toNum(n), 2);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v) => { const n = toNum(v); return Number.isFinite(n) && n > 0 ? n : 0; };

// ---- states ------------------------------------------------------------------------------------------------
// UT = Union Territory WITHOUT its own legislature: intra-UT supplies carry CGST + UTGST instead of CGST + SGST.
export const STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh', 1], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu', 1], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep', 1], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands', 1],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh', 1], ['97', 'Other Territory'], ['96', 'Other Countries'],
].map(([code, name, ut]) => ({ code, name, ut: !!ut, label: `${code} - ${name}` }));
export const STATE_LABELS = STATES.filter((s) => s.code !== '96').map((s) => s.label);
const LEGACY = { 25: '26', 28: '37' };            // old Daman & Diu, old Andhra Pradesh: still seen in older GSTINs
export const stateByCode = (c) => STATES.find((s) => s.code === (LEGACY[c] || c));
export const isUtWithoutLegislature = (code) => !!stateByCode(code)?.ut;
/** "27 - Maharashtra" | "27" | a GSTIN | "Maharashtra"  ->  "27" ('' if unknown) */
export function stateCodeOf(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = /^(\d{2})/.exec(s);
  if (m) return stateByCode(m[1])?.code || '';
  const byName = STATES.find((x) => x.name.toLowerCase() === s.toLowerCase());
  return byName ? byName.code : '';
}
export const stateLabel = (code) => stateByCode(code)?.label || '';

// ---- GSTIN / PAN --------------------------------------------------------------------------------------------------
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** The 15th character: a mod-36 check over the first 14 (weights 1,2,1,2…, digit-sum of each product). */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}
export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const cleanGstin = (g) => String(g ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
/** -> { ok, reason?, stateCode, pan } . reason: 'length' | 'format' | 'state' | 'checksum' */
export function validateGstin(raw) {
  const g = cleanGstin(raw);
  if (g.length !== 15) return { ok: false, reason: 'length' };
  if (!GSTIN_RE.test(g)) return { ok: false, reason: 'format' };
  const state = stateByCode(g.slice(0, 2));
  if (!state || state.code === '96') return { ok: false, reason: 'state' };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return { ok: false, reason: 'checksum' };
  return { ok: true, stateCode: state.code, pan: g.slice(2, 12), gstin: g };
}
export const gstinProblem = (raw) => {
  const r = validateGstin(raw);
  if (r.ok) return '';
  return {
    length: t('A GSTIN has 15 characters.'), format: t('This does not look like a GSTIN (2 digits, PAN, entity, Z, check character).'),
    state: t('The first two digits are not a valid state code.'), checksum: t('The last character does not match. Please re-check the GSTIN.'),
  }[r.reason];
};

// ---- units (UQC codes used in the GSTR-1 HSN summary) --------------------------------------------------------------------------
export const UNITS = [
  ['Nos', 'NOS'], ['Pcs', 'PCS'], ['Kg', 'KGS'], ['g', 'GMS'], ['Quintal', 'QTL'], ['Tonne', 'TON'], ['Ltr', 'LTR'], ['ml', 'MLT'],
  ['Mtr', 'MTR'], ['cm', 'CMS'], ['Sq.ft', 'SQF'], ['Sq.m', 'SQM'], ['Box', 'BOX'], ['Dozen', 'DOZ'], ['Pair', 'PRS'], ['Set', 'SET'],
  ['Bag', 'BAG'], ['Roll', 'ROL'], ['Bottle', 'BTL'], ['Packet', 'PAC'], ['Carton', 'CTN'], ['Can', 'CAN'], ['Bundle', 'BDL'],
  ['Unit', 'UNT'], ['Hrs', 'OTH'], ['Day', 'OTH'], ['Month', 'OTH'], ['Service', 'OTH'],
];
export const UNIT_NAMES = UNITS.map((u) => u[0]);
export const uqcOf = (unit) => UNITS.find((u) => u[0] === unit)?.[1] || 'OTH';
export const GST_RATES = [0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28, 40];   // shown in the picker; any rate can be typed
export const B2CL_LIMIT = 100000;   // inter-state supply to an unregistered person above this is reported invoice-wise (setting can override)

// ---- document types -----------------------------------------------------------------------------------------------------------
//   tax     : GST is charged on this document      taxDoc : it is a tax document that goes into returns
//   payable : money is expected against it          sign   : effect on outward supplies (credit notes reduce them)
export const DOC = {
  'Tax Invoice': { key: 'INV', tax: true, taxDoc: true, payable: true, sign: 1, title: 'TAX INVOICE', portal: 1 },
  'Bill of Supply': { key: 'BOS', tax: false, taxDoc: true, payable: true, sign: 1, title: 'BILL OF SUPPLY', portal: 1 },
  'Proforma Invoice': { key: 'PRO', tax: true, taxDoc: false, payable: false, sign: 0, title: 'PROFORMA INVOICE', portal: 0 },
  'Delivery Challan': { key: 'DC', tax: false, taxDoc: false, payable: false, sign: 0, title: 'DELIVERY CHALLAN', portal: 12 },
  'Credit Note': { key: 'CN', tax: true, taxDoc: true, payable: false, sign: -1, title: 'CREDIT NOTE', portal: 5, note: true },
  'Debit Note': { key: 'DN', tax: true, taxDoc: true, payable: true, sign: 1, title: 'DEBIT NOTE', portal: 4, note: true },
};
export const DOC_TYPES = Object.keys(DOC);
export const docOf = (d) => DOC[d] || DOC['Tax Invoice'];

// ---- financial year & numbering -----------------------------------------------------------------------------------------------------
/** India's financial year runs April to March. */
export function financialYear(dateStr) {
  const d = toDate(dateStr) || new Date();
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return { start, label: `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`, from: `${start}-04-01`, to: `${start + 1}-03-31` };
}
export const NUMBER_RE = /^[A-Za-z0-9/-]{1,16}$/;   // Rule 46(b): at most 16 characters, letters, digits, "/" and "-"

export function formatInvoiceNumber({ prefix, fy, seq, pad = 4, withFy = true, tag = '' }) {
  return `${prefix}${tag}/${withFy ? `${fy}/` : ''}${String(seq).padStart(pad, '0')}`;
}

// ---- amount in words (Indian system) -------------------------------------------------------------------------------------------------------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
  'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const below1000 = (n) => (n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${below100(n % 100)}` : ''}` : below100(n));
export function integerToWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${integerToWords(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}
export function amountInWords(amount) {
  const neg = amount < 0;
  const cents = Math.round(Math.abs(toNum(amount)) * 100);
  const rupees = Math.floor(cents / 100), paise = cents % 100;
  let s = `Rupees ${integerToWords(rupees)}`;
  if (paise) s += ` and ${below100(paise)} Paise`;
  return `${neg ? 'Minus ' : ''}${s} Only`;
}

// ---- tax mode ----------------------------------------------------------------------------------------------------------------------------------
/**
 * How is GST charged on this document?
 *   none    no GST charged (Bill of Supply, Delivery Challan, composition dealer)
 *   zero    zero-rated: export or SEZ supply under LUT (no tax)
 *   intra   CGST + SGST         utgst  CGST + UTGST (both parties in a UT without legislature)
 *   inter   IGST                unknown  we cannot tell (business state or place of supply missing): never guess
 */
export function taxMode({ docType, business = {}, pos = '', sez = false, exportType = '' }) {
  const cfg = docOf(docType);
  if (!cfg.tax || business.composition) return { mode: 'none' };
  if (exportType === 'LUT') return { mode: 'zero' };
  const from = stateCodeOf(business.gstin) || stateCodeOf(business.state);
  if (!from) return { mode: 'unknown', problem: 'business_state' };
  if (exportType === 'WPAY' || sez) return { mode: 'inter' };
  const to = stateCodeOf(pos);
  if (!to) return { mode: 'unknown', problem: 'pos' };
  if (to !== from) return { mode: 'inter' };
  return { mode: isUtWithoutLegislature(from) ? 'utgst' : 'intra' };
}
const HAS_TAX = new Set(['intra', 'utgst', 'inter']);

// ---- invoice calculation ----------------------------------------------------------------------------------------------------------------------------
/**
 * Fills every computed field of an invoice. Line values:
 *   taxable = qty x rate - discount%      (or backed out of the price when "prices include GST")
 *   CGST and SGST are each computed at half the rate, per line, so line values add up exactly to the totals used in GSTR-1.
 *   For GST-inclusive prices the tax is (price - taxable) so the customer still pays exactly the price shown.
 */
export function computeInvoice(data, { business = {}, settings = {} } = {}) {
  const d = { ...data };
  const cfg = docOf(d.doc_type);
  const pos = stateCodeOf(d.pos) || (d.export_type ? '96' : '');
  const { mode } = taxMode({ docType: d.doc_type, business, pos, sez: !!d.sez, exportType: d.export_type || '' });
  const taxed = HAS_TAX.has(mode);
  const split = mode === 'intra' || mode === 'utgst';
  const inclusive = !!d.price_incl && taxed;
  const rcm = !!d.reverse_charge && taxed;

  const T = { subtotal: 0, discount_total: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
  d.items = (d.items || []).map((src) => {
    const row = { ...src };
    const gross = num(row.qty) * num(row.rate);
    const discAmt = r2(gross * clamp(toNum(row.disc), 0, 100) / 100);
    const after = gross - discAmt;
    const rate = taxed ? num(row.gst) : 0;
    const cessRate = taxed ? num(row.cess_pct) : 0;
    const taxable = r2(inclusive && rate > 0 ? after / (1 + rate / 100) : after);
    let cgst = 0, sgst = 0, igst = 0;
    if (split) {
      if (inclusive && rate > 0) { const tax = r2(after) - taxable; cgst = r2(tax / 2); sgst = r2(tax - cgst); }
      else { cgst = r2(taxable * rate / 200); sgst = cgst; }
    } else if (mode === 'inter') {
      igst = inclusive && rate > 0 ? r2(r2(after) - taxable) : r2(taxable * rate / 100);
    }
    const cess = r2(taxable * cessRate / 100);
    Object.assign(row, { taxable, cgst, sgst, igst, cess, amount: r2(taxable + (rcm ? 0 : cgst + sgst + igst + cess)) });
    T.subtotal += gross; T.discount_total += discAmt; T.taxable += taxable; T.cgst += cgst; T.sgst += sgst; T.igst += igst; T.cess += cess;
    return row;
  });
  for (const k of Object.keys(T)) T[k] = r2(T[k]);
  Object.assign(d, T, { tax_mode: mode });

  // Under reverse charge the buyer pays the tax to the government, so the supplier's invoice total is the taxable value only.
  const before = r2(T.taxable + (rcm ? 0 : T.cgst + T.sgst + T.igst + T.cess));
  const wantRound = settings.gst?.round_off !== false;
  d.total = wantRound ? Math.round(before) : before;
  d.round_off = r2(d.total - before);

  d.payments = (d.payments || []).map((p) => ({ ...p }));
  d.paid = r2(d.payments.reduce((s, p) => s + num(p.amount), 0));
  d.balance = r2(d.total - d.paid);
  d.status = !cfg.payable ? '' : d.cancelled ? 'Cancelled' : d.balance <= 0.004 ? 'Paid' : d.paid > 0 ? 'Partial' : 'Unpaid';
  return d;
}

// ---- validation ----------------------------------------------------------------------------------------------------------------------------------------
/** Returns { fieldId | "_general": message }. Empty object = fine to save. */
export function validateInvoice(d, { business = {}, settings = {} } = {}) {
  const e = {};
  const cfg = docOf(d.doc_type);
  const gst = settings.gst || {};
  const bizState = stateCodeOf(business.gstin) || stateCodeOf(business.state);

  if (business.composition && cfg.tax) {
    e.doc_type = t('A composition dealer cannot charge GST. Use a Bill of Supply.');
  } else if (cfg.tax && cfg.taxDoc) {
    if (business.gstin && !validateGstin(business.gstin).ok) e._business = t('Your own GSTIN in Settings is not valid. Please correct it first.');
    else if (!business.gstin) e._business = t('Add your GSTIN in Settings before issuing a GST invoice.');
    else if (!bizState) e._business = t('Your business state is missing. Set it in Settings so tax is split correctly.');
  }
  if (d.bill_gstin) {
    const p = gstinProblem(d.bill_gstin);
    if (p) e.bill_gstin = p;
  }
  if (d.tax_mode === 'unknown' && !e._business) e.pos = t('Choose the place of supply so we can tell CGST + SGST from IGST.');
  if (d.number && !NUMBER_RE.test(d.number)) e.number = t('An invoice number can have at most 16 characters: letters, digits, "/" and "-".');
  if (cfg.note && !d.original_invoice && !String(d.ref_note || '').trim()) e.ref_note = t('Say which invoice this note is against.');
  if (cfg.taxDoc && cfg.tax && d.bill_gstin && HAS_TAX_MODE(d.tax_mode) && gst.hsn_digits !== 0) {
    const need = gst.hsn_digits || 4;
    const bad = (d.items || []).find((r) => String(r.hsn || '').replace(/\D/g, '').length < need);
    if (bad) e.items = t('Every item on a business (B2B) invoice needs an HSN/SAC code of at least {n} digits.', { n: need });
  }
  if (d.reverse_charge && !d.bill_gstin) e.reverse_charge = t('Reverse charge applies to purchases from unregistered suppliers, so it needs the supplier’s details. Untick it for a normal sale.');
  return e;
}
const HAS_TAX_MODE = (m) => HAS_TAX.has(m);

// ---- misc helpers used across the app ----------------------------------------------------------------------------------------------------------------
export function periodOf(dateStr) { return String(dateStr || '').slice(0, 7); }        // "2026-09"
export const fpOf = (ym) => `${ym.slice(5, 7)}${ym.slice(0, 4)}`;                      // GSTR filing period MMYYYY
export const gstDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };

/** Monthly return due dates (GSTR-1 on the 11th, GSTR-3B on the 20th of the following month). QRMP filers differ. */
export function filingDeadlines(today) {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const nxt = m === 12 ? [y + 1, 1] : [y, m + 1];
  const iso = (yy, mm, dd) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
  return [
    { return: 'GSTR-1', period: `${prev[0]}-${String(prev[1]).padStart(2, '0')}`, due: iso(y, m, 11) },
    { return: 'GSTR-3B', period: `${prev[0]}-${String(prev[1]).padStart(2, '0')}`, due: iso(y, m, 20) },
    { return: 'GSTR-1', period: `${y}-${String(m).padStart(2, '0')}`, due: iso(nxt[0], nxt[1], 11) },
  ].filter((x) => x.due >= today || addDays(x.due, 0) >= addDays(today, -1));
}
