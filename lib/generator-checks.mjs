// Generator / requirements checks for mock flow steps (config/flows/**.yaml).
// Analysis only: decodes the base64 generate / requirements / validate code, parses it with Babel and
// traces where every value comes from. Never executes the analysed code and never writes to the spec.
//
//   analyseFlows([{ file, text }], { flowIndex }) → { steps, dynamic, requirements, quality, suggestions, summary }
import { parse as babelParse } from '@babel/parser';
import YAML from 'yaml';
import { analyseFunction, sentenceL2, showPath, setSaved } from './l2-analyse.mjs';

// ───────────────────────────── constants ─────────────────────────────
const ARRAY_CB = new Set(['map', 'find', 'filter', 'forEach', 'some', 'every', 'flatMap', 'findIndex', 'findLast', 'reduce', 'sort']);
const PASS_METHODS = new Set(['toString', 'trim', 'toUpperCase', 'toLowerCase', 'valueOf', 'padStart', 'padEnd', 'replace', 'replaceAll']);
const SAME_ARRAY = new Set(['filter', 'slice', 'sort', 'concat', 'reverse', 'flat']);
const METHOD_NAMES = new Set([...ARRAY_CB, ...PASS_METHODS, ...SAME_ARRAY, 'includes', 'indexOf', 'join', 'push', 'pop', 'shift', 'unshift', 'splice', 'at', 'keys', 'values', 'entries', 'split', 'startsWith', 'endsWith', 'toISOString', 'length']);
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill']);
const CLONE_FNS = /^(structuredClone|cloneDeep|deepClone|clone|deepCopy|_\.cloneDeep)$/;
const GEN_FNS = /uuid|guid|random|timestamp|now$|^generate\w*id$|^new\w*id$|^create\w*id$|^make\w*id$|isoDate|currentTime|getTime$|nanoid|shortid/i;
// keys the runtime puts into sessionData by itself (not through a step's saveData)
export const RUNTIME_KEYS = new Set(['user_inputs', 'mockBaseUrl', 'sessionId', 'subscriberUrl', 'subscriberId', 'domain', 'version', 'flowId', 'usecaseId', 'env', 'npType', 'stats', 'apiList', 'transactionId', 'latestMessage_id', 'latestTimestamp', 'bapId', 'bapUri', 'bppId', 'bppUri', 'city_code', 'country_code']);
const CONTEXT_KEYS = new Set(['transactionId', 'latestMessage_id', 'latestTimestamp', 'bapId', 'bapUri', 'bppId', 'bppUri', 'city_code', 'country_code', 'mockBaseUrl', 'sessionId', 'subscriberUrl', 'subscriberId']);
export const isIdField = (k) => /^(id|ids|[a-z0-9_]+_ids?)$/i.test(String(k));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export const decode = (s) => (typeof s === 'string' && s.trim() ? Buffer.from(s, 'base64').toString('utf8') : '');

export function parseCode(code) {
  try { return { ast: babelParse(code, { sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, errorRecovery: false, ranges: false }) }; }
  catch (e) { return { error: e.message.replace(/\s+/g, ' ') }; }
}
const isFn = (n) => n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod)$/.test(n.type);
const keyName = (k) => (k.type === 'Identifier' ? k.name : k.type === 'StringLiteral' ? k.value : k.type === 'NumericLiteral' ? k.value : null);
function walk(n, cb, parent, opts = {}) {   // generic AST walk; opts.intoFns=false stops at nested functions
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const x of n) walk(x, cb, parent, opts); return; }
  if (!n.type) return;
  if (cb(n, parent) === false) return;
  if (opts.intoFns === false && isFn(n) && n !== opts.root) return;
  for (const k in n) { if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue; const v = n[k]; if (v && typeof v === 'object') walk(v, cb, n, opts); }
}

// top-level functions of a program: name → node (function declarations and const x = () => …)
export function topFunctions(ast) {
  const fns = {};
  for (const s of ast.program.body) {
    if (s.type === 'FunctionDeclaration' && s.id) fns[s.id.name] = s;
    if (s.type === 'VariableDeclaration') for (const d of s.declarations) if (d.id.type === 'Identifier' && isFn(d.init)) fns[d.id.name] = d.init;
  }
  return fns;
}

function usesRandom(node) { let r = false; walk(node, (n) => { if (/Call/.test(n.type) && /Member/.test(n.callee.type) && n.callee.object.name === 'Math' && n.callee.property.name === 'random') r = true; }); return r; }

// ───────────────────────────── values ─────────────────────────────
// { kind: session|payload|literal|generated|object|array|fallback|choice|template|unknown, … }
const U = (src) => ({ kind: 'unknown', src });
const RANK = { session: 6, payload: 5, generated: 4, template: 3, object: 3, array: 3, fallback: 3, choice: 3, literal: 2, unknown: 1 };
const isRoot = (v) => v && (v.kind === 'session' || v.kind === 'payload');

function extend(v, key) {
  if (!v) return U();
  switch (v.kind) {
    case 'session': case 'payload': return { kind: v.kind, path: [...v.path, key], cloned: v.cloned };
    case 'object': {
      if (key in v.props) return v.props[key];
      const s = v.spreads.find(isRoot); return s ? extend(s, key) : U();
    }
    case 'array': return typeof key === 'number' || key === '[*]' ? (v.items[typeof key === 'number' ? key : 0] || v.items[0] || U()) : U();
    case 'fallback': { const p = extend(v.primary, key); return v.fallback?.kind === 'object' || v.fallback?.kind === 'array' ? p : { kind: 'fallback', primary: p, fallback: extend(v.fallback, key) }; }
    case 'choice': return { kind: 'choice', options: v.options.map((o) => extend(o, key)) };
    case 'generated': return v;
    default: return U();
  }
}
const elemOf = (v) => extend(v, '[*]');

