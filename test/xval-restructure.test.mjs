// node test/xval-restructure.test.mjs - fixtures for lib/xval-restructure.mjs and restructure-xval.mjs (no spec repo needed).
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { restructure, verify } from '../lib/xval-restructure.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n    ${e.message.split('\n')[0]}`); } };
const load = (x) => YAML.parse(x, { maxAliasCount: -1 });
const ctx = (api) => `    - _NAME_: ${api.toUpperCase()}_CONTEXT
      action:
        - ${api}
      _RETURN_:
        - _NAME_: REQUIRED_CONTEXT_DOMAIN
          attr: $.context.domain
          _RETURN_: attr are present
        - _NAME_: REQUIRED_CONTEXT_TTL
          attr: $.context.ttl
          _RETURN_: attr are present
`;
const enumRule = (name) => `    - _NAME_: ${name}
      attr: $.message.order.fulfillments[*].type
      enumList:
        - LOAN
        - BASE
        - DRAWDOWN
      _RETURN_: attr all in enumList
`;
const file = (tests, extra = '') => `_TESTS_:\n${tests}${extra}_SESSION_DATA_:\n  trans: {}\n`;
const FIX = file(`  search:\n${ctx('search')}${enumRule('VALID_TYPE_SEARCH')}  on_search:\n${ctx('on_search')}${enumRule('VALID_TYPE_ON_SEARCH')}`);

t('repeated rule group → one _COMMON_ block named after the shared part of the parents, used twice', () => {
  const r = restructure(FIX);
  const g = r.defs.find((d) => d.kind === 'RULES');
  assert.equal(g.name, 'CONTEXT_CHECKS'); assert.equal(g.uses, 2);
  assert.match(r.text, /^_COMMON_:\n/m); assert.equal((r.text.match(/\*CONTEXT_CHECKS/g) || []).length, 2);
  assert.ok(r.text.indexOf('&CONTEXT_CHECKS') < r.text.indexOf('_TESTS_:'));
});
t('a rule that only repeats inside a repeated group is not split out again', () => {
  const r = restructure(FIX);
  assert.ok(!r.defs.some((d) => d.name === 'REQUIRED_CONTEXT_DOMAIN'));
});
t('repeated value list → ENUM_<field> named after the attr path', () => {
  const r = restructure(FIX);
  const l = r.defs.find((d) => d.kind === 'LIST');
  assert.equal(l.name, 'ENUM_ORDER_FULFILLMENTS_TYPE'); assert.equal(l.uses, 2);
  assert.equal((r.text.match(/enumList: \*ENUM_ORDER_FULFILLMENTS_TYPE/g) || []).length, 2);
});
t('loaded value is identical (what the generator reads), _COMMON_ is the first key', () => {
  const r = restructure(FIX); const a = load(FIX), b = load(r.text);
  assert.deepEqual(b._TESTS_, a._TESTS_); assert.deepEqual(b._SESSION_DATA_, a._SESSION_DATA_);
  assert.equal(Object.keys(b)[0], '_COMMON_'); assert.ok(verify(FIX, r.text).ok);
});
t('existing anchors (&a1) are expanded and rebuilt under a readable name', () => {
  const src = file(`  search:\n    - _NAME_: SEARCH_CONTEXT\n      _RETURN_: &a1\n        - _NAME_: R1\n          attr: $.context.domain\n          _RETURN_: attr are present\n        - _NAME_: R2\n          attr: $.context.ttl\n          _RETURN_: attr are present\n  on_search:\n    - _NAME_: ON_SEARCH_CONTEXT\n      _RETURN_: *a1\n`);
  const r = restructure(src);
  assert.deepEqual(r.anchorMap, [{ old: 'a1', now: 'CONTEXT_CHECKS', definedAt: 4, usedAt: [13] }]);
  const c = r.changes.find((x) => x.api === 'on_search');
  assert.equal(c.oldText, '_RETURN_: *a1'); assert.match(c.note, /old anchor &a1/); assert.ok(c.newLine > 0);
  assert.ok(!/&a1|\*a1/.test(r.text)); assert.ok(verify(src, r.text).ok);
});
t('changes: every replaced place has its old lines + old text and its new line; first one is "moved"', () => {
  const r = restructure(FIX);
  assert.equal(r.changes.length, r.defs.reduce((n, d) => n + d.uses, 0));
  const g = r.changes.filter((c) => c.block === 'CONTEXT_CHECKS');
  assert.deepEqual(g.map((c) => c.change), ['moved', 'replaced']);
  assert.deepEqual(g.map((c) => c.api), ['search', 'on_search']);
  assert.match(g[0].oldText, /^- _NAME_: REQUIRED_CONTEXT_DOMAIN/);
  const lines = r.text.split('\n');
  for (const c of r.changes) assert.match(lines[c.newLine - 1], new RegExp(`\\*${c.block}\\b`));
  const d = r.defs.find((x) => x.name === 'CONTEXT_CHECKS'); assert.match(d.definition, /^CONTEXT_CHECKS: &CONTEXT_CHECKS/);
});
t('same _NAME_ with different content → two blocks, the second named after its API', () => {
  const rule = (v) => `    - _NAME_: REQUIRED_ITEM_ID\n      attr: ${v}\n      _RETURN_: attr are present\n`;
  const src = file(`  search:\n${rule('$.a')}  on_search:\n${rule('$.a')}  select:\n${rule('$.b')}  on_select:\n${rule('$.b')}`);
  const r = restructure(src);
  assert.deepEqual(r.defs.map((d) => d.name).sort(), ['REQUIRED_ITEM_ID', 'REQUIRED_ITEM_ID_SELECT']);
  assert.ok(verify(src, r.text).ok);
});
t('short single-value lists (action: [search]) are not made common', () => {
  const src = file(`  search:\n    - _NAME_: A\n      action:\n        - search\n      attr: $.x\n      _RETURN_: attr are present\n  on_search:\n    - _NAME_: B\n      action:\n        - search\n      attr: $.y\n      _RETURN_: attr are present\n`);
  const r = restructure(src);
  assert.equal(r.defs.length, 0); assert.ok(!/_COMMON_/.test(r.text));
});
t('long single regex is made common (REGEX_ prefix)', () => {
  const rx = '^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(\\\\.\\\\d+)?Z$';
  const rule = (n) => `    - _NAME_: ${n}\n      attr: $.context.timestamp\n      reg:\n        - ${rx}\n      _RETURN_: attr follow regex reg\n`;
  const src = file(`  search:\n${rule('A')}  on_search:\n${rule('B')}`);
  const r = restructure(src);
  assert.equal(r.defs[0].name, 'REGEX_CONTEXT_TIMESTAMP'); assert.ok(verify(src, r.text).ok);
  assert.equal(load(r.text)._TESTS_.search[0].reg[0], load(src)._TESTS_.search[0].reg[0]);   // \\d kept as written
});
t('comment inside the moved block stays in _COMMON_, comment above a block stays in place', () => {
  const src = file(`  search:\n    # keep me above\n${ctx('search').replace('        - _NAME_: REQUIRED_CONTEXT_TTL', '        # ttl is optional in v1\n        - _NAME_: REQUIRED_CONTEXT_TTL')}  on_search:\n${ctx('on_search').replace('        - _NAME_: REQUIRED_CONTEXT_TTL', '        # ttl is optional in v1\n        - _NAME_: REQUIRED_CONTEXT_TTL')}`);
  const r = restructure(src);
  assert.ok(r.text.indexOf('# ttl is optional in v1') < r.text.indexOf('_TESTS_:'));
  assert.ok(r.text.indexOf('# keep me above') > r.text.indexOf('_TESTS_:'));
  assert.equal(r.droppedComments.length, 0);
});
t('a comment that exists only in a duplicate copy is reported, not silently lost', () => {
  const src = file(`  search:\n${enumRule('VALID_A')}  on_search:\n${enumRule('VALID_A').replace('        - BASE', '        # - OLD\n        - BASE')}`);
  const r = restructure(src);
  assert.equal(r.droppedComments.length, 1); assert.match(r.droppedComments[0].comment, /OLD/);
});
t('verify catches a changed value and an anchor that is used once', () => {
  const r = restructure(FIX);
  assert.equal(verify(FIX, r.text.replace('- DRAWDOWN', '- DRAWDOWNX')).ok, false);
  const once = verify(FIX, r.text.replace(/\n(\s+enumList: )\*ENUM_ORDER_FULFILLMENTS_TYPE(?![\s\S]*\*ENUM_ORDER)/, '\n$1[LOAN, BASE, DRAWDOWN]'));
  assert.ok(once.problems.some((p) => /used 1 time/.test(p)));
});
t('a file that already has _COMMON_ is refused (no double run)', () => {
  assert.throws(() => restructure(restructure(FIX).text), /already exists/);
});
t('--min-uses 3 and --kinds LIST are respected', () => {
  assert.equal(restructure(FIX, { minUses: 3 }).defs.length, 0);
  assert.deepEqual(restructure(FIX, { kinds: ['LIST'] }).defs.map((d) => d.kind), ['LIST']);
});

