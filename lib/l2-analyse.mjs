// L2 analysis: one decoded validate() function → checks. Pure, deterministic, never executes the analysed code.
const ROOTS = { targetPayload: 'payload', sessionData: 'session' };
const isFn = n => n && /Function/.test(n.type);

function src(code, n) { return n ? code.slice(n.start, n.end).replace(/\s+/g, ' ').trim() : ''; }

export function findMainFunction(ast) {
  const fns = [];
  const visit = (n, depth) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(x => visit(x, depth));
    if (isFn(n)) { fns.push({ n, depth }); if (depth > 0) return; depth++; }
    for (const k in n) if (k !== 'loc' && k !== 'start' && k !== 'end' && n[k] && typeof n[k] === 'object') visit(n[k], depth);
  };
  visit(ast.program, 0);
  const top = fns.filter(f => f.depth === 0).map(f => f.n);
  return top.find(f => /^(validate|meetsRequirements|requirements)$/.test(f.id?.name || '')) ||
         top.find(f => (f.params || []).length >= 1) || top[0] || null;
}

// Collect simple aliases: const order = targetPayload?.message?.order; const { a, b } = sessionData;
export function collectAliases(fn) {
  const alias = {}; const all = {};
  const bind = (name, init) => { (all[name] ||= []).push(init); if (!(name in alias)) alias[name] = init; };
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (n !== fn && isFn(n)) return; // do not descend into nested callbacks/helpers
    if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && n.left.type === 'VariableDeclaration') {
      const id = n.left.declarations[0]?.id;
      if (id?.type === 'Identifier') bind(id.name, { type: '__Elem', of: n.right });
    }
    if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier') bind(n.left.name, n.right);
    if (n.type === 'VariableDeclarator' && n.init) {
      if (n.id.type === 'Identifier') bind(n.id.name, n.init);
      if (n.id.type === 'ObjectPattern') for (const p of n.id.properties) {
        const id = p.type === 'ObjectProperty' ? (p.value.type === 'AssignmentPattern' ? p.value.left : p.value) : null;   // { a = 1 } defaults too
        if (id?.type === 'Identifier' && !p.computed) {
          bind(id.name, { type: '__Member', object: n.init, prop: p.key.name ?? p.key.value });
        }
      }
    }
    for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') visit(n[k]);
  };
  visit(fn.body);
  // a name bound more than once (let x = a; x = b) is only trusted when every binding names the same data
  Object.defineProperty(alias, '__all', { value: all, enumerable: false });
  return alias;
}

