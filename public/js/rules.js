// Workflow / rules engine: "when X happens, if Y, then do Z".
//
// A rule looks like:
//   { id, name, enabled, table, trigger, field?, match, conditions:[{field,op,value,vt}],
//     dedupeDays?, actions:[{type, ...}] }
//
// triggers: created | updated | saved | field_changed | deleted | approved | rejected | before_save | schedule
// actions : message | set_field | create_record | approval | adjust_stock | webhook | block
//
// Messages are NOT rendered when a rule fires: the outbox keeps the template and renders it against the
// latest record when you look at it or tap Send. So a bill whose payment is recorded a minute later
// never goes out saying "Balance due".
import { matchConditions, renderTemplate } from './logic.js';
import { tryEvaluate, todayStr, daysBetween, toNum } from './formula.js';
import { makeScope, fieldOf, isBlank } from './schema.js';

export const TRIGGERS = ['created', 'updated', 'saved', 'any', 'field_changed', 'deleted', 'approved', 'rejected', 'before_save', 'schedule'];
export const ACTIONS = ['message', 'set_field', 'create_record', 'approval', 'adjust_stock', 'webhook', 'block'];
export const CHANNELS = ['whatsapp', 'sms', 'email', 'inapp'];
const MAX_DEPTH = 4;

function triggerMatches(rule, event, rec, prev) {
  const t = rule.trigger;
  if (t === 'schedule') return event === 'schedule';
  if (t === 'saved') return event === 'created' || event === 'updated';
  if (t === 'any') return event === 'created' || event === 'updated' || event === 'deleted';
  if (t === 'field_changed') {
    // fires when an existing record is edited and this field's value changed
    if (event !== 'updated') return false;
    const a = prev?.data?.[rule.field], b = rec.data?.[rule.field];
    return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  }
  return t === event;
}

/** Evaluate a value that is either literal text (with {{templates}}) or "=formula". */
function resolveValue(raw, table, rec, ctx) {
  if (typeof raw !== 'string') return raw;
  if (raw.startsWith('=')) return tryEvaluate(raw.slice(1), makeScope(table, rec.data, ctx), null);
  return renderTemplate(raw, { table, data: rec.data, ctx });
}

export async function runRules(store, event, table, rec, prev, depth = 0, onlyRule = null) {
  const result = { blocked: null, fired: [] };
  if (depth > MAX_DEPTH) return result;
  const ctx = store.ctx();
  for (const rule of store.app.rules || []) {
    if (rule.enabled === false || rule.table !== table.id || (onlyRule && rule.id !== onlyRule)) continue;
    if (!triggerMatches(rule, event, rec, prev)) continue;
    if (!matchConditions(rule, table, rec.data, ctx)) continue;
    if (event === 'schedule' || rule.dedupeDays > 0) {
      const key = `${rule.id}:${rec.id}`;
      const last = store.lastRun(key);
      const gap = event === 'schedule' ? Math.max(1, rule.dedupeDays || 1) : rule.dedupeDays;
      if (last && daysBetween(todayStr(), last) < gap) continue;
      store.markRun(key);
    }
    result.fired.push(rule.id);
    for (const action of rule.actions || []) {
      const out = await execAction(store, rule, action, event, table, rec, prev, depth);
      if (out?.blocked) result.blocked = out.blocked;
    }
    if (result.blocked) break;
  }
  return result;
}