// ── CLI on a throw-away git repo ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xval-'));
const repo = path.join(tmp, 'spec'); fs.mkdirSync(path.join(repo, 'config/validations'), { recursive: true });
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString();
fs.writeFileSync(path.join(repo, 'config/validations/index.yaml'), FIX);
g('init', '-q', '-b', 'draft-X10-1.0.0'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'x', '--allow-empty'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'v');
const cli = (...a) => spawnSync(process.execPath, [path.join(root, 'restructure-xval.mjs'), ...a], { cwd: root, encoding: 'utf8' });
const out = path.join(tmp, 'out');
t('CLI dry run: writes the report, leaves the repo untouched', () => {
  const r = cli('--repo', repo, '--out', out); assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(out, 'draft-X10-1.0.0', 'report.md'))); assert.match(r.stdout, /identical ✓/);
  assert.equal(fs.readFileSync(path.join(repo, 'config/validations/index.yaml'), 'utf8'), FIX);
});
t('CLI --branch reads a branch with git show (multi-domain mode) and refuses --apply with it', () => {
  g('branch', 'draft-Y20-2.0.0');
  const r = cli('--repo', repo, '--branch', 'draft-X10-1.0.0,draft-Y20-2.0.0', '--out', out); assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(out, 'draft-Y20-2.0.0', 'index.yaml')));
  assert.equal(cli('--repo', repo, '--branch', 'draft-Y20-2.0.0', '--apply').status, 2);
});
t('CLI --apply writes the restructured file to the working tree', () => {
  const r = cli('--repo', repo, '--out', out, '--apply'); assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(fs.readFileSync(path.join(repo, 'config/validations/index.yaml'), 'utf8'), /^_COMMON_:/m);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