// Resolve an expression to a data path: { root: 'payload'|'session'|'var', path, length?, collection? }
export function pathOf(n, env, seen = new Set()) {
  if (!n) return null;
  switch (n.type) {
    case 'ParenthesizedExpression': case 'TSNonNullExpression': return pathOf(n.expression, env, seen);
    case 'ConditionalExpression': return pathOf(n.consequent, env, seen) || pathOf(n.alternate, env, seen);   // a ? b : c
    case 'NewExpression': return n.callee?.name === 'Set' && n.arguments.length === 1 ? pathOf(n.arguments[0], env, seen) : null;   // new Set(list) holds the same values
    case 'Identifier': {
      if (ROOTS[n.name] || env.roots?.[n.name]) return { root: ROOTS[n.name] || env.roots[n.name], path: '' };
      if (env.alias[n.name] && !seen.has(n.name)) {
        seen.add(n.name);
        const all = env.alias.__all?.[n.name];
        if (all && all.length > 1 && !env.over?.has(n.name)) {
          const rs = all.map(x => pathOf(x, env, new Set(seen)));
          if (rs.every(r => r && r.root !== 'var' && showPath(r) === showPath(rs[0]) && !!r.length === !!rs[0].length)) return rs[0];
          const noIdx = (r) => showPath(r).replace(/\[\d+\]/g, '[]');   // for (const f of x.fulfillments) … const f = x.fulfillments[0]
          if (rs.every(r => r && r.root !== 'var' && noIdx(r) === noIdx(rs[0]) && !!r.length === !!rs[0].length)) return { ...rs[0], path: rs[0].path.replace(/\[\d+\]/g, '[]') };
          return { root: 'var', path: n.name, ambiguous: true };
        }
        const r = pathOf(env.alias[n.name], env, seen); if (r) return r;
      }
      return { root: 'var', path: n.name };
    }
    case 'LogicalExpression':
      if (n.operator === '||' || n.operator === '??') return pathOf(n.left, env, seen) || pathOf(n.right, env, seen);
      if (n.operator === '&&') return pathOf(n.right, env, seen); // a && a.b → a.b
      return null;
    case '__Elem': { const b = pathOf(n.of, env, seen); return b && { ...b, path: join(b.path, '[]') }; }
    case '__Member': { const b = pathOf(n.object, env, seen); return b && { ...b, path: join(b.path, `.${n.prop}`) }; }
    case 'MemberExpression': case 'OptionalMemberExpression': {
      const b = pathOf(n.object, env, seen); if (!b) return null;
      let seg;
      if (!n.computed) seg = `.${n.property.name}`;
      else if (n.property.type === 'NumericLiteral') seg = `[${n.property.value}]`;
      else if (n.property.type === 'StringLiteral') seg = `.${n.property.value}`;
      else seg = '[]';
      if (seg === '.length') return { ...b, length: true };
      return { ...b, path: join(b.path, seg) };
    }
    case 'CallExpression': case 'OptionalCallExpression': {
      const m = memberName(n.callee);
      // value-preserving wrappers: Number(x), String(x), parseFloat(x), JSON.stringify(x), x.trim(), x.toString(), x.toLowerCase()
      const fnName = n.callee.type === 'Identifier' ? n.callee.name : (memberName(n.callee) && n.callee.object.type === 'Identifier' ? `${n.callee.object.name}.${m}` : '');
      if (COERCE_FN.has(fnName) && n.arguments.length >= 1) return pathOf(n.arguments[0], env, seen);
      if (COERCE_METHOD.has(m) && n.arguments.length === 0) return pathOf(n.callee.object, env, seen);
      if (['find', 'filter'].includes(m)) {   // x.find(i => i.type === 'START') → x[type=START]
        const b = pathOf(n.callee.object, env, seen); if (!b) return null;
        const lit = predLiteral(n.arguments[0]); const p = join(b.path, lit ? `[${lit.key}=${lit.value}]` : '[]');
        return { ...b, path: p, found: true, foundAt: p, lit, pred: n.arguments[0] };
      }
      if (m === 'map' && isFn(n.arguments[0])) {           // items.map(i => i.id) → items[].id
        const f = n.arguments[0], p = f.params[0]?.name; let body = f.body;
        if (body?.type === 'BlockStatement') body = body.body.find(x => x.type === 'ReturnStatement')?.argument;
        const b = pathOf(n.callee.object, env, new Set(seen));   // separate 'seen' sets: the element binding re-reads the same names
        const t = body && p ? String(body.type === 'Identifier' ? body.name : '') : '';
        if (b && body && p && /MemberExpression$/.test(body.type)) {
          const inner = pathOf(body, bindEnv(env, { [p]: { type: '__Elem', of: n.callee.object } }), new Set(seen));
          if (inner) return inner;
        }
        if (b && t === p) return { ...b, path: join(b.path, '[]') };
      }
      // wrapper helper defined in the same code, e.g. pick(sessionData.order_payload) → its argument
      if (n.callee.type === 'Identifier' && env.localFns.has(n.callee.name) && n.arguments.length === 1) return pathOf(n.arguments[0], env, seen);
      return null;
    }
    default: return null;
  }
}
// Bind names for an inner scope (callback parameter, helper parameter). Inner names shadow outer ones.
export function bindEnv(env, map) {
  const alias = Object.assign(Object.create(env.alias), map);
  return { ...env, alias, over: new Set([...(env.over || []), ...Object.keys(map)]), depth: (env.depth || 0) + 1 };
}
// Logical negation as a synthetic node (keeps start/end of the original so source text still works).
const FLIP = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
export function negate(n) {
  const at = { start: n.start, end: n.end };
  if (n.type === 'ParenthesizedExpression') return negate(n.expression);
  if (n.type === 'UnaryExpression' && n.operator === '!') return n.argument.type === 'ParenthesizedExpression' ? n.argument.expression : n.argument;
  if (n.type === 'BinaryExpression' && FLIP[n.operator]) return { ...n, operator: FLIP[n.operator] };
  if (n.type === 'LogicalExpression' && (n.operator === '&&' || n.operator === '||'))   // De Morgan
    return { ...at, type: 'LogicalExpression', operator: n.operator === '&&' ? '||' : '&&', left: negate(n.left), right: negate(n.right) };
  return { ...at, type: 'UnaryExpression', operator: '!', prefix: true, argument: n };
}
// A local variable holding a condition, e.g. const missing = !order?.id; if (missing) ...
const TEST_CALLS = new Set(['some', 'includes', 'has', 'every', 'test', 'isArray', 'isNaN', 'indexOf']);
function conditionAlias(name, env) {
  const b = env.alias[name];
  if (!b || env.over?.has(name) || (env.alias.__all?.[name]?.length || 0) > 1) return null;   // only a single, unambiguous binding
  const t = b.type === 'ParenthesizedExpression' ? b.expression : b;
  if (t.type === 'UnaryExpression' && t.operator === '!') return t;
  if (t.type === 'BinaryExpression' && /^(===|!==|==|!=|<|>|<=|>=)$/.test(t.operator)) return t;
  if (t.type === 'LogicalExpression' && t.operator !== '??' && [t.left, t.right].some(x => conditionAlias.isTest(x))) return t;
  if (/CallExpression$/.test(t.type) && (TEST_CALLS.has(memberName(t.callee)) || (t.callee.type === 'Identifier' && (t.callee.name === 'isNaN' || env.fnDefs?.has(t.callee.name))))) return t;
  return null;
}
conditionAlias.isTest = (x) => x && ((x.type === 'UnaryExpression' && x.operator === '!') || (x.type === 'BinaryExpression' && /^(===|!==|==|!=|<|>|<=|>=)$/.test(x.operator)));
// Helper summary: a local function whose body is a single returned expression is inlined with its
// parameters bound to the call arguments (bounded depth; never executed; the helper name is ignored).
function inlineHelper(call, env) {
  if (!/CallExpression$/.test(call?.type || '') || call.callee.type !== 'Identifier' || (env.depth || 0) > 3) return null;
  const f = env.fnDefs?.get(call.callee.name); if (!f) return null;
  let body = f.body;
  if (body.type === 'BlockStatement') { if (body.body.length !== 1 || body.body[0].type !== 'ReturnStatement') return null; body = body.body[0].argument; }
  if (!body || /Function|ObjectExpression/.test(body.type)) return null;
  if (!f.params.every(p => p.type === 'Identifier')) return null;
  const map = {}; f.params.forEach((p, i) => { map[p.name] = call.arguments[i] || { type: 'Identifier', name: 'undefined' }; });
  return { body, env: bindEnv(env, map) };
}
const COERCE_FN = new Set(['Number', 'String', 'parseFloat', 'parseInt', 'JSON.stringify', 'Boolean']);
const COERCE_METHOD = new Set(['trim', 'toString', 'toLowerCase', 'toUpperCase']);
const join = (a, b) => (a ? a + b : b.replace(/^\./, ''));
const memberName = c => (c && (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') && !c.computed ? c.property.name : null);
// Session data is what earlier calls saved (steps[].mock.saveData: key → JSONPath). SAVED holds, for the step being read,
// the latest earlier step that saved each key, so "sessionData.catalog[0].providers[].items[].id" reads as
// "catalog.providers[].items[].id from previous call on_search".
let SAVED = new Map();
export function setSaved(m) { SAVED = m; }
export function sessionRef(path) {
  const m = /^([A-Za-z_$][\w$]*)((?:\[\d*\])?)(.*)$/.exec(path || '');
  if (!m) return 'a previous call';
  const [, key, , rest] = m;
  if (key === 'user_inputs') return `user input ${rest.replace(/^\./, '') || ''}`.trim();   // values typed in the tool's form
  const hit = SAVED.get(key);
  const tidy = (x) => { x = x.replace(/^\$\.?/, '').replace(/^\./, ''); const i = x.lastIndexOf('message.'); return i >= 0 ? x.slice(i + 8) : x; };
  if (!hit) return `${tidy(key + rest)} from a previous call`;
  const base = String(hit.path);
  return `${tidy(base + rest) || key} from previous call ${hit.api}`;
}
export function showPath(p) {
  if (!p) return '';
  if (p.root === 'payload') return p.path.replace(/^message\./, '') || 'payload';
  if (p.root === 'session') return p.path ? sessionRef(p.path) : 'data from previous calls';
  return p.path;
}
function literal(n) {
  if (!n) return undefined;
  if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(n.type)) return n.value;
  if (n.type === 'NullLiteral') return null;
  if (n.type === 'Identifier' && n.name === 'undefined') return 'undefined';
  if (n.type === 'TemplateLiteral' && !n.expressions.length) return n.quasis.map(q => q.value.cooked).join('');
  return undefined;
}
// (i) => i.descriptor.code === 'X'  → { key: 'descriptor.code', value: 'X' }  (literal right side only)
function predLiteral(pred) {
  if (!pred || !isFn(pred) || pred.params[0]?.type !== 'Identifier') return null;
  let body = pred.body;
  if (body.type === 'BlockStatement') body = body.body.length === 1 && body.body[0].type === 'ReturnStatement' ? body.body[0].argument : null;
  if (!body || body.type !== 'BinaryExpression' || !['===', '=='].includes(body.operator)) return null;
  const p = pred.params[0].name;
  const keyOf = (x) => { const segs = []; while (x && /MemberExpression$/.test(x.type) && !x.computed) { segs.unshift(x.property.name); x = x.object; } return x?.type === 'Identifier' && x.name === p && segs.length ? segs.join('.') : null; };
  const k = keyOf(body.left) ?? keyOf(body.right); const v = keyOf(body.left) ? literal(body.right) : literal(body.left);
  return k && v !== undefined && v !== null && v !== 'undefined' ? { key: k, value: v } : null;
}
// loop variable over a literal list: for (const t of ['A','B']) / const L = ['A','B']; for (const t of L) → ['A','B']
function literalList(n, env) {
  if (n?.type !== 'Identifier') return null;
  const b = env.alias[n.name]; if (!b || b.type !== '__Elem') return null;
  let arr = b.of; if (arr?.type === 'Identifier' && (env.alias.__all?.[arr.name]?.length || 0) <= 1) arr = env.alias[arr.name];
  if (arr?.type !== 'ArrayExpression' || !arr.elements.length) return null;
  const vals = arr.elements.map(literal); return vals.every(v => v !== undefined && v !== null) ? vals : null;
}
// "[type=START]" at the end of a path → "[].type"
const unfilter = (f) => ({ ...f, path: f.path.replace(/\[([^\]=]+)=[^\]]*\]$/, '[].$1') });
// predicate like (p) => p.id === X  → "id equals X"
function predKey(pred, env, code) {
  if (!pred || !isFn(pred)) return null;
  let body = pred.body;
  if (body.type === 'BlockStatement') { const r = body.body.find(s => s.type === 'ReturnStatement'); body = r?.argument; }
  if (body && body.type === 'BinaryExpression' && ['===', '=='].includes(body.operator)) {
    const p = pred.params[0]?.name;
    const side = (x) => { const t = x ? src(code, x).replace(/\?\./g, '.') : ''; return t.startsWith(p + '.') ? t.slice(p.length + 1) : null; };
    const k = side(body.left) ?? side(body.right);
    const other = side(body.left) ? body.right : body.left;
    if (k) return { key: k, other };
  }
  return null;
}

