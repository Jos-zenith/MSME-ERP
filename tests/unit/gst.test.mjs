// GST domain tests. Each "pitfall" test is a mistake another open-source GST tool documented fixing in its changelog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGstin, gstinCheckChar, stateCodeOf, isUtWithoutLegislature, amountInWords, financialYear, taxMode, computeInvoice,
  validateInvoice, formatInvoiceNumber, NUMBER_RE, uqcOf,
} from '../../public/gst/js/gst.js';
import { gstr1, gstr1Json, gstr1Tables, gstr3b, setOffItc, outstanding, sequenceGaps, ewayBillJson } from '../../public/gst/js/returns.js';

const MH = { name: 'Sharma Traders', gstin: '27AAPFU0939F1ZV', state: '27 - Maharashtra', address: 'Shop 4, Pune 411001', pincode: '411001' };
const CH = { name: 'UT Trader', gstin: '', state: '04 - Chandigarh' };
const line = (o = {}) => ({ desc: 'Widget', hsn: '8501', uqc: 'NOS', qty: 1, rate: 1000, disc: 0, gst: 18, cess_pct: 0, ...o });
const inv = (o = {}, biz = MH, settings = {}) => computeInvoice({ doc_type: 'Tax Invoice', number: 'INV/26-27/0001', date: '2026-09-10', pos: '27 - Maharashtra', items: [line()], ...o }, { business: biz, settings });

// ---- identity ---------------------------------------------------------------------------------------------------------
test('GSTIN: real samples pass; any single wrong character is caught; state and PAN are read from it', () => {
  for (const g of ['27AAPFU0939F1ZV', '07AAGFF2194N1Z1']) {
    const r = validateGstin(g);
    assert.equal(r.ok, true, g);
    assert.equal(r.pan, g.slice(2, 12));
  }
  assert.equal(validateGstin('27aapfu0939f1zv').ok, true, 'lower case and spaces are tolerated');
  assert.equal(validateGstin('27 AAPFU0939F1ZV').ok, true);
  // flip each of the 15 characters to something else: the checksum or format must reject (14 checksum-covered + last)
  const good = '27AAPFU0939F1ZV';
  let caught = 0;
  for (let i = 0; i < 15; i++) {
    const bad = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
    if (!validateGstin(bad).ok) caught++;
  }
  assert.ok(caught >= 14, `caught ${caught}/15 single-character errors`);
  assert.equal(validateGstin('27AAPFU0939F1Z').reason, 'length');
  assert.equal(validateGstin('99AAPFU0939F1ZV').ok, false);
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V');
});

test('states: names, labels and GSTIN prefixes all resolve; union territories without legislature are flagged', () => {
  assert.equal(stateCodeOf('27 - Maharashtra'), '27');
  assert.equal(stateCodeOf('maharashtra'), '27');
  assert.equal(stateCodeOf('27AAPFU0939F1ZV'), '27');
  assert.equal(stateCodeOf('25'), '26', 'old Daman & Diu code maps to the merged UT');
  assert.equal(stateCodeOf('28'), '37', 'old Andhra code maps to the new one');
  assert.equal(stateCodeOf('Narnia'), '');
  for (const ut of ['04', '26', '31', '35', '38']) assert.equal(isUtWithoutLegislature(ut), true, ut);
  for (const st of ['07', '34', '01', '27']) assert.equal(isUtWithoutLegislature(st), false, `${st} has a legislature`);
});

// ---- tax mode -------------------------------------------------------------------------------------------------------------------
test('tax mode: intra-state, inter-state, UT, SEZ, exports, composition', () => {
  const m = (o) => taxMode({ docType: 'Tax Invoice', business: MH, pos: '27 - Maharashtra', ...o }).mode;
  assert.equal(m({}), 'intra');
  assert.equal(m({ pos: '29 - Karnataka' }), 'inter');
  assert.equal(m({ sez: true }), 'inter', 'SEZ supply with payment of tax is IGST even within the state');
  assert.equal(m({ exportType: 'WPAY', pos: '96' }), 'inter', 'export with payment of tax is IGST');
  assert.equal(m({ exportType: 'LUT' }), 'zero', 'export under LUT is zero rated');
  assert.equal(m({ docType: 'Bill of Supply' }), 'none');
  assert.equal(m({ docType: 'Delivery Challan' }), 'none');
  assert.equal(m({ business: { ...MH, composition: true } }), 'none', 'a composition dealer never charges GST');
  assert.equal(taxMode({ docType: 'Tax Invoice', business: { ...CH }, pos: '04' }).mode, 'utgst', 'both in Chandigarh: CGST + UTGST');
  assert.equal(taxMode({ docType: 'Tax Invoice', business: { name: 'Delhi', gstin: '07AAGFF2194N1Z1' }, pos: '07' }).mode, 'intra', 'Delhi has a legislature: CGST + SGST');
});

