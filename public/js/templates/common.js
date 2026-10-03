// Shared helpers for sector templates. Templates are plain data, built with the chosen language's `t()`
// so a Hindi-speaking owner gets Hindi field names from the very first screen.
export const F = (id, label, type = 'text', extra = {}) => ({ id, label, type, ...extra });

export function baseSettings(t, o = {}) {
  return {
    lang: o.lang || 'en',
    business: { name: o.businessName || '', phone: o.phone || '', address: '', gstin: '', upi: o.upi || '', email: '' },
    currency: { symbol: '₹', locale: 'en-IN', code: 'INR' },
    countryCode: '91',
    team: [t('Owner'), t('Staff 1')],
    deviceTag: '',
  };
}

export function tasksTable(t, team) {
  return {
    id: 'tasks', name: t('Tasks'), icon: '✅', titleField: 'title', labelFields: ['title'], searchFields: ['title'],
    listColumns: ['title', 'due', 'assignee', 'done'],
    fields: [
      F('title', t('Task'), 'text', { required: true }),
      F('due', t('Due date'), 'date', { width: 'half' }),
      F('assignee', t('Assigned to'), 'select', { options: team, width: 'half', default: team[0] }),
      F('done', t('Done'), 'checkbox', { width: 'half' }),
      F('notes', t('Notes'), 'longtext'),
    ],
  };
}

export const STATUS_COLORS = (good = [], warn = [], bad = [], info = []) => {
  const m = {};
  good.forEach((v) => (m[v] = 'good')); warn.forEach((v) => (m[v] = 'warn')); bad.forEach((v) => (m[v] = 'bad')); info.forEach((v) => (m[v] = 'info'));
  return m;
};

export function makeApp({ name, template, settings, tables, rules, dashboards }) {
  return { v: 1, name, template, settings, tables, rules, dashboards, updated: new Date().toISOString() };
}

export const cond = (field, op, value, vt = 'value') => ({ field, op, value, vt });