async function execAction(store, rule, a, event, table, rec, prev, depth) {
  const ctx = store.ctx();
  switch (a.type) {
    case 'block':
      return event === 'before_save' ? { blocked: renderTemplate(a.text || rule.name, { table, data: rec.data, ctx }) } : null;

    case 'message': {
      if (event === 'before_save') return null;
      const channel = a.channel || 'inapp';
      store.queueOutbox({
        ruleId: rule.id, ruleName: rule.name, table: table.id, recordId: rec.id, channel,
        to: a.to || '', subject: a.subject || '', body: a.body || '',
        holdMinutes: a.hold || 0, key: a.key || rule.id,
      });
      return null;
    }

    case 'set_field': {
      if (event === 'before_save' || event === 'deleted' || !a.field) return null;
      const v = resolveValue(a.value, table, rec, ctx);
      if (JSON.stringify(v) === JSON.stringify(rec.data[a.field])) return null;
      await store.patchRecord(table.id, rec.id, { [a.field]: v }, { depth: depth + 1 });
      return null;
    }

    case 'create_record': {
      if (event === 'before_save' || !a.table) return null;
      const target = store.table(a.table);
      if (!target) return null;
      const data = {};
      for (const [fid, raw] of Object.entries(a.values || {})) {
        let v = resolveValue(raw, table, rec, ctx);
        const f = fieldOf(target, fid);
        if (f?.type === 'date' && typeof raw === 'string' && /^\+\d+$/.test(raw.trim())) {
          const d = new Date(); d.setDate(d.getDate() + Number(raw.trim().slice(1))); v = todayStr(d);
        }
        data[fid] = v;
      }
      await store.saveRecord(a.table, { ...store.blankData(a.table), ...data }, { depth: depth + 1 });
      return null;
    }

    case 'approval': {
      if (event === 'before_save' || event === 'deleted') return null;
      if (rec.approval?.ruleId === rule.id) return null;
      await store.setApproval(table.id, rec.id, {
        status: 'pending', ruleId: rule.id, ruleName: rule.name,
        note: renderTemplate(a.note || rule.name, { table, data: rec.data, ctx }), at: store.now(),
      });
      return null;
    }

    case 'adjust_stock': {
      if (event === 'before_save' || event === 'schedule') return null;
      const lines = fieldOf(table, a.linesField);
      const itemCol = lines?.columns?.find((c) => c.id === a.itemColumn);
      if (!lines || !itemCol) return null;
      const sum = (r) => {
        const m = new Map();
        for (const row of r?.data?.[a.linesField] || []) {
          if (isBlank(row[a.itemColumn])) continue;
          m.set(row[a.itemColumn], (m.get(row[a.itemColumn]) || 0) + toNum(row[a.qtyColumn]));
        }
        return m;
      };
      const before = event === 'created' ? new Map() : sum(prev || rec);
      const after = event === 'deleted' ? new Map() : sum(rec);
      // an update that only happened because of stock effects must not re-apply them
      const items = new Set([...before.keys(), ...after.keys()]);
      const sign = a.sign === 1 || a.sign === '+' ? 1 : -1;
      for (const itemId of items) {
        const delta = (after.get(itemId) || 0) - (before.get(itemId) || 0);
        if (!delta) continue;
        const item = store.getRecord(itemCol.ref, itemId);
        if (!item) continue;
        const cur = toNum(item.data[a.targetField]);
        await store.patchRecord(itemCol.ref, itemId, { [a.targetField]: Math.round((cur + sign * delta) * 1000) / 1000 }, { depth: depth + 1 });
      }
      return null;
    }

    case 'webhook': {
      if (event === 'before_save' || !a.url) return null;
      store.queueOutbox({
        ruleId: rule.id, ruleName: rule.name, table: table.id, recordId: rec.id, channel: 'webhook', url: a.url,
        to: '', subject: '', body: '',
      });
      return null;
    }
    default: return null;
  }
}

/** Run every scheduled rule against every matching record. Called when the app opens / becomes visible. */
export async function runScheduled(store) {
  let fired = 0;
  for (const rule of (store.app.rules || []).filter((r) => r.trigger === 'schedule' && r.enabled !== false)) {
    const table = store.table(rule.table);
    if (!table) continue;
    for (const rec of store.records(rule.table)) {
      const r = await runRules(store, 'schedule', table, rec, null, 0, rule.id);
      fired += r.fired.length;
    }
  }
  return fired;
}