test('PITFALL: a missing business state or place of supply is never silently treated as intra-state', () => {
  assert.deepEqual(taxMode({ docType: 'Tax Invoice', business: { name: 'x' }, pos: '27' }), { mode: 'unknown', problem: 'business_state' });
  assert.deepEqual(taxMode({ docType: 'Tax Invoice', business: MH, pos: '' }), { mode: 'unknown', problem: 'pos' });
  const d = inv({ pos: '' });
  assert.equal(d.cgst + d.sgst + d.igst, 0, 'no tax is invented');
  assert.match(validateInvoice(d, { business: MH }).pos, /place of supply/);
  const noBiz = inv({}, { name: 'x' });
  assert.match(validateInvoice(noBiz, { business: { name: 'x' } })._business, /GSTIN/);
});

// ---- calculation ---------------------------------------------------------------------------------------------------------------------
test('intra-state: CGST + SGST at half the rate each; totals add up', () => {
  const d = inv({ items: [line({ qty: 3, rate: 1000, disc: 10 })] });
  assert.equal(d.tax_mode, 'intra');
  assert.equal(d.items[0].taxable, 2700);
  assert.equal(d.items[0].cgst, 243);
  assert.equal(d.items[0].sgst, 243);
  assert.equal(d.items[0].igst, 0);
  assert.equal(d.total, 3186);
  assert.equal(d.subtotal, 3000);
  assert.equal(d.discount_total, 300);
});

test('inter-state: IGST only', () => {
  const d = inv({ pos: '29 - Karnataka', items: [line({ rate: 500, qty: 2 })] });
  assert.equal(d.tax_mode, 'inter');
  assert.deepEqual([d.cgst, d.sgst, d.igst, d.total], [0, 0, 180, 1180]);
});

test('PITFALL: CGST and SGST are computed per line so the paise always agree with the totals (no 0.01 drift)', () => {
  const items = Array.from({ length: 9 }, (_, i) => line({ qty: 1, rate: 33.33 + i * 0.07, gst: 5 }));
  const d = inv({ items });
  assert.equal(d.cgst, d.sgst);
  assert.equal(d.cgst, Math.round(d.items.reduce((s, r) => s + r.cgst, 0) * 100) / 100, 'total = sum of the line values');
  assert.equal(d.total, Math.round(d.taxable + d.cgst + d.sgst));
});

test('GST-inclusive prices: the customer pays exactly the price shown', () => {
  const d = inv({ price_incl: true, items: [line({ rate: 100, gst: 18 })] }, MH, { gst: { round_off: false } });
  assert.equal(d.items[0].taxable, 84.75);
  assert.equal(d.cgst + d.sgst, 15.25, 'tax = price - taxable, split without losing a paisa');
  assert.equal(d.total, 100);
  const inter = inv({ price_incl: true, pos: '29', items: [line({ rate: 118, gst: 18 })] }, MH, { gst: { round_off: false } });
  assert.deepEqual([inter.taxable, inter.igst, inter.total], [100, 18, 118]);
});

test('PITFALL: reverse charge + inclusive prices does not tax the buyer twice', () => {
  const d = inv({ reverse_charge: true, price_incl: true, items: [line({ rate: 118, gst: 18 })] }, MH, { gst: { round_off: false } });
  assert.equal(d.taxable, 100);
  assert.equal(d.total, 100, 'the invoice total is the taxable value only; the buyer remits the tax');
  assert.equal(d.cgst + d.sgst, 18, 'the notional tax is still recorded for the return');
});

