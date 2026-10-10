// Connects the GST engine (gst.js) to the app's tables through table hooks. Pure: no DOM, so the store and the
// unit tests use exactly what the screens use.
//
//   gst_invoice   sales documents: live CGST/SGST or IGST split, round-off, payment status, FY-wise numbering
//   gst_purchase  purchase bills: the same maths from the supplier's side, so GSTR-3B can claim input credit
//   gst_party     customers / suppliers: a GSTIN fills in the state (and is checked) so nobody types it twice
import { registerHooks, isBlank } from '../../js/schema.js';
import { t } from '../../js/i18n.js';
import {
  computeInvoice, validateInvoice, validateGstin, gstinProblem, stateCodeOf, stateLabel, financialYear, formatInvoiceNumber, docOf, r2,
} from './gst.js';

/** "27 - Maharashtra" for the business, from its GSTIN first, then its state setting. */
export const businessState = (b = {}) => stateLabel(stateCodeOf(b.gstin) || stateCodeOf(b.state));
const stateName = (v) => String(stateLabel(stateCodeOf(v)) || '').replace(/^\d+ - /, '');

/** One line telling the person filling the bill how the tax is being split, and why. */
export function taxNote(mode, { from, to, docType, composition }) {
  switch (mode) {
    case 'intra': return t('Within {state}: CGST + SGST', { state: stateName(from) });
    case 'utgst': return t('Within {state}: CGST + UTGST', { state: stateName(from) });
    case 'inter': return t('{from} → {to}: IGST', { from: stateName(from) || '?', to: stateName(to) || '?' });
    case 'zero': return t('Zero-rated supply: no GST');
    case 'none': return composition ? t('Composition dealer: no GST charged') : t('No GST on a {doc}', { doc: docType || '' });
    default: return t('Choose the place of supply to split the tax');
  }
}

// ---- sales -------------------------------------------------------------------------------------------------
registerHooks('gst_invoice', {
  compute(d, ctx, table) {
    const business = ctx.business || {}, settings = ctx.settings || {};
    // who the bill is for: copied from the customer, so the name and address are never typed on the bill
    const partyField = table?.fields.find((f) => f.type === 'lookup');
    const party = partyField && d[partyField.id] ? ctx.getRecord?.(partyField.ref, d[partyField.id]) : null;
    d.bill_name = party ? String(party.data.name ?? '') : '';
    d.bill_address = party ? [party.data.address, party.data.city, party.data.pincode].filter((x) => !isBlank(x)).join(', ') : '';
    // a customer GSTIN typed on the bill decides the place of supply (once: it can still be changed by hand)
    const g = validateGstin(d.bill_gstin);
    if (g.ok && d._g_bill_gstin !== g.gstin) { d.bill_gstin = g.gstin; d.pos = stateLabel(g.stateCode); d._g_bill_gstin = g.gstin; }
    if (isBlank(d.pos)) d.pos = businessState(business);
    const out = computeInvoice(d, { business, settings });
    out.tax_total = r2(out.cgst + out.sgst + out.igst + out.cess);
    if (!out.total && !out.paid) out.status = '';                     // an empty bill is not "Paid"
    out.tax_note = taxNote(out.tax_mode, { from: businessState(business), to: out.pos, docType: d.doc_type, composition: business.composition });
    return out;
  },
  validate(d, ctx) {
    return validateInvoice(d, { business: ctx.business || {}, settings: ctx.settings || {} });
  },
  defaults(store) {
    return { doc_type: 'Tax Invoice', pos: businessState(store.business), price_incl: !!store.settings.gst?.price_incl };
  },
  number: {
    field: 'number',
    /** INV/26-27/0001: one series per document type and financial year. Counts saved documents, so a failed save leaves no gap. */
    next(store, table, data) {
      const cfg = docOf(data.doc_type);
      const fy = financialYear(data.date).label;
      const tag = store.settings.deviceTag || '';
      const prefix = store.settings.gst?.prefixes?.[cfg.key] || cfg.key;
      const head = `${prefix}${tag}/${fy}/`;
      let max = 0;
      for (const r of store.records(table.id)) {
        const n = String(r.data.number || '');
        if (n.startsWith(head) && /^\d+$/.test(n.slice(head.length))) max = Math.max(max, Number(n.slice(head.length)));
      }
      return formatInvoiceNumber({ prefix, fy, seq: max + 1, tag });
    },
  },
});

// ---- purchases: the supplier is the one charging the tax, so their state is "from" and ours is "to" ------------------
registerHooks('gst_purchase', {
  compute(d, ctx) {
    const business = ctx.business || {};
    const supplier = { gstin: d.supplier_gstin, state: d.supplier_state };
    const out = computeInvoice({ ...d, doc_type: 'Tax Invoice', pos: businessState(business) }, { business: supplier, settings: { gst: { round_off: false } } });
    delete out.status;
    out.tax_total = r2(out.cgst + out.sgst + out.igst + out.cess);
    out.tax_note = out.tax_mode === 'unknown'
      ? t('Unregistered supplier: no GST to claim')
      : taxNote(out.tax_mode, { from: stateCodeOf(d.supplier_gstin) || d.supplier_state, to: businessState(business) });
    return out;
  },
  validate(d) {
    const p = d.supplier_gstin ? gstinProblem(d.supplier_gstin) : '';
    return p ? { supplier_gstin: p } : {};
  },
});

// ---- parties ---------------------------------------------------------------------------------------------------
registerHooks('gst_party', {
  compute(d) {
    const g = validateGstin(d.gstin);
    if (g.ok) { d.gstin = g.gstin; d.state = stateLabel(g.stateCode); }
    return d;
  },
  validate(d) {
    const p = d.gstin ? gstinProblem(d.gstin) : '';
    return p ? { gstin: p } : {};
  },
});