// Turn a failing condition into checks. Returns [{type, field, other, values, guard, text}]
export function classify(test, env, code) {
  const out = [];
  const add = (o) => out.push(o);
  const P = (n) => pathOf(n, env);
  const withEnv = (e, f) => { const saved = env; env = e; try { return f(); } finally { env = saved; } };
  // inline a local helper; if its body is not understood, fall back to the rules below (never worse than before)
  const tryInline = (call, neg) => {
    const h = inlineHelper(call, env); if (!h) return false;
    const before = out.length; withEnv(h.env, () => walk(neg ? negate(h.body) : h.body));
    if (out.slice(before).some(o => o.type === 'Custom logic') || out.length === before) { out.length = before; return false; }
    return true;
  };
  const walk = (t) => {
    if (!t) return;
    if (t.type === 'ParenthesizedExpression') return walk(t.expression);
    // ── normalisation: equivalent forms are rewritten to the forms the rules below understand ──
    if (t.type === 'Identifier') { const c = conditionAlias(t.name, env); if (c) return walk(c); }
    if (t.type === 'UnaryExpression' && t.operator === '!') {
      const a = t.argument.type === 'ParenthesizedExpression' ? t.argument.expression : t.argument;
      if (a.type === 'Identifier') { const c = conditionAlias(a.name, env); if (c) return walk(negate(c)); }
      if (a.type === 'UnaryExpression' && a.operator === '!') return walk(a.argument);                      // !!x
      if (a.type === 'LogicalExpression' && a.operator !== '??') return walk(negate(a));                     // !(a && b) → !a || !b
      if (a.type === 'BinaryExpression' && FLIP[a.operator]) return walk(negate(a));                          // !(x === 1) → x !== 1
      if (tryInline(a, true)) return;
    }
    if (tryInline(t, false)) return;
    if (t.type === 'BinaryExpression' && /^(===|==|<)$/.test(t.operator) && memberName(t.left?.callee) === 'indexOf' && (literal(t.right) === -1 || (t.operator === '<' && literal(t.right) === 0) || (t.right.type === 'UnaryExpression' && t.right.operator === '-' && literal(t.right.argument) === 1)))
      return walk({ start: t.start, end: t.end, type: 'UnaryExpression', operator: '!', argument: { ...t.left, callee: { ...t.left.callee, property: { type: 'Identifier', name: 'includes' } } } });   // a.indexOf(x) === -1 → !a.includes(x)
    // x == null / x === undefined / typeof x === 'undefined' are all "x is missing"
    const typeOf = (x) => x?.type === 'UnaryExpression' && x.operator === 'typeof' ? x.argument : null;
    if (t.type === 'BinaryExpression' && (typeOf(t.left) || typeOf(t.right)) && typeof literal(typeOf(t.left) ? t.right : t.left) === 'string') {
      const f = P(typeOf(t.left) || typeOf(t.right)); const ty = literal(typeOf(t.left) ? t.right : t.left);
      if (f && f.root !== 'var') {
        if (ty === 'undefined') return add({ type: /^!/.test(t.operator) ? 'Must be absent' : 'Required', field: f });
        if (/^!/.test(t.operator)) return add({ type: 'Data type', field: f, values: [ty] });
      }
    }
    if (t.type === 'BinaryExpression' && /^!=/.test(t.operator)) {
      const lr = literal(t.right), f = P(t.left);
      if (f && f.root !== 'var' && !f.length && (lr === 'undefined' || (t.operator === '!=' && lr === null))) return add({ type: 'Must be absent', field: f });
    }
    // isNaN(Number(x)) / !Number.isFinite(x) → x must be a number; isNaN(Date.parse(x)) → a date
    const nanArg = (x) => (/CallExpression$/.test(x?.type || '') && ((x.callee.type === 'Identifier' && x.callee.name === 'isNaN') || (x.callee.type === 'MemberExpression' && src(code, x.callee) === 'Number.isNaN')) ? x.arguments[0] : null);
    if (nanArg(t) || (t.type === 'UnaryExpression' && t.operator === '!' && /CallExpression$/.test(t.argument.type || '') && ['Number.isFinite', 'isFinite'].includes(src(code, t.argument.callee)))) {
      let a = nanArg(t) || t.argument.arguments[0]; let ty = 'number';
      if (a?.type === 'NewExpression' && a.callee.name === 'Date') { a = a.arguments[0]; ty = 'date'; }
      else if (/CallExpression$/.test(a?.type || '') && src(code, a.callee) === 'Date.parse') { a = a.arguments[0]; ty = 'date'; }
      else if (/CallExpression$/.test(a?.type || '') && memberName(a.callee) === 'getTime' && a.callee.object.type === 'NewExpression' && a.callee.object.callee.name === 'Date') { a = a.callee.object.arguments[0]; ty = 'date'; }
      const f = P(a); if (f && f.root !== 'var') return add({ type: 'Data type', field: f, values: [ty] });
    }
    // fail when ANY element matches p → classify p for one element;  !X.every(p) is the same as X.some(!p)
    const arrPred = (call, neg) => {
      const fnArg = call.arguments[0]; if (!isFn(fnArg) || fnArg.params[0]?.type !== 'Identifier') return false;
      let body = fnArg.body; if (body.type === 'BlockStatement') { if (body.body.length !== 1 || body.body[0].type !== 'ReturnStatement') return false; body = body.body[0].argument; }
      const coll = P(call.callee.object); if (!coll || coll.root === 'var' || !body) return false;
      const inner = bindEnv(env, { [fnArg.params[0].name]: { type: '__Elem', of: call.callee.object } });
      const before = out.length; withEnv(inner, () => walk(neg ? negate(body) : body));
      for (let i = before; i < out.length; i++) if (out[i].type === 'Custom logic') { out.length = before; return false; }
      return out.length > before;
    };
    if (/CallExpression$/.test(t.type) && memberName(t.callee) === 'some' && arrPred(t, false)) return;
    if (t.type === 'BinaryExpression' && ['>', '!=='].includes(t.operator) && literal(t.right) === 0 && t.left.type === 'MemberExpression' && memberName(t.left) === 'length' && memberName(t.left.object?.callee) === 'filter' && arrPred(t.left.object, false)) return;
    if (t.type === 'UnaryExpression' && t.operator === '!' && /CallExpression$/.test(t.argument.type) && memberName(t.argument.callee) === 'every' && !predKey(t.argument.arguments[0], env, code) && arrPred(t.argument, true)) return;
    if (t.type === 'LogicalExpression' && t.operator === '||') { walk(t.left); walk(t.right); return; }
    if (t.type === 'LogicalExpression' && t.operator === '&&') {
      // all "x !== 'A' && x !== 'B'" on the same field → allowed values
      const parts = []; const flat = (x) => { if (x.type === 'LogicalExpression' && x.operator === '&&') { flat(x.left); flat(x.right); } else parts.push(x); }; flat(t);
      // !a && !b (different fields) → fails only when ALL are missing → at least one of a, b must be sent
      const alts = parts.map(x => (x.type === 'UnaryExpression' && x.operator === '!' ? P(x.argument.type === 'ParenthesizedExpression' ? x.argument.expression : x.argument) : null));
      if (parts.length >= 2 && alts.every(f => f && f.root !== 'var' && !f.length && !f.found) && new Set(alts.map(showPath)).size === alts.length)
        return add({ type: 'At least one of', field: alts[0], values: alts.map(showPath) });
      const neq = parts.every(x => x.type === 'BinaryExpression' && ['!==', '!='].includes(x.operator) && literal(x.right) !== undefined);
      if (neq) { const f = P(parts[0].left); const vals = parts.map(x => literal(x.right)); if (f && parts.every(x => showPath(P(x.left)) === showPath(f))) return add({ type: 'Allowed values', field: f, values: vals }); }
      const last = parts.pop();
      const before = out.length; walk(last);
      const guard = parts.map(x => src(code, x)).join(' && ');
      for (let i = before; i < out.length; i++) {
        out[i].guard = [out[i].guard, `only when ${guard}`].filter(Boolean).join('; ');
        out[i].guardNodes = [...(out[i].guardNodes || []), ...parts];
      }
      return;
    }
    // flag set inside a loop: let has = false; for (const s of stops) if (s.type === 'START') has = true; if (!has) fail
    const flagOf = (x) => (x?.type === 'Identifier' && env.flags?.get(x.name)?.length === 1 ? env.flags.get(x.name)[0] : null);
    if (flagOf(t)) { const before = out.length; walk(flagOf(t)); if (out.slice(before).every(o => o.type !== 'Custom logic')) return; out.length = before; }
    if (t.type === 'UnaryExpression' && t.operator === '!' && flagOf(t.argument)) {
      const ft = flagOf(t.argument);
      if (ft.type === 'BinaryExpression' && ['===', '=='].includes(ft.operator)) {
        const lv = literal(ft.right) !== undefined ? ft.right : literal(ft.left) !== undefined ? ft.left : null;
        const f = lv && P(lv === ft.right ? ft.left : ft.right);
        if (f && f.root !== 'var' && /\[\]/.test(f.path)) return add({ type: 'Must contain', field: f, values: [literal(lv)] });
      }
    }
    // table-driven checks: const checks = [[order.id, 'id'], [order.status, 'status']]; for (const c of checks) if (!c[0]) fail
    if (t.type === 'UnaryExpression' && t.operator === '!' && /MemberExpression$/.test(t.argument.type) && t.argument.object.type === 'Identifier') {
      const m = t.argument, rows = (() => {
        const b = env.alias[m.object.name]; if (!b || b.type !== '__Elem') return null;
        let arr = b.of; if (arr?.type === 'Identifier' && (env.alias.__all?.[arr.name]?.length || 0) <= 1) arr = env.alias[arr.name];
        return arr?.type === 'ArrayExpression' && arr.elements.length ? arr.elements : null;
      })();
      const pick = (e) => (m.computed && m.property.type === 'NumericLiteral' && e?.type === 'ArrayExpression') ? e.elements[m.property.value]
        : (!m.computed && e?.type === 'ObjectExpression') ? e.properties.find(p => (p.key?.name ?? p.key?.value) === m.property.name)?.value : undefined;
      if (rows && rows.every(e => pick(e))) {
        const before = out.length;
        for (const e of rows) walk({ start: t.start, end: t.end, type: 'UnaryExpression', operator: '!', prefix: true, argument: pick(e) });
        if (out.slice(before).every(o => o.type !== 'Custom logic')) return;
        out.length = before;
      }
    }
    if (t.type === 'UnaryExpression' && t.operator === '!') {
      let a = t.argument.type === 'ParenthesizedExpression' ? t.argument.expression : t.argument;
      if (a.type === 'Identifier' && env.alias[a.name] && /CallExpression$/.test(env.alias[a.name].type) && ['some', 'includes', 'has', 'every', 'test', 'isArray'].includes(memberName(env.alias[a.name].callee))) a = env.alias[a.name];
      if ((a.type === 'CallExpression' || a.type === 'OptionalCallExpression')) {
        const m = memberName(a.callee);
        if (m === 'isArray') { const f = P(a.arguments[0]); if (f) return add({ type: 'Non-empty list', field: f }); }
        if (m === 'includes' || m === 'has') {   // set.has(x) is the same check as list.includes(x)
          const lv = literalList(a.arguments[0], env), lc = P(a.callee.object);
          if (lv && lc && lc.root !== 'var') return add({ type: 'Must contain', field: lc, values: lv });   // for (const t of ['A','B']) if (!x.includes(t))
          const vals = a.callee.object.type === 'ArrayExpression' ? a.callee.object.elements.map(literal) : null;
          const f = P(a.arguments[0]);
          if (vals && vals.every(v => v !== undefined) && f) return add({ type: 'Allowed values', field: f, values: vals });
          const coll = P(a.callee.object);
          if (f && coll) return add({ type: 'Exists in', field: f, other: coll });
          if (coll && literal(a.arguments[0]) !== undefined) return add({ type: 'Must contain', field: coll, values: [literal(a.arguments[0])] });
        }
        if (m === 'some' || m === 'find' || m === 'every') {
          const coll = P(a.callee.object); const pk = predKey(a.arguments[0], env, code);
          const lv = pk && m !== 'every' && literalList(pk.other, env);
          if (coll && lv) return add({ type: 'Must contain', field: { ...coll, path: join(coll.path, '[].' + pk.key) }, values: lv });
          if (coll && pk && literal(pk.other) !== undefined) return add(m === 'every' ? { type: 'Expected value', field: { ...coll, path: join(coll.path, '[].' + pk.key) }, values: [literal(pk.other)] } : { type: 'Must contain', field: { ...coll, path: join(coll.path, '[].' + pk.key) }, values: [literal(pk.other)] });
          if (coll && pk && m === 'every') { const o = P(pk.other); if (o) return add({ type: 'Matches', field: { ...coll, path: join(coll.path, '[].' + pk.key) }, other: o }); }
          if (coll && pk) { const o = P(pk.other); return add({ type: 'Exists in', field: o || { root: 'var', path: src(code, pk.other) }, other: { ...coll, path: join(coll.path, '[].' + pk.key) } }); }
          if (coll) return add({ type: 'Custom logic', field: coll, text: src(code, t) });
        }
        if (m === 'test') return add({ type: 'Format', field: P(a.arguments[0]) || { root: 'var', path: src(code, a.arguments[0]) }, values: [src(code, a.callee.object)] });
      }
      const f = P(a);
      if (f && f.found && f.path === f.foundAt && f.lit) return add({ type: 'Must contain', field: unfilter(f), values: [f.lit.value] });   // !x.find(i => i.type === 'A')
      if (f && f.found && f.path === f.foundAt) { const lv = literalList(predKey(f.pred, env, code)?.other, env); if (lv) return add({ type: 'Must contain', field: { ...f, path: join(f.path, '.' + predKey(f.pred, env, code).key) }, values: lv }); }
      if (f && f.found && f.path === f.foundAt) { const pk = predKey(f.pred, env, code); if (pk) { const o = P(pk.other); return add({ type: 'Exists in', field: o || { root: 'var', path: src(code, pk.other) }, other: { ...f, path: join(f.path, '.' + pk.key) } }); } }
      if (f && f.length) return add({ type: 'Non-empty list', field: f });
      if (f && f.root !== 'var') return add({ type: 'Required', field: f });
      if (f && f.root === 'var') return add({ type: 'Custom logic', field: f, text: src(code, t) });
    }
    if (t.type === 'BinaryExpression') {
      const L = P(t.left), R = P(t.right), lr = literal(t.right), ll = literal(t.left);
      if (['!==', '!='].includes(t.operator)) {
        if (L && lr !== undefined) return add({ type: lr === 'undefined' ? 'Required' : 'Expected value', field: L, values: lr === 'undefined' ? undefined : [lr] });
        if (R && ll !== undefined) return add({ type: 'Expected value', field: R, values: [ll] });
        if (L && R) return add({ type: 'Matches', field: L, other: R });
      }
      if (['===', '=='].includes(t.operator)) {
        if (L && L.length && (lr === 0)) return add({ type: 'Non-empty list', field: L });
        if (L && (lr === undefined && R === null)) {}
        if (L && lr !== undefined) return add({ type: lr === null || lr === 'undefined' || lr === '' ? 'Required' : 'Must not be value', field: L, values: [lr] });
      }
      if (['<', '>', '<=', '>='].includes(t.operator) && (L || R)) {
        if (L && L.length && (t.operator === '<' || (t.operator === '<=' && literal(t.right) === 0))) return add({ type: 'Non-empty list', field: L });
        return add({ type: 'Comparison', field: L || R, text: src(code, t) });
      }
    }
    if (t.type === 'UnaryExpression' && t.operator === 'typeof') return add({ type: 'Custom logic', text: src(code, t) });
    if (/MemberExpression$|^Identifier$/.test(t.type)) { const f = P(t); if (f && f.root !== 'var' && !f.found) return add({ type: 'Must be absent', field: f }); }
    add({ type: 'Custom logic', field: P(t), text: src(code, t) });
  };
  walk(test);
  // merge "Required(X)" + "Non-empty list(X)" → Non-empty list
  const keyOf = (o) => `${o.type}|${showPath(o.field)}|${showPath(o.other)}|${JSON.stringify(o.values ?? '')}`;
  const ne = new Set(out.filter(o => o.type === 'Non-empty list').map(o => showPath(o.field)));
  const res = []; const seen = new Set();
  const deep = out.filter(o => ['Required', 'Non-empty list'].includes(o.type) && o.field).map(o => showPath(o.field));
  for (const o of out) {
    if (o.type === 'Required' && ne.has(showPath(o.field))) continue;
    // "!a || !a.items || !a.items[0].id" → keep only the deepest field (parents are implied)
    if (['Required', 'Non-empty list'].includes(o.type) && o.field && deep.some(d => d !== showPath(o.field) && (d.startsWith(showPath(o.field) + '.') || d.startsWith(showPath(o.field) + '[')))) continue;
    const k = keyOf(o); if (seen.has(k)) continue; seen.add(k); res.push(o);
  }
  return res;
}