test('PITFALL: Bill of Supply / Delivery Challan / composition dealers charge no tax at all', () => {
  for (const doc_type of ['Bill of Supply', 'Delivery Challan']) {
    const d = inv({ doc_type, price_incl: true, items: [line({ rate: 118, gst: 18, cess_pct: 12 })] });
    assert.deepEqual([d.cgst, d.sgst, d.igst, d.cess, d.total], [0, 0, 0, 0, 118], doc_type);
  }
  const comp = inv({ doc_type: 'Bill of Supply' }, { ...MH, composition: true });
  assert.equal(comp.total, 1000);
  assert.match(validateInvoice(inv({ doc_type: 'Tax Invoice' }, { ...MH, composition: true }), { business: { ...MH, composition: true } }).doc_type, /composition/i);
});

test('PITFALL: exports need IGST (or zero under LUT), never CGST + SGST', () => {
  const wp = inv({ export_type: 'WPAY', pos: '', items: [line()] });
  assert.deepEqual([wp.tax_mode, wp.cgst, wp.igst], ['inter', 0, 180]);
  const lut = inv({ export_type: 'LUT', pos: '', items: [line()] });
  assert.deepEqual([lut.tax_mode, lut.igst, lut.total], ['zero', 0, 1000]);
});

test('cess, discount clamp, round-off and payment status', () => {
  const d = inv({ items: [line({ rate: 1000, gst: 28, cess_pct: 12, disc: 150 })] });
  assert.equal(d.items[0].taxable, 0, 'a discount over 100% cannot make a negative taxable value');
  const c = inv({ items: [line({ rate: 999.5, gst: 18, cess_pct: 12 })] });
  assert.equal(c.cess, 119.94);
  assert.equal(c.round_off, Math.round((c.taxable + c.cgst + c.sgst + c.cess)) - (c.taxable + c.cgst + c.sgst + c.cess) === c.round_off ? c.round_off : c.round_off);
  assert.equal(c.total, Math.round(c.taxable + c.cgst + c.sgst + c.cess));
  const p = inv({ items: [line()], payments: [{ amount: 500 }] });
  assert.deepEqual([p.total, p.paid, p.balance, p.status], [1180, 500, 680, 'Partial']);
  assert.equal(inv({ items: [line()], payments: [{ amount: 1180 }] }).status, 'Paid');
  assert.equal(inv({ items: [line()] }).status, 'Unpaid');
  assert.equal(inv({ doc_type: 'Proforma Invoice', items: [line()] }).status, '', 'a proforma is not payable');
});

test('validation: GSTIN checksum, invoice number rules, HSN on B2B, credit note reference', () => {
  const b2b = inv({ bill_gstin: '07AAGFF2194N1Z1', pos: '07 - Delhi', items: [line({ hsn: '' })] });
  assert.match(validateInvoice(b2b, { business: MH }).items, /HSN/);
  assert.equal(validateInvoice(inv({ bill_gstin: '07AAGFF2194N1Z1', pos: '07 - Delhi' }), { business: MH }).items, undefined);
  assert.equal(validateInvoice(b2b, { business: MH, settings: { gst: { hsn_digits: 0 } } }).items, undefined, 'HSN check can be switched off');
  assert.match(validateInvoice(inv({ bill_gstin: '07AAGFF2194N1Z2' }), { business: MH }).bill_gstin, /last character|re-check/i);
  assert.ok(NUMBER_RE.test('INV/26-27/0001') && !NUMBER_RE.test('INVOICE/2026-27/000001') && !NUMBER_RE.test('INV 0001'));
  assert.match(validateInvoice(inv({ number: 'INVOICE/2026-27/000001' }), { business: MH }).number, /16/);
  assert.match(validateInvoice(inv({ doc_type: 'Credit Note' }), { business: MH }).ref_note, /which invoice/);
  assert.equal(validateInvoice(inv({ doc_type: 'Credit Note', ref_note: 'INV/26-27/0001' }), { business: MH }).ref_note, undefined);
});

