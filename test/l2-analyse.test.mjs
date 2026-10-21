// node test/l2-analyse.test.mjs - fixtures for the L2 analyser (lib/l2-analyse.mjs). Positive cases must classify,
// negative cases must stay "Custom logic" (never guessed). No repo needed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyseFunction, showPath } from '../lib/l2-analyse.mjs';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');

let passed = 0, failed = 0;
const fn = (body) => `function validate(targetPayload, sessionData) {\n${body}\nreturn { valid: true };\n}`;
const FAIL = `return { valid: false, code: 400, description: 'x' };`;
const rows = (body) => analyseFunction(fn(body), parse).checks.map(c => [c.type, showPath(c.field), showPath(c.other), (c.values || []).join(',')].filter(Boolean).join(' | '));
const t = (name, body, expected) => {
  const got = rows(body);
  try { assert.deepEqual(got, expected); passed++; console.log(`  ok  ${name}`); }
  catch { failed++; console.log(`  FAIL ${name}\n    got:      ${JSON.stringify(got)}\n    expected: ${JSON.stringify(expected)}`); }
};
const O = `const order = targetPayload?.message?.order;`;

// ── kept behaviour ──
t('if without braces + optional chaining', `if (!targetPayload?.message?.order?.id) ${FAIL}`, ['Required | order.id']);
t('alias + destructuring', `${O} const { provider } = order; if (!provider?.id) ${FAIL}`, ['Required | order.provider.id']);
t('destructuring with default value', `${O} const { quote = {} } = order; if (!quote.price) ${FAIL}`, ['Required | order.quote.price']);
t('nested if keeps the outer guard', `${O} if (order.payments) { if (!order.payments[0].id) ${FAIL} }`, ['Required | order.payments[0].id']);

// ── boolean aliases / negation ──
t('boolean alias', `${O} const missing = !order?.id; if (missing) ${FAIL}`, ['Required | order.id']);
t('negated boolean alias', `${O} const ok = order?.status === 'ACTIVE'; if (!ok) ${FAIL}`, ['Expected value | order.status | ACTIVE']);
t('!(a && b) → De Morgan', `${O} if (!(Array.isArray(order.items) && order.items.length > 0)) ${FAIL}`, ['Non-empty list | order.items']);
t('!(x === v)', `${O} if (!(order.status === 'ACTIVE')) ${FAIL}`, ['Expected value | order.status | ACTIVE']);
t('!!x', `${O} if (!!order.cancellation) ${FAIL}`, ['Must be absent | order.cancellation']);

// ── null / undefined semantics ──
t('x == null → Required', `${O} if (order.id == null) ${FAIL}`, ['Required | order.id']);
t('x === undefined → Required', `${O} if (order.id === undefined) ${FAIL}`, ['Required | order.id | undefined']);
t("typeof x === 'undefined' → Required", `${O} if (typeof order.id === 'undefined') ${FAIL}`, ['Required | order.id']);
t('x !== undefined → Must be absent', `${O} if (order.cancel !== undefined) ${FAIL}`, ['Must be absent | order.cancel']);
t('x != null → Must be absent', `${O} if (order.cancel != null) ${FAIL}`, ['Must be absent | order.cancel']);
t('x !== null stays Expected value null', `${O} if (order.cancel !== null) ${FAIL}`, ['Expected value | order.cancel']);

// ── else / else-if ──
t('else branch → negated condition', `${O} if (order.status === 'ACTIVE') { } else ${FAIL}`, ['Expected value | order.status | ACTIVE']);
t('else-if chain', `${O} if (!order.id) ${FAIL} else if (order.items.length === 0) ${FAIL}`, ['Required | order.id', 'Non-empty list | order.items']);