export function sentenceL2(c) {
  const f = showPath(c.field), o = showPath(c.other), v = c.values ? c.values.map(x => String(x)).join(', ') : '';
  switch (c.type) {
    case 'Required': return `${f} must be present`;
    case 'At least one of': return `at least one of ${v} must be present`;
    case 'Non-empty list': return `${f} must be a non-empty list`;
    case 'Expected value': return `${f} must be ${v}`;
    case 'Must not be value': return `${f} must not be ${v}`;
    case 'Allowed values': return `${f} must be one of the allowed values`;
    case 'Must contain': return `${f} must contain ${v}`;
    case 'Must be absent': return `${f} must not be sent`;
    case 'Matches': return `${f} must match ${o}`;
    case 'Exists in': return `${f} must exist in ${o}`;
    case 'Format': return `${f} must match the pattern ${v}`;
    case 'Data type': return `${f} must be a valid ${v}`;
    case 'Comparison': return `Comparison: ${c.text}`;
    default: return `Custom logic: ${c.text || f}`;
  }
}

// A guard condition in plain words for the Runs column: "order.items has entries", "issue.status is OPEN",
// "provider_id from previous call on_search is available". Anything else falls back to the code itself.
function plainCond(n, env, code, neg = false) {
  if (!n) return '';
  if (n.type === 'ParenthesizedExpression') return plainCond(n.expression, env, code, neg);
  if (n.type === 'UnaryExpression' && n.operator === '!') return plainCond(n.argument, env, code, !neg);
  if (n.type === 'LogicalExpression' && (n.operator === '&&' || n.operator === '||')) {
    const and = (n.operator === '&&') !== neg;   // De Morgan when negated
    return [plainCond(n.left, env, code, neg), plainCond(n.right, env, code, neg)].filter(Boolean).join(and ? ' and ' : ' or ');
  }
  const P = (x) => { const p = pathOf(x, env); return p && p.root !== 'var' && (p.path || p.root === 'session') ? p : null; };
  const name = (p) => showPath(p);
  const sent = (p, yes) => (p.root === 'session' ? (yes ? 'is available' : 'is not available') : (yes ? 'is sent' : 'is not sent'));
  if (n.type === 'BinaryExpression') {
    const L = P(n.left), R = P(n.right), lv = literal(n.right), ll = literal(n.left);
    const f = L || R, v = L ? lv : ll;
    let eq = /^(===|==)$/.test(n.operator) ? true : /^(!==|!=)$/.test(n.operator) ? false : null;
    if (f && f.length && typeof v === 'number' && v > 0 && /^(===|==|!==|!=|>|>=|<|<=)$/.test(n.operator)) {   // x.length === 1
      const op = neg ? { '===': '!==', '==': '!=', '!==': '===', '!=': '==', '>': '<=', '>=': '<', '<': '>=', '<=': '>' }[n.operator] : n.operator;
      const words = { '===': 'exactly', '==': 'exactly', '!==': 'not exactly', '!=': 'not exactly', '>': 'more than', '>=': 'at least', '<': 'fewer than', '<=': 'at most' }[op];
      return `${name(f)} has ${words} ${v} ${v === 1 ? 'entry' : 'entries'}`;
    }
    if (f && f.length && v === 0) {                          // x.length > 0 / === 0
      let has = ['>', '!==', '!='].includes(n.operator) ? true : ['===', '==', '<='].includes(n.operator) ? false : null;
      if (has !== null) { if (neg) has = !has; return `${name(f)} ${has ? 'has entries' : 'is empty'}`; }
    }
    if (f && !f.length && eq !== null && v !== undefined) {
      if (neg) eq = !eq;
      if (v === null || v === 'undefined') return `${name(f)} ${sent(f, !eq)}`;
      return `${name(f)} is ${eq ? '' : 'not '}${v}`;
    }
    if (L && R && eq !== null) return `${name(L)} ${eq !== neg ? 'matches' : 'does not match'} ${name(R)}`;
  }
  if (/CallExpression$/.test(n.type)) {
    const m = memberName(n.callee), obj = n.callee?.object;
    if (m === 'isArray' && src(code, obj) === 'Array') { const f = P(n.arguments[0]); if (f) return `${name(f)} is ${neg ? 'not ' : ''}a list`; }
    if (m === 'includes' || m === 'has') {
      const f = P(obj), v = literal(n.arguments[0]), g = P(n.arguments[0]);
      if (f && (v !== undefined || g)) return `${name(f)} ${neg ? 'does not include' : 'includes'} ${v !== undefined ? v : name(g)}`;
    }
    if (m === 'some' || m === 'find') { const f = P(obj), pl = predLiteral(n.arguments[0]); if (f && pl) return `${name(f)} ${neg ? 'has no' : 'has an'} entry with ${pl.key} = ${pl.value}`; }
    if (m === 'every') { const f = P(obj), pl = predLiteral(n.arguments[0]); if (f && pl) return `${neg ? 'not every' : 'every'} entry of ${name(f)} has ${pl.key} = ${pl.value}`; }
  }
  if (n.type === 'Identifier') {   // a local holding a condition: const bppCollects = payment.collected_by === 'BPP'
    const c = conditionAlias(n.name, env); if (c && c !== n) return plainCond(c, env, code, neg);
  }
  if (/MemberExpression$|^Identifier$/.test(n.type)) {
    const f = P(n);
    if (f && f.root === 'session' && !f.path) return '';   // "sessionData" on its own says nothing
    if (f) return f.length ? `${name(f)} ${neg ? 'is empty' : 'has entries'}` : `${name(f)} ${sent(f, !neg)}`;
    const v = pathOf(n, env);
    if (v && v.root === 'var') return `${v.path}${v.length ? (neg ? ' is empty' : ' has entries') : (neg ? ' is not set' : ' is set')}`;
  }
  let t = src(code, n); if (t.length > 90) t = t.slice(0, 89) + '…';
  return neg ? `not (${t})` : t;
}