// ───────────────────────────── context (one analysed function) ─────────────────────────────
// roots: { paramName: value }. Bindings are collected flat over the whole function (callbacks included).
class Ctx {
  constructor(fn, roots, prog, depth = 0, code = '') {
    this.fn = fn; this.roots = roots; this.prog = prog; this.depth = depth; this.code = code;
    this.vars = {}; this.memo = new Map();
    this.collect();
  }
  bind(name, b) { (this.vars[name] ||= []).push(b); }
  bindPattern(p, b) {
    if (!p) return;
    if (p.type === 'Identifier') return this.bind(p.name, b);
    if (p.type === 'AssignmentPattern') return this.bindPattern(p.left, { t: 'dflt', b, d: p.right });
    if (p.type === 'ObjectPattern') for (const q of p.properties) {
      if (q.type === 'RestElement') this.bindPattern(q.argument, b);
      else if (!q.computed) this.bindPattern(q.value, { t: 'member', of: b, key: keyName(q.key) });
    }
    if (p.type === 'ArrayPattern') p.elements.forEach((e, i) => e && this.bindPattern(e.type === 'RestElement' ? e.argument : e, { t: 'member', of: b, key: i }));
  }
  collect() {
    for (const [i, p] of (this.fn.params || []).entries()) if (p.type !== 'Identifier') this.bindPattern(p, { t: 'param', i });
    walk(this.fn.body, (n) => {
      if (n.type === 'VariableDeclarator' && n.init) this.bindPattern(n.id, { t: 'node', n: n.init });
      if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier') this.bind(n.left.name, { t: 'node', n: n.right });
      if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && n.left.type === 'VariableDeclaration') this.bindPattern(n.left.declarations[0].id, n.type === 'ForOfStatement' ? { t: 'elem', of: { t: 'node', n: n.right } } : { t: 'unknown' });
      if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && /Member/.test(n.callee.type) && ARRAY_CB.has(keyName(n.callee.property) || '') && isFn(n.arguments[0])) {
        const m = keyName(n.callee.property); const cb = n.arguments[0];
        this.bindPattern(cb.params[m === 'reduce' ? 1 : 0], { t: 'elem', of: { t: 'node', n: n.callee.object } });
        if (m === 'sort') this.bindPattern(cb.params[1], { t: 'elem', of: { t: 'node', n: n.callee.object } });
      }
    });
  }
  resolveBinding(b, seen) {
    switch (b.t) {
      case 'node': return this.resolve(b.n, seen);
      case 'member': return extend(this.resolveBinding(b.of, seen), b.key);
      case 'elem': return elemOf(this.resolveBinding(b.of, seen));
      case 'dflt': { const v = this.resolveBinding(b.b, seen); const d = this.resolve(b.d, seen); return d.kind === 'literal' ? { kind: 'fallback', primary: v, fallback: d } : v; }
      default: return U();
    }
  }
  resolveName(name, seen = new Set()) {
    if (name in this.roots) return this.roots[name];
    const bs = this.vars[name];
    if (!bs || seen.has(name)) return U(name);
    const s2 = new Set(seen).add(name);
    const vals = bs.map((b) => this.resolveBinding(b, s2));
    let best = vals[0];
    for (const v of vals) if ((RANK[v.kind] || 0) > (RANK[best.kind] || 0) || (best.kind === 'literal' && best.value == null && v.kind !== 'unknown')) best = v;
    return best;
  }
  callback(fnNode) {   // the expression a callback returns
    if (!isFn(fnNode)) return null;
    if (fnNode.body.type !== 'BlockStatement') return fnNode.body;
    let r = null; walk(fnNode.body, (n) => { if (r) return false; if (isFn(n)) return false; if (n.type === 'ReturnStatement' && n.argument) { r = n.argument; return false; } });
    return r;
  }
  sub(fnNode, args, seen) {   // analyse a called top-level function with its parameters bound to the call arguments
    if (this.depth > 4) return null;
    const roots = {};
    fnNode.params.forEach((p, i) => { if (p.type === 'Identifier' && args[i]) roots[p.name] = this.resolve(args[i], seen); });
    return new Ctx(fnNode, roots, this.prog, this.depth + 1, this.code);
  }
  returnValue(seen) {
    const vals = [];
    walk(this.fn.body, (n) => { if (isFn(n)) return false; if (n.type === 'ReturnStatement' && n.argument) vals.push(this.resolve(n.argument, seen)); });
    if (this.fn.body.type !== 'BlockStatement') vals.push(this.resolve(this.fn.body, seen));
    return vals.sort((a, b) => (RANK[b.kind] || 0) - (RANK[a.kind] || 0))[0] || U();
  }
  resolve(n, seen = new Set()) {
    if (!n) return U();
    if (this.memo.has(n) && !seen.size) return this.memo.get(n);
    const v = this._resolve(n, seen);
    if (!seen.size) this.memo.set(n, v);
    return v;
  }
  _resolve(n, seen) {
    switch (n.type) {
      case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return { kind: 'literal', value: n.value };
      case 'NullLiteral': return { kind: 'literal', value: null };
      case 'TemplateLiteral': return n.expressions.length ? { kind: 'template', parts: n.expressions.map((e) => this.resolve(e, seen)), quasis: n.quasis.map((q) => q.value.cooked) } : { kind: 'literal', value: n.quasis[0].value.cooked };
      case 'Identifier': return n.name === 'undefined' ? { kind: 'literal', value: undefined } : this.resolveName(n.name, seen);
      case 'ParenthesizedExpression': case 'AwaitExpression': case 'TSAsExpression': case 'TSNonNullExpression': return this.resolve(n.expression || n.argument, seen);
      case 'AssignmentExpression': return this.resolve(n.right, seen);
      case 'SequenceExpression': return this.resolve(n.expressions.at(-1), seen);
      case 'MemberExpression': case 'OptionalMemberExpression': {
        let k = n.computed ? (n.property.type === 'NumericLiteral' ? n.property.value : n.property.type === 'StringLiteral' ? n.property.value : '[*]') : n.property.name;
        if (k === '[*]') { const pv = this.resolve(n.property, seen); if (pv.kind === 'literal' && (typeof pv.value === 'string' || typeof pv.value === 'number')) k = pv.value; }
        return extend(this.resolve(n.object, seen), k);
      }
      case 'LogicalExpression': {
        const l = this.resolve(n.left, seen), r = this.resolve(n.right, seen);
        return n.operator === '&&' ? r : { kind: 'fallback', primary: l, fallback: r };
      }
      case 'ConditionalExpression': return { kind: 'choice', options: [this.resolve(n.consequent, seen), this.resolve(n.alternate, seen)] };
      case 'BinaryExpression': {
        const l = this.resolve(n.left, seen), r = this.resolve(n.right, seen);
        if (n.operator === '+') return { kind: 'template', parts: [l, r] };
        return l.kind === 'generated' ? l : r.kind === 'generated' ? r : U();
      }
      case 'ObjectExpression': {
        const props = {}; const spreads = [];
        for (const p of n.properties) {
          if (p.type === 'SpreadElement') spreads.push(this.resolve(p.argument, seen));
          else if (p.type === 'ObjectProperty' && !p.computed) props[keyName(p.key)] = this.resolve(p.value, seen);
        }
        return { kind: 'object', props, spreads };
      }
      case 'ArrayExpression': return { kind: 'array', items: n.elements.map((e) => (e?.type === 'SpreadElement' ? elemOf(this.resolve(e.argument, seen)) : this.resolve(e, seen))) };
      case 'NewExpression': {
        const c = n.callee.name;
        if (c === 'Date') return { kind: 'generated', how: 'timestamp' };
        if (c === 'Set' || c === 'Array') return n.arguments[0] ? this.resolve(n.arguments[0], seen) : U();
        return U();
      }
      case 'CallExpression': case 'OptionalCallExpression': return this.resolveCall(n, seen);
      default: return U(n.type);
    }
  }
  resolveCall(n, seen) {
    const c = n.callee; const a0 = n.arguments[0];
    if (c.type === 'Identifier') {
      if (/^(String|Number|parseInt|parseFloat|Boolean|encodeURIComponent)$/.test(c.name)) return this.resolve(a0, seen);
      if (CLONE_FNS.test(c.name)) return { ...this.resolve(a0, seen), cloned: true };
      if (GEN_FNS.test(c.name)) return { kind: 'generated', how: c.name + '()' };   // uuidv4(), currentTimestamp(), generate6DigitId() …
      if (this.prog.fns[c.name] && this.prog.fns[c.name] !== this.fn) { const s = this.sub(this.prog.fns[c.name], n.arguments, seen); if (s) return s.returnValue(); }
      return U(c.name + '()');
    }
    if (/Member/.test(c.type)) {
      const obj = c.object; const m = keyName(c.property) || '';
      const on = obj.type === 'Identifier' ? obj.name : '';
      if (on === 'JSON' && m === 'parse') { const inner = a0 && /Call/.test(a0.type) && a0.callee.object?.name === 'JSON' ? a0.arguments[0] : a0; return { ...this.resolve(inner, seen), cloned: true }; }
      if (on === 'JSON' && m === 'stringify') return this.resolve(a0, seen);
      if (on === 'Object' && m === 'assign') return { ...this.resolve(n.arguments.at(-1), seen), cloned: true };
      if (on === 'Math' && m === 'random') return { kind: 'generated', how: 'Math.random' };
      if (on === 'Date' && m === 'now') return { kind: 'generated', how: 'Date.now' };
      if ((on === 'crypto' || on === 'uuid') || GEN_FNS.test(m)) return { kind: 'generated', how: `${on || '…'}.${m}` };
      if (on === 'Math' && n.arguments.some(usesRandom)) return { kind: 'generated', how: 'Math.random' };
      if (on === 'Math') { const vs = n.arguments.map((x) => this.resolve(x, seen)); return vs.find((v) => v.kind === 'generated') || U('Math.' + m); }
      if (n.arguments.some((x) => isFn(x) && usesRandom(x))) return { kind: 'generated', how: 'inline random' };   // 'xxxxxxxx-…'.replace(/[xy]/g, c => Math.random() …)
      const base = this.resolve(obj, seen);
      if (m === 'toISOString' && base.kind === 'generated') return base;
      if (PASS_METHODS.has(m)) return base;
      if (m === 'find' || m === 'findLast' || m === 'at') return m === 'at' ? extend(base, a0?.type === 'NumericLiteral' ? a0.value : '[*]') : elemOf(base);
      if (SAME_ARRAY.has(m)) return base;
      if (m === 'map' || m === 'flatMap') { const r = this.callback(a0); return { kind: 'array', items: [r ? this.resolve(r, seen) : U()] }; }
      return U(m + '()');
    }
    return U('call');
  }
  line(n) { return n?.loc?.start?.line || 0; }
  src(n) { return n ? this.code.slice(n.start, n.end).replace(/\s+/g, ' ').trim().slice(0, 160) : ''; }
}

// ───────────────────────────── paths ─────────────────────────────
export function showSession(path) {   // ['drawdown_order',0,'items','[*]','id'] → sessionData.drawdown_order[0].items[*].id
  let s = 'sessionData';
  for (const p of path) s += typeof p === 'number' ? `[${p}]` : p === '[*]' ? '[*]' : `.${p}`;
  return s;
}
export function optChain(path) {   // safe-access form used in suggested snippets
  let s = 'sessionData';
  for (const [i, p] of path.entries()) s += typeof p === 'number' ? `?.[${p}]` : p === '[*]' ? '?.[0]' : i === 0 ? `.${p}` : `?.${p}`;
  return s;
}
const fieldStr = (keys) => keys.reduce((s, k) => (k === '[]' ? s + '[]' : s ? `${s}.${k}` : String(k)), '');
const toFieldKeys = (path) => path.map((p) => (typeof p === 'number' || p === '[*]' ? '[]' : p));
// field identity across APIs: parent object (singular) + field, e.g. message.catalog.providers[].items[].id → item.id
export function fieldIdentity(f) {
  const segs = f.replace(/\[\]/g, '').split('.').filter(Boolean);
  const leaf = segs.at(-1); let parent = segs.at(-2) || '';
  if (/ies$/.test(parent)) parent = parent.replace(/ies$/, 'y'); else if (/[^s]s$/.test(parent) && parent.length > 3) parent = parent.slice(0, -1);
  return `${parent}.${leaf}`;
}
// normalise a session path for comparing checks: indexes → 0, trailing length / index dropped
const normPath = (p) => { const q = p.map((x) => (typeof x === 'number' || x === '[*]' ? 0 : x)); while (q.length > 1 && (q.at(-1) === 'length' || q.at(-1) === 0)) q.pop(); return q; };
const startsWith = (a, b) => b.every((x, i) => a[i] === x);

function leafPaths(obj, pre = []) {   // all leaf field paths of a JSON payload
  if (Array.isArray(obj)) return obj.flatMap((x) => leafPaths(x, [...pre, '[]']));
  if (obj && typeof obj === 'object') return Object.entries(obj).flatMap(([k, v]) => leafPaths(v, [...pre, k]));
  return [{ keys: pre, value: obj }];
}
const getAt = (obj, keys) => keys.reduce((o, k) => (o == null ? undefined : k === '[]' ? o[0] : o[k]), obj);
function jsonPathKeys(jp) {   // $.message.order.items[0].id → ['message','order','items','[]','id']
  return String(jp || '').replace(/^\$\.?/, '').replace(/\[(\d+|\*)\]/g, '.[]').replace(/\['([^']+)'\]/g, '.$1').split('.').filter(Boolean);
}

