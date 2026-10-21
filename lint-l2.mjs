#!/usr/bin/env node
/**
 * lint-l2.mjs - checks L2 flow code (mock.validate / mock.requirements, base64 in config/flows/**.yaml)
 * against the L2 coding standard (standard/L2_STANDARD.md).
 *
 *   node lint-l2.mjs --config ../config --out ./lint-report               # checked-out branch (CI)
 *   node lint-l2.mjs --repo ../automation-specifications --ref origin/draft-FIS12-PF-2.3.0 --out ./lint-report
 *   node lint-l2.mjs --repo ../automation-specifications --ref-pattern 'origin/draft-FIS12*' --out ./lint-report
 *   --strict   code not yet in the standard shape is an error (default: warning, for migration)
 *
 * Exit code 1 when any ERROR is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as babelParse } from '@babel/parser';
import { parse as parseYaml } from 'yaml';

const args = { config: [], ref: [], exclude: [], out: './lint-report', strict: false };
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  const k = av[i], v = av[i + 1];
  if (k === '--config') { args.config.push(v); i++; } else if (k === '--repo') { args.repo = v; i++; }
  else if (k === '--ref') { args.ref.push(v); i++; } else if (k === '--ref-pattern') { args.refPattern = v; i++; }
  else if (k === '--exclude') { args.exclude.push(v); i++; } else if (k === '--out') { args.out = v; i++; }
  else if (k === '--strict') args.strict = true;
}

// ── sources (same options as extract-validations.mjs) ──
const sources = [];
for (const dir of args.config) {
  const base = path.join(dir, 'flows'); const files = [];
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ya?ml$/.test(e.name) && path.relative(base, p) !== 'index.yaml') files.push(path.relative(base, p).split(path.sep).join('/')); } };
  walk(base);
  sources.push({ label: path.basename(path.resolve(dir, '..')), files, read: (f) => fs.readFileSync(path.join(base, f), 'utf8') });
}
if (args.repo) {
  let refs = [...args.ref];
  if (args.refPattern) refs.push(...execFileSync('git', ['-C', args.repo, 'for-each-ref', '--format=%(refname:short)', `refs/remotes/${args.refPattern}`, `refs/heads/${args.refPattern}`]).toString().split('\n').filter(Boolean));
  refs = [...new Set(refs)].filter((r) => !args.exclude.some((x) => r.includes(x)));
  for (const ref of refs) {
    let files = [];
    try { files = execFileSync('git', ['-C', args.repo, 'ls-tree', '-r', '--name-only', ref, '--', 'config/flows'], { maxBuffer: 1 << 26 }).toString().split('\n')
      .filter((f) => /\.ya?ml$/.test(f) && f !== 'config/flows/index.yaml').map((f) => f.replace(/^config\/flows\//, '')).sort(); } catch {}
    sources.push({ label: ref.replace(/^(origin|upstream)\//, ''), files, read: (f) => execFileSync('git', ['-C', args.repo, 'show', `${ref}:config/flows/${f}`], { maxBuffer: 1 << 28 }).toString() });
  }
}
if (!sources.length) { console.error('pass --config <dir> or --repo <dir> --ref <ref>'); process.exit(2); }

// ── rules ──
const RULES = new Set(['required', 'nonEmpty', 'absent', 'eq', 'in', 'regex', 'contains', 'gte', 'lte', 'eqSession', 'eqPath', 'existsIn']);
const isFn = (n) => n && /Function/.test(n.type);
const prop = (obj, k) => obj?.properties?.find((p) => (p.key?.name ?? p.key?.value) === k);
const isLiteral = (n) => n && (/Literal$/.test(n.type) && n.type !== 'TemplateLiteral' || (n.type === 'TemplateLiteral' && !n.expressions.length)
  || (n.type === 'ArrayExpression' && n.elements.every(isLiteral)) || (n.type === 'ObjectExpression' && n.properties.every((p) => p.type === 'ObjectProperty' && isLiteral(p.value)))
  || (n.type === 'UnaryExpression' && n.operator === '-' && n.argument.type === 'NumericLiteral'));

function mainFunction(ast) {
  const top = ast.program.body.flatMap((s) => (s.type === 'FunctionDeclaration' ? [s] : s.type === 'VariableDeclaration' ? s.declarations.map((d) => d.init).filter(isFn) : []));
  return top.find((f) => /^(validate|meetsRequirements|requirements)$/.test(f.id?.name || '')) || top.find((f) => (f.params || []).length >= 1) || top[0] || null;
}
function walk(n, fn, anc = []) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach((x) => walk(x, fn, anc));
  if (fn(n, anc) === false) return;
  for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') walk(n[k], fn, [...anc, n]);
}
const failReturn = (n) => n.type === 'ReturnStatement' && n.argument?.type === 'ObjectExpression'
  && prop(n.argument, 'valid')?.value?.type === 'BooleanLiteral' && prop(n.argument, 'valid').value.value === false;
const passReturn = (n) => n.type === 'ReturnStatement' && n.argument?.type === 'ObjectExpression'
  && prop(n.argument, 'valid')?.value?.type === 'BooleanLiteral' && prop(n.argument, 'valid').value.value === true;

function lintFunction(code) {
  const out = []; const add = (severity, rule, message) => out.push({ severity, rule, message });
  let ast;
  try { ast = babelParse(code, { sourceType: 'unambiguous', plugins: ['typescript'] }); }
  catch (e) { add('ERROR', 'L2-000', `code does not parse: ${e.message}`); return { style: 'broken', issues: out }; }
  const fn = mainFunction(ast);
  if (!fn) { add('ERROR', 'L2-000', 'no validate function found'); return { style: 'broken', issues: out }; }

  let call = null; const fails = []; const catchPass = [];
  walk(fn.body, (n, anc) => {
    if (n !== fn && isFn(n) && !anc.some((a) => a.type === 'ArrayExpression')) return false;
    if (n.type === 'ReturnStatement' && /CallExpression$/.test(n.argument?.type || '') && n.argument.callee?.name === 'runChecks') call = n.argument;
    if (failReturn(n)) fails.push({ n, anc });
    if (passReturn(n) && anc.some((a) => a.type === 'CatchClause')) catchPass.push(n);
  });
  if (catchPass.length) add('ERROR', 'L2-008', 'a catch block returns valid:true - runtime errors are silently treated as a pass');

  if (!call) {
    const real = fails.filter((f) => !f.anc.some((a) => a.type === 'CatchClause'));
    if (!real.length) return { style: 'pass-through', issues: out };
    add(args.strict ? 'ERROR' : 'WARN', 'L2-001', `not in the standard shape: ${real.length} hand-written failure return(s) instead of return runChecks([...])`);
    const hidden = real.filter((f) => f.anc.filter((a) => a.type === 'IfStatement').length >= 2).length;
    if (hidden) add('WARN', 'L2-009', `${hidden} failure(s) nested inside 2+ if-blocks - a hidden skip state; declare it as "when"`);
    return { style: 'legacy', issues: out };
  }

  // ── standard shape ──
  const outside = fails.filter((f) => !f.anc.some((a) => a.type === 'CatchClause'));
  if (outside.length) add('ERROR', 'L2-002', `${outside.length} return {valid:false} outside runChecks - every check must be declared in the list`);
  const list = call.arguments[0];
  if (list?.type !== 'ArrayExpression') { add('ERROR', 'L2-003', 'runChecks must receive an inline array literal of checks'); return { style: 'standard', issues: out }; }
  const ids = new Set();
  list.elements.forEach((el, i) => {
    const at = `check #${i + 1}`;
    if (el?.type !== 'ObjectExpression') return add('ERROR', 'L2-003', `${at} is not an object literal`);
    const id = prop(el, 'id')?.value, desc = prop(el, 'desc')?.value, p = prop(el, 'path')?.value, rule = prop(el, 'rule')?.value,
      when = prop(el, 'when')?.value, reads = prop(el, 'reads')?.value, custom = prop(el, 'custom')?.value;
    const name = id?.type === 'StringLiteral' ? id.value : at;
    if (id?.type !== 'StringLiteral' || !id.value) add('ERROR', 'L2-004', `${at}: "id" must be a non-empty string`);
    else if (ids.has(id.value)) add('ERROR', 'L2-004', `${name}: duplicate id`); else ids.add(id.value);
    if (desc?.type !== 'StringLiteral' || !desc.value.trim()) add('ERROR', 'L2-004', `${name}: "desc" must be a non-empty string (it is the business description)`);
    if (custom) {
      if (!isFn(custom)) add('ERROR', 'L2-007', `${name}: "custom" must be a function`);
      if (reads?.type !== 'ArrayExpression' || !reads.elements.length || !reads.elements.every((e) => e?.type === 'StringLiteral'))
        add('ERROR', 'L2-007', `${name}: a custom check must list the fields it reads in "reads": ['$.path', 'session:key']`);
    } else {
      if (p?.type !== 'StringLiteral' || !/^\$\./.test(p.value)) add('ERROR', 'L2-005', `${name}: "path" must be a string literal starting with $.`);
      const key = rule?.type === 'StringLiteral' ? rule.value : rule?.type === 'ObjectExpression' && rule.properties.length === 1 ? (rule.properties[0].key.name ?? rule.properties[0].key.value) : null;
      if (!key || !RULES.has(key)) add('ERROR', 'L2-006', `${name}: "rule" must be one of ${[...RULES].join(', ')}`);
      else if (rule.type === 'ObjectExpression' && !isLiteral(rule.properties[0].value) && rule.properties[0].value.type !== 'RegExpLiteral') add('ERROR', 'L2-006', `${name}: rule value must be a literal`);
    }
    if (when) {
      const conds = when.type === 'ArrayExpression' ? when.elements : [when];
      const okCond = (c) => c?.type === 'ObjectExpression' && isLiteral(c) && (prop(c, 'session') || prop(c, 'path'));
      if (!conds.every(okCond)) add('ERROR', 'L2-010', `${name}: "when" must be a literal {path, eq|in|includes} or {session} object - no inline JS, so the skip condition is visible`);
    }
  });
  return { style: 'standard', issues: out, checks: list.elements.length };
}

// ── run ──
const rows = []; const summary = [];
for (const s of sources) {
  const sum = { Branch: s.label, Functions: 0, 'Pass-through': 0, Standard: 0, Legacy: 0, Errors: 0, Warnings: 0 };
  for (const f of s.files) {
    let doc; try { doc = parseYaml(s.read(f), { maxAliasCount: -1, uniqueKeys: false }); } catch { continue; }
    (doc?.steps || []).forEach((step, i) => {
      for (const key of ['validate', 'requirements']) {
        const b64 = step.mock?.[key]; if (!b64) continue;
        const code = Buffer.from(String(b64), 'base64').toString('utf8');
        const r = lintFunction(code);
        sum.Functions++; sum[{ 'pass-through': 'Pass-through', standard: 'Standard', legacy: 'Legacy', broken: 'Legacy' }[r.style]]++;
        for (const x of r.issues) {
          if (x.severity === 'ERROR') sum.Errors++; else sum.Warnings++;
          rows.push({ Branch: s.label, Severity: x.severity, Rule: x.rule, Flow: f, Step: i + 1, 'Action id': step.action_id || '', API: step.api || '', Function: key, Message: x.message });
        }
      }
    });
  }
  sum['In standard %'] = sum.Functions ? Math.round((100 * (sum.Standard + sum['Pass-through'])) / sum.Functions) : 100;
  summary.push(sum);
  console.log(`${s.label.padEnd(28)} functions=${sum.Functions} pass-through=${sum['Pass-through']} standard=${sum.Standard} legacy=${sum.Legacy} errors=${sum.Errors} warnings=${sum.Warnings}`);
}
fs.mkdirSync(args.out, { recursive: true });
const csv = (cols, list) => [cols.join(','), ...list.map((r) => cols.map((c) => { const v = String(r[c] ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(','))].join('\n') + '\n';
fs.writeFileSync(path.join(args.out, 'l2-lint.csv'), csv(['Branch', 'Severity', 'Rule', 'Flow', 'Step', 'Action id', 'API', 'Function', 'Message'], rows));
fs.writeFileSync(path.join(args.out, 'l2-lint-summary.csv'), csv(Object.keys(summary[0] || {}), summary));
console.log(`→ ${path.resolve(args.out)}/l2-lint.csv`);
process.exit(summary.some((s) => s.Errors > 0) ? 1 : 0);