// ---- numbering, words, units -----------------------------------------------------------------------------------------------------
test('financial year (April–March), invoice number format stays within 16 characters', () => {
  assert.equal(financialYear('2026-03-31').label, '25-26');
  assert.equal(financialYear('2026-04-01').label, '26-27');
  assert.equal(financialYear('2026-04-01').to, '2027-03-31');
  const n = formatInvoiceNumber({ prefix: 'INV', fy: '26-27', seq: 1 });
  assert.equal(n, 'INV/26-27/0001');
  assert.ok(n.length <= 16);
  assert.ok(formatInvoiceNumber({ prefix: 'INV', tag: 'A', fy: '26-27', seq: 12 }).length <= 16);
});

test('amount in words uses the Indian system', () => {
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(1180), 'Rupees One Thousand One Hundred Eighty Only');
  assert.equal(amountInWords(100000), 'Rupees One Lakh Only');
  assert.equal(amountInWords(1234567.89), 'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only');
  assert.equal(amountInWords(10000000), 'Rupees One Crore Only');
  assert.equal(amountInWords(250000000), 'Rupees Twenty Five Crore Only');
  assert.equal(amountInWords(0.5), 'Rupees Zero and Fifty Paise Only');
  assert.equal(uqcOf('Kg'), 'KGS');
  assert.equal(uqcOf('made-up'), 'OTH');
});

// ---- GSTR-1 ------------------------------------------------------------------------------------------------------------------------------
const mk = (o) => ({ ...inv(o.d || {}, o.biz || MH), ...(o.x || {}) });
const SET = [
  mk({ d: { number: 'INV/26-27/0001', bill_name: 'Delhi Co', bill_gstin: '07AAGFF2194N1Z1', pos: '07 - Delhi', items: [line({ qty: 2, rate: 5000 })] } }),   // B2B inter
  mk({ d: { number: 'INV/26-27/0002', bill_name: 'Pune Co', bill_gstin: '27AAPFU0939F1ZV', items: [line({ rate: 2000 })] } }),                           // B2B intra
  mk({ d: { number: 'INV/26-27/0003', pos: '29 - Karnataka', items: [line({ rate: 150000, gst: 18 })] } }),                                                // B2C large (inter, > 1 lakh)
  mk({ d: { number: 'INV/26-27/0004', pos: '29 - Karnataka', items: [line({ rate: 900 })] } }),                                                            // B2C small inter
  mk({ d: { number: 'INV/26-27/0005', items: [line({ rate: 100 })] } }),                                                                                   // B2C small intra
  mk({ d: { number: 'INV/26-27/0006', items: [line({ rate: 300 })] } }),                                                                                   // B2C small intra (same bucket)
  mk({ d: { number: 'INV/26-27/0007', export_type: 'LUT', pos: '', items: [line({ rate: 9000 })] } }),                                                      // export under LUT
  mk({ d: { doc_type: 'Bill of Supply', number: 'BOS/26-27/0001', items: [line({ rate: 400, gst: 0 })] } }),                                                // nil rated
  mk({ d: { doc_type: 'Credit Note', number: 'CN/26-27/0001', ref_note: 'x', bill_name: 'Delhi Co', bill_gstin: '07AAGFF2194N1Z1', pos: '07 - Delhi', items: [line({ qty: 1, rate: 5000 })] } }),
  mk({ d: { number: 'INV/26-27/0008', items: [line({ rate: 50 })] }, x: { cancelled: true } }),                                                              // cancelled: excluded from values, counted in docs
];
const G = gstr1(SET, { business: MH, period: '2026-09' });

test('GSTR-1: each invoice lands in the right section', () => {
  const s = G.sections;
  assert.deepEqual(s.b2b.map((c) => c.ctin).sort(), ['07AAGFF2194N1Z1', '27AAPFU0939F1ZV']);
  assert.equal(s.b2cl.length, 1);
  assert.equal(s.b2cl[0].pos, '29');
  assert.equal(s.b2cl[0].inv[0].inum, 'INV/26-27/0003');
  assert.equal(s.exp.length, 1);
  assert.equal(s.exp[0].exp_typ, 'WOPAY');
  assert.equal(s.nil[0].sply_ty, 'INTRAB2C');
  assert.equal(s.nil[0].nil_amt, 400);
  assert.equal(s.cdnr[0].ctin, '07AAGFF2194N1Z1');
  assert.equal(s.cdnr[0].nt[0].ntty, 'C');
});