// ───────────────────────────── generator analysis ─────────────────────────────
// Everything one generate() (plus the helpers it calls) reads from sessionData and writes into the payload.
export function analyseGenerator(code, helperCode = '') {
  const full = helperCode ? `${code}\n${helperCode}` : code;
  const genLines = code.split('\n').length;
  const { ast, error } = parseCode(full);
  if (error) return { error };
  const fns = topFunctions(ast);
  const main = fns.generate || Object.values(fns).find((f) => (f.params || []).length >= 2) || null;
  if (!main) return { error: 'no generate() function found' };
  const prog = { fns };
  const roots = {};
  if (main.params[0]?.type === 'Identifier') roots[main.params[0].name] = { kind: 'payload', path: [] };
  if (main.params[1]?.type === 'Identifier') roots[main.params[1].name] = { kind: 'session', path: [] };
  const where = (n) => { const l = n?.loc?.start?.line || 0; return l > genLines ? `helperLib line ${l - genLines - 1}` : `generate line ${l}`; };

  // every function reached from generate, with its parameters bound
  const ctxs = []; const seenFn = new Set();
  const visitCtx = (ctx) => {
    ctxs.push(ctx);
    walk(ctx.fn.body, (n) => {
      if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && n.callee.type === 'Identifier' && fns[n.callee.name] && fns[n.callee.name] !== ctx.fn) {
        const f = fns[n.callee.name]; const key = f.start + ':' + n.arguments.map((a) => ctx.resolve(a).kind).join(',');
        if (!seenFn.has(key) && ctx.depth < 4) { seenFn.add(key); visitCtx(ctx.sub(f, n.arguments, new Set())); }
      }
    });
  };
  const mainCtx = new Ctx(main, roots, prog, 0, full); visitCtx(mainCtx);

  const reads = []; const needs = []; const guards = []; const mutations = []; const writes = []; const varWrites = {}; const assignedRoots = [];
  const fnName = (ctx) => Object.entries(fns).find(([, f]) => f === ctx.fn)?.[0] || 'generate';
  for (const ctx of ctxs) {
    const fname = fnName(ctx);
    walk(ctx.fn.body, (n, parent) => {
      // session reads and the data each non-optional access needs to exist
      if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
        const ov = ctx.resolve(n.object);
        const prop = n.computed ? null : n.property.name;
        const isMethod = prop && METHOD_NAMES.has(prop) && parent && /Call/.test(parent.type) && parent.callee === n;
        if (ov.kind === 'session' && ov.path.length >= 1 && !n.optional && prop !== 'length') needs.push({ path: ov.path, line: ctx.line(n), where: where(n), fn: fname, src: ctx.src(n) });
        if (ov.kind === 'session' && !ov.path.length && (n.optional || true)) { /* sessionData.x itself: a read, not a need */ }
        if (!isMethod) { const v = ctx.resolve(n); if (v.kind === 'session' && v.path.length) reads.push({ path: v.path, line: ctx.line(n), where: where(n), fn: fname, cloned: v.cloned }); }
        else if (ov.kind === 'session' && ov.path.length) reads.push({ path: ov.path, line: ctx.line(n), where: where(n), fn: fname });
      }
      if (n.type === 'ForOfStatement') { const v = ctx.resolve(n.right); if (v.kind === 'session' && v.path.length) needs.push({ path: v.path, line: ctx.line(n), where: where(n), fn: fname, src: ctx.src(n.right) }); }
      if (n.type === 'SpreadElement' && parent?.type === 'ArrayExpression') { const v = ctx.resolve(n.argument); if (v.kind === 'session' && v.path.length) needs.push({ path: v.path, line: ctx.line(n), where: where(n), fn: fname, src: ctx.src(n) }); }
      if ((n.type === 'CallExpression') && n.callee.type === 'MemberExpression' && n.callee.object.name === 'JSON' && n.callee.property.name === 'parse') {
        const a = n.arguments[0]; const inner = a && a.type === 'CallExpression' && a.callee.object?.name === 'JSON' ? a.arguments[0] : null;
        if (inner) { const v = ctx.resolve(inner); if (v.kind === 'session' && v.path.length) needs.push({ path: v.path, line: ctx.line(n), where: where(n), fn: fname, src: ctx.src(n), why: 'JSON.parse(undefined) throws' }); }
      }
      // if (!x) throw / return  → x is guarded inside the generator
      if (n.type === 'IfStatement') {
        let exits = false; walk(n.consequent, (m) => { if (isFn(m)) return false; if (m.type === 'ThrowStatement' || m.type === 'ReturnStatement') exits = true; });
        if (exits) walk(n.test, (m, par) => { if (/Member|Identifier/.test(m.type)) { const v = ctx.resolve(m); if (v.kind === 'session' && v.path.length) guards.push({ path: v.path, throws: true, line: ctx.line(n), where: where(n), src: ctx.src(n.test), full: !(par && /Member/.test(par.type) && par.object === m) }); } });
      }
      // writes: X.a.b = v   /   X.a.push(v)
      if (n.type === 'AssignmentExpression' && /Member/.test(n.left.type)) recordWrite(ctx, n.left, n.right, n, fname);
      if (n.type === 'UnaryExpression' && n.operator === 'delete' && /Member/.test(n.argument.type)) { const v = ctx.resolve(n.argument.object); if (v.kind === 'session' && !v.cloned) mutations.push({ path: v.path, line: ctx.line(n), where: where(n), src: ctx.src(n) }); }
      if (/Call/.test(n.type) && /Member/.test(n.callee.type) && MUTATORS.has(keyName(n.callee.property) || '')) {
        const v = ctx.resolve(n.callee.object);
        if (v.kind === 'session' && !v.cloned && !isLocalCopy(ctx, n.callee.object)) mutations.push({ path: v.path, line: ctx.line(n), where: where(n), src: ctx.src(n) });
        if (keyName(n.callee.property) === 'push') recordWrite(ctx, n.callee.object, n.arguments[0], n, fname, true);
      }
    });
  }
  function isLocalCopy(ctx, node) {   // a local variable that holds a copy built in this function (e.g. const list = [] … list.push)
    const base = chainOf(node).base;
    return base?.type === 'Identifier' && (ctx.vars[base.name] || []).every((b) => b.t === 'node' && /ArrayExpression|ObjectExpression/.test(b.n.type));
  }
  function chainOf(left) {
    const keys = []; let x = left;
    while (x && /Member/.test(x.type)) { keys.unshift(x.computed ? (x.property.type === 'NumericLiteral' ? '[]' : x.property.type === 'StringLiteral' ? x.property.value : '[]') : x.property.name); x = x.object; }
    return { base: x, keys };
  }
  function recordWrite(ctx, target, valueNode, at, fname, push = false) {
    const { base, keys } = chainOf(target);
    const k2 = push ? [...keys, '[]'] : keys;
    const bv = base ? ctx.resolve(base) : U();
    if (bv.kind === 'payload') { const p = [...toFieldKeys(bv.path), ...k2]; writes.push({ ctx, keys: p, node: valueNode, line: ctx.line(at), where: where(at) }); assignedRoots.push(p); return; }
    if (bv.kind === 'session' && !bv.cloned && !(base.type === 'Identifier' && isLocalCopy(ctx, base))) {
      const rootless = base.type === 'Identifier' && base.name in ctx.roots && !bv.path.length;
      mutations.push({ path: [...bv.path, ...k2.filter((k) => k !== '[]')], line: ctx.line(at), where: where(at), src: ctx.src(at), direct: rootless });
    }
    if (base?.type === 'Identifier') (varWrites[base.name] ||= []).push({ ctx, keys: k2, node: valueNode, line: ctx.line(at), where: where(at) });
  }

  // expand the values put into the payload into leaf fields
  const fields = []; const copies = [];
  const expand = (ctx, node, keys, line, wh, seenVars = new Set(), depth = 0) => {
    if (!node || depth > 30) return;
    switch (node.type) {
      case 'ObjectExpression':
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') expand(ctx, p.argument, keys, ctx.line(p) || line, wh, seenVars, depth + 1);
          else if (p.type === 'ObjectProperty' && !p.computed) expand(ctx, p.value, [...keys, keyName(p.key)], ctx.line(p) || line, wh, seenVars, depth + 1);
        }
        return;
      case 'ArrayExpression': for (const e of node.elements) if (e) expand(ctx, e.type === 'SpreadElement' ? e.argument : e, [...keys, '[]'], ctx.line(e) || line, wh, seenVars, depth + 1); return;
      case 'AwaitExpression': case 'ParenthesizedExpression': return expand(ctx, node.argument || node.expression, keys, line, wh, seenVars, depth + 1);
      case 'Identifier': {
        const bs = ctx.vars[node.name];
        if (bs && !seenVars.has(node.name) && !(node.name in ctx.roots)) {
          const s2 = new Set(seenVars).add(node.name);
          const nodes = bs.filter((b) => b.t === 'node' && !(b.n.type === 'NullLiteral'));
          if (nodes.length && nodes.every((b) => /ObjectExpression|ArrayExpression|CallExpression|AwaitExpression/.test(b.n.type) && expandable(ctx, b.n))) nodes.forEach((b) => expand(ctx, b.n, keys, line, wh, s2, depth + 1));
          else leaf(ctx, node, keys, line, wh);
          for (const w of varWrites[node.name] || []) if (w.ctx === ctx) expand(ctx, w.node, [...keys, ...w.keys], w.line, w.where, s2, depth + 1);
          return;
        }
        return leaf(ctx, node, keys, line, wh);
      }
      case 'CallExpression': case 'OptionalCallExpression': {
        const c = node.callee; const m = /Member/.test(c.type) ? keyName(c.property) : null;
        if ((m === 'map' || m === 'flatMap') && isFn(node.arguments[0])) { const r = ctx.callback(node.arguments[0]); if (r) return expand(ctx, r, [...keys, '[]'], line, wh, seenVars, depth + 1); }
        if (c.type === 'MemberExpression' && c.object.name === 'JSON' && m === 'parse') { const a = node.arguments[0]; const inner = a && /Call/.test(a.type) && a.callee.object?.name === 'JSON' ? a.arguments[0] : a; return expand(ctx, inner, keys, line, wh, seenVars, depth + 1); }
        if (c.type === 'Identifier' && CLONE_FNS.test(c.name)) return expand(ctx, node.arguments[0], keys, line, wh, seenVars, depth + 1);
        if (c.type === 'Identifier' && fns[c.name] && ctx.depth < 4) {
          const sc = ctx.sub(fns[c.name], node.arguments, new Set());
          const rets = []; walk(sc.fn.body, (x) => { if (isFn(x)) return false; if (x.type === 'ReturnStatement' && x.argument) rets.push(x.argument); });
          if (sc.fn.body.type !== 'BlockStatement') rets.push(sc.fn.body);
          if (rets.length) { rets.forEach((r) => expand(sc, r, keys, line, wh, new Set(), depth + 1)); return; }
        }
        return leaf(ctx, node, keys, line, wh);
      }
      default: return leaf(ctx, node, keys, line, wh);
    }
  };
  function expandable(ctx, n) { if (/ObjectExpression|ArrayExpression/.test(n.type)) return true; const v = ctx.resolve(n); return v.kind === 'object' || v.kind === 'array' || isRoot(v); }
  function leaf(ctx, node, keys, line, wh) {
    const v = ctx.resolve(node);
    if (isRoot(v) || v.kind === 'object' || v.kind === 'array') {
      if (v.kind === 'object') { for (const [k, pv] of Object.entries(v.props)) fields.push({ keys: [...keys, k], value: pv, line, where: wh, src: ctx.src(node) }); v.spreads.filter(isRoot).forEach((s) => copies.push({ keys, value: s, line, where: wh, src: ctx.src(node) })); return; }
      if (v.kind === 'array') { v.items.forEach((it) => (isRoot(it) ? copies.push({ keys: [...keys, '[]'], value: it, line, where: wh, src: ctx.src(node) }) : fields.push({ keys: [...keys, '[]'], value: it, line, where: wh, src: ctx.src(node) }))); return; }
      copies.push({ keys, value: v, line, where: wh, src: ctx.src(node) });   // may be an object: nested fields are copied with it
      fields.push({ keys, value: v, line, where: wh, src: ctx.src(node) });   // … or a plain value written at this field
      return;
    }
    fields.push({ keys, value: v, line, where: wh, src: ctx.src(node) });
  }
  for (const w of writes) expand(w.ctx, w.node, w.keys, w.line, w.where);

  // quality facts
  const facts = qualityFacts(ast, main, mainCtx, fns, code, genLines, ctxs);
  return { reads, needs, guards, mutations, fields, copies, assignedRoots, facts, mainName: main.id?.name || 'generate' };
}