// ── coercion / type ──
t('Number(a) !== Number(b) → Matches', `${O} if (Number(order.quote.price.value) !== Number(sessionData.quote_price)) ${FAIL}`, ['Matches | order.quote.price.value | quote_price from a previous call']);
t('trim() → Required', `${O} if (!order.id?.trim()) ${FAIL}`, ['Required | order.id']);
t("typeof x !== 'string' → Data type", `${O} if (typeof order.id !== 'string') ${FAIL}`, ['Data type | order.id | string']);
t('isNaN(Number(x)) → Data type number', `${O} if (isNaN(Number(order.quote.price.value))) ${FAIL}`, ['Data type | order.quote.price.value | number']);
t('isNaN(Date.parse(x)) → Data type date', `${O} if (isNaN(Date.parse(order.created_at))) ${FAIL}`, ['Data type | order.created_at | date']);
t('JSON.stringify(a) !== JSON.stringify(b) → Matches', `${O} if (JSON.stringify(order.billing) !== JSON.stringify(sessionData.billing)) ${FAIL}`, ['Matches | order.billing | billing from a previous call']);

// ── arrays / callbacks ──
t('indexOf === -1 → Allowed values', `${O} if (['A','B'].indexOf(order.status) === -1) ${FAIL}`, ['Allowed values | order.status | A,B']);
t('X.some(p) fails for any element', `${O} if (order.items.some(i => !i.id)) ${FAIL}`, ['Required | order.items[].id']);
t('!X.every(p)', `${O} if (!order.items.every(i => i.quantity?.selected?.count > 0)) ${FAIL}`, ['Comparison | order.items[].quantity.selected.count']);
t('filter(p).length > 0', `${O} if (order.items.filter(i => !i.id).length > 0) ${FAIL}`, ['Required | order.items[].id']);
t('!X.some(k === literal) → Must contain', `${O} if (!order.tags.some(g => g.descriptor.code === 'LOAN_INFO')) ${FAIL}`, ['Must contain | order.tags[].descriptor.code | LOAN_INFO']);
t('!X.every(k === literal) → Expected value', `${O} if (!order.items.every(i => i.fulfillment_id === 'F1')) ${FAIL}`, ['Expected value | order.items[].fulfillment_id | F1']);
t('for-of element', `${O} for (const it of order.items) { if (!it.id) ${FAIL} }`, ['Required | order.items[].id']);

// ── helpers (implementation inspected, name ignored) ──
t('boolean helper inlined', `const hasId = (o) => !!o && !!o.id; ${O} if (!hasId(order.provider)) ${FAIL}`, ['Required | order.provider.id']);
t('helper name is not trusted', `function isValidOrder(o) { return o.items.length > 2; } ${O} if (!isValidOrder(order)) ${FAIL}`, ['Comparison | order.items']);

