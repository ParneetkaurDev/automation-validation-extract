#!/usr/bin/env node
/**
 * fix-duplicates.mjs - remove L2 checks that only repeat an L1 rule, from the flow-step validate code of one branch.
 *
 *   npm run fix-duplicates -- <branch> --repo <spec repo folder> [--apply] [--git-branch <name>] [--include-covered]
 *
 * Input : out/extract/<branch>/validations.json (from `npm run extract`, same commit as the repo) - its "In L1?" result
 * Safe by design:
 *   - only checks whose L1 result is "Already in L1" (and "Covered by L1" with --include-covered)
 *   - only `if (<condition>) return { valid: false … }` with no else, whose condition yields ONLY such checks
 *     (an `if (!a || !b)` where b is not in L1 is kept whole)
 *   - "Already in L1" where both layers are conditional is skipped (conditions may differ)
 *   - a guard is kept when later code reads inside the checked field without ?. (x.y, x[0], for…of x) -
 *     removing it would make the validator crash on payloads where the field is missing
 *   - after each edit the code must still parse and the analyser must find exactly the same checks minus the removed ones;
 *     otherwise that step is left untouched
 * Without --apply nothing is written to the repo (dry run). With --git-branch the change is committed on a new local
 * branch (never pushed). Report: out/fix/<branch>/fix-report.md + .csv
 */
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
import { parseDocument, LineCounter, isMap, isSeq, isScalar } from 'yaml';
import { analyseFunction, findMainFunction, collectAliases, pathOf, showPath } from './lib/l2-analyse.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const { parse } = createRequire(import.meta.url)('@babel/parser');

const argv = process.argv.slice(2); const opt = {}; const pos = [];
for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k === '--apply' || k === '--include-covered') opt[k.slice(2)] = true; else if (k.startsWith('--')) opt[k.slice(2)] = argv[++i]; else pos.push(k); }
const branch = pos[0]; const repo = opt.repo && path.resolve(opt.repo);
if (!branch || !repo) { console.error('usage: npm run fix-duplicates -- <branch> --repo <spec repo folder> [--apply] [--git-branch <name>] [--include-covered]'); process.exit(2); }
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const jsonFile = path.resolve(here, opt.json || path.join('out', 'extract', branch.replace(/[^\w.-]+/g, '_'), 'validations.json'));
if (!fs.existsSync(jsonFile)) { console.error(`not found: ${jsonFile}\n   run first: npm run extract -- ${branch}`); process.exit(2); }
const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
const rows = data.l2.filter(r => r.branch === branch || r.branch === data.l2[0]?.branch);
// the extraction must describe the code that is in the repo
const head = git('rev-parse', '--short=7', 'HEAD'); const jcommit = (rows[0]?.commit || '').split(' ')[0].slice(0, 7);
if (jcommit && !head.startsWith(jcommit) && !jcommit.startsWith(head)) { console.error(`validations.json is from commit ${jcommit}, the repo is at ${head} - re-run extract on the same commit`); process.exit(2); }
const REMOVABLE = new Set(['Already in L1', ...(opt['include-covered'] ? ['Covered by L1'] : [])]);
const isCandidate = r => r.function === 'Payload check' && (r.failKind || 'return') === 'return' && REMOVABLE.has(r.l1Detail) && !/make sure they use the same condition/.test(r.l1Remark || '');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const src = (code, n) => norm(code.slice(n.start, n.end));
const sig = c => [c.type, JSON.stringify(c.field), JSON.stringify(c.other || null), JSON.stringify(c.values || null), norm(c.condition)].join('|');

