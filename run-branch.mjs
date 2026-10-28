#!/usr/bin/env node
/**
 * run-branch.mjs — the three commands behind package.json, reading spec branches straight from GitHub.
 *
 *   npm run extract -- <branch | GROUP> [<branch> ...] [--json-only] [--name combined-name] [--l1-only]
 *       L1 + L2 validations per branch                      → out/extract/<branch>/
 *
 *   npm run common  -- <GROUP> | <branch> <branch> [...] [--name <name>]
 *       one domain, several use cases (branches)             → out/common/<name>/
 *         1_common/        validations present in ALL use cases
 *         2_intersection/  present in more than one but not all (Present in / Missing in / Remarks)
 *         3_specific/      one file per use case with only its own validations
 *         <name>_summary   counts per use case
 *       every file as .json (sorted keys), .csv and .xlsx
 *       <GROUP> = a group from branch-groups.json (TRV, RET, FIS, ...) → name defaults to <GROUP>-common
 *
 *   npm run check-generators -- <branch | GROUP> [...] [--flow <text>]
 *       mock generators: dynamic ids, meetsRequirements() coverage, code quality  → out/generators/<branch>/
 *
 *   npm run compare -- <branch> [<GROUP | common-name | path/to/common.json>]
 *       no common given → auto-picks the common report in out/common/ that fits the branch's domain
 *       extract <branch> and compare it with a common list   → out/compare/<branch>_vs_<name>/
 *
 * Branches are fetched directly from GitHub (no local clone needed) into a small cache folder.
 *   SPEC_REPO_URL  default https://github.com/ONDC-Official/automation-specifications.git
 *                  (or pass --from <owner/repo | url>, e.g. --from ParneetkaurDev/automation-specifications)
 *   SPEC_CACHE     default ./.spec-cache
 *   --no-fetch     use what is already in the cache (offline)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const safe = (x) => String(x || '').replace(/[^\w.-]+/g, '_');
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: here, stdio: 'inherit', ...opts }).status ?? 1;

// ── args ──
const [cmd, ...argv] = process.argv.slice(2);
const pos = [], opt = {}, passthrough = [];
const valueOpts = new Set(['--name', '--from', '--exclude', '--flow', '--runtime-keys']);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (!k.startsWith('--')) pos.push(k);
  else if (valueOpts.has(k)) opt[k.slice(2)] = argv[++i];
  else if (k === '--no-fetch') opt.noFetch = true;
  else passthrough.push(k); // --json-only, --l1-only, --include-requirements → extractor
}
const USAGE = `usage:
  npm run extract -- <branch | GROUP> [<branch> ...] [--json-only] [--name combined-name]
  npm run common  -- <TRV|RET|FIS|...>                          (groups in branch-groups.json)
  npm run common  -- <branch> <branch> [...] [--name <name>]
  npm run compare -- <branch> [<TRV|RET|FIS | common-name | common.json>]   (leave out to auto-pick)
  npm run check-generators -- <branch | TRV|RET|FIS> [<branch> …] [--flow <text>] [--full]   (generator / requirements / duplicate checks, read-only)`;
const GROUPS = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'branch-groups.json'), 'utf8')); } catch { return {}; } })();
const groupKey = (x) => Object.keys(GROUPS).find((k) => !k.startsWith('_') && k.toLowerCase() === String(x).toLowerCase());
if (!['extract', 'common', 'compare', 'check-generators'].includes(cmd) || !pos.length) die(USAGE);

// ── GitHub fetch into a bare cache repo ──
let url = opt.from || process.env.SPEC_REPO_URL || 'https://github.com/ONDC-Official/automation-specifications.git';
if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}.git`;
const CACHE = path.resolve(here, process.env.SPEC_CACHE || '.spec-cache');
const git = (...a) => execFileSync('git', ['-C', CACHE, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).toString().trim();

function fetchBranches(branches) {
  branches = branches.map((b) => b.replace(/^(origin|upstream)\//, ''));
  if (!fs.existsSync(path.join(CACHE, 'HEAD'))) execFileSync('git', ['init', '--quiet', '--bare', CACHE]);
  if (!opt.noFetch) {
    console.log(`── fetch from ${url.replace(/^https:\/\/github.com\//, 'github:')}: ${branches.join(', ')}`);
    const st = run('git', ['-C', CACHE, 'fetch', '--quiet', '--depth', '1', '--no-tags', url, ...branches.map((b) => `+refs/heads/${b}:refs/heads/${b}`)]);
    if (st !== 0) {
      const missing = branches.filter((b) => { try { return !execFileSync('git', ['ls-remote', '--heads', url, b]).toString().trim(); } catch { return false; } });
      if (missing.length) {
        let all = [];
        try { all = execFileSync('git', ['ls-remote', '--heads', url]).toString().split('\n').map((l) => l.split('refs/heads/')[1]).filter(Boolean); } catch {}
        for (const m of missing) {
          const key = (m.replace(/^draft-/, '').match(/^[A-Za-z]+/) || [''])[0].toLowerCase();
          const near = all.filter((b) => b.startsWith('draft-') && b.toLowerCase().includes(key));
          console.error(`   branch not found on GitHub: ${m}${near.length ? `\n     draft branches like it: ${near.join(', ')}` : ''}`);
        }
        process.exit(2);
      }
      console.warn('   fetch failed (network?) — using the cached copy');
    }
  }
  for (const b of branches) {
    try { console.log(`   ${b.padEnd(34)} ${git('log', '-1', '--format=%h %cs', b)}`); }
    catch { die(`   ${b} is not in the cache — run again without --no-fetch`); }
  }
  return branches;
}

function extract(branches, outDir, extra = []) {
  const st = run(node, ['extract-validations.mjs', '--repo', CACHE, ...branches.flatMap((b) => ['--ref', b]), '--out', outDir, ...extra, ...passthrough]);
  if (st > 1) process.exit(st);
  const json = path.join(here, outDir, 'validations.json');
  const data = JSON.parse(fs.readFileSync(json, 'utf8'));
  // branch label inside validations.json (x-branch-name from the spec, falls back to the git branch)
  const labels = [...new Set([...data.l1, ...data.l2].map((r) => r.branch))];
  return { json: path.relative(here, json), labels, ok: st === 0 };
}

// ── commands ──
if (cmd === 'extract') {
  // one workbook per branch: L1 · L2 per use case · L2 Common / Intersection / Specific between its use cases · Use cases · L2 vs L1
  const expanded = [...new Set(pos.flatMap((p) => (groupKey(p) ? GROUPS[groupKey(p)] : [p])))];
  const branches = fetchBranches(expanded);
  let failed = false;
  for (const b of branches) {
    const out = path.join('out', 'extract', safe(b));
    console.log(`── extract L1 + L2 → ${out}`);
    if (!extract([b], out).ok) failed = true;
  }
  // 2+ branches: one more workbook comparing every branch · use case with each other
  if (branches.length > 1) {
    const name = opt.name || (pos.length === 1 && groupKey(pos[0]) ? `${groupKey(pos[0])}-combined` : 'combined-' + branches.map((b) => b.replace(/^draft-/, '')).join('+'));
    const out = path.join('out', 'extract', safe(name));
    console.log(`── combined: ${branches.length} branches → ${out}`);
    if (!extract(branches, out, ['--combined-only']).ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (cmd === 'common') {
  const groups = pos.map(groupKey).filter(Boolean);
  const expanded = [...new Set(pos.flatMap((p) => (groupKey(p) ? GROUPS[groupKey(p)] : [p])))];
  if (expanded.length < 2) die('common needs a group or at least 2 branches\n' + USAGE + `\n   groups: ${Object.keys(GROUPS).filter((k) => !k.startsWith('_')).join(', ')}`);
  if (groups.length) console.log(`── group ${groups.join(' + ')}: ${expanded.length} branches`);
  const branches = fetchBranches(expanded);
  const name = opt.name || (groups.length && groups.length === pos.length ? groups.join('+') + '-common'
    : 'common-' + branches.map((b) => b.replace(/^draft-/, '')).join('+'));
  const dir = path.join('out', 'common', safe(name));
  console.log(`── extract ${branches.length} branches → ${dir}/source`);
  const { json, labels } = extract(branches, path.join(dir, 'source'), ['--json-only']);
  console.log('── split into common / intersection / use-case specific');
  const st = run(node, ['gold.mjs', 'partition', '--in', json, '--branches', labels.join(','), '--name', name, '--out', dir]);
  if (st === 0) console.log(`\nUse:  npm run compare -- <branch> ${groups.length === 1 && !opt.name ? groups[0] : name}`);
  process.exit(st);
}


if (cmd === 'check-generators') {   // mock generate() / meetsRequirements() / saveData checks per flow step - read-only
  const expanded = [...new Set(pos.flatMap((p) => (groupKey(p) ? GROUPS[groupKey(p)] : [p])))];
  const branches = fetchBranches(expanded);
  const args = ['check-generators.mjs', '--repo', CACHE, ...branches.flatMap((b) => ['--ref', b]), '--out', path.join('out', 'generators')];
  if (opt.flow) args.push('--flow', opt.flow);
  if (opt['runtime-keys']) args.push('--runtime-keys', opt['runtime-keys']);
  if (passthrough.includes('--full')) args.push('--full');
  process.exit(run(node, args));
}
// ── which common set to compare with ──
const COMMON_DIR = path.join(here, 'out', 'common');
const inCommon = (n) => path.join('out', 'common', safe(n), '1_common', `${safe(n)}_common.json`);
function listCommonSets() {   // every common report built with `npm run common`
  if (!fs.existsSync(COMMON_DIR)) return [];
  return fs.readdirSync(COMMON_DIR).flatMap((d) => {
    const dir = path.join(COMMON_DIR, d);
    const sum = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).find((f) => f.endsWith('_summary.json')) : null;
    const c1 = path.join(dir, '1_common'); const file = fs.existsSync(c1) ? fs.readdirSync(c1).find((f) => f.endsWith('_common.json')) : null;
    if (!sum || !file) return [];
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, sum), 'utf8'));
      return [{ name: m.name || d, file: path.relative(here, path.join(c1, file)), useCases: m.use_cases || [], domains: (m.per_use_case || []).map((u) => u.Domain).filter(Boolean),
        common: m.common, mtime: fs.statSync(path.join(dir, sum)).mtimeMs }];
    } catch { return []; }
  });
}
function findCommon(arg) {
  const gk = groupKey(arg);
  const candidates = [...(gk ? [inCommon(`${gk}-common`)] : []), arg, inCommon(arg), path.join('out', 'common', safe(arg), safe(arg) + '.csv'), path.join('gold', arg), path.join('gold', arg + '.csv')];
  const hit = candidates.find((c) => /\.(csv|json)$/.test(c) && fs.existsSync(path.resolve(here, c)));
  if (hit) return hit;
  const have = listCommonSets().map((c) => c.name);
  die(`common set not found: ${arg}${have.length ? `\n   available: ${have.join(', ')}` : ''}\n   build one with: npm run common -- ${gk || '<GROUP | branch branch ...>'}\n   or leave it out to auto-pick: npm run compare -- <branch>`);
}
// No common set given → pick the report that fits the branch's domain (read from config/index.yaml of the branch):
//   4 every use case has the same domain (e.g. all ONDC:TRV11)   3 some use cases have it
//   2 same domain family (ONDC:FIS12:SL ↔ ONDC:FIS12 / FIS12:BL)  1 same prefix (TRV11 ↔ TRV10, TRV13 …)
// A set the branch itself was built from is only used when nothing else fits (it would match itself).
function autoPickCommon(b) {
  let domain = '';
  try { domain = (/^\s*domain:\s*["']?([^\s"']+)/m.exec(git('show', `${b}:config/index.yaml`)) || [])[1] || ''; } catch {}
  const sets = listCommonSets();
  if (!sets.length) die(`no common reports yet in out/common/ - build one first, e.g.\n   npm run common -- <branch> <branch> --name <name>   or   npm run common:trv`);
  const fam = (d) => String(d).split(':').slice(0, 2).join(':');
  const pre = (d) => (String(d).split(':')[1] || '').replace(/\d.*$/, '');
  const me = b.replace(/^draft-/, '');
  const scored = sets.map((c) => {
    const ds = c.domains;
    const score = !domain || !ds.length ? 0 : ds.every((d) => d === domain) ? 4 : ds.includes(domain) ? 3 : ds.every((d) => fam(d) === fam(domain)) ? 2 : ds.every((d) => pre(d) === pre(domain)) ? 1 : 0;
    const why = ['', `same domain prefix ${pre(domain)}`, `same domain family ${fam(domain)}`, `some use cases are ${domain}`, `all use cases are ${domain}`][score];
    return { ...c, score, why, self: c.useCases.includes(me) };
  }).filter((c) => c.score > 0)
    .sort((x, y) => (x.self - y.self) || (y.score - x.score) || (y.useCases.length - x.useCases.length) || (y.mtime - x.mtime));
  if (!scored.length) die(`no common report fits ${b} (domain ${domain || 'unknown'})\n   available: ${sets.map((c) => `${c.name} [${[...new Set(c.domains)].join(', ')}]`).join('; ')}\n   pick one: npm run compare -- ${b} <name>`);
  const best = scored[0];
  console.log(`── auto-picked common set: ${best.name}  (${best.why}; built from ${best.useCases.join(', ')}; ${best.common} common validations)`);
  if (best.self) console.log(`   note: ${me} is one of the use cases this set was built from, so it matches its own validations`);
  if (scored.length > 1) console.log(`   other fits: ${scored.slice(1, 6).map((c) => `${c.name} (${c.why}${c.self ? ', includes this branch' : ''})`).join('; ')}\n   to use another: npm run compare -- ${b} <name>`);
  return best.file;
}

if (cmd === 'compare') {
  const [branch, commonArg] = pos;
  const [b] = fetchBranches([branch]);
  const goldCsv = commonArg ? findCommon(commonArg) : autoPickCommon(b);
  const goldName = path.basename(goldCsv).replace(/\.(csv|json)$/, '');
  const dir = path.join('out', 'compare', `${safe(b)}_vs_${safe(goldName)}`);
  console.log(`── extract L1 + L2 → ${dir}/report`);
  const { json, labels } = extract([b], path.join(dir, 'report'));
  const label = labels[0] || b;
  console.log(`── compare with ${goldName}`);
  const rc = run(node, ['gold.mjs', 'compare', '--in', json, '--gold', goldCsv, '--branch', label, '--max-warnings', '0', '--out', path.join(dir, 'compare')]);
  if (rc > 1) process.exit(rc);
  const short = b.replace(/^draft-/, '');
  const business = path.join(dir, `${safe(short)}_vs_${safe(goldName)}.xlsx`);
  console.log('── business report');
  const py = run('python3', ['domain-report.py', '--in', json, '--gold', goldCsv,
    '--compare', path.join(dir, 'compare', `${safe(label)}_vs_${safe(path.basename(goldCsv))}.xlsx`),
    '--branch', label, '--label', short, '--out', business]);
  console.log(`\nOpen: ${py === 0 ? business + '   (business view: Matching / Missing / Needs review / Extra)\n      ' : ''}${path.join(dir, 'compare', safe(label) + '_fix-list.md')}   (developer fix list)`);
  console.log(rc === 1 ? 'Result: FAIL (missing or blocker validations)' : 'Result: PASS');
  process.exit(rc);
}
