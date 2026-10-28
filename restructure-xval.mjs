#!/usr/bin/env node
/**
 * restructure-xval.mjs - restructure the x-validations (config/validations/index.yaml) of a spec repo:
 * every validation used in more than one place is defined ONCE in a "_COMMON_" section at the top of the
 * file (named YAML anchors = the common variables / reusable blocks) and reused below with *NAME.
 *
 *   npm run restructure-xval -- --repo <spec repo folder> [--branch <branch|GROUP>[,…]] [--apply]
 *                               [--min-uses 2] [--kinds RULES,RULE,LIST] [--out <folder>] [--js-yaml <folder>]
 *
 *   no --branch   the branch checked out in --repo (working tree, uncommitted edits included)
 *   --branch      one or more branches / a group from branch-groups.json, read with `git show` from the repo
 *                 (local branch, else origin/<branch>) - one domain or many, each handled on its own
 *   --repo        can be given more than once (one repo per domain). npm run restructure-xval:current uses
 *                 ../automation-specifications; set SPEC_REPO_DIR to use another folder
 *   --apply       write the result back to config/validations/index.yaml of the working tree (only without
 *                 --branch, and only when the check below passed). Default: dry run, nothing in the repo changes.
 *
 * Domain-agnostic: lib/xval-restructure.mjs knows nothing about a domain.
 * Check: both files are loaded with `yaml` and `js-yaml` (the loader the build uses) and _TESTS_ /
 * _SESSION_DATA_ must be identical value by value; every common block is defined once and used >= 2 times.
 * The code generator (ondc-code-generator) reads only _TESTS_ and _SESSION_DATA_, so _COMMON_ changes nothing.
 * Output: out/restructure-xval/<branch>/  index.yaml (restructured) · original.yaml · changes.xlsx (what changed, place by place)
 *         · changes.diff (line diff old → new) · report.md · report.json
 */
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
import { restructure, verify, DEFAULTS } from './lib/xval-restructure.mjs';
import { writeChangesXlsx, perApi, changeText } from './lib/xval-report.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = 'config/validations/index.yaml';

// ── args ──
const argv = process.argv.slice(2); const opt = { repo: [], branch: [] };
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === '--apply') opt.apply = true;
  else if (k === '--repo' || k === '--branch') opt[k.slice(2)].push(...String(argv[++i]).split(',').filter(Boolean));
  else if (k.startsWith('--')) opt[k.slice(2)] = argv[++i];
  else opt.branch.push(k);
}
const USAGE = 'usage: npm run restructure-xval -- --repo <spec repo folder> [--branch <branch|GROUP>[,…]] [--apply] [--min-uses 2] [--kinds RULES,RULE,LIST] [--out <folder>]';
if (!opt.repo.length) { console.error(USAGE); process.exit(2); }
if (opt.apply && opt.branch.length) { console.error('--apply works only on the checked-out branch (leave out --branch)'); process.exit(2); }
const settings = { ...DEFAULTS, ...(opt['min-uses'] && { minUses: Number(opt['min-uses']) }), ...(opt.kinds && { kinds: opt.kinds.split(',').map((x) => x.trim().toUpperCase()) }) };
opt.repo = opt.repo.map((r) => (process.env.SPEC_REPO_DIR && r === '../automation-specifications' ? process.env.SPEC_REPO_DIR : r));
const GROUPS = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'branch-groups.json'), 'utf8')); } catch { return {}; } })();
const branches = opt.branch.flatMap((b) => { const g = Object.keys(GROUPS).find((k) => !k.startsWith('_') && k.toLowerCase() === b.toLowerCase()); return g ? [].concat(GROUPS[g].branches || GROUPS[g]) : [b]; });

// js-yaml: the loader the build / generator side uses (optional second check)
function findJsYaml() {
  const tries = [opt['js-yaml'], here, ...opt.repo, ...opt.repo.map((r) => path.resolve(r, '..', 'automation-api-service-generator')), path.resolve(here, '..', 'automation-api-service-generator'), path.resolve(here, '..', 'automation-db')].filter(Boolean);
  for (const t of tries) { try { return createRequire(path.join(path.resolve(t), 'package.json'))('js-yaml'); } catch {} }
  return null;
}
const jsyaml = findJsYaml();
const loaders = jsyaml ? { 'js-yaml': (t) => jsyaml.load(t) } : {};

