// A small, safe expression language for calculated fields, conditions and templates.
// No eval / Function: expressions are tokenised, parsed to an AST and interpreted.
//
//   qty * rate * (1 - disc / 100)
//   IF(balance > 0, "Due", "Paid")
//   SUM(items.amount)          <- dotted path over a lines field returns a list
//   customer.city = "Pune" and total >= 5000

export class FormulaError extends Error {}

const KEYWORDS = { and: '&&', or: '||', not: '!', true: true, false: false, null: null };

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (src[j] !== c) throw new FormulaError('Text is missing its closing quote');
      out.push({ t: 'str', v: s });
      i = j + 1; continue;
    }
    // identifiers may include dots (path) and unicode letters so Hindi/Tamil ids also work
    if (/[\p{L}_]/u.test(c)) {
      let j = i;
      while (j < src.length && /[\p{L}\p{N}_.]/u.test(src[j])) j++;
      const word = src.slice(i, j);
      const lower = word.toLowerCase();
      if (lower in KEYWORDS && !word.includes('.')) {
        const k = KEYWORDS[lower];
        out.push(typeof k === 'string' ? { t: 'op', v: k } : { t: 'lit', v: k });
      } else out.push({ t: 'id', v: word });
      i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<>', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%()<>=,!'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new FormulaError(`Unexpected character "${c}"`);
  }
  return out;
}

// precedence climbing
const BINARY = {
  '||': 1, '&&': 2,
  '==': 3, '=': 3, '!=': 3, '<>': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
};

function parseTokens(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;

  function primary() {
    const tk = next();
    if (!tk) throw new FormulaError('The formula ends too early');
    if (tk.t === 'num' || tk.t === 'str' || tk.t === 'lit') return { k: 'lit', v: tk.v };
    if (tk.t === 'id') {
      if (isOp('(')) {
        next();
        const args = [];
        if (!isOp(')')) {
          do { args.push(expr(0)); } while (isOp(',') && next());
        }
        if (!isOp(')')) throw new FormulaError(`Missing ")" after ${tk.v}(`);
        next();
        return { k: 'call', name: tk.v.toUpperCase(), args };
      }
      return { k: 'ref', parts: tk.v.split('.') };
    }
    if (tk.t === 'op') {
      if (tk.v === '(') {
        const e = expr(0);
        if (!isOp(')')) throw new FormulaError('Missing ")"');
        next();
        return e;
      }
      if (tk.v === '-') return { k: 'neg', a: primary() };
      if (tk.v === '!') return { k: 'not', a: expr(3) };
    }
    throw new FormulaError(`Unexpected "${tk.v}"`);
  }

  function expr(minPrec) {
    let left = primary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== 'op' || !(tk.v in BINARY)) break;
      const prec = BINARY[tk.v];
      if (prec < minPrec) break;
      next();
      const right = expr(prec + 1);
      left = { k: 'bin', op: tk.v, a: left, b: right };
    }
    return left;
  }

  const ast = expr(0);
  if (p < tokens.length) throw new FormulaError(`Unexpected "${tokens[p].v}"`);
  return ast;
}

const cache = new Map();
export function parse(src) {
  const key = String(src);
  let ast = cache.get(key);
  if (!ast) {
    if (!key.trim()) throw new FormulaError('The formula is empty');
    ast = parseTokens(tokenize(key));
    if (cache.size > 500) cache.clear();
    cache.set(key, ast);
  }
  return ast;
}

// ---- value helpers -------------------------------------------------------
const isBlank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
export const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.reduce((a, b) => a + toNum(b), 0);
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};
const isNumeric = (v) => typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined || v === '' ||
  (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, ''))));
const truthy = (v) => (Array.isArray(v) ? v.length > 0 : !!v && v !== '0' && v !== 'false');
const flat = (args) => args.flatMap((a) => (Array.isArray(a) ? a : [a]));
const nums = (args) => flat(args).filter((v) => !isBlank(v)).map(toNum);
const str = (v) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));

