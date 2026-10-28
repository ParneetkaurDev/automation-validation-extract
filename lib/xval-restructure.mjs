// x-validations restructure: move repeated validations of config/validations/index.yaml into one
// "_COMMON_" section at the top (named YAML anchors) and reuse them with aliases.
// Domain-agnostic: works on any branch / domain, nothing in here knows about FIS, RET, TRV, ...
//
// What becomes common (only when it appears >= minUses times with exactly the same content):
//   RULES  a list of rules (e.g. the _RETURN_ list of a CONTEXT group)          → <NAME>_CHECKS
//   RULE   one rule (_NAME_ + variables + _CONTINUE_/_SCOPE_ + _RETURN_)        → its _NAME_
//   LIST   a list of values used as a variable (enum list, regex list, tags)    → ENUM_ / REGEX_ / LIST_ <field>
// Biggest blocks go first, so a rule that only appears inside a repeated block is not split out again.
//
// Safe by construction: the loaded YAML (what the code generator receives) is exactly the same as before.
// verify() proves it by loading both texts and comparing _TESTS_ and _SESSION_DATA_ value by value.
// Existing anchors (&a1, &REQUIRED_ORDER_ID, ...) are expanded first and rebuilt under readable names.
import { parseDocument, LineCounter, visit, isMap, isSeq, isScalar, isAlias, Alias, Pair, Scalar, YAMLMap } from 'yaml';

export const DEFAULTS = { minUses: 2, minListItems: 2, minSingleValueChars: 30, commonKey: '_COMMON_', kinds: ['RULES', 'RULE', 'LIST'] };
const TO_STRING = { lineWidth: 0, flowCollectionPadding: false };
const NAME = '_NAME_', RET = '_RETURN_';

const key = (pair) => (isScalar(pair.key) ? pair.key.value : pair.key);
const mapGet = (m, k) => m.items.find((p) => key(p) === k)?.value;
const isRule = (n) => isMap(n) && n.items.some((p) => key(p) === NAME);

// canonical text of a node: same text <=> same loaded value (aliases count as their name)
function canon(n) {
  if (n == null) return 'null';
  if (isAlias(n)) return `*${n.source}`;
  if (isScalar(n)) return JSON.stringify(n.value) ?? 'undefined';
  if (isMap(n)) return `{${n.items.map((p) => `${JSON.stringify(key(p))}:${canon(p.value)}`).join(',')}}`;
  if (isSeq(n)) return `[${n.items.map(canon).join(',')}]`;
  return JSON.stringify(n);
}
function size(n) {
  if (isMap(n)) return 1 + n.items.reduce((s, p) => s + 1 + size(p.value), 0);
  if (isSeq(n)) return 1 + n.items.reduce((s, x) => s + size(x), 0);
  return 1;
}
function kindOf(n, o) {
  if (isRule(n)) return 'RULE';
  if (isSeq(n) && n.items.length >= 2 && n.items.every((x) => isRule(x) || isAlias(x))) return 'RULES';
  if (isSeq(n) && n.items.length && n.items.every(isScalar)) {
    if (n.items.length >= o.minListItems) return 'LIST';
    if (String(n.items[0].value).length >= o.minSingleValueChars) return 'LIST';
  }
  return null;
}

// walk everything under _TESTS_ and the common section; every visited node gets a place {node, set, where}
function places(root, o) {
  const out = [];
  const walk = (node, set, ctx) => {
    if (isAlias(node) || !node) return;
    const kind = kindOf(node, o);
    const from = ctx.from || node.__fromAlias || null;          // inside content that used to be an old alias
    if (kind && o.kinds.includes(kind)) out.push({ node, set, kind, ...ctx, from });
    const ruleName = isRule(node) ? mapGet(node, NAME)?.value : null;
    const rules = ruleName ? [...ctx.rules, String(ruleName)] : ctx.rules;
    if (isMap(node)) for (const p of node.items) walk(p.value, (v) => { p.value = v; }, { ...ctx, rules, varKey: key(p), owner: node, path: [...ctx.path, key(p)], from });
    else if (isSeq(node)) node.items.forEach((x, i) => walk(x, (v) => { node.items[i] = v; }, { ...ctx, rules, varKey: null, owner: node, path: [...ctx.path, i], from }));
  };
  for (const top of [o.commonKey, '_TESTS_']) {
    const sec = mapGet(root, top);
    if (!isMap(sec)) continue;
    for (const p of sec.items) walk(p.value, (v) => { p.value = v; }, { section: top, api: key(p), rules: [], varKey: key(p), owner: sec, path: [top, key(p)], from: null });
  }
  return out;
}