// Payload / session fields referenced anywhere inside some condition nodes (used for skip-state parents).
function fieldsIn(nodes, env) {
  const out = new Set();
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (/MemberExpression$/.test(n.type) || n.type === 'Identifier') {
      const p = pathOf(n, env);
      if (p && (p.root === 'payload' || p.root === 'session') && p.path) { out.add(showPath(p)); return; }
      if (n.type === 'Identifier') return;
    }
    for (const k in n) if (k !== 'loc' && k !== 'start' && k !== 'end' && n[k] && typeof n[k] === 'object') visit(n[k]);
  };
  visit(nodes);
  return [...out].sort();
}

// ── Tier 1: the L2 coding standard ──
//   return runChecks([ { id, desc, path, rule, when?, reads?, custom? }, ... ], targetPayload, sessionData)
// Every property is a literal, so the rows below are read directly - nothing is inferred.
const STD_RULES = { required: 'Required', nonEmpty: 'Non-empty list', absent: 'Must be absent', eq: 'Expected value', in: 'Allowed values',
  regex: 'Format', eqSession: 'Matches', eqPath: 'Matches', existsIn: 'Exists in', contains: 'Must contain', gte: 'Comparison', lte: 'Comparison' };
function objLit(n) {                       // ObjectExpression / ArrayExpression of literals → JS value (functions → '<fn>')
  if (!n) return undefined;
  if (n.type === 'ObjectExpression') { const o = {}; for (const p of n.properties) { if (p.type !== 'ObjectProperty') return undefined; o[p.key.name ?? p.key.value] = objLit(p.value); } return o; }
  if (n.type === 'ArrayExpression') return n.elements.map(objLit);
  if (isFn(n)) return '<fn>';
  if (n.type === 'RegExpLiteral') return `/${n.pattern}/${n.flags}`;
  const l = literal(n); return l;
}
const stdPath = (p) => (typeof p === 'string' ? p.replace(/^\$\.message\./, '').replace(/^\$\./, '').replace(/\[\*\]/g, '[]') : '');
function stdWhen(w) {
  if (!w || typeof w !== 'object') return { text: '', fields: [] };
  const list = Array.isArray(w) ? w : [w];
  const parts = list.map(x => {
    if (x.session) return { text: `session data has ${x.session}`, field: `session data: ${x.session}` };
    const f = stdPath(x.path);
    if ('eq' in x) return { text: `${f} is ${x.eq}`, field: f };
    if ('in' in x) return { text: `${f} is one of ${[].concat(x.in).join(', ')}`, field: f };
    if ('includes' in x) return { text: `${f} includes ${x.includes}`, field: f };
    return { text: `${f} is present`, field: f };
  });
  return { text: parts.map(p => p.text).join(' and '), fields: parts.map(p => p.field) };
}
function parseStandard(fn, code) {
  let call = null;
  const visit = (n) => {
    if (!n || typeof n !== 'object' || call) return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (n !== fn && isFn(n)) return;
    if (n.type === 'ReturnStatement' && /CallExpression$/.test(n.argument?.type || '') && n.argument.callee.type === 'Identifier' && n.argument.callee.name === 'runChecks') call = n.argument;
    for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') visit(n[k]);
  };
  visit(fn.body);
  if (!call || call.arguments[0]?.type !== 'ArrayExpression') return null;
  const checks = [];
  for (const el of call.arguments[0].elements) {
    const c = objLit(el) || {};
    const ruleKey = typeof c.rule === 'string' ? c.rule : (c.rule && typeof c.rule === 'object' ? Object.keys(c.rule)[0] : (c.custom ? 'custom' : ''));
    const ruleVal = c.rule && typeof c.rule === 'object' ? c.rule[ruleKey] : undefined;
    const w = stdWhen(c.when);
    const type = c.custom ? 'Custom (declared)' : (STD_RULES[ruleKey] || 'Custom logic');
    const firstRead = Array.isArray(c.reads) && typeof c.reads[0] === 'string' ? c.reads[0] : '';
    const field = typeof c.path === 'string' ? { root: 'payload', path: c.path.replace(/^\$\./, '').replace(/\[\*\]/g, '[]') }
      : firstRead.startsWith('session:') ? { root: 'session', path: firstRead.slice(8) }
      : { root: 'payload', path: firstRead.replace(/^\$\./, '').replace(/\[\*\]/g, '[]') };
    let other = null, values;
    if (ruleKey === 'eqSession') other = { root: 'session', path: String(ruleVal) };
    else if (ruleKey === 'eqPath' || ruleKey === 'existsIn') other = String(ruleVal).startsWith('session:') ? { root: 'session', path: String(ruleVal).slice(8) } : { root: 'payload', path: String(ruleVal).replace(/^\$\./, '').replace(/\[\*\]/g, '[]') };
    else if (ruleVal !== undefined) values = [].concat(ruleVal);
    checks.push({ type, field, other, values, id: c.id || '', msg: c.desc || '', code: 400,
      guard: w.text ? `only when ${w.text}` : '', guardFields: w.fields,
      reads: Array.isArray(c.reads) ? c.reads.join(', ') : '', condition: src(code, el), text: c.desc || '' });
  }
  return checks;
}