// ───────────────────────────── code quality facts ─────────────────────────────
function qualityFacts(ast, main, mainCtx, fns, code, genLines, ctxs) {
  const out = [];
  const inGen = (n) => (n.loc?.start?.line || 0) <= genLines;
  const add = (rule, n, extra = {}) => out.push({ rule, line: n?.loc?.start?.line || 0, src: n ? code.slice(n.start, Math.min(n.end, n.start + 160)).replace(/\s+/g, ' ').trim() : '', ...extra });
  // try/catch that swallows errors
  walk(main.body, (n) => {
    if (n.type === 'TryStatement' && n.handler) {
      let rethrows = false; walk(n.handler.body, (m) => { if (isFn(m)) return false; if (m.type === 'ThrowStatement') rethrows = true; });
      let throwsInside = false; walk(n.block, (m) => { if (isFn(m)) return false; if (m.type === 'ThrowStatement') throwsInside = true; });
      if (!rethrows) add('silent-catch', n.handler, { throwsInside });
    }
  });
  // no return in generate
  let hasReturn = false; walk(main.body, (n) => { if (isFn(n) && n !== main) return false; if (n.type === 'ReturnStatement' && n.argument) hasReturn = true; });
  if (!hasReturn) add('no-return', main);
  // async without await (whole reachable code)
  if (main.async) { let aw = false; walk(main.body, (n) => { if (n.type === 'AwaitExpression') aw = true; }); if (!aw) add('async-no-await', main); }
  // style: var, ==, console.log (generate code only, not helperLib)
  walk(ast.program, (n, parent) => {
    if (!inGen(n)) return;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') add('var', n);
    if (n.type === 'BinaryExpression' && (n.operator === '==' || n.operator === '!=') && !(n.right.type === 'NullLiteral' || n.left.type === 'NullLiteral')) add('loose-equality', n);
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'console' && /^(log|debug|info)$/.test(n.callee.property.name)) add('console', n);
  });
  // find() result used without a null check
  for (const ctx of ctxs) {
    for (const [name, bs] of Object.entries(ctx.vars)) {
      const b = bs.find((x) => x.t === 'node' && /Call/.test(x.n.type) && /Member/.test(x.n.callee.type) && /^(find|findLast)$/.test(keyName(x.n.callee.property) || ''));
      if (!b || bs.length > 1) continue;
      let checked = false; let used = null;
      walk(ctx.fn.body, (n, parent) => {
        if (n.type === 'IfStatement' || n.type === 'ConditionalExpression' || n.type === 'LogicalExpression') walk(n.test || n.left, (m) => { if (m.type === 'Identifier' && m.name === name) checked = true; });
        if (/Member/.test(n.type) && n.object.type === 'Identifier' && n.object.name === name && !n.optional && !used) used = n;
      });
      if (used && !checked) add('find-unchecked', used, { name });
    }
  }
  // hardcoded ISO timestamps (generate code only)
  walk(main.body, (n) => { if (n.type === 'StringLiteral' && ISO_DATE.test(n.value) && inGen(n)) add('hardcoded-timestamp', n); });
  // helpers that read sessionData as a free variable (helpers run at script scope)
  for (const [name, f] of Object.entries(fns)) {
    if (f === main || (f.loc?.start?.line || 0) <= genLines) continue;
    const params = new Set(); walk(f.params, (n) => { if (n.type === 'Identifier') params.add(n.name); });
    let free = null; walk(f.body, (n) => { if (!free && n.type === 'Identifier' && n.name === 'sessionData' && !params.has('sessionData')) free = n; });
    if (free) add('helper-free-session', free, { name });
  }
  return out;
}

// ───────────────────────────── requirements / validate ─────────────────────────────
// sessionData[key] where key runs over a literal list: for (const key of ['a','b']) / ['a','b'].every(k => sessionData[k])
function literalKeys(ctx, prop) {
  const lits = (node, depth = 0) => {
    if (!node || depth > 3) return null;
    if (node.type === 'ArrayExpression') { const v = node.elements.map((e) => (e?.type === 'StringLiteral' ? e.value : null)); return v.every((x) => x !== null) ? v : null; }
    if (node.type === 'Identifier') { const b = (ctx.vars[node.name] || []).find((x) => x.t === 'node'); return b ? lits(b.n, depth + 1) : null; }
    return null;
  };
  if (prop.type !== 'Identifier') return null;
  for (const b of ctx.vars[prop.name] || []) if (b.t === 'elem' && b.of.t === 'node') { const v = lits(b.of.n); if (v) return v; }
  return null;
}

export function analyseRequirements(code) {
  const { ast, error } = parseCode(code);
  if (error) return { error };
  const fns = topFunctions(ast);
  const main = fns.meetsRequirements || Object.values(fns)[0];
  if (!main) return { error: 'no meetsRequirements() function found' };
  const roots = {}; if (main.params[0]?.type === 'Identifier') roots[main.params[0].name] = { kind: 'session', path: [] };
  const ctx = new Ctx(main, roots, { fns }, 0, code);
  const checked = []; const badReturns = []; let failReturns = 0; const altKeys = new Set(); const ifGuards = [];
  walk(main.body, (n) => {
    if (n.type === 'IfStatement') {   // if (<test>) return { valid: false … } → the paths in <test> are validated
      walk(n.test, (m, parent) => {
        if (!/Member/.test(m.type) || (parent && /Member/.test(parent.type) && parent.object === m)) return;   // only the full path (a?.b?.c, not a?.b)
        const v = ctx.resolve(m);
        if (v.kind === 'session' && v.path.length === 1 && v.path[0] === '[*]' && m.computed) for (const k of literalKeys(ctx, m.property) || []) ifGuards.push({ path: [k], line: ctx.line(n), src: ctx.src(n.test) });
        else if (v.kind === 'session' && v.path.length && v.path[0] !== '[*]') ifGuards.push({ path: v.path, line: ctx.line(n), src: ctx.src(n.test) });
      });
    }
    if (n.type === 'LogicalExpression' && n.operator !== '&&') {   // sessionData.a || sessionData.b → b is an alternative name, not a hard requirement
      const l = ctx.resolve(n.left), r = ctx.resolve(n.right);
      if (l.kind === 'session' && r.kind === 'session' && l.path.length && r.path.length) { altKeys.add(String(l.path[0])); altKeys.add(String(r.path[0])); }
    }
    if (/Member/.test(n.type)) {
      const v = ctx.resolve(n);
      if (v.kind === 'session' && v.path.length === 1 && v.path[0] === '[*]' && n.computed) { for (const k of literalKeys(ctx, n.property) || []) checked.push({ path: [k], line: ctx.line(n) }); }
      else if (v.kind === 'session' && v.path.length && v.path[0] !== '[*]') checked.push({ path: v.path, line: ctx.line(n) });
    }
    if (n.type === 'ReturnStatement') {
      const a = n.argument;
      if (a?.type === 'ObjectExpression') {
        const ks = a.properties.map((p) => p.key && keyName(p.key));
        if (!['valid', 'code', 'description'].every((k) => ks.includes(k))) badReturns.push({ line: ctx.line(n), src: ctx.src(n) });
        const vp = a.properties.find((p) => p.key && keyName(p.key) === 'valid');
        if (vp && !(vp.value.type === 'BooleanLiteral' && vp.value.value === true)) failReturns++;
      } else if (a) badReturns.push({ line: ctx.line(n), src: ctx.src(n) });
    }
  });
  return { checked, badReturns, alwaysPasses: failReturns === 0, altKeys, ifGuards };
}

export function analyseValidate(code) {   // payload ⇄ session comparisons in validate()
  const { ast, error } = parseCode(code);
  if (error) return { error, compares: [], sessionKeys: new Set() };
  const fns = topFunctions(ast);
  const main = fns.validate || Object.values(fns)[0];
  if (!main) return { compares: [], sessionKeys: new Set() };
  const roots = {};
  if (main.params[0]?.type === 'Identifier') roots[main.params[0].name] = { kind: 'payload', path: [] };
  if (main.params[1]?.type === 'Identifier') roots[main.params[1].name] = { kind: 'session', path: [] };
  const ctx = new Ctx(main, roots, { fns }, 0, code);
  const compares = []; const sessionKeys = new Set();
  const flat = (v) => (v.kind === 'fallback' ? flat(v.primary) : v.kind === 'choice' ? v.options.map(flat).find(isRoot) || v : v);
  walk(main.body, (n) => {
    if (/Member/.test(n.type)) { const v = flat(ctx.resolve(n)); if (v.kind === 'session' && v.path.length) sessionKeys.add(String(v.path[0])); }
    let pair = null;
    if (n.type === 'BinaryExpression' && /^(===|!==|==|!=)$/.test(n.operator)) pair = [n.left, n.right];
    if (/Call/.test(n.type) && /Member/.test(n.callee.type) && /^(includes|has)$/.test(keyName(n.callee.property) || '')) pair = [n.callee.object, n.arguments[0]];
    if (pair) {
      const [a, b] = pair.map((x) => flat(ctx.resolve(x)));
      const p = [a, b].find((v) => v.kind === 'payload'); const s = [a, b].find((v) => v.kind === 'session');
      if (p && s) compares.push({ payload: fieldStr(toFieldKeys(p.path)), session: s.path, line: ctx.line(n) });
    }
  });
  return { compares, sessionKeys };
}

// ───────────────────────────── flow file analysis ─────────────────────────────
function yamlLines(text) {   // steps[i].mock.<key> → line in the flow YAML
  const lc = new YAML.LineCounter(); const doc = YAML.parseDocument(text, { lineCounter: lc });
  const at = (keys) => { const node = doc.getIn(keys, true); return node?.range ? lc.linePos(node.range[0]).line : 0; };
  return { at, data: doc.toJS({ maxAliasCount: -1 }) };
}

function classify(v) {   // where a written value comes from
  if (!v) return { source: 'unknown' };
  switch (v.kind) {
    case 'session': return v.path[0] === 'user_inputs' ? { source: 'user_input', key: String(v.path[1] ?? ''), path: v.path } : { source: 'session', key: String(v.path[0] ?? ''), path: v.path };
    case 'payload': return v.path[0] === 'context' ? { source: 'context' } : { source: 'defaultPayload', path: v.path };
    case 'generated': return { source: 'generated', how: v.how };
    case 'literal': return { source: 'literal', value: v.value };
    case 'fallback': {
      const p = classify(v.primary);
      if (p.source === 'literal' || p.source === 'unknown') { const f = classify(v.fallback); return f.source === 'unknown' ? p : f; }
      const f = classify(v.fallback);
      return f.source === 'literal' && f.value != null && f.value !== '' ? { ...p, fallbackLiteral: f.value } : p;
    }
    case 'choice': { const cs = v.options.map(classify); const dyn = cs.find((c) => /session|user_input|generated|context/.test(c.source)); const lit = cs.find((c) => c.source === 'literal' && c.value != null); return dyn ? (lit ? { ...dyn, fallbackLiteral: lit.value } : dyn) : cs[0]; }
    case 'template': { const cs = v.parts.map(classify); const order = ['session', 'user_input', 'generated', 'context']; for (const o of order) { const c = cs.find((x) => x.source === o); if (c) return { ...c, template: true }; } return cs.every((c) => c.source === 'literal') ? { source: 'literal', value: (v.quasis || []).join('…') } : { source: 'unknown' }; }
    default: return { source: 'unknown', src: v.src };
  }
}

