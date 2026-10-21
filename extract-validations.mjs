#!/usr/bin/env node
/**
 * extract-validations.mjs — deterministic L1 + L2 validation extractor (single file).
 *
 * L1 = config/validations/index.yaml (_TESTS_ / x-validations)
 * L2 = config/flows/**.yaml → steps[].mock.validate (payload checks) and steps[].mock.requirements
 *      (session prerequisites), base64 JavaScript decoded and parsed into a syntax tree.
 *
 * Writes, per domain/branch:
 *   <out>/<DOMAIN>_<VERSION>_<BRANCH>_validations.xlsx  tabs 'L1 Validations' + 'L2 Validations': API, Field, Check, Values, Runs, Validation
 *   <out>/validations.json                              machine-readable { l1: [...], l2: [...] }
 *
 * Usage
 *   node extract-validations.mjs --config ./config --out ./validation-report
 *   node extract-validations.mjs --repo ../automation-specifications --ref origin/draft-FIS12-PF-2.3.0 --out ./validation-report
 *   node extract-validations.mjs --repo ../automation-specifications --ref-pattern 'origin/draft-FIS1*' --out ./validation-report
 *
 * Options
 *   --config <dir>                 a checked-out config folder (repeatable)
 *   --repo <dir> --ref <git ref>   read straight from git without checkout (repeatable --ref)
 *   --ref-pattern <glob>           all refs matching the pattern
 *   --exclude <text>               skip refs containing text (repeatable)
 *   --out <dir>                    output folder (default ./validation-report)
 *   --l1-only                      skip L2
 *   --include-requirements         also extract requirements() and 'session data … must be present' checks (skipped by default)
 *   --json-only                    skip xlsx generation
 *
 * No AI: every cell comes from the source files through fixed rules — same input, same output.
 * L2 code that does not follow a recognised pattern is reported as "Custom logic", never guessed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseDocument, LineCounter, isMap, isSeq, isAlias, isScalar } from 'yaml';
import ExcelJS from 'exceljs';
import { analyseFunction, showPath, sentenceL2, setSaved } from './lib/l2-analyse.mjs';
import { annotateL2, IN_L1_VALUES, IN_L1_HELP } from './lib/l1-vs-l2.mjs';

// ───────────────────────────── CLI ─────────────────────────────
function parseArgs(argv) {
  const a = { config: [], ref: [], exclude: [], out: './validation-report', jsonOnly: false, l1Only: false, includeSession: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--config') { a.config.push(v); i++; }
    else if (k === '--repo') { a.repo = v; i++; }
    else if (k === '--ref') { a.ref.push(v); i++; }
    else if (k === '--ref-pattern') { a.refPattern = v; i++; }
    else if (k === '--exclude') { a.exclude.push(v); i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--json-only') a.jsonOnly = true;
    else if (k === '--l1-only') a.l1Only = true;
    else if (k === '--include-requirements') a.includeSession = true;
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0]); process.exit(0); }
  }
  return a;
}

// ───────────────────────────── sources ─────────────────────────────
function sourcesFromArgs(a) {
  const src = [];
  for (const dir of a.config) {
    src.push({
      label: path.basename(path.resolve(dir, '..')),
      read: (rel) => { const p = path.join(dir, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; },
      listFlows: () => {
        const base = path.join(dir, 'flows'); const out = [];
        const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
          const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ya?ml$/.test(e.name) && path.relative(base, p) !== 'index.yaml') out.push(path.relative(base, p).split(path.sep).join('/')); } };
        walk(base); return out;
      },
      commit: null,
    });
  }
  if (a.repo) {
    let refs = [...a.ref];
    if (a.refPattern) {
      const out = execFileSync('git', ['-C', a.repo, 'for-each-ref', '--format=%(refname:short)', `refs/remotes/${a.refPattern}`, `refs/heads/${a.refPattern}`]).toString();
      refs.push(...out.split('\n').filter(Boolean));
    }
    refs = [...new Set(refs)].filter(r => !a.exclude.some(x => r.includes(x)));
    for (const ref of refs) {
      const show = (rel) => { try { return execFileSync('git', ['-C', a.repo, 'show', `${ref}:config/${rel}`], { maxBuffer: 1 << 28 }).toString(); } catch { return null; } };
      let commit = null;
      try { commit = execFileSync('git', ['-C', a.repo, 'log', '-1', '--format=%h %cs', ref]).toString().trim(); } catch {}
      const listFlows = () => {
        try {
          return execFileSync('git', ['-C', a.repo, 'ls-tree', '-r', '--name-only', ref, '--', 'config/flows'], { maxBuffer: 1 << 26 }).toString()
            .split('\n').filter(f => /\.ya?ml$/.test(f) && f !== 'config/flows/index.yaml').map(f => f.replace(/^config\/flows\//, '')).sort();
        } catch { return []; }
      };
      src.push({ label: ref.replace(/^(origin|upstream)\//, ''), read: show, listFlows, commit });
    }
  }
  return src;
}

// ───────────────────────────── YAML helpers ─────────────────────────────
function loadYaml(text) {
  const lineCounter = new LineCounter();
  // uniqueKeys:false + YAML 1.2 alias semantics: a re-defined anchor applies to later aliases.
  const doc = parseDocument(text, { lineCounter, uniqueKeys: false, maxAliasCount: -1, prettyErrors: false });
  const fatal = doc.errors.filter(e => e.code !== 'DUPLICATE_KEY');
  if (fatal.length) throw new Error(fatal.map(e => e.message).join('; '));
  return { doc, lineCounter };
}
const deref = (node, doc) => (isAlias(node) ? node.resolve(doc) : node);
function mapGet(map, key, doc) {
  if (!isMap(map)) return undefined;
  const it = map.items.find(p => (isScalar(p.key) ? p.key.value : p.key) === key);
  return it ? deref(it.value, doc) : undefined;
}
function toJS(node, doc) {
  node = deref(node, doc);
  if (node == null) return null;
  if (isScalar(node)) return node.value;
  return node.toJS(doc, { maxAliasCount: -1 });
}
const lineOf = (node, lc) => (node && node.range ? lc.linePos(node.range[0]).line : null);

// ───────────────────────────── DSL expression parser ─────────────────────────────
// Grammar:  expr := and ('||' and)* ; and := unary ('&&' unary)* ;
//           unary := '!' unary | '(' expr ')' | pred
//           pred  := ID 'are present' | ID 'are not present' | ID 'are unique'
//                  | ID ('all in'|'any in'|'none in'|'equal to'|'greater than'|'less than'|'follow regex') ID
const BIN = [['all', 'in'], ['any', 'in'], ['none', 'in'], ['equal', 'to'], ['greater', 'than'], ['less', 'than'], ['follow', 'regex']];
function tokenize(s) {
  s = String(s).trim();   // " x are present " - surrounding spaces are valid in the YAML source
  const t = []; const re = /\s*(\|\||&&|!|\(|\)|[A-Za-z_$][\w$.]*)/y; let m;
  while (re.lastIndex < s.length && (m = re.exec(s))) t.push(m[1]);
  if (re.lastIndex < s.trimEnd().length) throw new Error(`Cannot parse expression: ${s}`);
  return t;
}
function parseExpr(src) {
  const t = tokenize(String(src)); let i = 0;
  const peek = (o = 0) => t[i + o];
  const expect = (x) => { if (t[i] !== x) throw new Error(`Expected '${x}' in: ${src}`); i++; };
  function or() { let n = and(); while (peek() === '||') { i++; n = { op: 'or', a: n, b: and() }; } return n; }
  function and() { let n = unary(); while (peek() === '&&') { i++; n = { op: 'and', a: n, b: unary() }; } return n; }
  function unary() {
    if (peek() === '!') { i++; return { op: 'not', a: unary() }; }
    if (peek() === '(') { i++; const n = or(); expect(')'); return n; }
    return pred();
  }
  function pred() {
    const left = t[i++];
    if (peek() === 'are' && peek(1) === 'present') { i += 2; return { op: 'present', x: left }; }
    if (peek() === 'are' && peek(1) === 'not' && peek(2) === 'present') { i += 3; return { op: 'not', a: { op: 'present', x: left } }; }
    if (peek() === 'are' && peek(1) === 'unique') { i += 2; return { op: 'unique', x: left }; }
    for (const [w1, w2] of BIN) if (peek() === w1 && peek(1) === w2) { i += 2; return { op: `${w1} ${w2}`, x: left, y: t[i++] }; }
    throw new Error(`Unknown operator after '${left}' in: ${src}`);
  }
  const n = or(); if (i !== t.length) throw new Error(`Trailing tokens in: ${src}`); return n;
}
const opsOf = (n, acc = new Set()) => { if (!n) return acc; if (n.op === 'and' || n.op === 'or') { opsOf(n.a, acc); opsOf(n.b, acc); } else if (n.op === 'not') opsOf(n.a, acc); else acc.add(n.op); return acc; };
const varsOf = (n, acc = new Set()) => { if (!n) return acc; if (n.a) varsOf(n.a, acc); if (n.b) varsOf(n.b, acc); if (n.x) acc.add(n.x); if (n.y) acc.add(n.y); return acc; };

// ───────────────────────────── business translation ─────────────────────────────
const KNOWN_REGEX = [
  [/d\{4\}-\\*d\{2\}-\\*d\{2\}T/, 'an RFC-3339 date-time (e.g. 2026-10-16T10:00:00.000Z)'],
  [/^\^P\(/, 'an ISO-8601 duration (e.g. PT30S, P1D)'],
  [/std\\{0,2}:\[0-9\]/, "a city code in the form std:<STD code> or '*'"],
  [/^\^\\\*\$$/, "'*' (all cities)"],
  [/\(\?!\.\*\\b\(\?:http\|https\|www\)/, 'a bare domain name (no http/https/www)'],
  [/\^https\?:/, 'a valid http(s) URL'],
];
function friendlyRegex(r) {
  const s = Array.isArray(r) ? r.join(' | ') : String(r);
  for (const [re, label] of KNOWN_REGEX) if (re.test(s)) return label;
  return `the pattern ${s}`;
}
function joinScope(scope, p) {
  if (!scope || typeof p !== 'string' || !p.startsWith('$.')) return p;
  if (/^\$\.(message|context)\b/.test(p)) return p; // absolute path: _SCOPE_ does not apply
  const s = Array.isArray(scope) ? scope[0] : scope;
  // relative path inside _SCOPE_: "$.list[*]..." → "<scope>.list[*]..."
  return s + p.slice(1);
}
function humanPath(p) {
  if (typeof p !== 'string') return String(p);
  return p
    .replace(/^\$\.message\./, '')
    .replace(/^\$\./, '')
    .replace(/\[\?\(@\.([\w.]+)\s*==\s*'([^']+)'\)\]/g, '[$1=$2]')
    .replace(/\[\*\]/g, '[]');
}
function areaOf(p) {
  const s = String(p);
  const rules = [
    [/^\$\.context/, 'Context'], [/\.issue\b/, 'Issue (IGM)'], [/xinput/, 'Forms (xinput)'], [/\.tags\b|\.list\b/, 'Tags'],
    [/\.quote\b/, 'Quote'], [/\.payments?\b/, 'Payments'], [/\.fulfillments?\b|\.stops\b/, 'Fulfillments'],
    [/\.documents\b/, 'Documents'], [/\.cancellation_terms\b/, 'Cancellation terms'], [/\.items\b/, 'Items'],
    [/\.provider\b|providers\b/, 'Provider'], [/\.catalog\b/, 'Catalog'], [/\.intent\b/, 'Search intent'], [/\.order\b|order_id/, 'Order'],
  ];
  for (const [re, a] of rules) if (re.test(s)) return a;
  return 'Other';
}
function fmtValues(v, max = 25) {
  if (Array.isArray(v)) { const flat = v.flat(Infinity).map(String); return flat.length > max ? `${flat.slice(0, max).join(', ')} … (+${flat.length - max} more)` : flat.join(', '); }
  return String(v);
}

// Describe a variable reference used in an expression.
function describeVar(name, vars, scope) {
  if (name === 'action') return { kind: 'action', text: 'the API action' };
  if (!(name in vars)) return { kind: 'unknown', text: name };
  const v = vars[name];
  if (typeof v === 'string' && v.startsWith('$.')) {
    const full = joinScope(scope, v);
    return { kind: 'path', path: full, text: humanPath(full) };
  }
  if (Array.isArray(v) && v.length && v.every(x => typeof x === 'string' && x.startsWith('$.'))) {
    const full = v.map(x => joinScope(scope, x));
    return { kind: 'path', path: full[0], text: full.map(humanPath).join(' / ') };
  }
  return { kind: 'list', values: v, text: fmtValues(v) };
}

function sentence(n, vars, scope, { negate = false } = {}) {
  const D = (x) => describeVar(x, vars, scope);
  switch (n.op) {
    case 'and': return negate ? `${sentence(n.a, vars, scope, { negate })} OR ${sentence(n.b, vars, scope, { negate })}` : `${sentence(n.a, vars, scope)} AND ${sentence(n.b, vars, scope)}`;
    case 'or': return negate ? `${sentence(n.a, vars, scope, { negate })} AND ${sentence(n.b, vars, scope, { negate })}` : `${sentence(n.a, vars, scope)} OR ${sentence(n.b, vars, scope)}`;
    case 'not': return sentence(n.a, vars, scope, { negate: !negate });
    case 'present': return `${D(n.x).text} ${negate ? 'is absent' : 'is present'}`;
    case 'unique': return `${D(n.x).text} ${negate ? 'has duplicates' : 'has no duplicate values'}`;
    case 'follow regex': return `${D(n.x).text} ${negate ? 'does not match' : 'matches'} ${friendlyRegex(vars[n.y])}`;
    case 'equal to': return `${D(n.x).text} ${negate ? 'differs from' : 'equals'} ${D(n.y).text}`;
    case 'greater than': return `${D(n.x).text} is ${negate ? 'not ' : ''}greater than ${D(n.y).text}`;
    case 'less than': return `${D(n.x).text} is ${negate ? 'not ' : ''}less than ${D(n.y).text}`;
    default: { // all in / any in / none in
      const x = D(n.x), y = D(n.y);
      const q = { 'all in': 'every value of', 'any in': 'at least one value of', 'none in': 'no value of' }[n.op];
      const target = y.kind === 'list' ? `one of [${y.text}]` : (y.kind === 'action' ? 'the API action' : `found in ${y.text}`);
      const verb = negate ? 'is NOT' : 'is';
      if (x.kind === 'action') return `the API action ${negate ? 'is not' : 'is'} ${y.kind === 'list' ? `one of [${y.text}]` : y.text}`;
      return `${q} ${x.text} ${verb} ${target}`;
    }
  }
}

// Rule statement (the thing that must hold), phrased as a requirement.
function ruleStatement(n, vars, scope) {
  if (n.op === 'present') return `${describeVar(n.x, vars, scope).text} must be present`;
  if (n.op === 'unique') return `${describeVar(n.x, vars, scope).text} must not contain duplicate values`;
  if (n.op === 'follow regex') return `${describeVar(n.x, vars, scope).text} must be ${friendlyRegex(vars[n.y])}`;
  if (n.op === 'all in') {
    const x = describeVar(n.x, vars, scope), y = describeVar(n.y, vars, scope);
    if (y.kind === 'list') return `Every ${x.text} must be one of the allowed values`;
    if (x.kind === 'list') return `${y.text} must include all of [${x.text}]`;
    return `Every ${x.text} must exist in ${y.text}`;
  }
  if (n.op === 'any in') {
    const x = describeVar(n.x, vars, scope), y = describeVar(n.y, vars, scope);
    if (y.kind === 'list') return `At least one ${x.text} must be one of the allowed values`;
    if (x.kind === 'list') return `${y.text} must include at least one of [${x.text}]`;
    return `At least one ${x.text} must exist in ${y.text}`;
  }
  if (n.op === 'equal to') return `${describeVar(n.x, vars, scope).text} must equal ${describeVar(n.y, vars, scope).text}`;
  if (n.op === 'and') return `${ruleStatement(n.a, vars, scope)}; and ${lowerFirst(ruleStatement(n.b, vars, scope))}`;
  return capFirst(sentence(n, vars, scope));
}
const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);

function ruleType(n) {
  const ops = opsOf(n);
  const t = [];
  if (ops.has('present')) t.push('Required');
  if (ops.has('all in') || ops.has('any in') || ops.has('none in')) t.push('Allowed values');
  if (ops.has('follow regex')) t.push('Format');
  if (ops.has('unique')) t.push('Unique');
  if (ops.has('equal to') || ops.has('greater than') || ops.has('less than')) t.push('Comparison');
  return t.join(' + ') || 'Other';
}

// ───────────────────────────── skip-state classification ─────────────────────────────
// Returns {cls, detail}. Self-guard: the rule only skips when its own field is absent → "optional field".
function classifyConditions(conds, rulePaths) {
  if (!conds.length) return { cls: 'Always runs' };
  const strip = (p) => String(p).replace(/\[\*\]$/, '');
  const kinds = conds.map(c => {
    const n = c.ast;
    const vs = [...varsOf(n)];
    if (vs.includes('action')) return 'action';
    if (n.op === 'not' && n.a.op === 'present') {
      const v = describeVar(n.a.x, c.vars, c.scope);
      if (v.kind === 'path' && rulePaths.some(rp => rp && (rp === v.path || strip(rp) === strip(v.path)))) return 'self';
      return 'presence';
    }
    const ops = opsOf(n);
    if ([...ops].every(o => o === 'present')) return 'presence';
    return 'value';
  });
  if (kinds.every(k => k === 'self')) return { cls: 'Optional field (checked only when present)' };
  if (kinds.every(k => k === 'self' || k === 'action')) return { cls: 'API-specific' };
  if (kinds.includes('value')) return { cls: 'Conditional – depends on a value (scenario)' };
  return { cls: 'Conditional – depends on another field being present' };
}

// ───────────────────────────── extraction ─────────────────────────────
const META = new Set(['_NAME_', '_RETURN_', '_CONTINUE_', '_DESCRIPTION_', '_SCOPE_', 'action', 'domain', 'version']);

function extractBranch(src) {
  const idxText = src.read('index.yaml');
  const valText = src.read('validations/index.yaml');
  if (!valText) return { error: 'config/validations/index.yaml not found' };
  let meta = {};
  if (idxText) {
    try {
      const { doc } = loadYaml(idxText);
      const j = doc.toJS({ maxAliasCount: -1 }) || {};
      meta = { domain: j.info?.domain, version: j.info?.version, usecases: j.info?.['x-usecases'] || [], branch: j.info?.['x-branch-name'] };
    } catch (e) { meta = { parseWarning: String(e.message) }; }
  }
  const { doc, lineCounter: lc } = loadYaml(valText);
  const root = doc.contents;
  const tests = mapGet(root, '_TESTS_', doc);
  const rows = []; const problems = [];
  if (!isMap(tests)) return { meta, rows, problems: ['_TESTS_ section missing'] };

  for (const pair of tests.items) {
    const api = isScalar(pair.key) ? pair.key.value : String(pair.key);
    const list = deref(pair.value, doc);
    if (!isSeq(list)) continue;
    for (const t of list.items) walk(deref(t, doc), { api, groups: [], conds: [], scope: null, filters: {} });
  }

  function walk(node, ctx) {
    if (!isMap(node)) return;
    const name = toJS(mapGet(node, '_NAME_', doc), doc);
    const retNode = mapGet(node, '_RETURN_', doc);
    const contRaw = toJS(mapGet(node, '_CONTINUE_', doc), doc);
    const scopeOwn = toJS(mapGet(node, '_SCOPE_', doc), doc);
    const scope = scopeOwn || ctx.scope;
    const desc = toJS(mapGet(node, '_DESCRIPTION_', doc), doc);
    const vars = {};
    for (const p of node.items) {
      const k = isScalar(p.key) ? p.key.value : String(p.key);
      if (!META.has(k)) vars[k] = toJS(p.value, doc);
    }
    const filters = { ...ctx.filters };
    for (const k of ['action', 'domain', 'version']) { const v = toJS(mapGet(node, k, doc), doc); if (v != null) filters[k] = v; }
    const line = lineOf(node, lc);
    const conds = [...ctx.conds];
    if (contRaw != null && String(contRaw).trim()) {
      try { conds.push({ expr: String(contRaw), ast: parseExpr(contRaw), vars, scope, by: name, line }); }
      catch (e) { problems.push(`${ctx.api} › ${name} (line ${line}): ${e.message}`); conds.push({ expr: String(contRaw), ast: { op: 'present', x: '?' }, vars, scope, by: name, line }); }
    }
    if (isSeq(retNode)) {
      for (const c of retNode.items) walk(deref(c, doc), { api: ctx.api, groups: [...ctx.groups, name], conds, scope, filters });
      return;
    }
    const expr = toJS(retNode, doc);
    if (expr == null) { problems.push(`${ctx.api} › ${name} (line ${line}): no _RETURN_`); return; }
    let ast;
    try { ast = parseExpr(expr); } catch (e) { problems.push(`${ctx.api} › ${name} (line ${line}): ${e.message}`); return; }

    const mainVar = [...varsOf(ast)].find(v => describeVar(v, vars, scope).kind === 'path');
    const main = mainVar ? describeVar(mainVar, vars, scope) : { path: '', text: '' };
    const valueVar = [...varsOf(ast)].find(v => v !== mainVar && describeVar(v, vars, scope).kind === 'list');
    const regexVar = ast.op === 'follow regex' || [...opsOf(ast)].includes('follow regex') ? [...varsOf(ast)].find(v => Array.isArray(vars[v]) || typeof vars[v] === 'string') : null;
    let values = '';
    if (opsOf(ast).has('follow regex')) { const rv = Object.entries(vars).find(([k]) => /reg/i.test(k)); values = rv ? `${friendlyRegex(rv[1])}\n${fmtValues(rv[1], 999)}` : ''; }
    else if (valueVar) values = fmtValues(vars[valueVar], 999);

    const rulePaths = [...varsOf(ast)].map(v => describeVar(v, vars, scope)).filter(d => d.kind === 'path').map(d => d.path);
    const { cls } = classifyConditions(conds, rulePaths);
    // fields the skip condition depends on (other than the rule's own field) → parent conditions
    const strip = (p) => String(p).replace(/\[\*\]$/, '');
    const condFields = [...new Set(conds.flatMap(c => [...varsOf(c.ast)].map(v => describeVar(v, c.vars, c.scope))
      .filter(d => d.kind === 'path' && !rulePaths.some(rp => strip(rp) === strip(d.path))).map(d => d.text)))];
    const when = conds.length
      ? conds.map(c => `Skipped when ${safeSentence(c)}${c.by !== name ? ` (inherited from ${c.by})` : ''}`).join('; ')
      : 'Always';
    const fp = crypto.createHash('sha1').update([ctx.api, main.path || '', ast.op === 'and' ? [...opsOf(ast)].sort().join('&') : ast.op, values].join('|')).digest('hex').slice(0, 12);

    rows.push({
      api: ctx.api, area: areaOf(main.path), field: main.text, jsonPath: main.path,
      validation: ruleStatement(ast, vars, scope), ruleType: ruleType(ast), values,
      when, runClass: cls, conditionExpr: conds.map(c => c.expr).join(' ; '), condFields: condFields.join('; '),
      ruleName: name, group: ctx.groups.join(' › '), expression: String(expr),
      appliesTo: [filters.domain && `domain: ${fmtValues(filters.domain)}`, filters.version && `version: ${fmtValues(filters.version)}`].filter(Boolean).join(' | '),
      description: desc || '', line, fingerprint: fp,
    });
  }
  function safeSentence(c) { try { return sentence(c.ast, c.vars, c.scope); } catch { return c.expr; } }
  return { meta, rows, problems };
}

// ═════════════════════════════ L2 (flow-step validate / requirements) ═════════════════════════════
// Every flow step may carry base64 JavaScript in mock.validate (checks the incoming payload) and
// mock.requirements (checks session prerequisites). We decode it, parse it into a syntax tree and turn
// every `return { valid: false, ... }` into one row. The failing `if` condition is mapped to a check
// type with fixed rules; anything that does not match a known pattern is reported as "Custom logic"
// (never guessed) so it can be rewritten to the lint standard later.


let INCLUDE_SESSION = false;
// "Runs" condition in plain words: checks that only run once an earlier call has happened read as such.
function runsText(c) {
  if (c.when) return c.when;   // plain "Only when …" built from the enclosing ifs and earlier exits (lib/l2-analyse.mjs)
  const f = c.guardFields || [];
  if (!f.length) return c.guard || '';
  const prev = f.map(x => /from previous call (\S+)$/.exec(x)?.[1] || (/from a previous call$|^user input/.test(x) ? 'earlier' : null));
  if (prev.every(Boolean)) {
    const calls = [...new Set(prev.filter(p => p !== 'earlier'))];
    return calls.length ? `only when previous call ${calls.join(' / ')} has the data` : 'only when the earlier data is available';
  }
  return `depends on ${f.filter((x, i) => !prev[i]).join(', ')}`;
}
function extractL2(src, babelParse) {
  const files = src.listFlows();
  const steps = []; const checks = []; const problems = [];
  for (const rel of files) {
    const text = src.read(`flows/${rel}`);
    let d;
    try { d = loadYaml(text).doc.toJS({ maxAliasCount: -1 }); } catch (e) { problems.push(`${rel}: ${e.message}`); continue; }
    if (!d || !Array.isArray(d.steps)) continue;
    const flowId = d.meta?.flowId || rel;
    const saved = new Map();
    d.steps.forEach((s, i) => {
      setSaved(new Map(saved));                                 // what earlier calls saved
      for (const [k, v] of Object.entries(s.mock?.saveData || {})) if (typeof v === 'string') saved.set(k, { api: s.api || '', path: v });
      const step = { flow: rel, flowId, step: i + 1, actionId: s.action_id || '', api: s.api || '', owner: s.owner || '' };
      // Only validate() is extracted: requirements() just checks that earlier steps saved session data,
      // which is not a payload validation. --include-requirements brings it back.
      const fns = [['validate', 'Payload check'], ...(INCLUDE_SESSION ? [['requirements', 'Prerequisite (session)']] : [])];
      for (const [fnKey, fnLabel] of fns) {
        const b64 = s.mock?.[fnKey];
        if (!b64) { step[fnKey] = 'none'; continue; }
        let code;
        try { code = Buffer.from(String(b64), 'base64').toString('utf8'); } catch { step[fnKey] = 'decode error'; continue; }
        const hash = crypto.createHash('sha1').update(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/\s+/g, '')).digest('hex').slice(0, 10);
        const r = analyseFunction(code, babelParse);
        if (r.error) { problems.push(`${rel} step ${i + 1} (${s.action_id}) ${fnKey}: ${r.error}`); step[fnKey] = 'parse error'; continue; }
        step[fnKey] = r.stub ? 'pass-through' : `${r.checks.length} check(s)`;
        step[`${fnKey}Style`] = r.style;
        step[`${fnKey}Hash`] = hash;
        for (const c of r.checks) {
          // "session data: X must be present" is a prerequisite, not a payload rule – skipped unless --include-requirements
          if (!INCLUDE_SESSION && c.field?.root === 'session' && ['Required', 'Non-empty list'].includes(c.type)) continue;
          const field = showPath(c.field);
          const values = c.values ? c.values.map(String).join(', ') : '';
          const compared = showPath(c.other);
          checks.push({
            api: step.api, flow: rel, flowId, step: i + 1, actionId: step.actionId, owner: step.owner,
            function: fnLabel, area: c.field?.root === 'session' ? 'Session data' : areaOf(c.field?.root === 'payload' ? '$.' + c.field.path : ''),
            field, fieldRoot: c.field?.root || '', checkType: c.type, validation: sentenceL2(c), comparedWith: compared, values,
            onlyWhen: runsText(c), condFields: (c.guardFields || []).join('; '), checkId: c.id || '', reads: c.reads || '',
            codeStyle: r.style, failKind: c.failKind || 'return', errorCode: c.code ?? '', errorMessage: c.msg, condition: c.condition,
            parsed: c.type === 'Custom logic' ? 'Custom logic (not machine-readable)' : r.style === 'standard' ? 'L2 standard (declared)' : 'Standard pattern', implHash: hash,
            ruleId: crypto.createHash('sha1').update([step.api, fnKey, c.type, field, compared, values].join('|')).digest('hex').slice(0, 12),
          });
        }
      }
      steps.push(step);
    });
  }
  return { steps, checks, problems };
}

// ═════════════════════════════ workbook output ═════════════════════════════
const NAVY = 'FF1F3A5F', ZEBRA = 'FFF5F7FA', FONT = 'Arial', AMBER = 'FFB54708';
const API_ORDER = ['search', 'on_search', 'select', 'on_select', 'init', 'on_init', 'confirm', 'on_confirm', 'status', 'on_status', 'update', 'on_update', 'cancel', 'on_cancel', 'track', 'on_track', 'rating', 'on_rating', 'support', 'on_support', 'issue', 'on_issue', 'issue_status', 'on_issue_status'];
const apiRank = a => { const i = API_ORDER.indexOf(a); return i < 0 ? 999 : i; };
function styleHeader(ws) {
  const r = ws.getRow(1);
  r.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  r.alignment = { vertical: 'middle', wrapText: true }; r.height = 30;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}
function bodyStyle(ws, wrapCols = []) {
  ws.eachRow((row, i) => {
    if (i === 1) return;
    row.font = { name: FONT, size: 10 };
    row.alignment = { vertical: 'top' };
    for (const c of wrapCols) row.getCell(c).alignment = { vertical: 'top', wrapText: true };
    if (i % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
  });
}
function sheet(wb, name, cols, rows, wrap = []) {
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  rows.forEach(r => ws.addRow(r));
  styleHeader(ws); bodyStyle(ws, wrap.map(k => cols.findIndex(c => c[1] === k) + 1));
  return ws;
}

// Unique L2 checks: the same check is usually copy-pasted into many flow steps.
function uniqueL2(checks) {
  const m = new Map();
  for (const c of checks) {
    const k = c.ruleId;
    if (!m.has(k)) m.set(k, { ...c, steps: new Set(), flows: new Set(), messages: new Set() });
    const u = m.get(k); u.steps.add(`${c.flow}#${c.step}`); u.flows.add(c.flow); u.messages.add(c.errorMessage);
  }
  return [...m.values()].map(u => ({ ...u, usedInSteps: u.steps.size, usedInFlows: u.flows.size, exampleMessage: [...u.messages][0] }))
    .sort((a, b) => apiRank(a.api) - apiRank(b.api) || a.function.localeCompare(b.function) || a.area.localeCompare(b.area) || a.field.localeCompare(b.field));
}

// One row per validation, in the same shape (and with the same Key) as the gold baseline, so a branch
// workbook can be compared row by row with gold/<name>.csv. Same rules as gold.mjs simplify:
// Key = Layer | API | Field | Check; duplicates collapse to the strongest copy (Always > If present > Conditional).
const GOLD_COLS = ['Key', 'Layer', 'API', 'Field', 'Check', 'Values', 'Runs', 'Depends on', 'Validation', 'Source'];
const RUN_RANK = { 'Always': 0, 'If present': 1, 'Conditional': 2 };
const VALUE_LIST = /Allowed values|Expected value/;
function goldRows(res) {
  const out = new Map();
  const normValues = (v, check) => {
    const s = String(v || '').trim(); if (!s) return '';
    return VALUE_LIST.test(check) ? s.split(',').map(x => x.trim()).filter(Boolean).sort().join(', ') : s.split('\n')[0].trim();
  };
  const add = (layer, r, check, values, runs, cond, source) => {
    const key = [layer, r.api, r.field, check].join(' | ');
    const row = { Key: key, Layer: layer, API: r.api, Field: r.field, Check: check, Values: values,
      Runs: runs + (cond ? ` (${cond})` : ''), 'Depends on': runs === 'Conditional' ? (r.condFields || '') : '',
      Validation: r.validation, Source: source, _runs: runs, 'In L1?': r.inL1 || '', 'L1 remark': r.l1Remark || '' };
    const prev = out.get(key);
    if (!prev || RUN_RANK[runs] < RUN_RANK[prev._runs]) out.set(key, row);
  };
  for (const r of res.l1.rows) {
    const runs = r.runClass === 'Always runs' ? 'Always' : r.runClass.startsWith('Optional') ? 'If present' : 'Conditional';
    add('L1', r, r.ruleType, normValues(r.values, r.ruleType), runs, runs === 'Conditional' ? r.when.replace(/^Skipped when /, 'skipped when ') : '',
      `config/validations/index.yaml:${r.line}`);
  }
  for (const r of res.l2?.checks || []) {
    const fn = r.function === 'Prerequisite (session)' ? 'requirements' : 'validate';
    add('L2', r, r.checkType, normValues(r.values || r.comparedWith, r.checkType), r.onlyWhen ? 'Conditional' : 'Always', r.onlyWhen || '',
      `config/flows/${r.flow} step ${r.step} (${r.actionId}) mock.${fn}`);
  }
  return [...out.values()].sort((x, y) => x.Key.localeCompare(y.Key));
}


// Readable layout: roomy rows with padding, light grid, one colour band per API (so each API reads as a block),
// a thicker line where a new API starts, and Runs coloured (Always = green, If present = blue, Conditional = amber).
function formatValidationSheet(ws) {
  const GRID = { style: 'thin', color: { argb: 'FFD9DEE5' } };
  const SEP = { style: 'medium', color: { argb: 'FF8A97A8' } };
  const BANDS = ['FFFFFFFF', 'FFF3F6FA'];
  const RUN_COLOURS = { Always: 'FF1E6B34', 'If present': 'FF1F5FA8', Conditional: 'FFB54708' };
  const widths = ws.columns.map(c => c.width || 12);
  const head = ws.getRow(1);
  head.height = 34;
  head.eachCell(c => { c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true }; c.border = { top: GRID, bottom: GRID, left: GRID, right: GRID }; });
  let band = 0, prevApi = null;
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const api = row.getCell(1).value;
    const newGroup = api !== prevApi;
    if (newGroup && prevApi !== null) band = 1 - band;
    prevApi = api;
    // row height: enough lines for the longest wrapped cell, plus padding
    let lines = 1;
    row.eachCell({ includeEmpty: true }, (c, col) => {
      const text = String(c.value ?? '');
      const per = Math.max(8, Math.floor((widths[col - 1] - 2) * 1.15));
      lines = Math.max(lines, text.split('\n').reduce((n, part) => n + Math.max(1, Math.ceil(part.length / per)), 0));
    });
    row.height = Math.max(24, lines * 14 + 10);
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.font = { name: FONT, size: 10, bold: col === 1 && newGroup, color: { argb: 'FF1F2933' } };
      c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BANDS[band] } };
      c.border = { top: newGroup && i > 2 ? SEP : GRID, bottom: GRID, left: GRID, right: GRID };
    });
    const runs = row.getCell(5); const kind = String(runs.value || '').split(' (')[0];
    if (RUN_COLOURS[kind]) runs.font = { name: FONT, size: 10, color: { argb: RUN_COLOURS[kind] }, bold: kind !== 'Always' };
  });
  ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
}

async function writeDomainWorkbook(file, src, res) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'extract-validations.mjs'; wb.created = new Date(0);
  // Clean business view: only what is needed to read and compare a validation (Layer = the tab, Key = API | Field | Check).
  const cols = [['API', 'API', 16], ['Field', 'Field', 44], ['Check', 'Check', 16], ['Values', 'Values', 38], ['Runs', 'Runs', 36], ['Validation', 'Validation', 62]];
  const rows = goldRows(res).sort((a, b) => apiRank(a.API) - apiRank(b.API) || a.API.localeCompare(b.API) || a.Field.localeCompare(b.Field) || a.Check.localeCompare(b.Check));
  const LCOL = { Duplicate: 'FF1E6B34' };
  for (const layer of ['L1', 'L2']) {
    const c = layer === 'L2' ? [...cols, ['In L1?', 'In L1?', 22], ['L1 remark', 'L1 remark', 80]] : cols;
    const ws = sheet(wb, `${layer} Validations`, c, rows.filter(r => r.Layer === layer), []);
    formatValidationSheet(ws);
    if (layer === 'L2') ws.eachRow((row, i) => { if (i > 1) { const cell = row.getCell(7); const col = LCOL[cell.value]; if (col) cell.font = { name: FONT, size: 10, bold: true, color: { argb: col } }; } });
  }
  // L2 vs L1 summary: one row per API, one column per result
  const l2 = rows.filter(r => r.Layer === 'L2');
  const apis = [...new Set(l2.map(r => r.API))];
  const sumRows = [...apis.map(a => ({ API: a, ...Object.fromEntries(IN_L1_VALUES.map(l => [l, l2.filter(r => r.API === a && r['In L1?'] === l).length])), Total: l2.filter(r => r.API === a).length })),
    { API: 'Total', ...Object.fromEntries(IN_L1_VALUES.map(l => [l, l2.filter(r => r['In L1?'] === l).length])), Total: l2.length }];
  const ss = sheet(wb, 'L2 vs L1', [['API', 'API', 18], ['Duplicate', 'Duplicate', 14], ['Not in L1 (-)', '-', 14], ['Total', 'Total', 10]], sumRows, []);
  ss.getRow(sumRows.length + 1).font = { name: FONT, size: 10, bold: true };
  ss.addRow([]);
  for (const l of IN_L1_VALUES) ss.addRow([l, IN_L1_HELP[l]]);
  const probs = [...res.l1.problems.map(p => ({ layer: 'L1', p })), ...(res.l2?.problems || []).map(p => ({ layer: 'L2', p }))];
  if (probs.length) sheet(wb, 'Parse problems', [['Layer', 'layer', 8], ['Problem', 'p', 140]], probs);
  await wb.xlsx.writeFile(file);
}

// ═════════════════════════════ main ═════════════════════════════
const args = parseArgs(process.argv.slice(2));
INCLUDE_SESSION = args.includeSession;
const sources = sourcesFromArgs(args);
if (!sources.length) { console.error('Nothing to read: pass --config <dir> or --repo <dir> --ref <ref>'); process.exit(2); }
let babelParse = null;
if (!args.l1Only) {
  try { babelParse = (await import('@babel/parser')).parse; }
  catch { console.error('L2 needs @babel/parser (npm install). Use --l1-only to skip L2.'); process.exit(2); }
}
fs.mkdirSync(args.out, { recursive: true });
const results = []; const allL1 = []; const allL2 = [];
for (const src of sources) {
  const res = {};
  try { res.l1 = extractBranch(src); if (res.l1.error) res.error = res.l1.error; } catch (e) { res.error = e.message; res.l1 = { rows: [], problems: [], meta: {} }; }
  if (!res.error && babelParse) { try { res.l2 = extractL2(src, babelParse); } catch (e) { res.l2 = { steps: [], checks: [], problems: [`L2 failed: ${e.message}`] }; } }
  if (res.l2) annotateL2(res.l1.rows, res.l2.checks);   // L2 vs L1: is the same validation already in L1?
  const safe = (x) => String(x || '').replace(/[^\w.-]+/g, '_');
  const meta = res.l1?.meta || {};
  const file = path.join(args.out, `${safe(meta.domain || 'UNKNOWN')}_${safe(meta.version)}_${safe(src.label)}_validations.xlsx`);
  if (!args.jsonOnly && !res.error) await writeDomainWorkbook(file, src, res);
  results.push({ src, res, file });
  const base = { domain: meta.domain, version: meta.version, branch: meta.branch || src.label, commit: src.commit };
  for (const r of res.l1?.rows || []) allL1.push({ ...base, ...r });
  for (const r of res.l2?.checks || []) allL2.push({ ...base, ...r });
  const u = res.l2 ? uniqueL2(res.l2.checks) : [];
  console.log(`${res.error ? 'ERROR' : 'ok   '}  ${src.label.padEnd(28)} ${String(meta.domain || '').padEnd(15)} ${String(meta.version || '').padEnd(6)} L1=${String(res.l1?.rows?.length ?? 0).padEnd(5)} L2 steps=${String(res.l2?.steps.length ?? '-').padEnd(5)} L2 unique=${String(u.length).padEnd(4)} custom=${String(u.filter(x => x.checkType === 'Custom logic').length).padEnd(4)} problems=${(res.l1?.problems?.length ?? 0) + (res.l2?.problems?.length ?? 0)}${res.error ? '  ' + res.error : ''}`);
}
// Stable order so two runs / two branches line up row by row: every row gets the same Key as the common (gold) list
// (Layer | API | Field | Check) and rows are sorted by branch → API (flow order) → Key → values → source location.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortRows = (layer, rows) => rows
  .map(r => ({ key: [layer, r.api, r.field, layer === 'L1' ? r.ruleType : r.checkType].join(' | '), ...r }))
  .sort((a, b) => cmp(a.branch, b.branch) || apiRank(a.api) - apiRank(b.api) || cmp(a.api, b.api) || cmp(a.key, b.key)
    || cmp(String(a.values ?? ''), String(b.values ?? '')) || cmp(String(a.comparedWith ?? ''), String(b.comparedWith ?? ''))
    || cmp(a.flow ?? '', b.flow ?? '') || (a.step ?? 0) - (b.step ?? 0) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.ruleName ?? a.condition ?? '', b.ruleName ?? b.condition ?? ''));
fs.writeFileSync(path.join(args.out, 'validations.json'), JSON.stringify({ l1: sortRows('L1', allL1), l2: sortRows('L2', allL2) }, null, 1));
console.log(`\nL1 ${allL1.length} rules, L2 ${allL2.length} check occurrences from ${results.length} branch(es) → ${path.resolve(args.out)}`);
process.exit(results.some(r => r.res.error) ? 1 : 0);