// Walk the main function and collect every failing return with its condition and guards.
// opts (all optional; without opts the behaviour is unchanged):
//   fnName      analyse this top-level function instead of the detected main one (e.g. a helper generate() calls)
//   paramRoots  { paramName: 'payload' | 'session' } instead of "1st parameter = payload, 2nd = session"
//   mode        'generator': every throw new Error(...) outside a catch is a failure point (generate() has no { valid: false })
export function analyseFunction(code, babelParse, opts = {}) {
  let ast;
  try { ast = babelParse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['typescript'] }); }
  catch (e) { return { error: `parse error: ${e.message}` }; }
  let fn = findMainFunction(ast);
  if (opts.fnName) {
    let hit = null;
    for (const st of ast.program.body) {
      if (st.type === 'FunctionDeclaration' && st.id?.name === opts.fnName) hit = st;
      if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id?.name === opts.fnName && isFn(d.init)) hit = d.init;
    }
    fn = hit;
  }
  if (!fn) return { error: 'no function found' };
  const localFns = new Set(); const fnDefs = new Map();
  const scanFns = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(scanFns);
    if (n.type === 'FunctionDeclaration' && n !== fn && n.id) localFns.add(n.id.name);
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && isFn(n.init)) { localFns.add(n.id.name); fnDefs.set(n.id.name, n.init); }
    if (n.type === 'FunctionDeclaration' && n !== fn && n.id) fnDefs.set(n.id.name, n);
    for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') scanFns(n[k]);
  };
  scanFns(ast.program);
  // validate(targetPayload, sessionData) - also accept other parameter names, e.g. validate(p, s)
  const roots = {}; const [p0, p1] = fn.params || [];
  if (opts.paramRoots) Object.assign(roots, opts.paramRoots);
  else {
    if (p0?.type === 'Identifier') roots[p0.name] = 'payload';
    if (p1?.type === 'Identifier') roots[p1.name] = 'session';
  }
  const alias = collectAliases(fn);
  // boolean flags: declared false, only ever set to true inside an if → flag means "some loop element matched the if test"
  const flags = new Map();
  const vf = (n, ifTest) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(x => vf(x, ifTest));
    if (n !== fn && isFn(n)) return;
    if (n.type === 'IfStatement') { vf(n.test, null); vf(n.consequent, n.test); vf(n.alternate, null); return; }
    if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier' && n.right.type === 'BooleanLiteral' && n.right.value === true)
      (flags.get(n.left.name) || flags.set(n.left.name, []).get(n.left.name)).push(ifTest);
    for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') vf(n[k], ifTest);
  };
  vf(fn.body, null);
  for (const [name, tests] of flags) {
    const binds = alias.__all?.[name] || [];
    if (tests.some(x => !x) || !binds.some(b => b.type === 'BooleanLiteral' && b.value === false) || !binds.every(b => b.type === 'BooleanLiteral')) flags.delete(name);
  }
  const env = { alias, localFns, roots, fnDefs, flags };
  const std = opts.mode === 'generator' ? null : parseStandard(fn, code);
  if (std) return { stub: std.length === 0, checks: std, returns: 1, style: 'standard' };
  // ── Step 1: failure points - every way the code says "invalid" becomes { condition, message } ──
  //   return { valid: false, ... }                              (kind 'return')
  //   pushError(400, "...")  - a local function that pushes into an error list that decides `valid`   (kind 'report')
  //   errors.push({ ... })   - pushing straight into that list                                          (kind 'report')
  //   throw new Error("...") - inside a try whose catch returns { valid: false }                        (kind 'throw')
  const own = (root, f) => { const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n !== root && isFn(n)) return; f(n); for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') walk(n[k]); }; walk(root); };
  const isValidObj = (o, v) => o?.type === 'ObjectExpression' && o.properties.some(p => (p.key?.name ?? p.key?.value) === 'valid' && p.value?.type === 'BooleanLiteral' && p.value.value === v);
  const errArrays = new Set();     // X in  return { valid: X.length === 0 }
  own(fn, (n) => {
    if (n.type !== 'ReturnStatement' || n.argument?.type !== 'ObjectExpression') return;
    const v = n.argument.properties.find(p => (p.key?.name ?? p.key?.value) === 'valid')?.value;
    if (!v || v.type === 'BooleanLiteral') return;
    own(v, (m) => { if (/MemberExpression$/.test(m.type) && memberName(m) === 'length' && m.object.type === 'Identifier') errArrays.add(m.object.name); });
  });
  const isErrPush = (n) => /CallExpression$/.test(n?.type || '') && memberName(n.callee) === 'push' && n.callee.object?.type === 'Identifier' && errArrays.has(n.callee.object.name);
  const reporters = new Set();     // local functions whose body pushes into an error list
  for (const [name, f] of fnDefs) { let hit = false; const w = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(w); if (isErrPush(n)) hit = true; for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') w(n[k]); }; w(f.body); if (hit) reporters.add(name); }
  const fmt = (d) => (!d ? '' : d.type === 'StringLiteral' ? d.value : d.type === 'TemplateLiteral' ? d.quasis.map((q, i) => q.value.cooked + (d.expressions[i] ? `{${src(code, d.expressions[i])}}` : '')).join('') : src(code, d));
  const objProp = (o, ...ks) => o?.type === 'ObjectExpression' ? o.properties.find(p => ks.includes(p.key?.name ?? p.key?.value))?.value : undefined;
  const msgArg = (args) => {             // pushError(400, "msg") / errors.push({ code, description }) / errors.push("msg")
    const o = args.find(a => a?.type === 'ObjectExpression');
    if (o) return { msg: fmt(objProp(o, 'description', 'message', 'msg', 'error')), code: literal(objProp(o, 'code')) };
    const t = [...args].reverse().find(a => ['StringLiteral', 'TemplateLiteral', 'BinaryExpression'].includes(a?.type));
    return { msg: fmt(t), code: literal(args.find(a => a?.type === 'NumericLiteral')) };
  };
  const tryCatchFails = (t) => { let hit = false; own(t.handler?.body || {}, (n) => { if (isValidObj(n, false)) hit = true; }); return hit; };
  const siteOf = (n, anc) => {
    if (n.type === 'ReturnStatement' && isValidObj(n.argument, false)) {
      const o = n.argument; return { kind: 'return', msg: fmt(objProp(o, 'description', 'message')), code: literal(objProp(o, 'code')) };
    }
    if (n.type === 'ExpressionStatement' && /CallExpression$/.test(n.expression?.type || '')) {
      const c = n.expression;
      if (c.callee.type === 'Identifier' && reporters.has(c.callee.name)) return { kind: 'report', ...msgArg(c.arguments) };
      if (isErrPush(c)) return { kind: 'report', ...msgArg(c.arguments) };
    }
    // generator mode: if (…) return defaultPayload  → the step silently sends the default payload (a check with a fallback)
    if (opts.mode === 'generator' && n.type === 'ReturnStatement' && n.argument?.type === 'Identifier' && roots[n.argument.name] === 'payload'
      && anc.some(a => a.node.type === 'IfStatement' && a.key !== 'test')) return { kind: 'fallback', msg: 'returns defaultPayload unchanged', code: undefined };
    if (n.type === 'ThrowStatement' && n.argument?.type === 'NewExpression') {
      const t = [...anc].reverse().find(a => a.node.type === 'TryStatement' && a.key === 'block');
      if (t && tryCatchFails(t.node)) return { kind: 'throw', msg: fmt(n.argument.arguments[0]), code: undefined };
      if (opts.mode === 'generator') return { kind: 'throw', msg: fmt(n.argument.arguments[0]), code: undefined };
    }
    return null;
  };
  // ── Step 2: when does each failure point run? enclosing ifs + earlier exits in the same block ──
  //   if (x) return { valid: true }  →  later checks run only when x is false
  //   if (x) continue;               →  later checks in the loop run only when x is false
  const endsWith = (stmt, test) => { const last = stmt?.type === 'BlockStatement' ? stmt.body[stmt.body.length - 1] : stmt; return !!last && test(last); };
  const hasFailure = (n) => { let hit = false; own(n, (m) => { if (isValidObj(m, false) || isErrPush(m) || (/CallExpression$/.test(m.type) && m.callee?.type === 'Identifier' && reporters.has(m.callee.name)) || m.type === 'ThrowStatement') hit = true; }); return hit; };
  const exitOf = (stmt, anc) => {
    if (stmt?.type !== 'IfStatement' || stmt.alternate || hasFailure(stmt.consequent)) return null;
    if (endsWith(stmt.consequent, (x) => x.type === 'ReturnStatement' && isValidObj(x.argument, true))) return { node: stmt.test, neg: true, kind: 'exit' };
    const inLoop = anc.some(a => /^(For|ForOf|ForIn|While|DoWhile)Statement$/.test(a.node.type));
    if (inLoop && endsWith(stmt.consequent, (x) => x.type === 'ContinueStatement' && !x.label)) return { node: stmt.test, neg: true, kind: 'continue' };
    return null;
  };
  const fails = []; let returns = 0; const sites = { return: 0, report: 0, throw: 0 };
  const visit = (n, anc, exits) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { let acc = exits; for (const x of n) { visit(x, anc, acc); const e = exitOf(x, anc); if (e) acc = [...acc, e]; } return; }
    if (n !== fn && isFn(n)) return;
    if (n.type === 'ReturnStatement') returns++;
    const site = siteOf(n, anc);
    if (site) {
      // nearest enclosing if → failing condition; outer ifs → guards; catch → runtime error
      let cond = null; const guards = []; let inCatch = false;
      for (let i = anc.length - 1; i >= 0; i--) {
        const { node: a, key } = anc[i];
        if (a.type === 'CatchClause') { inCatch = true; break; }
        if (a.type === 'IfStatement' && key !== 'test') {
          const negated = key === 'alternate';
          if (!cond) cond = { test: a.test, negated };
          else guards.push({ text: (negated ? 'not ' : '') + src(code, a.test), node: a.test, neg: negated });
        }
      }
      guards.reverse();
      for (const e of exits) guards.push({ text: `not ${src(code, e.node)}`, node: e.node, neg: true, kind: e.kind });
      sites[site.kind] = (sites[site.kind] || 0) + 1;
      fails.push({ msg: site.msg, code: site.code, kind: site.kind, cond, guards, inCatch });
    }
    for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') visit(n[k], [...anc, { node: n, key: k }], exits);
  };
  visit(fn.body, [], []);
  const checks = [];
  for (const f of fails) {
    if (f.inCatch) continue; // runtime error handler, not a business rule
    let cs;
    if (!f.cond) cs = [{ type: 'Custom logic', text: 'unconditional failure (loop / fall-through)' }];
    else if (f.cond.negated) { cs = classify(negate(f.cond.test), env, code); if (cs.length === 1 && cs[0].type === 'Custom logic') cs = [{ type: 'Custom logic', text: `else-branch of: ${src(code, f.cond.test)}` }]; }
    else cs = classify(f.cond.test, env, code);
    for (const c of cs) {
      const when = [...(c.guardNodes || []).map(g => plainCond(g, env, code, false)), ...f.guards.map(g => plainCond(g.node, env, code, g.neg))].filter(Boolean);
      checks.push({ ...c, msg: f.msg, code: f.code, failKind: f.kind, exitGuards: f.guards.filter(g => g.kind).length, ifGuards: f.guards.filter(g => !g.kind).length + (c.guardNodes || []).length,
        guard: [c.guard, ...f.guards.map(g => `only when ${g.text}`)].filter(Boolean).join('; '),
        guardFields: fieldsIn([...(c.guardNodes || []), ...f.guards.map(g => g.node)], env),
        when: when.length ? (() => { const w = `Only when ${[...new Set(when)].join(' and ')}`; return w.length > 220 ? w.slice(0, 219) + '…' : w; })() : '',
        condition: f.cond ? src(code, f.cond.test) : '' });
    }
  }
  // a function with code but no failure point we recognise is reported, not silently treated as pass-through
  let trivial = true; own(fn.body, (m) => { if (/Statement$/.test(m.type) && !['BlockStatement', 'ReturnStatement', 'ExpressionStatement', 'EmptyStatement'].includes(m.type)) trivial = false; if (m.type === 'ReturnStatement' && !isValidObj(m.argument, true)) trivial = false; });
  const style = fails.length ? 'legacy' : trivial ? 'pass-through' : 'unrecognised';
  return { stub: fails.length === 0, checks, returns, sites, style };
}
