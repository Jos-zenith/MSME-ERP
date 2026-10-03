// If–then conditions and message templates, shared by workflows, dashboards and messages.
import { tryEvaluate, evaluate, isTruthy, compare, looseEquals, toNum, todayStr, daysBetween } from './formula.js';
import { makeScope, formatValue, isBlank, fmtNumber } from './schema.js';

export const OPS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'empty', 'notempty', 'past', 'today', 'next_days', 'older_days'];
export const OPS_LABEL = {
  '=': 'is', '!=': 'is not', '>': 'is more than', '>=': 'is at least', '<': 'is less than', '<=': 'is at most',
  contains: 'contains', empty: 'is empty', notempty: 'is not empty',
  past: 'is in the past', today: 'is today', next_days: 'is within the next … days', older_days: 'is more than … days ago',
};
export const NO_VALUE_OPS = ['empty', 'notempty', 'past', 'today'];

export function opsForType(type) {
  switch (type) {
    case 'number': case 'money': return ['=', '!=', '>', '>=', '<', '<=', 'empty', 'notempty'];
    case 'date': return ['past', 'today', 'next_days', 'older_days', '=', '>', '<', 'empty', 'notempty'];
    case 'select': case 'lookup': return ['=', '!=', 'empty', 'notempty'];
    case 'checkbox': return ['='];
    case 'lines': return ['empty', 'notempty'];
    default: return ['=', '!=', 'contains', 'empty', 'notempty'];
  }
}

function typed(def, raw) {
  if (def?.type === 'number' || def?.type === 'money') return raw === '' || raw === null ? raw : Number(raw);
  if (def?.type === 'checkbox') return raw === true || raw === 'true' || raw === 'yes';
  return raw;
}

function testOne(op, l, r) {
  switch (op) {
    case '=': return looseEquals(l, r);
    case '!=': return !looseEquals(l, r);
    case '>': return !isBlank(l) && compare(l, r) > 0;
    case '>=': return !isBlank(l) && compare(l, r) >= 0;
    case '<': return !isBlank(l) && compare(l, r) < 0;
    case '<=': return !isBlank(l) && compare(l, r) <= 0;
    case 'contains': return String(l ?? '').toLowerCase().includes(String(r ?? '').toLowerCase());
    case 'past': return !isBlank(l) && String(l) < todayStr();
    case 'today': return String(l) === todayStr();
    case 'next_days': { const n = daysBetween(l, todayStr()); return n !== null && n >= 0 && n <= toNum(r); }
    case 'older_days': { const n = daysBetween(todayStr(), l); return n !== null && n > toNum(r); }
    default: return false;
  }
}

export function testCondition(cond, table, data, ctx) {
  if (!cond.field) return true;
  const scope = makeScope(table, data, ctx);
  const { value: left, def } = scope.withDef(cond.field.split('.'));
  if (cond.op === 'empty') return isBlank(left);
  if (cond.op === 'notempty') return !isBlank(left);
  let right = cond.value;
  if (cond.vt === 'field' && cond.value) right = scope(String(cond.value).split('.'));
  else right = typed(def, right);
  // a condition on a list (e.g. any line item's discount) passes if ANY element passes
  if (Array.isArray(left)) return left.some((x) => testOne(cond.op, x, right));
  return testOne(cond.op, left, right);
}

/** `spec` = { match: 'all'|'any', conditions: [...] }. No conditions = always true. */
export function matchConditions(spec, table, data, ctx) {
  const conds = (spec?.conditions || []).filter((c) => c.field);
  if (!conds.length) return true;
  const results = conds.map((c) => testCondition(c, table, data, ctx));
  return spec.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

// ---- templates ----------------------------------------------------------------------
//  Hello {{customer.name}}, your bill {{number}} is {{total}}.
//  {{#if balance > 0}}Balance due: {{balance}}{{else}}Paid, thank you!{{/if}}
//  {{#each items}}{{@n}}. {{desc}} x {{qty}}  {{amount}}
//  {{/each}}
const TAG = /\{\{\s*([^{}]*?)\s*\}\}/g;

function parseTemplate(src) {
  const root = [];
  const stack = [{ nodes: root }];
  let last = 0, m;
  const top = () => stack[stack.length - 1];
  const pushText = (s) => { if (s) top().nodes.push({ k: 'text', v: s }); };
  TAG.lastIndex = 0;
  while ((m = TAG.exec(src))) {
    pushText(src.slice(last, m.index));
    last = m.index + m[0].length;
    const body = m[1];
    if (body.startsWith('#if ')) {
      const node = { k: 'if', expr: body.slice(4), then: [], else: [] };
      top().nodes.push(node);
      stack.push({ nodes: node.then, node });
    } else if (body.startsWith('#each ')) {
      const node = { k: 'each', path: body.slice(6).trim(), body: [] };
      top().nodes.push(node);
      stack.push({ nodes: node.body, node });
    } else if (body === 'else') {
      const t = top();
      if (t.node?.k === 'if') t.nodes = stack[stack.length - 1].nodes = t.node.else;
    } else if (body === '/if' || body === '/each') {
      if (stack.length > 1) stack.pop();
    } else top().nodes.push({ k: 'var', v: body });
  }
  pushText(src.slice(last));
  return root;
}

export function renderTemplate(tpl, { table, data, ctx }) {
  if (!tpl) return '';
  const out = [];
  const walkNodes = (nodes, scope, n) => {
    for (const nd of nodes) {
      if (nd.k === 'text') out.push(nd.v);
      else if (nd.k === 'var') out.push(renderVar(nd.v, scope, n));
      else if (nd.k === 'if') {
        let ok = false;
        try { ok = isTruthy(evaluate(nd.expr, scope)); } catch { ok = false; }
        walkNodes(ok ? nd.then : nd.else, scope, n);
      } else if (nd.k === 'each') {
        const def = table?.fields.find((f) => f.id === nd.path);
        const rows = Array.isArray(data[nd.path]) ? data[nd.path] : [];
        rows.forEach((row, i) => {
          const rs = makeScope(table, data, ctx, row, def?.columns || []);
          walkNodes(nd.body, rs, i + 1);
        });
      }
    }
  };
  const renderVar = (v, scope, n) => {
    if (v === '@n') return String(n ?? '');
    if (/^[\p{L}\p{N}_.]+$/u.test(v)) {
      const { value, def } = scope.withDef(v.split('.'));
      if (value === null || value === undefined || typeof value === 'object') return '';
      return def ? formatValue(def, value, ctx) : String(value);
    }
    const r = tryEvaluate(v, scope, '');
    return typeof r === 'number' ? fmtNumber(r) : String(r ?? '');
  };
  walkNodes(parseTemplate(String(tpl)), makeScope(table, data, ctx), 1);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** Variables used by a template (for editor hints / validation). */
export function templateRefs(tpl) {
  const refs = new Set();
  TAG.lastIndex = 0;
  let m;
  while ((m = TAG.exec(String(tpl || '')))) {
    const b = m[1];
    if (/^[\p{L}\p{N}_.]+$/u.test(b) && b !== '@n') refs.add(b.split('.')[0]);
  }
  return [...refs];
}
