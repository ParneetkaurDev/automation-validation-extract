// node test/run-tests.mjs - self-contained tests (no repo needed): runner, lint, extractor (standard shape), compare.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));   // safe for folders with spaces
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-test-'));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// ── 1. runChecks ──
const { runChecks } = require(path.join(root, 'standard/runChecks.js'));
globalThis.runChecks = runChecks;
const example = fs.readFileSync(path.join(root, 'standard/examples/on_select.validate.js'), 'utf8');
const validate = new Function('runChecks', `${example}; return validate;`)(runChecks);
const good = { context: { action: 'on_select', transaction_id: 't1' }, message: { order: { provider: { id: 'P1' },
  items: [{ id: 'I1', category_ids: ['LOAN'], tags: [{ descriptor: { code: 'LOAN_INFO' } }] }], fulfillments: [{ id: 'F1' }], quote: { price: { value: '100' } } } } };
const sess = { transactionId: ['t1'], item_ids: ['I1'], sanction_limit: 500 };
test('runChecks: valid payload passes', () => assert.equal(validate(good, sess).valid, true));
test('runChecks: every failing check is reported by id', () => {
  const bad = structuredClone(good);
  bad.context.transaction_id = 'x'; bad.message.order.items[0].id = 'I9'; bad.message.order.items[0].tags = [];
  bad.message.order.quote.price.value = '900'; delete bad.message.order.provider.id;
  assert.deepEqual(validate(bad, sess).failed, ['S03', 'O04', 'S06', 'BL_SEL_01', 'BL_SEL_02']);
});
test('runChecks: "when" skips checks whose condition does not hold', () => {
  const p = structuredClone(good); p.message.order.items[0].category_ids = ['OTHER']; p.message.order.items[0].tags = []; p.context.transaction_id = 'zz';
  assert.equal(validate(p, {}).valid, true);
});
test('runChecks: unknown rule is a 500, not a silent pass', () => assert.equal(runChecks([{ id: 'X', desc: 'd', path: '$.a', rule: { bogus: 1 } }], { a: 1 }, {}).code, 500));

// ── 2. fixture config: one flow with a standard, a broken and a legacy function ──
const cfg = path.join(tmp, 'config');
fs.mkdirSync(path.join(cfg, 'flows/F'), { recursive: true });
fs.mkdirSync(path.join(cfg, 'validations'));
fs.writeFileSync(path.join(cfg, 'index.yaml'), 'info:\n  domain: ONDC:TEST\n  version: 1.0.0\n  x-branch-name: test-branch\n');
fs.writeFileSync(path.join(cfg, 'validations/index.yaml'), `_TESTS_:
  search:
    - _NAME_: CTX
      _RETURN_:
        - _NAME_: REQ_TXN
          attr: $.context.transaction_id
          _RETURN_: attr are present
        - _NAME_: REQ_ITEM
          attr: $.message.intent.item.id
          gate: $.message.intent.flag
          _CONTINUE_: "!(gate are present)"
          _RETURN_: " attr are present "
`);
const b64 = (s) => Buffer.from(s).toString('base64');
const broken = `function validate(p,s){ if(!p.x) return {valid:false,code:400,description:"x"}; return runChecks([{id:"A",path:"context.action",rule:{eq:"x"}},{id:"A",desc:"d",path:"$.a",rule:{weird:1}},{id:"B",desc:"d",custom:(p)=>true}],p,s)}`;
const legacy = `function validate(p,s){ try { if (s.flag) { if (p.context.action !== 'search') return {valid:false,code:400,description:'bad action'}; } return {valid:true}; } catch(e) { return {valid:true}; } }`;
fs.writeFileSync(path.join(cfg, 'flows/F/flow.yaml'), `meta: { flowId: F }
steps:
  - { api: on_select, action_id: s1, mock: { validate: ${b64(example)} } }
  - { api: search, action_id: s2, mock: { validate: ${b64(broken)} } }
  - { api: search, action_id: s3, mock: { validate: ${b64(legacy)} } }
`);