// ── names ──
const clean = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
function commonSuffix(names) {
  const parts = names.map((n) => clean(n).split('_'));
  const out = [];
  for (let i = 1; ; i++) {
    const w = parts[0][parts[0].length - i];
    if (!w || parts.some((p) => p[p.length - i] !== w)) break;
    out.unshift(w);
  }
  return out.join('_');
}
function fieldName(p) {           // $.message.order.fulfillments[*].type → ORDER_FULFILLMENTS_TYPE
  const str = String(p);
  const filters = [...str.matchAll(/==\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);   // tags[?(@.descriptor.code=='LOAN_INFO')]
  const segs = str.replace(/\[[^\]]*\]/g, '').replace(/^\$\.?/, '').split('.').filter(Boolean)
    .filter((x) => !['message', 'tags', 'list', 'descriptor'].includes(x));
  return clean(filters.length ? [filters[filters.length - 1], segs[segs.length - 1]].join('_') : segs.slice(-3).join('_'));
}
function proposeName(group) {
  const first = group[0];
  if (group.kind === 'RULE') return clean(mapGet(first.node, NAME).value);
  if (group.kind === 'RULES') {
    // ON_SEARCH_CONTEXT / SEARCH_CONTEXT → CONTEXT (the API name in front is dropped)
    const parents = group.map((g) => { const n = clean(g.rules[g.rules.length - 1] || g.api || 'GROUP'), a = clean(g.api) + '_';
      return n.startsWith(a) && n.length > a.length ? n.slice(a.length) : n; });
    return `${(commonSuffix(parents) || clean(parents[0])).replace(/^(\d+_)+/, '')}_CHECKS`;   // 2_OFFER_X → OFFER_X
  }
  // LIST: name it after the field it is compared with, else after the variable / rule
  const k = String(first.varKey || '');
  const pre = /reg/i.test(k) ? 'REGEX' : /tag/i.test(k) ? 'TAGS' : /enum|valid|value|type|code|status/i.test(k) ? 'ENUM' : 'LIST';
  for (const g of group) {
    if (!isMap(g.owner)) continue;
    const attr = g.owner.items.find((p) => isScalar(p.value) && /^\$\./.test(String(p.value.value)));
    if (attr) return `${pre}_${fieldName(attr.value.value)}`;
  }
  const ruleNames = group.map((g) => g.rules[g.rules.length - 1]).filter(Boolean);
  return `${pre}_${clean(ruleNames.length ? (commonSuffix(ruleNames) || ruleNames[0]) : k)}${k && pre === 'LIST' ? '' : ''}`;
}
function unique(name, taken, group) {
  const base = /^[A-Z_]/.test(name) ? name : `X_${name}`;
  const apis = group.filter((g) => g.section === '_TESTS_').map((g) => clean(g.api));
  const tries = [base, ...apis.map((a) => `${base}_${a}`)];
  let n = tries.find((t) => !taken.has(t));
  for (let i = 2; !n; i++) if (!taken.has(`${base}_${i}`)) n = `${base}_${i}`;
  taken.add(n); return n;
}
function commentsOf(n) {
  const out = [];
  const take = (x) => { for (const c of [x?.commentBefore, x?.comment]) if (c) out.push(c); };
  if (n?.comment) out.push(n.comment);                       // commentBefore of the block itself is kept on the alias
  if (isMap(n) || isSeq(n)) visit(n, { Node(_, x) { if (x !== n) take(x); }, Pair(_, p) { take(p.key); } });
  return out.join('\n');
}
const usedIn = (g) => `${g.section === '_TESTS_' ? g.api : `inside ${g.api}`}${g.rules.length ? ' › ' + g.rules.join(' › ') : ''}`;