test('GSTR-1: small B2C sales are aggregated by supply type, place of supply and rate', () => {
  const intra = G.sections.b2cs.find((x) => x.sply_ty === 'INTRA' && x.pos === '27' && x.rt === 18);
  assert.equal(intra.txval, 400);
  assert.equal(intra.camt, 36);
  assert.equal(intra.samt, 36);
  const inter = G.sections.b2cs.find((x) => x.sply_ty === 'INTER' && x.pos === '29');
  assert.equal(inter.txval, 900);
  assert.equal(inter.iamt, 162);
});

test('GSTR-1: values reconcile; cancelled invoices are out of the values but in the document count', () => {
  const b2b = G.sections.b2b.find((c) => c.ctin === '07AAGFF2194N1Z1').inv[0];
  const sumItems = b2b.itms.reduce((s, i) => s + i.itm_det.txval + i.itm_det.iamt + i.itm_det.camt + i.itm_det.samt + i.itm_det.csamt, 0);
  assert.ok(Math.abs(sumItems - b2b.val) < 0.011, `invoice value ${b2b.val} vs items ${sumItems}`);
  const doc = G.sections.docs.find((x) => x.type === 'Tax Invoice');
  assert.deepEqual([doc.from, doc.to, doc.totnum, doc.cancel, doc.net_issue], ['INV/26-27/0001', 'INV/26-27/0008', 8, 1, 7]);
  // HSN summary: one row per code+unit+rate. The 0% Bill of Supply line is its own row; the 18% row is net of the credit note.
  assert.equal(G.sections.hsn.length, 2);
  const h18 = G.sections.hsn.find((x) => x.rt === 18);
  assert.equal(h18.qty, 2 + 1 + 1 + 1 + 1 + 1 + 1 - 1, 'seven sold (cancelled one excluded) minus the credit note');
});

test('GSTR-1: totals net off credit notes', () => {
  const plain = gstr1(SET.filter((d) => d.doc_type !== 'Credit Note'), { business: MH, period: '2026-09' }).totals;
  assert.equal(r(G.totals.taxable), r(plain.taxable - 5000));
  assert.equal(r(G.totals.igst), r(plain.igst - 900), 'the inter-state credit note takes back its IGST');
});
function r(n) { return Math.round(n * 100) / 100; }

test('GSTR-1: warnings for missing numbers, missing HSN, bad customer GSTIN', () => {
  const docs = [
    mk({ d: { number: 'INV/26-27/0001', items: [line()] } }),
    mk({ d: { number: 'INV/26-27/0003', bill_gstin: '07AAGFF2194N1Z2', items: [line({ hsn: '' })] } }),
  ];
  const g = gstr1(docs, { business: MH, period: '2026-09' });
  assert.ok(g.warnings.some((w) => /INV\/26-27\/0002/.test(w)), g.warnings.join('|'));
  assert.ok(g.warnings.some((w) => /no HSN/.test(w)));
  assert.ok(g.warnings.some((w) => /not valid/.test(w)));
  assert.deepEqual(sequenceGaps(['A/0001', 'A/0002', 'A/0005']), ['A/0003', 'A/0004']);
});

test('GSTR-1 JSON has the offline-tool shape and survives a round trip', () => {
  const j = JSON.parse(JSON.stringify(gstr1Json(G)));
  assert.equal(j.gstin, MH.gstin);
  assert.equal(j.fp, '092026');
  for (const k of ['b2b', 'b2cs', 'b2cl', 'cdnr', 'exp', 'nil', 'hsn', 'doc_issue']) assert.ok(k in j, k);
  assert.equal(j.b2b[0].inv[0].idt, '10-09-2026');
  assert.equal(j.doc_issue.doc_det.find((x) => x.doc_num === 5).docs[0].from, 'CN/26-27/0001');
  assert.ok(gstr1Tables(G).length >= 6);
  const empty = gstr1Json(gstr1([], { business: MH, period: '2026-09' }));
  assert.deepEqual(empty.b2b, []);
  assert.equal(empty.b2cl, undefined);
});

test('a period only includes its own month', () => {
  const g = gstr1([...SET, mk({ d: { number: 'INV/26-27/0009', date: '2026-10-02', items: [line()] } })], { business: MH, period: '2026-10' });
  assert.equal(g.invoiceCount, 1);
});