// ── 3. lint ──
const lint = spawnSync('node', [path.join(root, 'lint-l2.mjs'), '--config', cfg, '--out', path.join(tmp, 'lint')], { encoding: 'utf8' });
const lintCsv = fs.readFileSync(path.join(tmp, 'lint/l2-lint.csv'), 'utf8');
test('lint: errors exit 1', () => assert.equal(lint.status, 1));
for (const rule of ['L2-002', 'L2-004', 'L2-005', 'L2-006', 'L2-007', 'L2-008', 'L2-001', 'L2-009'])
  test(`lint: ${rule} reported`, () => assert.match(lintCsv, new RegExp(rule)));
test('lint: the standard example has no issues', () => assert.doesNotMatch(lintCsv, /,1,s1,/));

// ── 4. extractor ──
execFileSync('node', [path.join(root, 'extract-validations.mjs'), '--config', cfg, '--json-only', '--out', path.join(tmp, 'x')]);
const j = JSON.parse(fs.readFileSync(path.join(tmp, 'x/validations.json'), 'utf8'));
test('L1: spaces around an expression parse', () => assert.equal(j.l1.length, 2));
test('L1: skip condition fields recorded', () => assert.equal(j.l1.find((r) => r.ruleName === 'REQ_ITEM').condFields, 'intent.flag'));
test('L2 standard: each declared check becomes one row', () => assert.equal(j.l2.filter((r) => r.actionId === 's1').length, 8));
test('L2 standard: when → Depends on', () => assert.equal(j.l2.find((r) => r.checkId === 'BL_SEL_01').condFields, 'order.items[].category_ids'));
test('L2 legacy: outer if → guard field', () => assert.equal(j.l2.find((r) => r.actionId === 's3').condFields, 'flag from a previous call'));

// ── 5. gold + compare ──
const json = path.join(tmp, 'x/validations.json');
const gold = path.join(tmp, 'gold.csv');
const cols = 'Key,Layer,API,Field,Check,Values,Runs,Depends on,Cross-call ID,Validation';
fs.writeFileSync(gold, `${cols}
L1 | search | context.transaction_id | Required,L1,search,context.transaction_id,Required,,Always,,,
L1 | search | intent.item.id | Required,L1,search,intent.item.id,Required,,Always,,,
L1 | search | context.city | Required,L1,search,context.city,Required,,Always,,,
`);
const cmp = (extra = []) => spawnSync('node', [path.join(root, 'gold.mjs'), 'compare', '--in', json, '--gold', gold, '--out', path.join(tmp, 'cmp'), ...extra], { encoding: 'utf8' });
const r1 = cmp();
test('compare: MISSING and BLOCKER fail the gate', () => { assert.equal(r1.status, 1); assert.match(r1.stdout, /MISSING=1 {2}BLOCKER=1 /); });
test('compare: developer message says what is missing, where to add it and how to waive', () => {
  assert.match(r1.stdout, /✖ MISSING {2}\[L1\] search › context\.city › Required/);
  assert.match(r1.stdout, /Add it to: config\/validations\/index\.yaml → _TESTS_ → search/);
  assert.match(r1.stdout, /✖ BLOCKER {2}\[L1\] search › intent\.item\.id/);
  assert.match(r1.stdout, /Fix here: +config\/validations\/index\.yaml:\d+/);
  assert.match(r1.stdout, /Or waive: +add {2}"L1 \| search \| context\.city \| Required"/);
});
test('compare: GitHub annotations when running in Actions', () => {
  const r = spawnSync('node', [path.join(root, 'gold.mjs'), 'compare', '--in', json, '--gold', gold, '--out', path.join(tmp, 'cmp')], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } });
  assert.match(r.stdout, /^::error file=config\/validations\/index\.yaml,line=\d+,title=BLOCKER/m);
});
const w = path.join(tmp, 'w.csv');
fs.writeFileSync(w, 'Key,Reason\nL1 | search | context.*,test\nL1 | search | intent.item.id | Required,test\n');
const r2 = cmp(['--waivers', w]);
test('compare: wildcard + exact waivers clear the gate', () => { assert.equal(r2.status, 0, r2.stdout); assert.match(r2.stdout, /WAIVED=2/); });

console.log(`\n${passed} tests passed`);
fs.rmSync(tmp, { recursive: true, force: true });