// ── main ──
export function restructure(text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const lc = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: false, lineCounter: lc });
  const lineOf = (off) => lc.linePos(off).line;
  const srcLines = text.split('\n');
  if (doc.errors.length) throw new Error(`YAML errors: ${doc.errors.map((e) => e.message).join('; ')}`);
  const root = doc.contents;
  if (!isMap(root) || !mapGet(root, '_TESTS_')) throw new Error('not an x-validations file (_TESTS_ missing)');
  if (mapGet(root, o.commonKey)) throw new Error(`${o.commonKey} already exists - this file was restructured already`);

  // 1. old anchors → expand every alias, drop the anchors
  const oldAnchors = new Map();
  const oldAnchorLines = new Map(), oldAliasLines = new Map();
  visit(doc, { Node(_, n) { if (n.anchor && !oldAnchors.has(n.anchor)) { oldAnchors.set(n.anchor, JSON.stringify(n.toJS(doc, { maxAliasCount: -1 }))); let ln = n.range ? lineOf(n.range[0]) : null;   // the line that carries &name (can be the line above a block)
      while (ln > 1 && !srcLines[ln - 1].includes(`&${n.anchor}`)) ln--; oldAnchorLines.set(n.anchor, ln); } },
    Alias(_, a) { if (!oldAliasLines.has(a.source)) oldAliasLines.set(a.source, []); oldAliasLines.get(a.source).push(lineOf(a.range[0])); } });
  const oldAliasCount = (() => { let c = 0; visit(doc, { Alias() { c++; } }); return c; })();
  visit(doc, { Alias(_, n) { const c = n.resolve(doc).clone(); c.__fromAlias = { name: n.source, line: lineOf(n.range[0]) }; return c; } });
  visit(doc, { Node(_, n) { if (n.anchor) n.anchor = undefined; } });

  // 2. common section at the top
  const common = new YAMLMap();
  const commonPair = new Pair(new Scalar(o.commonKey), common);
  commonPair.key.commentBefore = ` ${o.commonKey}: validations used in more than one place, defined once and reused below with *NAME.\n` +
    ' Generated by automation-validation-extract (npm run restructure-xval). Edit a block here and every place that uses it changes.';
  root.items.unshift(commonPair);

  // 3. biggest repeated block first, until nothing repeats
  const taken = new Set(), defs = [], droppedComments = [], changes = [];
  // where a place was in the ORIGINAL file and what was written there
  const changeOf = (pl, name, kind, first) => {
    let oldLines = null, oldText = '', note = '';
    if (pl.from && pl.from === pl.node.__fromAlias) { oldLines = [pl.from.line, pl.from.line]; oldText = srcLines[pl.from.line - 1].trim(); note = `was a reference to the old anchor &${pl.from.name}`; }
    else if (pl.from) { oldLines = [pl.from.line, pl.from.line]; oldText = srcLines[pl.from.line - 1].trim(); note = `part of the old anchor &${pl.from.name}`; }
    else if (pl.node.range) {
      let a = lineOf(pl.node.range[0]), b = lineOf(Math.max(pl.node.range[0], pl.node.range[1] - 1));
      while (b > a && !srcLines[b - 1].trim()) b--;
      oldLines = [a, b]; oldText = srcLines.slice(a - 1, b).join('\n');
      const ind = Math.min(...oldText.split('\n').filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
      oldText = oldText.split('\n').map((l) => l.slice(ind)).join('\n');
    }
    return { block: name, kind, change: first ? 'moved' : 'replaced', where: usedIn(pl), api: pl.section === '_TESTS_' ? pl.api : null,
      inBlock: pl.section === '_TESTS_' ? null : pl.api, rulePath: pl.rules.join(' › '), oldLines, oldText, note, path: pl.path };
  };
  for (let guard = 0; guard < 5000; guard++) {
    const groups = new Map();
    for (const pl of places(root, o)) {
      const c = canon(pl.node);
      if (!groups.has(c)) groups.set(c, Object.assign([], { kind: pl.kind, size: size(pl.node) }));
      groups.get(c).push(pl);
    }
    let best = null;
    for (const g of groups.values()) if (g.length >= o.minUses && (!best || g.size > best.size)) best = g;
    if (!best) break;
    const name = unique(proposeName(best), taken, best);
    const def = best[0].node;                     // the first one moves to the top (with its comments)
    for (const pl of best.slice(1)) { const c = commentsOf(pl.node); if (c && c !== commentsOf(best[0].node)) droppedComments.push({ where: usedIn(pl), now: name, comment: c }); }
    for (const pl of best) {
      changes.push(changeOf(pl, name, best.kind, pl === best[0]));
      const a = new Alias(name);
      if (pl.node.commentBefore) a.commentBefore = pl.node.commentBefore;     // a comment above the block stays where it was
      if (pl.node.spaceBefore) a.spaceBefore = true;
      pl.set(a);
    }
    def.anchor = name;
    def.commentBefore = undefined; def.spaceBefore = undefined;
    common.items.push(new Pair(new Scalar(name), def));
    defs.push({ name, kind: best.kind, uses: best.length, size: best.size, usedIn: best.map(usedIn) });
  }
  if (!defs.length) root.items.shift();

  // 4. order the common section: lists, rules, rule lists; a block is always defined after what it uses
  const order = { LIST: 0, RULE: 1, RULES: 2 };
  const kindByName = new Map(defs.map((d) => [d.name, d.kind]));
  const deps = new Map(common.items.map((p) => { const s = new Set(); visit(p.value, { Alias(_, a) { s.add(a.source); } }); return [key(p), s]; }));
  const pending = [...common.items].sort((a, b) => order[kindByName.get(key(a))] - order[kindByName.get(key(b))] || key(a).localeCompare(key(b)));
  const sorted = [], done = new Set();
  while (pending.length) {
    const i = pending.findIndex((p) => [...deps.get(key(p))].every((d) => done.has(d)));
    const [p] = pending.splice(i < 0 ? 0 : i, 1);
    sorted.push(p); done.add(key(p));
  }
  common.items = sorted;
  sorted.forEach((p, i) => { if (i && kindByName.get(key(p)) !== kindByName.get(key(sorted[i - 1]))) p.key.spaceBefore = true; });
  const pos = new Map(sorted.map((p, i) => [key(p), i]));
  defs.sort((a, b) => pos.get(a.name) - pos.get(b.name));
  for (const d of defs) d.dependsOn = [...deps.get(d.name)];

  const out = doc.toString(TO_STRING);
  // old anchor → new name (same loaded value), else it is now part of a bigger block
  const finalDoc = parseDocument(out, { uniqueKeys: false });
  const newByValue = new Map();
  visit(finalDoc, { Node(_, n) { if (n.anchor) newByValue.set(JSON.stringify(n.toJS(finalDoc, { maxAliasCount: -1 })), n.anchor); } });
  const anchorMap = [...oldAnchors].map(([old, v]) => ({ old, now: newByValue.get(v) || '(inside a larger common block, or used once)' }));
  // where each change and each block is in the NEW file
  const lc2 = new LineCounter(); const d2 = parseDocument(out, { uniqueKeys: false, lineCounter: lc2 });
  const newLine = (path) => { const n = d2.getIn(path, true); return n?.range ? lc2.linePos(n.range[0]).line : null; };
  for (const c of changes) c.newLine = newLine(c.path);
  const commonMap = d2.get(o.commonKey, true);
  for (const d of defs) {
    const pair = commonMap.items.find((p) => key(p) === d.name), n = pair.value;
    const a = lc2.linePos(pair.key.range[0]).line, b = lc2.linePos(Math.max(n.range[0], n.range[1] - 1)).line;
    d.newLines = [a, b]; d.definition = out.split('\n').slice(a - 1, b).map((l) => l.replace(/^  /, '')).join('\n');
  }
  for (const a of anchorMap) { a.definedAt = oldAnchorLines.get(a.old); a.usedAt = oldAliasLines.get(a.old) || []; }
  return { text: out, defs, changes, anchorMap, oldAnchorCount: oldAnchors.size, oldAliasCount, droppedComments };
}

