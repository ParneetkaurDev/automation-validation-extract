// node test/generator-checks.test.mjs - fixtures for lib/generator-checks.mjs (dynamic fields, requirements, code quality), positive and negative.
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { parse as babel } from '@babel/parser';
import { analyseFunction } from '../lib/l2-analyse.mjs';
import { analyseFlows, analyseGenerator, analyseRequirements, fieldIdentity, flowIndexRefs } from '../lib/generator-checks.mjs';
let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n    ${e.message.split('\n')[0]}`); } };
const b64 = (s) => Buffer.from(s).toString('base64');
const OK_REQ = 'function meetsRequirements(sessionData) { return { valid: true, code: 200, description: "ok" }; }';
// step(api, { gen, req, val, save, def, inputs, example })
const step = (api, o = {}) => ({ api, action_id: `${api}_1`, owner: o.owner || 'BAP', mock: {
  generate: b64(o.gen || 'async function generate(defaultPayload, sessionData) { return defaultPayload; }'),
  requirements: b64(o.req || OK_REQ), validate: b64(o.val || 'function validate(targetPayload, sessionData) { return { valid: true, code: 200, description: "ok" }; }'),
  saveData: o.save || {}, defaultPayload: { context: {}, message: o.def || {} }, inputs: o.inputs || {} }, examples: o.example ? [{ name: 'e', payload: { message: o.example } }] : [] });
const flow = (steps, helper = '') => ({ file: 'config/flows/X/test.yaml', text: YAML.stringify({ meta: {}, steps, helperLib: helper ? b64(helper) : '' }) });
const run = (steps, helper) => analyseFlows([flow(steps, helper)]);
const dyn = (r, field, stepNo) => r.dynamic.find((x) => x.field === field && (!stepNo || x.step === stepNo));
const reqRow = (r, key, stepNo) => r.requirements.find((x) => x.key === key && (!stepNo || x.step === stepNo));
const rules = (r, rule) => r.quality.filter((x) => x.rule === rule);

const ON_SEARCH = step('on_search', { owner: 'BPP', save: { catalog: '$.message.catalog' }, example: { catalog: { providers: [{ id: 'P1', items: [{ id: 'I1' }] }] } } });

// ── 1. dynamic fields ──
t('dynamic: id read from an earlier saveData key → Dynamic – from earlier call', () => {
  const r = run([ON_SEARCH, step('select', { gen: 'async function generate(defaultPayload, sessionData) { const c = sessionData.catalog?.[0]; defaultPayload.message = { order: { items: [{ id: c.providers[0].items[0].id }] } }; return defaultPayload; }' })]);
  const d = dyn(r, 'message.order.items[].id'); assert.equal(d.status, 'Dynamic – from earlier call'); assert.match(d.source, /saved by on_search \(step 1/);
});
t('dynamic: hardcoded id that already exists in an earlier step → Hardcoded (High) with session fix + validate snippet', () => {
  const r = run([ON_SEARCH, step('select', { gen: 'async function generate(defaultPayload, sessionData) { defaultPayload.message = { order: { items: [{ id: "I1" }] } }; return defaultPayload; }' })]);
  const d = dyn(r, 'message.order.items[].id'); assert.equal(d.status, 'Hardcoded'); assert.equal(d.severity, 'Medium'); assert.match(d.match, /Same field name/);
  assert.match(d.fix, /sessionData\.catalog\?\.\[0\]\?\.providers\?\.\[0\]\?\.items\?\.\[0\]\?\.id/);
  assert.ok(r.suggestions.some((s) => s.target === 'validate' && /targetPayload\?\.message\?\.order\?\.items\?\.\[0\]\?\.id !== expected/.test(s.snippet)));
});
t('dynamic: hardcoded id already checked in validate → no validate suggestion', () => {
  const val = 'function validate(targetPayload, sessionData) { if (targetPayload.message.order.items[0].id !== sessionData.catalog[0].providers[0].items[0].id) return { valid: false, code: 400, description: "x" }; return { valid: true, code: 200, description: "ok" }; }';
  const r = run([ON_SEARCH, step('select', { val, gen: 'async function generate(defaultPayload, sessionData) { defaultPayload.message = { order: { items: [{ id: "I1" }] } }; return defaultPayload; }' })]);
  assert.match(dyn(r, 'message.order.items[].id').inValidate, /^Yes/); assert.equal(r.suggestions.filter((s) => s.target === 'validate').length, 0);
});
t('dynamic: hardcoded id in the first step that has it → first defined here (Info), not High', () => {
  const r = run([step('on_search', { owner: 'BPP', gen: 'async function generate(defaultPayload, sessionData) { defaultPayload.message = { catalog: { providers: [{ id: "P1" }] } }; return defaultPayload; }' })]);
  const d = dyn(r, 'message.catalog.providers[].id'); assert.equal(d.status, 'Hardcoded – first defined here'); assert.equal(d.severity, 'Info');
});
t('dynamic: first-defined id used later but not saved → Low with saveData fix', () => {
  const r = run([step('on_search', { owner: 'BPP', gen: 'async function generate(p, s) { p.message = { catalog: { providers: [{ id: "P1" }] } }; return p; }' }), step('select', { example: { order: { provider: { id: 'P1' } } } })]);
  const d = dyn(r, 'message.catalog.providers[].id', 1); assert.equal(d.severity, 'Low'); assert.match(d.fix, /add saveData provider_id/);
});
t('dynamic: id kept from defaultPayload (generator never sets it) → Hardcoded – kept from defaultPayload', () => {
  const r = run([ON_SEARCH, step('select', { def: { order: { items: [{ id: 'I1' }] } }, gen: 'async function generate(p, s) { p.message.order.quantity = 1; return p; }' })]);
  assert.equal(dyn(r, 'message.order.items[].id').status, 'Hardcoded – kept from defaultPayload');
});
t('dynamic: negative - defaultPayload id replaced by the generator is not "kept"', () => {
  const r = run([ON_SEARCH, step('select', { def: { order: { items: [{ id: 'I1' }] } }, gen: 'async function generate(p, s) { p.message = { order: { items: [{ id: s.catalog?.[0]?.providers?.[0]?.items?.[0]?.id }] } }; return p; }' })]);
  assert.equal(dyn(r, 'message.order.items[].id').status, 'Dynamic – from earlier call');
});
t('dynamic: user input with literal fallback → User input – with hardcoded fallback + quality rule', () => {
  const r = run([step('init', { inputs: { jsonSchema: { properties: { provider_id: {} } } }, gen: 'async function generate(p, s) { const id = String(s.user_inputs?.provider_id ?? "PROVIDER_ID"); p.message = { order: { provider: { id } } }; return p; }' })]);
  assert.equal(dyn(r, 'message.order.provider.id').status, 'User input – with hardcoded fallback'); assert.equal(rules(r, 'hardcoded-fallback').length, 1);
});
t('dynamic: negative - `|| {}` default on a destructure is not a hardcoded fallback', () => {
  const r = run([step('select', { inputs: { jsonSchema: { properties: { itemId: {} } } }, gen: 'async function generate(p, s) { const { itemId } = s?.user_inputs || {}; p.message = { order: { items: [{ id: itemId }] } }; return p; }' })]);
  assert.equal(dyn(r, 'message.order.items[].id').status, 'Dynamic – user input'); assert.equal(rules(r, 'hardcoded-fallback').length, 0);
});
t('dynamic: uuidv4() / helper id generators / inline Math.random uuid → Generated', () => {
  const helper = "function uuidv4() { return 'xxxxxxxx'.replace(/[x]/g, (c) => (Math.random() * 16 | 0).toString(16)); }";
  const r = run([step('on_confirm', { gen: "async function generate(p, s) { p.message = { order: { id: `O_${uuidv4()}`, payments: [{ id: 'x'.replace(/x/g, () => Math.random().toString(16)) }] } }; return p; }" })], helper);
  assert.equal(dyn(r, 'message.order.id').status, 'Generated'); assert.equal(dyn(r, 'message.order.payments[].id').status, 'Generated');
});
t('dynamic: object copied from session (clone + override) → nested ids Dynamic via copy', () => {
  const r = run([step('on_init', { owner: 'BPP', save: { order: '$.message.order' }, example: { order: { id: 'O1', items: [{ id: 'I1' }] } } }),
    step('on_update', { owner: 'BPP', example: { order: { id: 'O1', items: [{ id: 'I1' }] } }, gen: 'async function generate(p, s) { const order = JSON.parse(JSON.stringify(s.order?.[0])); order.status = "DONE"; p.message = { order }; return p; }' })]);
  const d = dyn(r, 'message.order.items[].id', 2); assert.equal(d.status, 'Dynamic – from earlier call'); assert.match(d.source, /copied/);
});
t('dynamic: values traced through a called helper function and loops', () => {
  const gen = 'async function generate(p, s) { await build(p, s); return p; }\nasync function build(p, s) { const { catalog } = s; let pid = null; for (const pr of catalog[0].providers) { pid = pr.id; } p.message = { order: { provider: { id: pid } } }; return p; }';
  const r = run([ON_SEARCH, step('select', { gen })]);
  assert.equal(dyn(r, 'message.order.provider.id').status, 'Dynamic – from earlier call');
});
t('fieldIdentity: plural parents become singular so catalog items match order items', () => {
  assert.equal(fieldIdentity('message.catalog.providers[].items[].id'), 'item.id');
  assert.equal(fieldIdentity('message.order.items[].id'), 'item.id');
  assert.equal(fieldIdentity('message.order.provider.id'), 'provider.id');
  assert.equal(fieldIdentity('message.catalog.categories[].id'), 'category.id');
});

t('dynamic: same field path in an earlier step → High, Same field path', () => {
  const r = run([step('on_select', { owner: 'BPP', save: { sel: '$.message.order' }, example: { order: { items: [{ id: 'I1' }] } } }), step('init', { gen: 'async function generate(p, s) { p.message = { order: { items: [{ id: "I1" }] } }; return p; }' })]);
  const d = dyn(r, 'message.order.items[].id', 2); assert.equal(d.severity, 'High'); assert.equal(d.match, 'Same field path'); assert.match(d.fix, /sessionData\.sel\?\.\[0\]\?\.items\?\.\[0\]\?\.id/);
});

// ── 2. requirements ──
const USE_ORDER = 'async function generate(p, s) { const o = s.order[0]; p.message = { order: { id: o.id, items: o.items.map((i) => ({ id: i.id })) } }; return p; }';
const SAVE_ORDER = step('on_init', { owner: 'BPP', save: { order: '$.message.order' } });
t('requirements: key used without a guard and not checked → Not in requirements (High) + snippet', () => {
  const r = run([SAVE_ORDER, step('confirm', { gen: USE_ORDER })]);
  const q = reqRow(r, 'order', 2); assert.equal(q.status, 'Not in requirements'); assert.equal(q.severity, 'High');
  assert.match(q.snippet, /if \(!sessionData\.order\?\.\[0\]\?\.items\?\.length\)|if \(!sessionData\.order\?\.\[0\]\?\.items\)/);
  assert.equal(rules(r, 'requirements-stub').length, 1);
});
t('requirements: key checked only at the top while generator needs a nested array → Shallow check', () => {
  const req = 'function meetsRequirements(sessionData) { if (!sessionData.order?.length) return { valid: false, code: 400, description: "x" }; return { valid: true, code: 200, description: "ok" }; }';
  const r = run([SAVE_ORDER, step('confirm', { gen: USE_ORDER, req })]);
  assert.equal(reqRow(r, 'order', 2).status, 'Shallow check');
});
t('requirements: negative - deep check covers the generator → Checked', () => {
  const req = 'function meetsRequirements(sessionData) { if (!sessionData.order?.[0]?.items?.length) return { valid: false, code: 400, description: "x" }; return { valid: true, code: 200, description: "ok" }; }';
  const r = run([SAVE_ORDER, step('confirm', { gen: USE_ORDER, req })]);
  assert.equal(reqRow(r, 'order', 2).status, 'Checked'); assert.equal(rules(r, 'requirements-stub').length, 0);
});
t('requirements: keys checked through a literal list loop count as checked', () => {
  const req = 'function meetsRequirements(sessionData) { const need = ["order"]; for (const k of need) { if (!sessionData[k]?.length) return { valid: false, code: 400, description: k }; } return { valid: true, code: 200, description: "ok" }; }';
  const r = run([SAVE_ORDER, step('confirm', { gen: 'async function generate(p, s) { p.message = { order: { id: s.order?.[0]?.id } }; return p; }', req })]);
  assert.equal(reqRow(r, 'order', 2).status, 'Checked');
});
t('requirements: generator guards with throw → Not in requirements – generator throws (Medium)', () => {
  const gen = 'async function generate(p, s) { const o = s.order?.[0]; if (!o) throw new Error("no order"); p.message = { order: { id: o.id } }; return p; }';
  const q = reqRow(run([SAVE_ORDER, step('confirm', { gen })]), 'order', 2); assert.equal(q.status, 'Not in requirements – generator throws'); assert.equal(q.severity, 'Medium');
});
t('requirements: throw guard inside a swallowing try/catch is High', () => {
  const gen = 'async function generate(p, s) { try { const o = s.order?.[0]; if (!o) throw new Error("no order"); p.message = { order: { id: o.id } }; return p; } catch (e) { return p; } }';
  const r = run([SAVE_ORDER, step('confirm', { gen })]);
  assert.equal(reqRow(r, 'order', 2).severity, 'High'); assert.equal(rules(r, 'silent-catch').length, 1);
});
t('requirements: optional-only read → read optionally (Medium)', () => {
  const r = run([SAVE_ORDER, step('confirm', { gen: 'async function generate(p, s) { p.message = { order: { id: s.order?.[0]?.id } }; return p; }' })]);
  assert.equal(reqRow(r, 'order', 2).status, 'Not in requirements – read optionally');
});
t('requirements: key saved only by a later step / by the same step / never', () => {
  const gen = 'async function generate(p, s) { p.message = { order: { id: s.order[0].id, x: s.ghost[0] } }; return p; }';
  const r = run([step('confirm', { gen, save: { order: '$.message.order' } }), step('on_confirm', { save: { order: '$.message.order' } })]);
  assert.equal(reqRow(r, 'order', 1).status, 'Saved only by this step (after generate runs)');
  assert.equal(reqRow(r, 'ghost', 1).status, 'Never saved');
  const r2 = run([step('confirm', { gen }), step('on_confirm', { save: { order: '$.message.order' } })]);
  assert.equal(reqRow(r2, 'order', 1).status, 'Saved only by a later step');
});
t('requirements: requirement checks a key that is never saved before the step → High; alternatives (a || b) are ignored', () => {
  const req = 'function meetsRequirements(s) { if (!s.missing_key?.length) return { valid: false, code: 400, description: "x" }; const tx = s.transactionId || s.transaction_id; return { valid: true, code: 200, description: "ok" }; }';
  const r = run([step('confirm', { req })]);
  assert.equal(reqRow(r, 'missing_key').status, 'Checked but not saved before this step'); assert.equal(reqRow(r, 'transaction_id'), undefined);
});
t('requirements: user input declared in mock.inputs → OK; not declared → Medium', () => {
  const gen = 'async function generate(p, s) { p.message = { order: { items: [{ id: s.user_inputs.item_id, x: s.user_inputs.other }] } }; return p; }';
  const r = run([step('select', { gen, inputs: { jsonSchema: { properties: { item_id: {} } } } })]);
  assert.equal(reqRow(r, 'user_inputs.item_id').severity, 'OK'); assert.equal(reqRow(r, 'user_inputs.other').status, 'User input – not declared in mock.inputs');
});
t('analyseRequirements: return shape and always-pass detection', () => {
  assert.equal(analyseRequirements(OK_REQ).alwaysPasses, true);
  assert.equal(analyseRequirements('function meetsRequirements(s) { if (!s.a) return { valid: false }; return { valid: true, code: 200, description: "" }; }').badReturns.length, 1);
});

// ── 3. code quality ──
t('quality: silent catch, console.log, var, ==, async without await', () => {
  const gen = 'async function generate(p, s) { try { var a = 1; if (a == "1") console.log("x"); return p; } catch (e) { console.error(e); return p; } }';
  const r = run([step('search', { gen })]);
  for (const k of ['silent-catch', 'var', 'loose-equality', 'console', 'async-no-await']) assert.equal(rules(r, k).length, 1, k);
});
t('quality: negative - catch that re-throws, == null, console.error only', () => {
  const gen = 'async function generate(p, s) { try { const a = await Promise.resolve(1); if (a == null) console.error("x"); return p; } catch (e) { throw new Error(e.message); } }';
  const r = run([step('search', { gen })]);
  for (const k of ['silent-catch', 'var', 'loose-equality', 'console', 'async-no-await']) assert.equal(rules(r, k).length, 0, k);
});
t('quality: writes into sessionData / user_inputs are flagged; writes into a clone are not', () => {
  const bad = 'async function generate(p, s) { const { user_inputs } = s; user_inputs.x = [1]; const o = s.order[0]; o.status = "A"; p.message = { order: o }; return p; }';
  assert.equal(rules(run([SAVE_ORDER, step('confirm', { gen: bad })]), 'session-mutation').length, 2);
  const good = 'async function generate(p, s) { const o = structuredClone(s.order[0]); o.status = "A"; const list = []; list.push(1); p.message = { order: o }; return p; }';
  assert.equal(rules(run([SAVE_ORDER, step('confirm', { gen: good })]), 'session-mutation').length, 0);
});
t('quality: saved array read without [0]', () => {
  assert.equal(rules(run([SAVE_ORDER, step('confirm', { gen: 'async function generate(p, s) { p.message = { order: { id: s.order.id } }; return p; }' })]), 'session-no-index').length, 1);
  assert.equal(rules(run([SAVE_ORDER, step('confirm', { gen: 'async function generate(p, s) { p.message = { order: { id: s.order?.[0]?.id, n: s.order.length } }; return p; }' })]), 'session-no-index').length, 0);
});
t('quality: find() result used without a null check (and not when checked)', () => {
  const g = (chk) => `async function generate(p, s) { const it = s.order?.[0]?.items?.find((i) => i.id === "A"); ${chk} p.message = { x: it.price }; return p; }`;
  assert.equal(rules(run([SAVE_ORDER, step('confirm', { gen: g('') })]), 'find-unchecked').length, 1);
  assert.equal(rules(run([SAVE_ORDER, step('confirm', { gen: g('if (!it) throw new Error("x");') })]), 'find-unchecked').length, 0);
});
t('quality: hardcoded timestamp, no return, parse error, helper reading free sessionData, duplicate generators', () => {
  assert.equal(rules(run([step('confirm', { gen: 'async function generate(p, s) { p.message = { order: { created_at: "2024-01-01T00:00:00.000Z" } }; return p; }' })]), 'hardcoded-timestamp').length, 1);
  assert.equal(rules(run([step('confirm', { gen: 'async function generate(p, s) { p.message = {}; }' })]), 'no-return').length, 1);
  assert.equal(rules(run([step('confirm', { gen: 'async function generate(p, s) { p.message = { ; return p; }' })]), 'parse-error').length, 1);
  assert.equal(rules(run([step('confirm', { gen: 'async function generate(p, s) { p.message = { u: url() }; return p; }' })], 'function url() { return sessionData.mockBaseUrl; }'), 'helper-free-session').length, 1);
  const long = 'async function generate(defaultPayload, sessionData) { defaultPayload.message = { order: { status: "A", tags: [' + Array.from({ length: 20 }, (_, i) => `{ code: "C${i}" }`).join(', ') + '] } }; return defaultPayload; }';
  assert.equal(rules(run([step('on_status', { gen: long }), step('on_status', { gen: long })]), 'duplicate-generator').length, 2);
});
t('read-only: the analysed code is never executed', () => {
  globalThis.__ran = false;
  run([step('confirm', { gen: 'globalThis.__ran = true; async function generate(p, s) { globalThis.__ran = true; return p; }' })]);
  assert.equal(globalThis.__ran, false);
});
t('flowIndexRefs: $ref list of config/flows/index.yaml', () => {
  const set = flowIndexRefs('flows:\n  - id: a\n    config:\n      $ref: "./LAMF/a.yaml"\n  # - id: b\n');
  assert.deepEqual([...set], ['config/flows/LAMF/a.yaml']);
});
t('analyseGenerator: reads helperLib appended after generate', () => {
  const g = analyseGenerator('async function generate(p, s) { p.message = { u: makeUrl(s) }; return p; }', 'function makeUrl(sessionData) { return sessionData.mockBaseUrl + sessionData.transactionId[0]; }');
  assert.ok(g.reads.some((r) => r.path[0] === 'transactionId'));
});

// ── duplicate checks (generate() vs meetsRequirements()) ──
const REQ_ORDER = 'function meetsRequirements(s) { if (!s.order?.length) return { valid: false, code: 400, description: "x" }; return { valid: true, code: 200, description: "ok" }; }';
t('duplicates: same check in generate() and meetsRequirements() → Duplicate', () => {
  const gen = 'async function generate(p, s) { const o = s.order?.[0]; if (!o) throw new Error("no order"); p.message = { order: { id: o.id } }; return p; }';
  const r = run([SAVE_ORDER, step('confirm', { gen, req: REQ_ORDER })]);
  assert.equal(r.duplicates.length, 1); assert.equal(r.duplicates[0].verdict, 'Duplicate'); assert.equal(r.duplicates[0].key, 'order');
});
t('duplicates: requirement checks a deeper path → Covered by requirements', () => {
  const req = 'function meetsRequirements(s) { if (!s.order?.[0]?.items?.length) return { valid: false, code: 400, description: "x" }; return { valid: true, code: 200, description: "ok" }; }';
  const gen = 'async function generate(p, s) { const o = s.order?.[0]; if (!o) throw new Error("no order"); p.message = { order: { id: o.id } }; return p; }';
  assert.equal(run([SAVE_ORDER, step('confirm', { gen, req })]).duplicates[0].verdict, 'Covered by requirements');
});
t('duplicates: negative - generator checks something requirements does not (deeper, or another key)', () => {
  const gen = 'async function generate(p, s) { const it = s.order?.[0]?.items; if (!s.order?.[0]?.items?.length) throw new Error("x"); if (!s.user_inputs?.id) throw new Error("y"); p.message = { order: { items: it } }; return p; }';
  assert.equal(run([SAVE_ORDER, step('confirm', { gen, req: REQ_ORDER })]).duplicates.length, 0);
});
t('generator checks: only ids that should be dynamic get "Should come from" and a validate() fallback', () => {
  const r = run([ON_SEARCH, step('select', { gen: 'async function generate(p, s) { p.message = { order: { items: [{ id: "I1" }], provider: { id: s.catalog?.[0]?.providers?.[0]?.id } } }; return p; }' })]);
  const rows = r.dynamic.filter((x) => x.dynamicFrom);
  assert.deepEqual(rows.map((x) => x.field), ['message.order.items[].id']);
  assert.match(rows[0].dynamicFrom, /^sessionData\.catalog/); assert.match(rows[0].validateCheck, /const expected = sessionData\.catalog/); assert.equal(rows[0].today, '"I1"');
});

// ── L2 extractor: requirements / generator validations, duplicates, static vs dynamic ──
t('L2: requirements.js validations are extracted one per check (incl. literal key lists)', () => {
  const req = 'function meetsRequirements(s) { if (!s.order?.[0]?.items?.length) return { valid: false, code: 400, description: "no items" }; for (const k of ["a", "b"]) { if (!s[k]) return { valid: false, code: 400, description: k }; } return { valid: true, code: 200, description: "ok" }; }';
  const r = run([SAVE_ORDER, step('confirm', { req })]);
  const rows = r.reqValidations.filter((x) => x.step === 2);
  assert.deepEqual(rows.map((x) => x.fieldPath), ['session:order[0].items', 'session:a', 'session:b']);
  assert.equal(rows[0].checkType, 'Non-empty list'); assert.equal(rows[0].errorMessage, 'no items');
});
t('L2: generator validations from generate() and the functions it calls (throw and return-defaultPayload)', () => {
  const gen = 'async function generate(p, s) { await build(p, s); return p; }\nasync function build(dp, sd) { if (!sd.user_inputs?.item_id) throw new Error("item missing"); if (!sd.order?.[0]) return dp; dp.message = { order: { id: sd.order[0].id } }; return dp; }';
  const r = run([SAVE_ORDER, step('confirm', { gen })]);
  const rows = r.genValidations.filter((x) => x.step === 2);
  assert.equal(rows.length, 2); assert.match(rows[0].function, /build\(\) \(called by generate\)/);
  assert.equal(rows[0].errorMessage, 'item missing'); assert.equal(rows[1].errorMessage, 'returns defaultPayload unchanged');
});
t('L2: generator validation already in requirements.js → Duplicate with the source; deeper requirement → Duplicate (covered)', () => {
  const gen = 'async function generate(p, s) { const o = s.order?.[0]; if (!o) throw new Error("no order"); p.message = { order: { id: o.id } }; return p; }';
  const g = run([SAVE_ORDER, step('confirm', { gen, req: REQ_ORDER })]).genValidations.find((x) => x.step === 2);
  assert.equal(g.duplicate, 'Duplicate'); assert.match(g.duplicateOf, /requirements\.js/);
  const deep = 'function meetsRequirements(s) { if (!s.order?.[0]?.items?.length) return { valid: false, code: 400, description: "x" }; return { valid: true, code: 200, description: "ok" }; }';
  assert.equal(run([SAVE_ORDER, step('confirm', { gen, req: deep })]).genValidations.find((x) => x.step === 2).duplicate, 'Duplicate (covered)');
});
t('L2: generator validation already in validate() → Duplicate of Validator; negative - unrelated checks are Not duplicate', () => {
  const gen = 'async function generate(p, s) { if (!s.order?.[0]?.id) throw new Error("x"); if (!s.other?.length) throw new Error("y"); p.message = {}; return p; }';
  const val = 'function validate(t, s) { if (!s.order?.[0]?.id) return { valid: false, code: 400, description: "x" }; return { valid: true, code: 200, description: "ok" }; }';
  const rows = run([SAVE_ORDER, step('confirm', { gen, val })]).genValidations.filter((x) => x.step === 2);
  assert.equal(rows[0].duplicate, 'Duplicate'); assert.match(rows[0].duplicateOf, /Validator/); assert.equal(rows[1].duplicate, 'Not duplicate');
});
t('L2: existing validate() behaviour unchanged without opts (throw outside a failing try is not a check)', () => {
  const r = analyseFunction('function validate(t, s) { if (!t.x) throw new Error("x"); return { valid: true }; }', babel);
  assert.equal(r.checks.length, 0);
});
t('static vs dynamic: every field marked, static ids that exist earlier get an opportunity', () => {
  const r = run([ON_SEARCH, step('select', { inputs: { jsonSchema: { properties: { q: {} } } }, gen: 'async function generate(p, s) { p.message = { order: { items: [{ id: "I1", quantity: { count: s.user_inputs.q } }], provider: { id: s.catalog?.[0]?.providers?.[0]?.id }, created: new Date().toISOString(), type: "DEFAULT" } }; return p; }' })]);
  const v = Object.fromEntries(r.values.filter((x) => x.step === 2).map((x) => [x.field, x]));
  assert.equal(v['message.order.items[].id'].kind, 'Static'); assert.match(v['message.order.items[].id'].opportunity, /sessionData\.catalog/);
  assert.equal(v['message.order.items[].quantity.count'].kind, 'Dynamic'); assert.equal(v['message.order.provider.id'].kind, 'Dynamic');
  assert.equal(v['message.order.created'].kind, 'Dynamic'); assert.equal(v['message.order.type'].kind, 'Static'); assert.equal(v['message.order.type'].opportunity, '');
});

console.log(`\n${passed} tests passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