// group rows by failure point: flow + step + condition
const byPoint = new Map();
for (const r of rows) { const k = `${r.flow}#${r.step}#${norm(r.condition)}`; (byPoint.get(k) || byPoint.set(k, []).get(k)).push(r); }
const report = []; const changedFiles = new Set(); let removedIfs = 0, removedChecks = 0;
const flowsDir = path.join(repo, 'config', 'flows');
const flowFiles = [...new Set(rows.map(r => r.flow))];
for (const rel of flowFiles) {
  const file = path.join(flowsDir, rel); let text = fs.readFileSync(file, 'utf8');
  const lc = new LineCounter(); const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: false, maxAliasCount: -1 });
  const steps = doc.get('steps', true); if (!isSeq(steps)) continue;
  const edits = [];
  steps.items.forEach((st, i) => {
    const stepNo = i + 1; if (!isMap(st)) return;
    const mock = st.get('mock', true); const node = isMap(mock) ? mock.get('validate', true) : null;
    if (!isScalar(node) || typeof node.value !== 'string') return;
    const points = [...byPoint.entries()].filter(([k]) => k.startsWith(`${rel}#${stepNo}#`));
    const todo = points.filter(([, rs]) => rs.every(isCandidate));
    for (const [, rs] of points.filter(([, rs]) => rs.some(isCandidate) && !rs.every(isCandidate)))
      report.push({ rel, step: stepNo, api: rs[0].api, status: 'kept', reason: 'same if also checks something L1 does not', condition: norm(rs[0].condition), checks: rs.map(r => `${r.checkType} ${r.field} (${r.l1Detail})`).join('; ') });
    if (!todo.length) return;
    const b64 = node.value; const code = Buffer.from(b64, 'base64').toString('utf8');
    if (Buffer.from(code, 'utf8').toString('base64') !== b64) { report.push({ rel, step: stepNo, api: todo[0][1][0].api, status: 'kept', reason: 'base64 does not round-trip - left untouched' }); return; }
    const ast = parse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['typescript'] });
    const fn = findMainFunction(ast);
    // every `if (cond) return {valid:false}` / `if (cond) { return {valid:false} }` with no else, not inside catch
    const ifs = [];
    const walk = (n, inCatch) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(x => walk(x, inCatch));
      if (n.type === 'CatchClause') inCatch = true;
      if (n.type === 'IfStatement' && !n.alternate && !inCatch) {
        const c = n.consequent; const ret = c.type === 'ReturnStatement' ? c : (c.type === 'BlockStatement' && c.body.length === 1 && c.body[0].type === 'ReturnStatement' ? c.body[0] : null);
        const ok = ret?.argument?.type === 'ObjectExpression' && ret.argument.properties.some(p => (p.key?.name ?? p.key?.value) === 'valid' && p.value?.type === 'BooleanLiteral' && p.value.value === false);
        if (ok) ifs.push(n);
      }
      for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') walk(n[k], inCatch); };
    walk(fn?.body, false);
    // places that read INSIDE a field without ?. : x.y / x[0] / for (… of x) - they throw when x is missing
    const P = (x) => String(x || '').replace(/\[[^\]]*\]/g, '');
    const env = { alias: collectAliases(fn), localFns: new Set(), fnDefs: new Map(), roots: Object.fromEntries((fn.params || []).slice(0, 2).map((p, i) => [p.name, i ? 'session' : 'payload'])) };
    const derefs = [];
    const dw = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(dw);
      const at = (x) => { const p = pathOf(x, env); if (p && p.root !== 'var' && !p.length) derefs.push({ path: P(showPath(p)), start: n.start }); };
      if (n.type === 'MemberExpression') at(n.object);
      if (n.type === 'ForOfStatement') at(n.right);
      for (const k in n) if (k !== 'loc' && n[k] && typeof n[k] === 'object') dw(n[k]); };
    dw(fn?.body);
    const remove = []; const removedRows = [];
    for (const [, rs] of todo) {
      const hits = ifs.filter(n => src(code, n.test) === norm(rs[0].condition));
      const guarded = new Set(rs.map(r => P(r.field)));
      const crash = hits.length && derefs.find(d => guarded.has(d.path) && hits.some(h => d.start > h.end));
      if (crash) { report.push({ rel, step: stepNo, api: rs[0].api, status: 'kept', reason: `guard: later code reads inside ${crash.path} without a null check - removing it would make the validator crash when ${crash.path} is missing`, condition: norm(rs[0].condition), checks: rs.map(r => `${r.checkType} ${r.field} (${r.l1Detail})`).join('; ') }); continue; }
      if (!hits.length) { report.push({ rel, step: stepNo, api: rs[0].api, status: 'kept', reason: 'failing if not found as a simple if/return (else branch, extra statements or nested in catch)', condition: norm(rs[0].condition), checks: rs.map(r => `${r.checkType} ${r.field}`).join('; ') }); continue; }
      remove.push(...hits); removedRows.push(...rs);
    }
    if (!remove.length) return;
    // cut whole lines when the if statement owns its lines, else just the statement
    const cuts = [...new Set(remove)].sort((a, b) => b.start - a.start).map(n => {
      let s = n.start, e = n.end; const ls = code.lastIndexOf('\n', s - 1) + 1; let le = code.indexOf('\n', e); if (le < 0) le = code.length;
      if (!code.slice(ls, s).trim() && !code.slice(e, le).trim()) { s = ls; e = Math.min(le + 1, code.length); }
      return [s, e]; });
    let next = code; for (const [s, e] of cuts) next = next.slice(0, s) + next.slice(e);
    // verify: parses cleanly and the analyser finds the same checks minus the removed ones
    let okParse = true; try { parse(next, { sourceType: 'unambiguous', plugins: ['typescript'] }); } catch { okParse = false; }
    const before = analyseFunction(code, parse).checks || [], after = analyseFunction(next, parse).checks || [];
    const removedConds = new Set(removedRows.map(r => norm(r.condition)));
    const expect = before.filter(c => !removedConds.has(norm(c.condition))).map(sig).sort();
    const got = after.map(sig).sort();
    if (!okParse || JSON.stringify(expect) !== JSON.stringify(got)) { report.push({ rel, step: stepNo, api: removedRows[0].api, status: 'kept', reason: okParse ? 'verification failed: other checks would change' : 'verification failed: code would not parse', condition: [...removedConds].join(' | ') }); return; }
    edits.push({ node, newB64: Buffer.from(next, 'utf8').toString('base64') });
    removedIfs += cuts.length; removedChecks += removedRows.length;
    for (const r of removedRows) report.push({ rel, step: stepNo, api: r.api, status: 'removed', reason: r.l1Detail, condition: norm(r.condition), checks: `${r.checkType} ${r.field}`, l1: r.l1Rules, remark: r.l1Remark });
  });
  if (!edits.length) continue;
  for (const { node, newB64 } of edits.sort((a, b) => b.node.range[0] - a.node.range[0])) {
    const [s, e] = node.range; if (text.slice(s, e) !== node.value) throw new Error(`${rel}: unexpected YAML scalar form at offset ${s}`);
    text = text.slice(0, s) + newB64 + text.slice(e);
  }
  // the YAML must still parse to the same steps with the new code
  const check = parseDocument(text, { uniqueKeys: false, maxAliasCount: -1 }); if (check.errors.length) throw new Error(`${rel}: YAML would not parse - nothing written`);
  if (opt.apply) { fs.writeFileSync(file, text); changedFiles.add(path.relative(repo, file)); }
}
// report
const outDir = path.join(here, 'out', 'fix', branch.replace(/[^\w.-]+/g, '_')); fs.mkdirSync(outDir, { recursive: true });
const rem = report.filter(r => r.status === 'removed'), kept = report.filter(r => r.status === 'kept');
const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const cols = ['status', 'rel', 'step', 'api', 'checks', 'condition', 'reason', 'l1', 'remark'];
fs.writeFileSync(path.join(outDir, 'fix-report.csv'), [cols.join(','), ...report.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n');
const md = [`# Duplicate L2 checks - ${branch}`, '', `Repo: ${repo} @ ${head} · ${opt.apply ? 'APPLIED' : 'dry run (nothing written)'} · removable: ${[...REMOVABLE].join(', ')}`, '',
  `- Removed: ${removedChecks} checks in ${removedIfs} \`if\` statements, ${opt.apply ? changedFiles.size : new Set(rem.map(r => r.rel)).size} flow file(s)`, `- Kept on purpose: ${kept.length} (see reasons)`, '',
  '## Removed', '', '| Flow | Step | API | Check | Condition | L1 rule |', '|---|---|---|---|---|---|', ...rem.map(r => `| ${r.rel} | ${r.step} | ${r.api} | ${r.checks} | \`${r.condition.replace(/\|/g, '\\|')}\` | ${r.l1 || ''} |`), '',
  '## Kept', '', '| Flow | Step | API | Reason | Condition |', '|---|---|---|---|---|', ...kept.map(r => `| ${r.rel} | ${r.step} | ${r.api} | ${r.reason} | \`${String(r.condition || '').replace(/\|/g, '\\|')}\` |`)].join('\n');
fs.writeFileSync(path.join(outDir, 'fix-report.md'), md + '\n');
console.log(`${opt.apply ? 'applied' : 'dry run'}: ${removedChecks} duplicate checks in ${removedIfs} if-statements; kept ${kept.length} on purpose → ${path.relative(here, outDir)}/fix-report.md`);
// optional: new local branch + commit (never pushed)
if (opt.apply && opt['git-branch'] && changedFiles.size) {
  git('checkout', '-b', opt['git-branch']); git('add', ...changedFiles);
  git('commit', '-m', `Remove L2 checks that repeat L1 rules (${branch})\n\n${removedChecks} checks in ${removedIfs} if-statements; generated by fix-duplicates.mjs, see out/fix/${branch}/fix-report.md`);
  console.log(`committed on local branch ${opt['git-branch']} (not pushed): ${git('log', '-1', '--format=%h')}`);
}
