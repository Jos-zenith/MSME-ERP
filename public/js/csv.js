// CSV / TSV parsing and writing (RFC 4180 quoting) + the header names used by Zoho Books exports and imports.

export function detectDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const counts = { '\t': 0, ';': 0, ',': 0 };
  let q = false;
  for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

/** -> array of rows (arrays of strings). Handles quotes, escaped quotes, CRLF, BOM. Blank lines are dropped. */
export function parseCsv(text, delimiter) {
  text = String(text).replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

// A text cell that starts with = + - @ can run as a formula when opened in Excel / Sheets ("CSV injection").
// Numbers and phone-like values are left alone; anything else gets a leading apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER_OR_PHONE = /^[+-]?[\d\s().-]+$/;
export const safeCell = (v) => {
  if (typeof v !== 'string' || !FORMULA_START.test(v) || PLAIN_NUMBER_OR_PHONE.test(v)) return v;
  return `'${v}`;
};

export function toCsv(rows) {
  const esc = (raw) => {
    const v = safeCell(raw);
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens Hindi/Tamil/Telugu text correctly
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

/** "12/03/2026", "12-3-26", "2026-03-12", "12 Mar 2026" -> "2026-03-12" (day first, as in India). */
export function parseDate(s) {
  s = String(s ?? '').trim();
  if (!s) return '';
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  const p = (n) => String(n).padStart(2, '0');
  if (m) return `${m[1]}-${p(m[2])}-${p(m[3])}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${p(m[2])}-${p(m[1])}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseNumber(s) {
  const n = parseFloat(String(s ?? '').replace(/[₹$,\s]|Rs\.?/gi, ''));
  return Number.isNaN(n) ? null : n;
}

// header (normalised: lowercase letters+digits only) -> our field id. Covers Zoho Books / Inventory,
// Vyapar, Tally and plain spreadsheet column names.
export const ALIASES = {
  name: ['itemname', 'name', 'contactname', 'displayname', 'customername', 'productname', 'partyname', 'companyname', 'item'],
  code: ['sku', 'itemcode', 'code', 'productcode', 'itemid', 'skucode'],
  barcode: ['barcode', 'ean', 'upc', 'barcodeno'],
  price: ['rate', 'sellingprice', 'price', 'mrp', 'salesprice', 'itemprice', 'salerate', 'saleprice'],
  cost: ['purchaserate', 'buyingprice', 'costprice', 'cost', 'purchaseprice', 'purchasecost'],
  stock: ['openingstock', 'stock', 'stockonhand', 'quantity', 'qty', 'stockinhand', 'currentstock', 'openingstockvalue'],
  reorder: ['reorderlevel', 'reorder', 'minstock', 'minimumstock', 'lowstockalert'],
  unit: ['unit', 'usageunit', 'uom', 'unitofmeasure', 'primaryunit'],
  tax: ['taxpercentage', 'tax', 'gst', 'taxrate', 'gstpercent', 'itemtax', 'taxpercent', 'gstrate'],
  phone: ['phone', 'mobile', 'mobilephone', 'contactnumber', 'mobileno', 'phonenumber', 'mobilenumber', 'whatsapp', 'contactno'],
  email: ['email', 'emailid', 'emailaddress'],
  city: ['city', 'billingcity', 'area', 'town', 'location'],
  notes: ['notes', 'note', 'remarks', 'description', 'comments'],
  supplier: ['supplier', 'vendor', 'vendorname'],
  date: ['date', 'invoicedate', 'billdate', 'receivedon'],
  due_date: ['duedate', 'paymentduedate'],
};

export const normHeader = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Guess which of our fields each CSV header belongs to. Returns [fieldId|''] per header. */
export function autoMap(headers, fields) {
  const used = new Set();
  return headers.map((hd) => {
    const n = normHeader(hd);
    let hit = fields.find((f) => !used.has(f.id) && (normHeader(f.label) === n || normHeader(f.id) === n));
    hit ||= fields.find((f) => !used.has(f.id) && (ALIASES[f.id] || []).includes(n));
    if (hit) used.add(hit.id);
    return hit ? hit.id : '';
  });
}

// ---- export presets --------------------------------------------------------------------------------------
// Header names follow Zoho Books' import templates as closely as we can. Zoho's import wizard also lets you map
// columns by hand, so a slightly different header there is easy to fix.
export const ZOHO_EXPORT = {
  items: {
    title: 'Zoho Books — Items',
    columns: [['Item Name', 'name'], ['SKU', 'code'], ['Rate', 'price'], ['Purchase Rate', 'cost'], ['Opening Stock', 'stock'], ['Usage unit', 'unit'], ['Reorder Level', 'reorder'], ['Product Type', () => 'goods'], ['Status', () => 'Active']],
  },
  customers: {
    title: 'Zoho Books — Contacts',
    columns: [['Contact Name', 'name'], ['Display Name', 'name'], ['EmailID', 'email'], ['Phone', 'phone'], ['MobilePhone', 'phone'], ['Billing City', 'city'], ['Notes', 'notes'], ['Contact Type', () => 'customer']],
  },
};