const dayMs = 86400000;
export function toDate(v) {
  if (v instanceof Date) return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
export const dateStr = (d) => d.toISOString().slice(0, 10);
export function todayStr(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
export function addDays(v, n) {
  const d = toDate(v);
  return d ? dateStr(new Date(d.getTime() + toNum(n) * dayMs)) : null;
}
export function daysBetween(a, b) {
  const da = toDate(a), db = toDate(b);
  return da && db ? Math.round((da - db) / dayMs) : null;
}
export const round = (n, d = 0) => {
  const f = 10 ** d;
  return (n < 0 ? -1 : 1) * Math.round((Math.abs(n) + Number.EPSILON) * f) / f;
};

export function looseEquals(a, b) {
  if (isBlank(a) && isBlank(b)) return true;
  if (isNumeric(a) && isNumeric(b) && !(isBlank(a) || isBlank(b))) return toNum(a) === toNum(b);
  return str(a).toLowerCase() === str(b).toLowerCase();
}
export function compare(a, b) {
  if (isNumeric(a) && isNumeric(b)) return toNum(a) - toNum(b);
  const x = str(a).toLowerCase(), y = str(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

export const FUNCTIONS = {
  SUM: (...a) => nums(a).reduce((x, y) => x + y, 0),
  AVG: (...a) => { const n = nums(a); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : 0; },
  MIN: (...a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
  MAX: (...a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
  COUNT: (...a) => flat(a).filter((v) => !isBlank(v)).length,
  ROUND: (n, d = 0) => round(toNum(n), toNum(d)),
  ABS: (n) => Math.abs(toNum(n)),
  FLOOR: (n) => Math.floor(toNum(n)),
  CEIL: (n) => Math.ceil(toNum(n)),
  CONCAT: (...a) => flat(a).map(str).join(''),
  UPPER: (s) => str(s).toUpperCase(),
  LOWER: (s) => str(s).toLowerCase(),
  LEN: (s) => str(s).length,
  CONTAINS: (s, sub) => str(s).toLowerCase().includes(str(sub).toLowerCase()),
  EMPTY: (v) => isBlank(v),
  IFEMPTY: (v, alt) => (isBlank(v) ? alt : v),
  TODAY: () => todayStr(),
  ADDDAYS: (d, n) => addDays(d, n),
  DAYS: (a, b) => daysBetween(a, b),
  MONTH: (d) => (toDate(d) ? toDate(d).getUTCMonth() + 1 : null),
  YEAR: (d) => (toDate(d) ? toDate(d).getUTCFullYear() : null),
};
// lazily evaluated: only the chosen branch runs
const LAZY = { IF: true };

function run(node, scope) {
  switch (node.k) {
    case 'lit': return node.v;
    case 'ref': return scope(node.parts);
    case 'neg': return -toNum(run(node.a, scope));
    case 'not': return !truthy(run(node.a, scope));
    case 'call': {
      if (LAZY[node.name]) {
        if (node.name === 'IF') {
          const [c, a, b] = node.args;
          if (!c) throw new FormulaError('IF needs a condition');
          return truthy(run(c, scope)) ? (a ? run(a, scope) : null) : (b ? run(b, scope) : null);
        }
      }
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new FormulaError(`Unknown function ${node.name}`);
      return fn(...node.args.map((x) => run(x, scope)));
    }
    case 'bin': {
      const { op } = node;
      if (op === '&&') return truthy(run(node.a, scope)) && truthy(run(node.b, scope));
      if (op === '||') return truthy(run(node.a, scope)) || truthy(run(node.b, scope));
      const a = run(node.a, scope), b = run(node.b, scope);
      switch (op) {
        case '+':
          return isNumeric(a) && isNumeric(b) ? toNum(a) + toNum(b) : str(a) + str(b);
        case '-': return toNum(a) - toNum(b);
        case '*': return toNum(a) * toNum(b);
        case '/': return toNum(b) === 0 ? 0 : toNum(a) / toNum(b);
        case '%': return toNum(b) === 0 ? 0 : toNum(a) % toNum(b);
        case '=': case '==': return looseEquals(a, b);
        case '!=': case '<>': return !looseEquals(a, b);
        case '<': return compare(a, b) < 0;
        case '<=': return compare(a, b) <= 0;
        case '>': return compare(a, b) > 0;
        case '>=': return compare(a, b) >= 0;
      }
    }
  }
  throw new FormulaError('Cannot evaluate');
}

/** Evaluate `src`; `scope(parts)` resolves references. Throws FormulaError on bad input. */
export function evaluate(src, scope) {
  return run(parse(src), scope);
}
/** Same, but never throws: returns `fallback` on any error. */
export function tryEvaluate(src, scope, fallback = null) {
  try { return evaluate(src, scope); } catch { return fallback; }
}
export function isTruthy(v) { return truthy(v); }

/** Static check: returns null if OK, or a human-readable problem. `known(head)` says if a name exists. */
export function check(src, known) {
  let ast;
  try { ast = parse(src); } catch (e) { return e.message; }
  let problem = null;
  (function walk(n) {
    if (problem || !n) return;
    if (n.k === 'ref' && known && !known(n.parts[0])) problem = `Unknown field "${n.parts[0]}"`;
    if (n.k === 'call') {
      if (!FUNCTIONS[n.name] && !LAZY[n.name]) problem = `Unknown function ${n.name}`;
      n.args.forEach(walk);
    }
    if (n.k === 'bin') { walk(n.a); walk(n.b); }
    if (n.k === 'neg' || n.k === 'not') walk(n.a);
  })(ast);
  return problem;
}
