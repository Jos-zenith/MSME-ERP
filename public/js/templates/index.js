import { retail, retailSample } from './retail.js';
import { service, serviceSample } from './service.js';
import { gstShop, gstShopSample } from './gst.js';
import { makeApp, baseSettings, tasksTable } from './common.js';

function blank(t, o = {}) {
  const settings = baseSettings(t, o);
  return makeApp({ name: o.businessName || t('My business'), template: 'blank', settings, tables: [tasksTable(t, settings.team)], rules: [], dashboards: [] });
}

export const TEMPLATES = [
  { id: 'retail', icon: '🛒', title: 'Shop: billing + stock', desc: 'Invoices with UPI QR, stock that updates itself, customers, low-stock and payment reminders.', build: retail, sample: retailSample },
  { id: 'gst', icon: '🧮', title: 'Shop with GST invoices', desc: 'Everything in the shop app, plus CGST/SGST/IGST worked out for you, HSN codes, credit notes, purchases with input credit and GSTR-1 / 3B ready to file.', build: gstShop, sample: gstShopSample, needsGstin: true },
  { id: 'service', icon: '🛠️', title: 'Service jobs', desc: 'Repair shop, salon or workshop: track jobs, notify customers when ready, owner approvals.', build: service, sample: serviceSample },
  { id: 'blank', icon: '✨', title: 'Start empty', desc: 'Build your own tables, forms and workflows from scratch.', build: blank, sample: null },
];

export function buildTemplate(id, t, opts) {
  return (TEMPLATES.find((x) => x.id === id) || TEMPLATES.find((x) => x.id === 'blank')).build(t, opts);
}