const safe = (x) => String(x || '').replace(/[^\w.@-]+/g, '_');
let failed = 0;
for (const repoArg of opt.repo) {
  const repo = path.resolve(repoArg);
  if (!fs.existsSync(path.join(repo, '.git')) && !fs.existsSync(path.join(repo, FILE))) {
    console.error(`✗ spec repo not found: ${repo}\n   pass --repo <folder of automation-specifications> (or set SPEC_REPO_DIR)`); failed++; continue;
  }
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).toString();
  const targets = branches.length ? branches.map((b) => ({ branch: b })) : [{ branch: git('branch', '--show-current').trim() || 'HEAD', worktree: true }];
  for (const t of targets) {
    let text, commit;
    try {
      if (t.worktree) { text = fs.readFileSync(path.join(repo, FILE), 'utf8'); commit = git('rev-parse', '--short=7', 'HEAD').trim() + (git('status', '--porcelain', '--', FILE).trim() ? ' + uncommitted changes' : ''); }
      else {
        const ref = [t.branch, `origin/${t.branch}`].find((r) => { try { git('rev-parse', '--verify', '--quiet', r); return true; } catch { return false; } });
        if (!ref) throw new Error(`branch ${t.branch} not found in ${repo} (git fetch origin ${t.branch})`);
        text = git('show', `${ref}:${FILE}`); commit = git('rev-parse', '--short=7', ref).trim();
      }
    } catch (e) { console.error(`✗ ${t.branch}: ${e.message.split('\n')[0]}`); failed++; continue; }

    console.log(`── ${path.basename(repo)} · ${t.branch} @ ${commit}`);
    let r;
    try { r = restructure(text, settings); } catch (e) { console.error(`  ✗ ${e.message}`); failed++; continue; }
    const v = verify(text, r.text, { commonKey: settings.commonKey, loaders });
    const outDir = path.resolve(here, opt.out || 'out/restructure-xval', safe(t.branch));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.yaml'), r.text);
    const info = { repo, branch: t.branch, commit, file: FILE, generated: new Date().toISOString(), settings, loaders: ['yaml', ...Object.keys(loaders)],
      linesBefore: text.split('\n').length, linesAfter: r.text.split('\n').length, verify: v, ...r, text: undefined };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(info, null, 1));
    fs.writeFileSync(path.join(outDir, 'report.md'), report(info, text));
    fs.writeFileSync(path.join(outDir, 'original.yaml'), text);
    await writeChangesXlsx(path.join(outDir, 'changes.xlsx'), info);
    const diff = spawnSync('git', ['diff', '--no-index', '--no-color', '-U3', '--', 'original.yaml', 'index.yaml'], { cwd: outDir, encoding: 'utf8', maxBuffer: 1 << 26 });
    fs.writeFileSync(path.join(outDir, 'changes.diff'), diff.stdout || '');
    const byKind = (k) => r.defs.filter((d) => d.kind === k).length;
    console.log(`  ${r.defs.length} common blocks (${byKind('RULES')} rule groups, ${byKind('RULE')} rules, ${byKind('LIST')} value lists), ` +
      `${r.defs.reduce((s, d) => s + d.uses, 0)} places reuse them · lines ${info.linesBefore} → ${info.linesAfter}`);
    console.log(`  check (${info.loaders.join(' + ')}): ${v.ok ? 'identical ✓' : 'FAILED ✗'}${v.ok ? '' : '\n    ' + v.problems.join('\n    ')}`);
    if (!jsyaml) console.log('  note: js-yaml not found (pass --js-yaml <folder with node_modules/js-yaml>) - checked with yaml only');
    console.log(`  → ${path.relative(process.cwd(), outDir)}/ (index.yaml, changes.xlsx, changes.diff, report.md, report.json)`);
    if (!v.ok) { failed++; continue; }
    if (opt.apply) { fs.writeFileSync(path.join(repo, FILE), r.text); console.log(`  applied → ${path.join(repo, FILE)} (not committed)`); }
  }
}
process.exit(failed ? 1 : 0);