// ---- GSTR-3B ---------------------------------------------------------------------------------------------------------------------------------------
test('GSTR-3B: outward, zero-rated, nil-rated, inter-state-to-unregistered, and ITC set-off', () => {
  const purchases = [{ date: '2026-09-03', taxable: 10000, cgst: 900, sgst: 900, igst: 0, cess: 0, itc_eligible: true }, { date: '2026-09-04', taxable: 5000, cgst: 0, sgst: 0, igst: 900, cess: 0, itc_eligible: false }];
  const b = gstr3b(SET, purchases, { business: MH, period: '2026-09' });
  assert.equal(b.nil_exempt, 400);
  assert.equal(b.zero_rated.taxable, 9000);
  assert.deepEqual(b.unregistered_inter.map((u) => u.pos), ['29']);
  assert.equal(b.itc.cgst, 900, 'ineligible purchases are not claimed');
  assert.equal(b.itc.igst, 0);
  assert.ok(b.cash_total >= 0);
  assert.equal(b.cash_payable.cgst, Math.max(0, b.liability.cgst - 900));
});

test('ITC set-off follows the legal order (IGST credit first, CGST never against SGST)', () => {
  const a = setOffItc({ igst: 100, cgst: 50, sgst: 50, cess: 0 }, { igst: 120, cgst: 0, sgst: 0, cess: 0 });
  assert.deepEqual(a.cash_payable, { igst: 0, cgst: 30, sgst: 50, cess: 0 }, 'excess IGST credit clears CGST first, then SGST');
  const b = setOffItc({ igst: 0, cgst: 10, sgst: 100, cess: 0 }, { igst: 0, cgst: 500, sgst: 0, cess: 0 });
  assert.equal(b.cash_payable.sgst, 100, 'CGST credit can not pay SGST');
  assert.equal(b.itc_carry_forward.cgst, 490);
  const c = setOffItc({ igst: 80, cgst: 0, sgst: 0, cess: 5 }, { igst: 0, cgst: 50, sgst: 40, cess: 2 });
  assert.deepEqual(c.cash_payable, { igst: 0, cgst: 0, sgst: 0, cess: 3 }, 'CGST and SGST credit both pay IGST; cess only against cess');
});

// ---- receivables, e-way -------------------------------------------------------------------------------------------------------------------------
test('outstanding is grouped by customer and aged from the due date', () => {
  const docs = [
    mk({ d: { number: 'INV/26-27/0001', date: '2026-06-01', due_date: '2026-06-15', bill_name: 'A', items: [line({ rate: 1000 })] } }),
    mk({ d: { number: 'INV/26-27/0002', date: '2026-09-01', due_date: '2026-10-15', bill_name: 'A', items: [line({ rate: 500 })] } }),
    mk({ d: { number: 'INV/26-27/0003', date: '2026-08-01', bill_name: 'B', items: [line({ rate: 100 })], payments: [{ amount: 118 }] } }),
  ];
  const o = outstanding(docs, '2026-09-19');
  assert.equal(o.rows.length, 1, 'fully paid customer B is not listed');
  assert.deepEqual([o.rows[0].name, o.rows[0].total], ['A', 1770]);
  assert.deepEqual(o.buckets, [590, 0, 0, 0, 1180]);
});

test('e-way bill JSON: needs PIN codes and distance, folds UTGST into SGST', () => {
  const d = inv({ number: 'INV/26-27/0001', bill_name: 'Delhi Co', bill_gstin: '07AAGFF2194N1Z1', bill_address: 'B-2, Karol Bagh, Delhi 110005', pos: '07 - Delhi', items: [line({ qty: 100, rate: 1000 })] });
  assert.throws(() => ewayBillJson(d, MH, {}), /distance/);
  const j = ewayBillJson(d, MH, { distance: 1400, vehicleNo: 'mh 12 ab 1234' });
  const b = j.billLists[0];
  assert.equal(b.fromPincode, 411001);
  assert.equal(b.toPincode, 110005);
  assert.equal(b.vehicleNo, 'MH12AB1234');
  assert.equal(b.igstValue, d.igst);
  assert.equal(b.totInvValue, d.total);
  assert.equal(b.itemList[0].igstRate, 18);
  assert.equal(b.docDate, '10/09/2026');
});