export const showSave = (jp) => { const m = /^EVAL#(.+)$/.exec(String(jp)); if (!m) return String(jp); try { return 'EVAL: ' + Buffer.from(m[1], 'base64').toString('utf8').replace(/\s+/g, ' ').slice(0, 160); } catch { return String(jp); } };
const isEval = (jp) => /^EVAL#/.test(String(jp));
const SEV_ORDER = { High: 0, Medium: 1, Low: 2, Info: 3 };
const QUALITY = {
  'parse-error': ['High', 'Code does not parse', 'Fix the syntax error; the step cannot run.'],
  'silent-catch': ['High', 'try/catch swallows errors and sends the default payload', 'Remove the try/catch (or re-throw in catch) so a broken generator fails the step instead of silently sending defaultPayload. Move the data checks into meetsRequirements().'],
  'session-mutation': ['High', 'Mutates sessionData / user_inputs', 'Work on a copy (const x = structuredClone(sessionData.key?.[0])) or a local variable; never assign into sessionData. Saved data must only change through saveData.'],
  'session-no-index': ['High', 'Saved session value read without [0]', 'Session values are arrays (one entry per save). Read sessionData.<key>?.[0].<field>.'],
  'helper-free-session': ['High', 'helperLib function reads sessionData as a free variable', 'Helpers run at script scope; pass sessionData as a parameter.'],
  'requirements-shape': ['Medium', 'meetsRequirements() returns an object without valid / code / description', 'Return { valid, code, description } on every path.'],
  'requirements-stub': ['Medium', 'meetsRequirements() always passes although the generator reads saved data', 'Add a check for every session key the generator reads (see Requirements tab).'],
  'hardcoded-fallback': ['Medium', 'Missing data falls back to a hardcoded value', 'Do not hide missing data behind a placeholder: mark the input as required in mock.inputs or check it in meetsRequirements(), then read it without a literal fallback.'],
  'find-unchecked': ['Medium', 'find() result used without a null check', 'Check the result (if (!x) throw new Error(...)) or use optional chaining before reading its fields.'],
  'no-return': ['Medium', 'generate() has no return statement', 'Return the payload (return defaultPayload).'],
  'hardcoded-timestamp': ['Medium', 'Hardcoded timestamp literal', 'Use new Date().toISOString() (or the currentTimestamp helper) so timestamps are current.'],
  'var': ['Low', 'Uses var', 'Use const / let.'],
  'loose-equality': ['Low', 'Uses == / !=', 'Use === / !==.'],
  'console': ['Low', 'console.log left in generator', 'Remove debug logging.'],
  'async-no-await': ['Info', 'async function without await', 'Fine at runtime; drop async if nothing is awaited.'],
  'duplicate-generator': ['Info', 'Same generator code in several steps', 'Move the shared logic into a helperLib function and call it from each step.'],
};

export function analyseFlows(flows, opt = {}) {
  const dynamic = []; const requirements = []; const quality = []; const suggestions = []; const stepsOut = []; const duplicates = []; const reqValidations = []; const genValidations = []; const values = [];
  const genHashes = new Map();
  const parsed = flows.map((f) => { try { return { ...f, ...yamlLines(f.text) }; } catch (e) { return { ...f, err: e.message }; } });
  // which flow saves which key (for keys used in one flow but only saved in another)
  const savedIn = {};
  for (const f of parsed) for (const s of f.data?.steps || []) for (const k of Object.keys(s.mock?.saveData || {})) (savedIn[k] ||= new Set()).add(f.file);

  for (const f of parsed) {
    if (f.err || !Array.isArray(f.data?.steps)) continue;
    const steps = f.data.steps; const helper = decode(f.data.helperLib);
    const active = opt.flowIndex ? opt.flowIndex.has(f.file) : true;
    const label = (j) => `${steps[j].api} (step ${j + 1}, ${steps[j].action_id})`;
    // field identities present in every step (examples + defaultPayload + generator output)
    const stepInfo = steps.map((s, i) => {
      const m = s.mock || {};
      const gcode = decode(m.generate); const rcode = decode(m.requirements); const vcode = decode(m.validate);
      const gen = gcode ? analyseGenerator(gcode, helper) : null;
      const examplePayloads = (s.examples || []).map((e) => e?.payload).filter(Boolean);
      const idsIn = new Map();   // identity → field path
      const addFields = (obj) => { for (const lp of leafPaths(obj?.message || {})) { const fp = fieldStr(['message', ...lp.keys]); if (isIdField(lp.keys.at(-1))) idsIn.set(fieldIdentity(fp), fp); } };
      examplePayloads.forEach(addFields); addFields(m.defaultPayload);
      if (gen && !gen.error) for (const x of gen.fields) { const fp = fieldStr(x.keys); if (fp.startsWith('message') && isIdField(x.keys.at(-1))) idsIn.set(fieldIdentity(fp), fp); }
      return { s, m, gcode, rcode, vcode, gen, examplePayloads, idsIn };
    });
    const where = (i, key) => ({ flow: f.file, active: active ? 'Yes' : 'No', step: i + 1, api: steps[i].api, action_id: steps[i].action_id, owner: steps[i].owner || '', yamlLine: f.at(['steps', i, 'mock', key]) });
    const savedBefore = (key, i) => { for (let j = i - 1; j >= 0; j--) if (steps[j].mock?.saveData && key in steps[j].mock.saveData) return j; return -1; };
    const savedAfter = (key, i) => { for (let j = i; j < steps.length; j++) if (steps[j].mock?.saveData && key in steps[j].mock.saveData) return j; return -1; };
    const inputDeclared = (key, i) => { for (let j = i; j >= 0; j--) if (steps[j].mock?.inputs?.jsonSchema?.properties && key in steps[j].mock.inputs.jsonSchema.properties) return j; return -1; };

    stepInfo.forEach((st, i) => {
      const { m, gcode, rcode, vcode, gen } = st;
      const counts = { dynamicIssues: 0, requirementGaps: 0, quality: 0 };
      // what earlier steps saved (for readable "x from previous call on_search" texts of the L2 extractor)
      const savedMap = new Map(); for (let j = 0; j < i; j++) for (const [k, v] of Object.entries(steps[j].mock?.saveData || {})) if (typeof v === 'string') savedMap.set(k, { api: steps[j].api || '', path: v });
      setSaved(savedMap);
      const l2Req = rcode ? l2Checks(rcode, {}, 'meetsRequirements') : { checks: [], style: 'none' };
      if (l2Req.error) quality.push({ ...where(i, 'requirements'), function: 'meetsRequirements', line: '', rule: 'parse-error', severity: 'High', finding: `meetsRequirements() does not parse: ${l2Req.error}`, code: '', fix: QUALITY['parse-error'][2] });
      l2Req.checks.forEach((c, k) => reqValidations.push({ ...where(i, 'requirements'), id: `R${i + 1}.${k + 1}`, ...checkRow(c), style: l2Req.style }));
      const l2Val = vcode ? l2Checks(vcode, {}, 'validate') : { checks: [] };
      if (!gcode) { stepsOut.push({ ...where(i, 'generate'), generator: 'none', ...counts }); return; }
      if (gen.error) {
        quality.push({ ...where(i, 'generate'), function: 'generate', line: '', rule: 'parse-error', severity: 'High', finding: `${QUALITY['parse-error'][1]}: ${gen.error}`, code: '', fix: QUALITY['parse-error'][2] });
        stepsOut.push({ ...where(i, 'generate'), generator: 'parse error', ...counts, quality: 1 }); return;
      }
      const norm = gcode.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
      if (norm.length > 300) { if (!genHashes.has(norm)) genHashes.set(norm, []); genHashes.get(norm).push({ ...where(i, 'generate') }); }
      const validate = vcode ? analyseValidate(vcode) : { compares: [], sessionKeys: new Set() };
      const req = rcode ? analyseRequirements(rcode) : { error: 'no requirements code', checked: [], badReturns: [], alwaysPasses: true };

      // ── generator validations (same L2 extractor, generator mode) and duplicates against requirements.js / validate() ──
      const genFns = generatorFunctions(gcode, helper);
      let gk = 0;
      for (const gf of genFns) {
        const r = l2Checks(gf.code, { mode: 'generator', fnName: gf.name, paramRoots: gf.paramRoots }, gf.name);
        for (const c of r.checks || []) {
          const row = checkRow(c);
          const dup = findDuplicate(c, l2Req.checks, l2Val.checks || []);
          genValidations.push({ ...where(i, 'generate'), id: `G${i + 1}.${++gk}`, function: gf.name === 'generate' ? 'generate()' : `${gf.name}() (called by generate)`, ...row,
            swallowed: gen.facts.some((q) => q.rule === 'silent-catch') ? 'Yes - the catch in generate() swallows it and sends defaultPayload' : '',
            duplicate: dup.verdict, duplicateOf: dup.source, duplicateCheck: dup.check, remark: dup.remark });
        }
      }

      // ── 1. dynamic fields ──
      const exact = new Map(); for (const x of gen.fields) { const fp = fieldStr(x.keys); if (!exact.has(fp)) exact.set(fp, x); }
      const copyList = gen.copies.map((c) => ({ ...c, fp: fieldStr(c.keys) }));
      const rootsFp = gen.assignedRoots.map((r) => fieldStr(r));
      const candidates = new Map();
      for (const [fp, x] of exact) if (fp.startsWith('message') && isIdField(x.keys.at(-1))) candidates.set(fp, { x });
      const defaultLeaves = leafPaths(m.defaultPayload?.message || {}).map((lp) => ({ fp: fieldStr(['message', ...lp.keys]), value: lp.value, keys: ['message', ...lp.keys] }));
      const exampleLeaves = st.examplePayloads.flatMap((p) => leafPaths(p.message || {}).map((lp) => fieldStr(['message', ...lp.keys])));
      for (const fp of new Set([...defaultLeaves.map((d) => d.fp), ...exampleLeaves])) {
        if (candidates.has(fp) || !isIdField(fp.split(/[.[\]]+/).filter(Boolean).at(-1))) continue;
        const cp = copyList.filter((c) => fp.startsWith(c.fp + '.') || fp.startsWith(c.fp + '[]')).sort((a, b) => b.fp.length - a.fp.length)[0];
        const covered = rootsFp.some((r) => fp === r || fp.startsWith(r + '.') || fp.startsWith(r + '['));
        if (cp && !(exact.has(fp))) candidates.set(fp, { copy: cp });
        else if (!covered) { const d = defaultLeaves.find((x) => x.fp === fp); if (d) candidates.set(fp, { kept: d }); }
      }
      for (const [fp, c] of [...candidates].sort((a, b) => a[0].localeCompare(b[0]))) {
        const ident = fieldIdentity(fp);
        let earlier = -1; for (let j = i - 1; j >= 0; j--) if (stepInfo[j].idsIn.has(ident)) { earlier = j; break; }
        const cls = c.x ? classify(c.x.value) : c.copy ? { ...classify(c.copy.value), copied: true } : { source: 'defaultPayload', value: c.kept.value };
        const line = c.x?.where || c.copy?.where || 'defaultPayload';
        const code = c.x?.src || c.copy?.src || (c.kept ? JSON.stringify(c.kept.value) : '');
        // a session key saved earlier that holds this field (for the fix / the validate check)
        const sourceKey = earlier >= 0 ? findSavedKey(steps, stepInfo, i, ident) : null;
        const validated = validate.compares.find((cmp) => fieldIdentity(cmp.payload) === ident);
        let status, severity, fix = '', detail = '';
        // ids are matched across steps by parent + field name; an identical field path is a sure match
        const earlierFp = earlier >= 0 ? stepInfo[earlier].idsIn.get(ident) : '';
        const match = earlier < 0 ? '' : earlierFp === fp ? 'Same field path' : 'Same field name - confirm it is the same object';
        const src = cls.source;
        if (src === 'session') {
          const j = savedBefore(cls.key, i);
          status = 'Dynamic – from earlier call'; severity = 'OK';
          detail = `${showSession(cls.path)}${cls.copied ? ' (copied with the parent object)' : ''}${j >= 0 ? ` · saved by ${label(j)} as ${cls.key}: ${showSave(steps[j].mock.saveData[cls.key])}` : ' · key is not saved by an earlier step (see Requirements)'}`;
          if (cls.fallbackLiteral !== undefined) { status = 'Dynamic – with hardcoded fallback'; severity = 'Medium'; fix = `Remove the fallback ${JSON.stringify(cls.fallbackLiteral)}; check ${cls.key} in meetsRequirements() instead.`; }
        } else if (src === 'user_input') {
          const d = inputDeclared(cls.key, i);
          status = cls.fallbackLiteral !== undefined ? 'User input – with hardcoded fallback' : 'Dynamic – user input'; severity = cls.fallbackLiteral !== undefined ? 'Medium' : 'OK';
          detail = `sessionData.user_inputs.${cls.key}${d >= 0 ? ` · declared in mock.inputs of ${label(d)}` : ' · not declared in mock.inputs'}${cls.fallbackLiteral !== undefined ? ` · falls back to ${JSON.stringify(cls.fallbackLiteral)}` : ''}`;
          if (cls.fallbackLiteral !== undefined) fix = `Mark ${cls.key} as required in mock.inputs.jsonSchema and drop the ${JSON.stringify(cls.fallbackLiteral)} fallback, so a missing input is reported instead of sending a placeholder id.`;
          if (earlier >= 0 && sourceKey && !validated) { fix = (fix ? fix + ' ' : '') + `The id also exists in ${label(earlier)}: check in validate() that it matches ${showSession(sourceKey.path)}.`; }
        } else if (src === 'generated') {
          status = earlier >= 0 ? 'Generated – but already exists earlier' : 'Generated'; severity = earlier >= 0 ? 'Low' : 'OK';
          detail = `${cls.how}${earlier >= 0 ? ` · ${ident} already appears in ${label(earlier)}` : ''}`;
          if (earlier >= 0) fix = `Confirm a new value is intended; otherwise read it from ${sourceKey ? showSession(sourceKey.path) : `the ${steps[earlier].api} response (add a saveData key)`}.`;
        } else if (src === 'context') { status = 'Dynamic – context'; severity = 'OK'; detail = 'from defaultPayload.context (runtime)'; }
        else if (src === 'literal' || src === 'defaultPayload') {
          const lit = src === 'literal' ? cls.value : cls.value ?? getAt(m.defaultPayload, fp.split('.').flatMap((s) => s.endsWith('[]') ? [s.slice(0, -2), '[]'] : [s]));
          const kept = !!c.kept || src === 'defaultPayload';
          if (earlier >= 0) {
            status = kept ? 'Hardcoded – kept from defaultPayload' : 'Hardcoded'; severity = earlierFp === fp ? 'High' : 'Medium';
            detail = `${lit === undefined ? 'value from the defaultPayload template' : JSON.stringify(lit)} · ${ident} already exists in ${label(earlier)} (${stepInfo[earlier].idsIn.get(ident)})`;
            fix = sourceKey
              ? `Read it from the earlier call: ${optChain(sourceKey.path)} (saved by ${label(sourceKey.step)} as ${sourceKey.key}).`
              : `Save it in ${label(earlier)} (mock.saveData, e.g. ${suggestSaveKey(ident)}: "${toJsonPath(stepInfo[earlier].idsIn.get(ident))}") and read it here from sessionData.`;
            if (!validated) fix += ` If it cannot be made dynamic, add a check in this step's validate() that ${fp} matches the value from ${steps[earlier].api}.`;
          } else {
            const usedLater = stepInfo.slice(i + 1).findIndex((x) => x.idsIn.has(ident));
            const savedHere = Object.values(m.saveData || {}).some((jp) => { const k = fieldStr(jsonPathKeys(jp)); return fp === k || fp.startsWith(k + '.') || fp.startsWith(k + '['); });
            status = kept ? 'Hardcoded – first defined here (defaultPayload)' : 'Hardcoded – first defined here'; severity = 'Info';
            detail = `${JSON.stringify(lit)} · first step in the flow with ${ident}`;
            if (usedLater >= 0 && !savedHere) { severity = 'Low'; fix = `Later steps use ${ident} (${label(i + 1 + usedLater)}) but this step does not save it: add saveData ${suggestSaveKey(ident)}: "${toJsonPath(fp)}" so they can read and check it.`; }
            else fix = 'Acceptable for the first step that creates this id; prefer a user input or a generated value if the id must differ per run.';
          }
        } else { status = 'Check manually'; severity = 'Low'; detail = cls.src ? `value from ${cls.src}` : 'source could not be traced'; fix = 'Confirm the value comes from an earlier call or user input.'; }
        const validateCol = earlier < 0 ? '-' : validated ? `Yes (validate line ${validated.line})` : 'No';
        const shouldDyn = earlier >= 0 && /^Hardcoded/.test(status);
        const dynamicFrom = !shouldDyn ? '' : sourceKey ? `${optChain(sourceKey.path)}   (saved by ${label(sourceKey.step)} as ${sourceKey.key})` : `not saved yet - add saveData ${suggestSaveKey(ident)}: "${toJsonPath(stepInfo[earlier].idsIn.get(ident))}" in ${label(earlier)}, then read sessionData.${suggestSaveKey(ident)}?.[0]`;
        const valCheck = shouldDyn ? (validated ? `Already in validate() (line ${validated.line})` : validateSnippet(fp, sourceKey?.path, steps[earlier].api)) : '';
        dynamic.push({ ...where(i, 'generate'), field: fp, identity: ident, status, severity, source: detail, line, code, earlier: earlier >= 0 ? label(earlier) : '', earlierField: earlier >= 0 ? stepInfo[earlier].idsIn.get(ident) : '', match, inValidate: validateCol, fix, today: shouldDyn ? `${detail.split(' · ')[0]}${/defaultPayload/.test(status) ? ' (left in defaultPayload)' : ''}` : '', code, dynamicFrom, validateCheck: valCheck });
        if (/^Hardcoded/.test(status) && earlier >= 0) {
          counts.dynamicIssues++;
          if (!validated) suggestions.push({ ...where(i, 'validate'), target: 'validate', reason: `${fp} is hardcoded but must match ${label(earlier)}`, snippet: validateSnippet(fp, sourceKey?.path, steps[earlier].api) });
          if (!sourceKey) suggestions.push({ ...where(earlier, 'saveData'), target: 'saveData', reason: `Save ${ident} so ${label(i)} can read it`, snippet: `${suggestSaveKey(ident)}: "${toJsonPath(stepInfo[earlier].idsIn.get(ident))}"` });
        } else if (/fallback/.test(status)) counts.dynamicIssues++;
      }

      // ── static vs dynamic: every payload field generate() sends ──
      {
        const seenV = new Set();
        const valueRow = (fp, cls, how, codeTxt, wh) => {
          if (seenV.has(fp) || !fp.startsWith('message')) return; seenV.add(fp);
          const ident = fieldIdentity(fp); const leafName = fp.split(/[.[\]]+/).filter(Boolean).at(-1);
          let earlier = -1; for (let j = i - 1; j >= 0; j--) if (stepInfo[j].idsIn.has(ident)) { earlier = j; break; }
          const src = cls.source; let kind, why, opportunity = '';
          if (src === 'session') { kind = 'Dynamic'; why = `from sessionData: ${showSession(cls.path)}${(() => { const j = savedBefore(cls.key, i); return j >= 0 ? ` (saved by ${label(j)})` : ''; })()}${cls.fallbackLiteral !== undefined ? ` - falls back to ${JSON.stringify(cls.fallbackLiteral)} when missing` : ''}`; }
          else if (src === 'user_input') { kind = 'Dynamic'; why = `from user input user_inputs.${cls.key}${cls.fallbackLiteral !== undefined ? ` - falls back to ${JSON.stringify(cls.fallbackLiteral)} when missing` : ''}`; }
          else if (src === 'context') { kind = 'Dynamic'; why = 'from the request context (set by the runtime)'; }
          else if (src === 'generated') { kind = 'Dynamic'; why = `generated at run time (${cls.how})`; }
          else if (src === 'literal' || src === 'defaultPayload') {
            kind = 'Static';
            const lit = src === 'literal' ? JSON.stringify(cls.value) : 'value from defaultPayload';
            const canBe = earlier >= 0 && (isIdField(leafName) || /^(ref_|created_at$)/.test(leafName));
            if (canBe) {
              const sk = findSavedKey(steps, stepInfo, i, ident);
              why = `${src === 'literal' ? 'hardcoded' : 'taken from defaultPayload'} (${lit}) although ${ident} already comes in ${label(earlier)}`;
              opportunity = sk ? `Use ${optChain(sk.path)} (saved by ${label(sk.step)} as ${sk.key})` : `Save it in ${label(earlier)} (saveData ${suggestSaveKey(ident)}: "${toJsonPath(stepInfo[earlier].idsIn.get(ident))}") and read it from sessionData`;
            } else why = `${src === 'literal' ? 'hardcoded' : 'taken from defaultPayload'} (${lit}); ${earlier >= 0 ? 'a fixed value for this step' : 'no earlier call has this field'}`;
          } else { kind = 'Check manually'; why = cls.src ? `value from ${cls.src} could not be traced` : 'source could not be traced'; }
          // structured source, used to combine the same field across APIs / flows
          const sj = src === 'session' ? savedBefore(cls.key, i) : -1;
          const srcType = { session: 'sessionData', user_input: 'user input', context: 'context', generated: 'generated', literal: 'hardcoded', defaultPayload: 'defaultPayload' }[src] || 'not traced';
          const srcFrom = src === 'session' ? (sj >= 0 ? steps[sj].api : cls.key) : src === 'user_input' ? cls.key : '';
          const dpVal = () => { const v = getAt(m.defaultPayload, fp.split('.').flatMap((x) => (x.endsWith('[]') ? [x.slice(0, -2), '[]'] : [x]))); return v === undefined || typeof v === 'object' ? '' : JSON.stringify(v); };
          const staticValue = kind === 'Static' ? (cls.value !== undefined ? JSON.stringify(cls.value) : dpVal()) : '';
          values.push({ ...where(i, 'generate'), field: fp, kind, why, opportunity, earlier: earlier >= 0 ? label(earlier) : '', code: codeTxt, where: wh, srcType, srcFrom, staticValue });
        };
        for (const [fp, x] of exact) { const c = classify(x.value); if (c.source === 'unknown' && (x.value?.kind === 'object' || x.value?.kind === 'array')) continue; valueRow(fp, c, 'write', x.src, x.where); }
        // fields copied with a whole object (from sessionData or the defaultPayload template), known from the step's examples
        for (const fp of new Set([...defaultLeaves.map((d) => d.fp), ...exampleLeaves])) {
          if (exact.has(fp) || seenV.has(fp)) continue;
          const cp = copyList.filter((c) => fp.startsWith(c.fp + '.') || fp.startsWith(c.fp + '[]')).sort((a, b) => b.fp.length - a.fp.length)[0];
          const covered = rootsFp.some((r) => fp === r || fp.startsWith(r + '.') || fp.startsWith(r + '['));
          if (cp) valueRow(fp, { ...classify(cp.value), copied: true }, 'copy', cp.src, cp.where);
          else if (!covered && defaultLeaves.some((d) => d.fp === fp)) valueRow(fp, { source: 'defaultPayload', value: defaultLeaves.find((d) => d.fp === fp).value }, 'kept', 'defaultPayload', 'defaultPayload');
        }
      }

      // ── 2. requirements coverage ──
      const byKey = new Map();
      const keyOf = (p) => (p[0] === 'user_inputs' ? `user_inputs.${p[1] ?? ''}` : String(p[0]));
      for (const r of gen.reads) { if (!r.path.length || r.path[0] === '[*]' || (r.path[0] === 'user_inputs' && r.path.length < 2)) continue; const k = keyOf(r.path); if (!byKey.has(k)) byKey.set(k, { reads: [], needs: [] }); byKey.get(k).reads.push(r); }
      for (const n of gen.needs) { if (n.path[0] === 'user_inputs' || n.path[0] === '[*]') continue; const k = keyOf(n.path); if (!byKey.has(k)) byKey.set(k, { reads: [], needs: [] }); byKey.get(k).needs.push(n); }
      const checked = (req.checked || []).map((c) => ({ ...c, n: normPath(c.path) }));
      const silent = gen.facts.find((q) => q.rule === 'silent-catch');
      let readsSaved = false;
      for (const [k, u] of [...byKey].sort((a, b) => a[0].localeCompare(b[0]))) {
        const isInput = k.startsWith('user_inputs.');
        const used = [...new Set(u.reads.map((r) => showSession(r.path)))].sort((a, b) => b.length - a.length).slice(0, 4).join('\n');
        const usedWhere = [...new Set(u.reads.map((r) => r.where))].slice(0, 4).join(', ');
        const reqFor = checked.filter((c) => String(c.path[0]) === k);
        const reqShown = [...new Set(reqFor.map((c) => showSession(c.path)))].join('\n');
        let status, severity, savedBy = '', fix = '', snippet = '';
        if (isInput) {
          const ik = k.slice(12); const d = inputDeclared(ik, i);
          savedBy = d >= 0 ? `mock.inputs of ${label(d)}` : '';
          status = d >= 0 ? 'User input – declared' : 'User input – not declared in mock.inputs'; severity = d >= 0 ? 'OK' : 'Medium';
          if (d < 0) fix = `Declare ${ik} in mock.inputs.jsonSchema.properties (mark it required) of this step.`;
          requirements.push({ ...where(i, 'requirements'), key: k, used, usedWhere, savedBy, inRequirements: reqShown || '-', status, severity, fix, snippet });
          if (d < 0) counts.requirementGaps++;
          continue;
        }
        const jb = savedBefore(k, i); const ja = jb < 0 ? savedAfter(k, i) : -1;
        const runtime = RUNTIME_KEYS.has(k);
        if (jb >= 0) savedBy = `${label(jb)} → ${k}: ${showSave(steps[jb].mock.saveData[k])}`;
        else if (runtime) savedBy = 'runtime';
        if (!runtime || jb >= 0) readsSaved = readsSaved || !CONTEXT_KEYS.has(k);
        const unguardedNeeds = u.needs.filter((n) => !gen.guards.some((g) => startsWith(normPath(n.path), normPath(g.path)) && normPath(g.path).length >= normPath(n.path).length));
        // a need inside a loop / find / map only requires the iterated array itself ([*] = any element)
        const cut = (p) => (p.includes('[*]') ? p.slice(0, p.indexOf('[*]')) : p);
        const deepestNeed = (list) => [...list].sort((a, b) => normPath(cut(b.path)).length - normPath(cut(a.path)).length)[0];
        const deepest = (list) => { const d = deepestNeed(list); return d ? normPath(cut(d.path)) : undefined; };
        const needPath = deepest(unguardedNeeds.length ? unguardedNeeds : u.needs) || normPath(u.reads.map((r) => r.path).sort((a, b) => a.length - b.length)[0] || [k]).slice(0, 1);
        const covers = (p) => checked.some((c) => startsWith(c.n, p));
        if (jb < 0 && !runtime) {
          const other = [...(savedIn[k] || [])].filter((x) => x !== f.file);
          status = ja === i ? 'Saved only by this step (after generate runs)' : ja >= 0 ? 'Saved only by a later step' : other.length ? 'Saved only in another flow' : 'Never saved';
          severity = ja >= 0 || !other.length ? 'High' : 'Medium';
          savedBy = ja >= 0 ? `${label(ja)} → ${k}: ${showSave(steps[ja].mock.saveData[k])}` : other.length ? other.slice(0, 3).join(', ') : '';
          fix = ja === i ? `generate() reads ${k} before this step's own saveData stores it, so on the first run it is always empty. Read the value from an earlier step, or generate it here and save it.` : ja >= 0 ? `Move the saveData of ${k} to a step before this one, or read the value from a step that has already run.` : other.length ? 'Confirm the session is shared between these flows; otherwise save the key in this flow before this step.' : `Add a saveData entry ${k}: "<JSONPath>" to the earlier step whose response holds this data.`;
        } else if (CONTEXT_KEYS.has(k) && !reqFor.length) {
          status = 'Runtime value'; severity = 'Info';
        } else if (!reqFor.length) {
          const guarded = u.needs.length && !unguardedNeeds.length;
          status = guarded ? 'Not in requirements – generator throws' : u.needs.length ? 'Not in requirements' : 'Not in requirements – read optionally';
          severity = guarded ? (silent ? 'High' : 'Medium') : u.needs.length ? 'High' : 'Medium';
          fix = guarded ? `Move the check into meetsRequirements() so the step is blocked before generate() runs${silent ? ' (today the generator\'s catch swallows the error and sends defaultPayload)' : ''}.`
            : u.needs.length ? `Check ${showSession(needPath)} in meetsRequirements(); generate() reads it without a guard (${deepestNeed(u.needs).where}: ${deepestNeed(u.needs).src}).`
            : `Check ${k} in meetsRequirements(); generate() silently sends an empty value when it is missing.`;
          snippet = reqSnippet(needPath, jb >= 0 ? label(jb) : '');
        } else if (needPath.length > 1 && !covers(needPath) && unguardedNeeds.length) {
          status = 'Shallow check'; severity = 'Medium';
          const dn = deepestNeed(unguardedNeeds);
          fix = `meetsRequirements() checks ${reqShown.split('\n')[0]} but generate() also needs ${showSession(deepest(unguardedNeeds))} (${dn.where}: ${dn.src}).`;
          snippet = reqSnippet(deepest(unguardedNeeds), jb >= 0 ? label(jb) : '');
        } else { status = 'Checked'; severity = 'OK'; }
        if (severity !== 'OK' && severity !== 'Info') counts.requirementGaps++;
        requirements.push({ ...where(i, 'requirements'), key: k, used, usedWhere, savedBy, inRequirements: reqShown || '-', status, severity, fix, snippet });
        if (snippet) suggestions.push({ ...where(i, 'requirements'), target: 'requirements', reason: `${status}: ${k}`, snippet });
      }
      // keys requirements checks that can never be present at this step
      for (const k of new Set((req.checked || []).map((c) => String(c.path[0])))) {
        if (k === 'user_inputs' || RUNTIME_KEYS.has(k) || savedBefore(k, i) >= 0 || byKey.has(k) || req.altKeys?.has(k)) continue;
        const ja = savedAfter(k, i);
        requirements.push({ ...where(i, 'requirements'), key: k, used: byKey.has(k) ? 'yes' : '- (not used by generate)', usedWhere: '', savedBy: ja >= 0 ? `only later: ${label(ja)}` : '', inRequirements: [...new Set(req.checked.filter((c) => String(c.path[0]) === k).map((c) => showSession(c.path)))].join('\n'),
          status: 'Checked but not saved before this step', severity: 'High', fix: 'This requirement can never pass at this step: save the key in an earlier step or remove the check.', snippet: '' });
        counts.requirementGaps++;
      }

      // ── duplicate checks: the same data checked in generate() (if … throw/return) and in meetsRequirements() ──
      const seenDup = new Set();
      for (const g of gen.guards.filter((x) => x.full)) {
        const gn = normPath(g.path);
        const r = (req.ifGuards || []).map((x) => ({ ...x, n: normPath(x.path) })).filter((x) => startsWith(x.n, gn)).sort((a, b) => a.n.length - b.n.length)[0];
        if (!r) continue;
        const key = gn.join('.') + '|' + g.line; if (seenDup.has(key)) continue; seenDup.add(key);
        const same = r.n.length === gn.length;
        duplicates.push({ ...where(i, 'generate'), key: keyOf(g.path), generatorCheck: `${g.where}: if (${g.src})`, checks: showSession(g.path), requirementsCheck: `requirements line ${r.line}: if (${r.src})`, requirementsChecks: showSession(r.path),
          verdict: same ? 'Duplicate' : 'Covered by requirements',
          remark: same ? 'meetsRequirements() already checks the same value before generate() runs, so this check in generate() can never fail.'
            : `meetsRequirements() checks the deeper path ${showSession(r.path)}, which implies this one, so the check in generate() can never fail.`,
          action: 'Keep the check in meetsRequirements() and remove it from generate() (or keep it only as a defensive guard).' });
      }

      // ── 3. code quality ──
      const q = (rule, extra) => { const [sev, title, fx] = QUALITY[rule]; quality.push({ ...where(i, extra.key || 'generate'), function: extra.fn || 'generate', line: extra.line ?? '', rule, severity: sev, finding: extra.finding || title, code: extra.code || '', fix: extra.fix || fx }); counts.quality++; };
      const genLines = gcode.split('\n').length;
      const loc = (l) => (l > genLines ? `helperLib line ${l - genLines - 1}` : `generate line ${l}`);
      for (const fct of gen.facts) {
        if (fct.rule === 'silent-catch') q('silent-catch', { line: loc(fct.line), code: fct.src, finding: QUALITY['silent-catch'][1] + (fct.throwsInside ? ' (the throw guards inside try never reach the runner)' : '') });
        else q(fct.rule, { line: loc(fct.line), code: fct.src, finding: fct.rule === 'find-unchecked' ? `find() result "${fct.name}" used without a null check` : fct.rule === 'helper-free-session' ? `helper ${fct.name}() reads sessionData without taking it as a parameter` : undefined, fn: fct.line > genLines ? 'helperLib' : 'generate' });
      }
      const seenMut = new Set();
      for (const mu of gen.mutations) { const s = showSession(mu.path); if (seenMut.has(s)) continue; seenMut.add(s); q('session-mutation', { line: mu.where, code: mu.src, finding: `Writes into ${s}` }); }
      const seenIdx = new Set();
      for (const r of gen.reads) {
        const k = r.path[0];
        if (k === 'user_inputs' || RUNTIME_KEYS.has(k) || r.path.length < 2 || typeof r.path[1] === 'number' || r.path[1] === '[*]' || METHOD_NAMES.has(r.path[1])) continue;
        const sj = savedBefore(k, i) >= 0 ? savedBefore(k, i) : savedAfter(k, 0);
        if (sj < 0 || isEval(steps[sj].mock.saveData[k])) continue;   // EVAL# saveData may store a plain value
        if (seenIdx.has(k)) continue; seenIdx.add(k);
        q('session-no-index', { line: r.where, code: showSession(r.path), finding: `${showSession(r.path)} reads a field of the saved array itself` });
      }
      const seenFb = new Set();
      for (const x of gen.fields) {
        const c = classify(x.value); const fp = fieldStr(x.keys);
        if (c.fallbackLiteral !== undefined && /session|user_input/.test(c.source) && !seenFb.has(fp)) { seenFb.add(fp); q('hardcoded-fallback', { line: x.where, code: x.src, finding: `${fp} falls back to ${JSON.stringify(c.fallbackLiteral)} when ${c.source === 'user_input' ? 'user_inputs.' : ''}${c.key} is missing` }); }
      }
      if (req.error && rcode) q('parse-error', { key: 'requirements', fn: 'meetsRequirements', finding: `meetsRequirements() does not parse: ${req.error}` });
      for (const b of req.badReturns || []) q('requirements-shape', { key: 'requirements', fn: 'meetsRequirements', line: `requirements line ${b.line}`, code: b.src });
      if (req.alwaysPasses && readsSaved && !req.error) q('requirements-stub', { key: 'requirements', fn: 'meetsRequirements' });

      stepsOut.push({ ...where(i, 'generate'), generator: 'yes', ...counts });
    });
  }
  // duplicated generators across steps / flows
  for (const list of genHashes.values()) {
    if (list.length < 2) continue;
    const names = list.map((w) => `${w.flow.split('/').pop()} step ${w.step}`);
    for (const w of list) quality.push({ ...w, function: 'generate', line: '', rule: 'duplicate-generator', severity: 'Info', finding: `Same generate() code in ${list.length} steps: ${names.filter((n) => n !== `${w.flow.split('/').pop()} step ${w.step}`).slice(0, 5).join(', ')}${list.length > 6 ? ' …' : ''}`, code: '', fix: QUALITY['duplicate-generator'][2] });
  }
  const sortRows = (rows) => rows.sort((a, b) => a.flow.localeCompare(b.flow) || a.step - b.step || (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  const byStep = (rows) => rows.sort((a, b) => a.flow.localeCompare(b.flow) || a.step - b.step);
  return { reqValidations: byStep(reqValidations), genValidations: byStep(genValidations), values: byStep(values), duplicates: sortRows(duplicates), steps: stepsOut, dynamic: sortRows(dynamic), requirements: sortRows(requirements), quality: sortRows(quality), suggestions: suggestions.sort((a, b) => a.flow.localeCompare(b.flow) || a.step - b.step) };
}

// ───────────────────────────── L2 extractor glue ─────────────────────────────
function l2Checks(code, opts, label) {
  if (label === 'meetsRequirements' && !opts.paramRoots) {   // meetsRequirements(sessionData): its only parameter is the session, whatever its name
    const { ast } = parseCode(code); const fns = ast ? topFunctions(ast) : {};
    const f = fns.meetsRequirements || Object.values(fns)[0];
    if (f?.params?.[0]?.type === 'Identifier') opts = { ...opts, fnName: fns.meetsRequirements ? 'meetsRequirements' : undefined, paramRoots: { [f.params[0].name]: 'session' } };
  }
  const r = analyseFunction(code, babelParse, opts);
  if (r.error) return { error: r.error, checks: [] };
  // sessionData[key] for key in a literal list → one check per key
  const out = [];
  for (const c of r.checks) {
    if (c.field?.root === 'session' && /^\[\]/.test(c.field.path || '')) {
      const keys = loopKeys(code);
      if (keys.length) { for (const k of keys) out.push({ ...c, field: { ...c.field, path: k + c.field.path.slice(2) } }); continue; }
    }
    out.push(c);
  }
  return { ...r, checks: out };
}
function loopKeys(code) {   // ["a","b"] lists that a for…of / .every / .some walks over with sessionData[key]
  const { ast } = parseCode(code); if (!ast) return [];
  const keys = new Set();
  walk(ast.program, (n) => {
    const arr = n.type === 'ForOfStatement' ? n.right : (/Call/.test(n.type) && /Member/.test(n.callee.type) && /^(every|some|forEach|filter|find)$/.test(keyName(n.callee.property) || '')) ? n.callee.object : null;
    if (!arr) return;
    let lit = arr;
    if (arr.type === 'Identifier') walk(ast.program, (m) => { if (m.type === 'VariableDeclarator' && m.id.name === arr.name && m.init?.type === 'ArrayExpression') lit = m.init; });
    if (lit.type === 'ArrayExpression' && lit.elements.every((e) => e?.type === 'StringLiteral')) lit.elements.forEach((e) => keys.add(e.value));
  });
  return [...keys];
}
function checkRow(c) {
  // Field = the field only (context.transaction_id); the call it was saved by goes to its own column
  const shown = showPath(c.field) || c.field?.path || '';
  const m = /^(.*?) from (?:previous call (\S+)|a previous call)$/.exec(shown);
  const field = m ? m[1] : shown === 'data from previous calls' ? 'sessionData' : shown.replace(/^user input /, 'user_inputs.');
  return { checkType: c.type, field, fromCall: m ? (m[2] || '') : '', fieldPath: c.field ? `${c.field.root}:${c.field.path}` : '', validation: sentenceL2(c),
    comparedWith: showPath(c.other), values: c.values ? c.values.map(String).join(', ') : '', onlyWhen: c.when || '', errorCode: c.code ?? '', errorMessage: c.msg || '', condition: c.condition || '', failKind: c.failKind || '' };
}
// signature for comparing checks: root + path without indexes / trailing length, presence checks grouped together
const PRESENCE = new Set(['Required', 'Non-empty list', 'Non-empty', 'Present', 'Truthy']);
function sig(c) {
  if (!c.field) return null;
  const path = String(c.field.path || '').replace(/\[(\d+|\*)?\]/g, '').replace(/\.length$/, '').replace(/^\./, '');
  return { root: c.field.root, path, kind: PRESENCE.has(c.type) ? 'presence' : c.type, extra: [showPath(c.other), (c.values || []).map(String).sort().join(',')].join('|') };
}
function findDuplicate(g, reqChecks, valChecks) {
  const a = sig(g);
  if (!a || a.root === 'var' || g.type === 'Custom logic') return { verdict: g.type === 'Custom logic' ? 'Check manually' : 'Not duplicate', source: '', check: '', remark: g.type === 'Custom logic' ? 'custom logic - compare by hand' : '' };
  const same = (b) => b && b.root === a.root && b.path === a.path && b.kind === a.kind && (a.kind === 'presence' || b.extra === a.extra);
  const deeper = (b) => b && a.kind === 'presence' && b.kind === 'presence' && b.root === a.root && b.path.startsWith(a.path + '.');
  for (const [list, name] of [[reqChecks, 'requirements.js (meetsRequirements)'], [valChecks, 'Validator (validate)']]) {
    const hit = list.find((c) => same(sig(c)));
    if (hit) return { verdict: 'Duplicate', source: name, check: `${sentenceL2(hit)}${hit.msg ? ` - "${hit.msg}"` : ''}`, remark: `${name} already does the same check` };
  }
  const deep = reqChecks.find((c) => deeper(sig(c)));
  if (deep) return { verdict: 'Duplicate (covered)', source: 'requirements.js (meetsRequirements)', check: `${sentenceL2(deep)}${deep.msg ? ` - "${deep.msg}"` : ''}`, remark: 'requirements.js checks a deeper field, which implies this one' };
  return { verdict: 'Not duplicate', source: '', check: '', remark: '' };
}
// generate() and the local / helperLib functions it calls with sessionData or the payload (with their parameter roles)
function generatorFunctions(gcode, helper) {
  const code = helper ? `${gcode}\n${helper}` : gcode;
  const { ast } = parseCode(code); if (!ast) return [];
  const fns = topFunctions(ast);
  const main = fns.generate ? 'generate' : Object.keys(fns).find((k) => (fns[k].params || []).length >= 2);
  if (!main) return [];
  const out = []; const seen = new Set();
  const visit = (name, roles) => {
    const key = name + JSON.stringify(roles); if (seen.has(key) || out.length > 20) return; seen.add(key);
    out.push({ name, code, paramRoots: roles });
    walk(fns[name].body, (n) => {
      if (!/Call/.test(n.type) || n.callee.type !== 'Identifier' || !fns[n.callee.name] || n.callee.name === name) return;
      const f = fns[n.callee.name]; const r2 = {};
      n.arguments.forEach((a, k) => { const p = f.params[k]; if (a.type === 'Identifier' && roles[a.name] && p?.type === 'Identifier') r2[p.name] = roles[a.name]; });
      if (Object.keys(r2).length) visit(n.callee.name, r2);
    });
  };
  const p = fns[main].params; const roles = {};
  if (p[0]?.type === 'Identifier') roles[p[0].name] = 'payload';
  if (p[1]?.type === 'Identifier') roles[p[1].name] = 'session';
  visit(main, roles);
  return out;
}

function findSavedKey(steps, stepInfo, i, ident) {   // a saveData key of an earlier step whose JSONPath holds this field
  for (let j = i - 1; j >= 0; j--) {
    const fp = stepInfo[j].idsIn.get(ident); if (!fp) continue;
    for (const [k, jp] of Object.entries(steps[j].mock?.saveData || {})) {
      const base = fieldStr(jsonPathKeys(jp));
      if (fp === base || fp.startsWith(base + '.') || fp.startsWith(base + '[')) {
        const rest = fp.slice(base.length).replace(/^\./, '');
        const path = [k, 0, ...rest.split('.').filter(Boolean).flatMap((s) => (s.endsWith('[]') ? [s.slice(0, -2), 0] : [s]))];
        return { key: k, step: j, path };
      }
    }
  }
  return null;
}
const suggestSaveKey = (ident) => ident.replace('.', '_');
const toJsonPath = (fp) => '$.' + String(fp).replace(/\[\]/g, '[*]');
function reqSnippet(path, savedBy) {
  const p = [...path]; const v = optChain(p);
  const what = showSession(p).replace(/^sessionData\./, '');
  return `if (!${v}${p.length === 1 ? '?.length' : ''}) {\n  return { valid: false, code: 400, description: "Missing ${what} in session${savedBy ? ` (saved by ${savedBy})` : ''}" };\n}`;
}
function validateSnippet(fp, expectedPath, api) {
  const payloadPath = 'targetPayload' + fp.split('.').map((s) => (s.endsWith('[]') ? `?.${s.slice(0, -2)}?.[0]` : `?.${s}`)).join('');
  const saved = expectedPath ? optChain(expectedPath) : `sessionData.<saved_key>?.[0]  /* save it in ${api} first */`;
  const arr = fp.includes('[]') ? '// [0] = first element; loop over the array if there are several\n' : '';
  return `${arr}const expected = ${saved};\nif (expected && ${payloadPath} !== expected) {\n  return { valid: false, code: 400, description: "${fp} must match the value from ${api}" };\n}`;
}

// active flows: config/flows/index.yaml $ref list (commented-out flows are not in it)
export function flowIndexRefs(indexText) {
  try { const d = YAML.parse(indexText); const set = new Set(); for (const f of d?.flows || []) { const r = f?.config?.$ref; if (r) set.add('config/flows/' + r.replace(/^\.\//, '')); } return set; } catch { return null; }
}