function report(i, before) {
  const L = [];
  const kinds = { RULES: 'Rule group', RULE: 'Rule', LIST: 'Value list' };
  const apis = (d) => [...new Set(d.usedIn.map((u) => u.split(' › ')[0]))].join(', ');
  L.push(`# x-validations restructure - ${i.branch}`, '',
    `Repo \`${i.repo}\` · branch **${i.branch}** @ \`${i.commit}\` · file \`${i.file}\` · ${i.generated.slice(0, 16).replace('T', ' ')} UTC`, '',
    '## Summary', '', '| | |', '|---|---|',
    `| Lines | ${i.linesBefore} → ${i.linesAfter} |`,
    `| Common blocks in \`${i.settings.commonKey}\` | ${i.defs.length} (${i.defs.filter((d) => d.kind === 'RULES').length} rule groups, ${i.defs.filter((d) => d.kind === 'RULE').length} rules, ${i.defs.filter((d) => d.kind === 'LIST').length} value lists) |`,
    `| Places that now reuse a block | ${i.defs.reduce((s, d) => s + d.uses, 0)} |`,
    `| Anchors before | ${i.oldAnchorCount} anchors (e.g. \`&a1\`), ${i.oldAliasCount} aliases - rebuilt under readable names |`,
    `| Check | ${i.verify.ok ? '**identical** ✓' : '**FAILED** ✗'} - _TESTS_ and _SESSION_DATA_ loaded with ${i.loaders.join(' and ')} are the same before and after |`, '');
  if (!i.verify.ok) L.push('### Problems', '', ...i.verify.problems.map((p) => `- ${p}`), '');
  L.push('## How to read the new file', '',
    `- \`${i.settings.commonKey}\` is the first key. Each entry is \`NAME: &NAME <block>\`; the rules below use it as \`*NAME\`.`,
    '- **Rule group** (`…_CHECKS`): a whole `_RETURN_` list shared by several APIs, e.g. the context checks.',
    '- **Rule**: one rule (`_NAME_` + variables + `_CONTINUE_` + `_RETURN_`) used in several places.',
    '- **Value list** (`ENUM_`/`REGEX_`/`TAGS_`/`LIST_`): an enum / regex / tag list used as a variable in several rules.',
    '- Changing a block in `_COMMON_` changes every place that uses it. To change only one place, replace its `*NAME` with a copy of the block.',
    '- The code generator reads only `_TESTS_` and `_SESSION_DATA_`; `_COMMON_` itself produces no tests.', '');
  L.push('## What changed, per API', '', 'Every row in `changes.xlsx` → **Changes** is one place in the old file: its old lines and text, and the `*NAME` that replaced it. `changes.diff` is the line diff.', '',
    '| API | Places changed | Moved to `_COMMON_` | Replaced by reference | Old lines replaced | Common blocks used |', '|---|---|---|---|---|---|',
    ...perApi(i).map((e) => `| ${e.api} | ${e.places} | ${e.moved} | ${e.replaced} | ${e.oldLines} | ${[...e.blocks].map((b) => `\`${b}\``).join(', ')} |`), '');
  L.push('## Changes (old line → new line)', '', '| Old lines | API › rule | Change | New line |', '|---|---|---|---|',
    ...[...i.changes].filter((c) => c.api).sort((a, b) => (a.oldLines?.[0] ?? 0) - (b.oldLines?.[0] ?? 0))
      .map((c) => `| ${c.oldLines ? (c.oldLines[0] === c.oldLines[1] ? c.oldLines[0] : c.oldLines.join('-')) : ''} | ${c.api}${c.rulePath ? ' › ' + c.rulePath : ''} | ${changeText(c)}${c.note ? ` (${c.note})` : ''} | ${c.newLine} |`), '');
  L.push('## Common blocks', '', '| # | Name | Type | Used | APIs | Uses blocks |', '|---|---|---|---|---|---|');
  i.defs.forEach((d, n) => L.push(`| ${n + 1} | \`${d.name}\` | ${kinds[d.kind]} | ${d.uses} | ${apis(d)} | ${d.dependsOn.map((x) => `\`${x}\``).join(', ')} |`));
  L.push('', '## Where each block is used', '');
  for (const d of i.defs) L.push(`- **\`${d.name}\`** - ${d.usedIn.map((u) => u.replace(/^inside /, 'inside `') + (u.startsWith('inside ') ? '`' : '')).join(' · ')}`);
  L.push('', '## Old anchors', '', '| Before | Now |', '|---|---|', ...i.anchorMap.map((a) => `| \`&${a.old}\` | ${a.now.startsWith('(') ? a.now : `\`&${a.now}\``} |`), '');
  if (i.droppedComments.length) {
    L.push('## Comments that were only in a duplicate copy', '', 'These copies were replaced by the common block, so their inner comments are not in the new file. Copy them back if they still matter:', '');
    for (const c of i.droppedComments) L.push(`- ${c.where} (now \`*${c.now}\`):`, '', '```yaml', ...c.comment.split('\n').map((x) => `#${x}`), '```', '');
  }
  if (/_NAME_:\s*ANCHOR_DEFINITIONS/.test(before)) L.push('## Note', '', '`ANCHOR_DEFINITIONS` (a dummy rule that only held anchors) is still in `_TESTS_` because it is a real test. With `_COMMON_` it is no longer needed and can be removed by hand.', '');
  return L.join('\n');
}
