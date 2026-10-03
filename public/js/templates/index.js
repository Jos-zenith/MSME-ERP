import { retail, retailSample } from './retail.js';
import { service, serviceSample } from './service.js';
import { makeApp, baseSettings, tasksTable } from './common.js';

function blank(t, o = {}) {
  const settings = baseSettings(t, o);
  return makeApp({ name: o.businessName || t('My business'), template: 'blank', settings, tables: [tasksTable(t, settings.team)], rules: [], dashboards: [] });
}

export const TEMPLATES = [
  { id: 'retail', icon: '🛒', title: 'Shop: billing + stock', desc: 'Invoices with UPI QR, stock that updates itself, customers, low-stock and payment reminders.', build: retail, sample: retailSample },
  { id: 'service', icon: '🛠️', title: 'Service jobs', desc: 'Repair shop, salon or workshop: track jobs, notify customers when ready, owner approvals.', build: service, sample: serviceSample },
  { id: 'blank', icon: '✨', title: 'Start empty', desc: 'Build your own tables, forms and workflows from scratch.', build: blank, sample: null },
];

export function buildTemplate(id, t, opts) {
  return (TEMPLATES.find((x) => x.id === id) || TEMPLATES[2]).build(t, opts);
}