// load both texts the way a YAML loader does and compare everything except the common section
export function verify(before, after, { commonKey = DEFAULTS.commonKey, loaders = {} } = {}) {
  const problems = [];
  const loadWith = { yaml: (t) => parseDocument(t, { uniqueKeys: false }).toJS({ maxAliasCount: -1 }), ...loaders };
  for (const [name, load] of Object.entries(loadWith)) {
    let a, b;
    try { a = load(before); b = load(after); } catch (e) { problems.push(`${name}: could not load (${e.message})`); continue; }
    const strip = (x) => { const c = { ...x }; delete c[commonKey]; return c; };
    if (JSON.stringify(strip(a)) !== JSON.stringify(strip(b))) {
      for (const k of new Set([...Object.keys(strip(a)), ...Object.keys(strip(b))])) {
        const sub = (x) => x?.[k];
        if (JSON.stringify(sub(a)) !== JSON.stringify(sub(b))) {
          const apis = new Set([...Object.keys(a[k] || {}), ...Object.keys(b[k] || {})]);
          const diff = [...apis].filter((api) => JSON.stringify(a[k]?.[api]) !== JSON.stringify(b[k]?.[api]));
          problems.push(`${name}: ${k} differs${diff.length ? ' in ' + diff.join(', ') : ''}`);
        }
      }
    }
  }
  const d = parseDocument(after, { uniqueKeys: false });
  for (const e of [...d.errors, ...d.warnings]) problems.push(`yaml: ${e.message.split('\n')[0]}`);
  // every common block is used at least twice, and defined only once
  const defined = new Map(), used = new Map();
  visit(d, { Node(_, n) { if (n.anchor) defined.set(n.anchor, (defined.get(n.anchor) || 0) + 1); }, Alias(_, a) { used.set(a.source, (used.get(a.source) || 0) + 1); } });
  for (const [n, c] of defined) { if (c > 1) problems.push(`anchor &${n} defined ${c} times`); if ((used.get(n) || 0) < 2) problems.push(`&${n} used ${used.get(n) || 0} time(s)`); }
  return { ok: problems.length === 0, problems };
}