// ── conservative: stays Custom logic ──
t('conflicting reassignment stays Custom', `let v = targetPayload.message.order.id; if (x) v = targetPayload.message.order.provider.id; if (!v) ${FAIL}`, ['Custom logic | v']);
t('same-path reassignment is resolved', `let v = targetPayload.message.order.id; v = targetPayload?.message?.order?.id; if (!v) ${FAIL}`, ['Required | order.id']);
t('unknown local variable stays Custom', `const n = compute(); if (!n) ${FAIL}`, ['Custom logic | n']);
t('helper with several statements stays as before', `function chk(o) { const a = 1; return a > o; } ${O} if (chk(order.x)) ${FAIL}`, ['Custom logic | order.x']);
// ── TRV patterns (added 2026-10-20) ──
t('!x.find(k === literal) → Must contain', `${O} const refund = order.quote?.breakup?.find((b) => b.title === 'REFUND'); if (!refund) ${FAIL}`, ['Must contain | order.quote.breakup[].title | REFUND']);
t('field of a found element keeps the filter', `${O} const start = order.fulfillments[0].stops?.find((s) => s.type === 'START'); if (!start?.authorization) ${FAIL}`, ['Required | order.fulfillments[0].stops[type=START].authorization']);
t('value check on a found element', `${O} const start = order.fulfillments[0].stops.find((s) => s.type === 'START'); if (start.location?.gps !== '1,2') ${FAIL}`, ['Expected value | order.fulfillments[0].stops[type=START].location.gps | 1,2']);
t('loop flag → Must contain', `${O} let hasStart = false; for (const s of order.fulfillments[0].stops) { if (s.type === 'START') hasStart = true; } if (!hasStart) ${FAIL}`, ['Must contain | order.fulfillments[0].stops[].type | START']);
t('loop flag set on a bad element', `${O} let bad = false; for (const i of order.items) { if (!i.id) bad = true; } if (bad) ${FAIL}`, ['Required | order.items[].id']);
t('loop over a literal list + some()', `const issue = targetPayload.message.issue; const req = ['ORDER', 'ITEM']; for (const t of req) { if (!issue?.refs?.some((r) => r?.ref_type === t)) ${FAIL} }`, ['Must contain | issue.refs[].ref_type | ORDER,ITEM']);
t('loop over a literal list + includes()', `${O} const codes = order.tags.map((g) => g.descriptor.code); for (const c of ['A', 'B']) { if (!codes.includes(c)) ${FAIL} }`, ['Must contain | order.tags[].descriptor.code | A,B']);
t('same name, for-of element and [0] → same field', `${O} for (const f of order.fulfillments) { if (!f.id) ${FAIL} } const f = order.fulfillments[0]; if (!f.agent) ${FAIL}`, ['Required | order.fulfillments[].id', 'Required | order.fulfillments[].agent']);
t('table-driven checks [[value, label], ...]', `${O} const checks = [[order.id, 'id'], [order.status, 'status']]; for (const c of checks) { if (!c[0]) ${FAIL} }`, ['Required | order.id', 'Required | order.status']);
t('table-driven checks [{ v, name }, ...]', `${O} const checks = [{ v: order.id, n: 'id' }]; for (const c of checks) { if (!c.v) ${FAIL} }`, ['Required | order.id']);
// ── Step 1: failure points other than return { valid: false } (added 2026-10-21) ──
const R_ERR = `const errors = []; const pushError = (code, description) => { errors.push({ code, description }); };`;
const R_END = `return { valid: errors.length === 0, code: errors.length === 0 ? 200 : 400, description: JSON.stringify(errors) };`;
const fnRaw = (body) => `function validate(targetPayload, sessionData) {\n${body}\n}`;
const rowsRaw = (body) => analyseFunction(fnRaw(body), parse).checks.map(c => [c.type, showPath(c.field), showPath(c.other), (c.values || []).join(',')].filter(Boolean).join(' | '));
const tr = (name, body, expected) => { const got = rowsRaw(body); try { assert.deepEqual(got, expected); passed++; console.log(`  ok  ${name}`); } catch { failed++; console.log(`  FAIL ${name}\n    got:      ${JSON.stringify(got)}\n    expected: ${JSON.stringify(expected)}`); } };
tr('reporter function pushError(code, msg)', `${R_ERR} ${O} if (!order.provider?.id) pushError(400, 'provider id missing'); ${R_END}`, ['Required | order.provider.id']);
tr('reporter inside a loop', `${R_ERR} ${O} for (const item of order.items) { if (!item.id) pushError(400, 'item id'); } ${R_END}`, ['Required | order.items[].id']);
tr('errors.push({ ... }) directly', `const errors = []; ${O} if (order.status !== 'ACTIVE') errors.push({ code: 400, description: 'status' }); ${R_END}`, ['Expected value | order.status | ACTIVE']);
tr('push into a list that does not decide valid is ignored', `const seen = []; ${O} if (order.id) seen.push(order.id); return { valid: true };`, []);
tr('throw inside try, catch returns valid:false', `try { ${O} if (!order.id) throw new Error('order id missing'); } catch (e) { return { valid: false, code: 400, description: e.message }; } return { valid: true };`, ['Required | order.id']);
tr('throw without a failing catch is ignored', `${O} if (!order.id) throw new Error('x'); return { valid: true };`, []);
{ const r = analyseFunction(fnRaw(`${R_ERR} ${O} if (!order.id) pushError(400, 'order id missing'); ${R_END}`), parse);
  try { assert.equal(r.checks[0].msg, 'order id missing'); assert.equal(r.checks[0].failKind, 'report'); assert.deepEqual(r.sites, { return: 0, report: 1, throw: 0 }); passed++; console.log('  ok  reporter message, kind and site count'); }
  catch (e) { failed++; console.log('  FAIL reporter message, kind and site count', e.message); } }
{ const r = analyseFunction(fnRaw(`const x = 1; if (x > 2) { foo(); } return { valid: true };`), parse);
  try { assert.equal(r.style, 'unrecognised'); passed++; console.log('  ok  code without a recognised failure point is flagged'); } catch { failed++; console.log('  FAIL unrecognised style', r.style); } }
{ const r = analyseFunction(fnRaw(`return { valid: true, code: 200 };`), parse);
  try { assert.equal(r.style, 'pass-through'); passed++; console.log('  ok  trivial pass-through stays pass-through'); } catch { failed++; console.log('  FAIL pass-through', r.style); } }

// ── Step 2: run conditions ("Only when …") ──
const whenOf = (body) => analyseFunction(fn(body), parse).checks.map(c => c.when);
const tw = (name, body, expected) => { const got = whenOf(body); try { assert.deepEqual(got, expected); passed++; console.log(`  ok  ${name}`); } catch { failed++; console.log(`  FAIL ${name}\n    got:      ${JSON.stringify(got)}\n    expected: ${JSON.stringify(expected)}`); } };
tw('no condition → Always (empty)', `${O} if (!order.id) ${FAIL}`, ['']);
tw('early return valid:true makes later checks conditional', `${O} if (!sessionData.provider_id) return { valid: true }; if (!order.provider.id) ${FAIL}`, ['Only when provider_id from a previous call is available']);
tw('checks before the early exit stay Always', `${O} if (!order.id) ${FAIL} if (order.status === 'DRAFT') return { valid: true }; if (!order.items) ${FAIL}`, ['', 'Only when order.status is not DRAFT']);
tw('continue guard in a loop', `${O} for (const it of order.items) { if (it.location_id == null) continue; if (it.location_id !== 'L1') ${FAIL} }`, ['Only when order.items[].location_id is sent']);
tw('enclosing if in plain words', `${O} if (order.items.length > 0) { if (!order.items[0].id) ${FAIL} }`, ['Only when order.items has entries']);
tw('exit inside a loop does not leak after the loop', `${O} for (const it of order.items) { if (it.skip) continue; if (!it.id) ${FAIL} } if (!order.id) ${FAIL}`, ['Only when order.items[].skip is not sent', '']);
tw('condition held in a local', `${O} const bpp = order.payment?.collected_by === 'BPP'; if (bpp) { if (!order.payment.uri) ${FAIL} }`, ['Only when order.payment.collected_by is BPP']);
tw('Array.isArray / includes / length in plain words', `${O} if (Array.isArray(order.items) && order.items.length === 1) { if (!order.items[0].id) ${FAIL} }`, ['Only when order.items is a list and order.items has exactly 1 entry']);
tw('sessionData on its own is dropped', `${O} if (sessionData && sessionData.order_id) { if (order.id !== sessionData.order_id) ${FAIL} }`, ['Only when order_id from a previous call is available']);
tw('if/else exit is not an early exit', `${O} if (order.a) { return { valid: true }; } else { order.b = 1; } if (!order.id) ${FAIL}`, ['']);

// ── Step 3: at least one of ──
t('!a && !b → At least one of', `const issue = targetPayload.message.issue; if (!issue.issue_actions && !issue.actions) ${FAIL}`, ['At least one of | issue.issue_actions | issue.issue_actions,issue.actions']);
t('!a && !b on the same field is not "at least one of"', `${O} if (!order.id && !order.id) ${FAIL}`, ['Required | order.id']);
t('!a && x !== v keeps the guard reading', `${O} if (!order.a && order.status !== 'X') ${FAIL}`, ['Expected value | order.status | X']);
t('flag set in two places stays Custom', `${O} let ok = false; for (const s of order.items) { if (s.a === 'X') ok = true; if (s.b === 'Y') ok = true; } if (!ok) ${FAIL}`, ['Custom logic | ok']);
t('X.some(p) with unknown predicate stays Custom', `${O} if (order.items.some(i => weird(i))) ${FAIL}`, ['Custom logic']);
t('catch-block failures are ignored', `try { a(); } catch (e) { ${FAIL} }`, []);

console.log(`\n${passed} L2 analyser tests passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed) process.exit(1);
