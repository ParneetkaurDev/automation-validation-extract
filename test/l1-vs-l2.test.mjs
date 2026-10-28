// node test/l1-vs-l2.test.mjs - fixtures for the L1 ↔ L2 comparison (lib/l1-vs-l2.mjs). No repo needed.
import assert from 'node:assert/strict';
import { annotateL2, normPath } from '../lib/l1-vs-l2.mjs';
let passed = 0, failed = 0;
const L1 = (api, jsonPath, expression, values = '', runClass = 'Always runs', ruleName = 'R', line = 1) =>
  ({ api, jsonPath, field: jsonPath.replace(/^\$\.message\./, '').replace(/^\$\./, '').replace(/\[\*\]/g, '[]'), expression, values, runClass, when: runClass === 'Always runs' ? 'Always' : 'Skipped when x is absent', ruleName, line, ruleType: '' });
const L2 = (api, field, checkType, values = '', extra = {}) => ({ api, field, fieldRoot: 'payload', checkType, values, onlyWhen: '', comparedWith: '', ...extra });
const l1 = [
  L1('on_select', '$.message.order.provider.id', 'attr are present', '', 'Always runs', 'PROVIDER_ID', 10),
  L1('on_select', '$.message.order.items[*].id', 'attr are present', '', 'Always runs', 'ITEM_ID', 11),
  L1('on_select', '$.message.order.fulfillments[*].type', 'attr all in enums', 'ROUTE, TRIP', 'Always runs', 'FF_TYPE', 12),
  L1('on_select', '$.message.order.quote.ttl', 'attr are present', '', 'Optional field (checked only when present)', 'TTL', 13),
  L1('on_select', '$.message.order.tags[?(@.descriptor.code==\'BAP_TERMS\')].list[*].descriptor.code', 'attr any in codes', 'STATIC_TERMS', 'Always runs', 'TERMS', 14),
  L1('on_init', '$.message.order.status', 'attr are present', '', 'Always runs', 'STATUS', 20),
];
// Duplicate only for an exact match ('Already in L1' with nothing different); dup = expected "In L1?" when it is not the default
const t = (name, c, label, remark, dup) => {
  annotateL2(l1, [c]);
  const want = dup ?? (label === 'Already in L1' ? 'Duplicate' : '-');
  try { assert.equal(c.l1Detail, label); assert.equal(c.inL1, want); if (remark) assert.match(c.l1Remark, remark); passed++; console.log(`  ok  ${name}`); }
  catch { failed++; console.log(`  FAIL ${name}\n    got: ${c.l1Detail} / ${c.inL1} | ${c.l1Remark}`); }
};
assert.equal(normPath('$.message.order.items[*].tags[?(@.code==\'X\')].id'), 'order.items.tags.id'); passed++; console.log('  ok  path normalisation');
t('same Required, L1 always → Duplicate', L2('on_select', 'order.provider.id', 'Required'), 'Already in L1', /PROVIDER_ID, line 10/);
t('[0] vs [*] is the same field', L2('on_select', 'order.items[0].id', 'Required'), 'Already in L1', /ITEM_ID/);
t('Required parent of an always-required child → Implied', L2('on_select', 'order.items', 'Non-empty list'), 'Covered by L1', /order.items\[\].id/);
t('Expected value inside L1 list → Stricter', L2('on_select', 'order.fulfillments[].type', 'Expected value', 'ROUTE'), 'L2 is stricter', /accepts only ROUTE/);
t('same allowed list → Duplicate', L2('on_select', 'order.fulfillments[].type', 'Allowed values', 'TRIP, ROUTE'), 'Already in L1');
t('value outside L1 list → Conflict', L2('on_select', 'order.fulfillments[].type', 'Expected value', 'DELIVERY'), 'Conflicts with L1', /accepts DELIVERY, but L1 only allows/);
t('L1 only when present, L2 always → Stricter, but a Duplicate (L1 has it conditionally)', L2('on_select', 'order.quote.ttl', 'Required'), 'L2 is stricter', /as optional/, 'Duplicate');
t('find() filter matches L1 JSONPath filter', L2('on_select', 'order.tags[descriptor.code=BAP_TERMS].list[].descriptor.code', 'Must contain', 'STATIC_TERMS'), 'Already in L1', /TERMS/);
t('different filter value is not the same field', L2('on_select', 'order.tags[descriptor.code=OTHER].list[].descriptor.code', 'Must contain', 'STATIC_TERMS'), 'Only in L2');
t('cross-call Matches on an L1 field → different check', L2('on_select', 'order.provider.id', 'Matches', '', { comparedWith: 'order.provider.id from previous call on_search' }), 'L2 adds a check', /sent earlier in on_search/);
t('field only validated in another API', L2('on_select', 'order.status', 'Required'), 'Only in L2', /checks it in on_init/);
t('unresolved code variable', L2('on_select', 'sourceItem', 'Required', '', { fieldRoot: 'var' }), 'Check manually');
t('at least one of, L1 always requires one → covered', L2('on_select', 'order.provider.id', 'At least one of', 'order.provider.id, order.provider.descriptor'), 'Covered by L1', /at least one of/);
t('at least one of, no L1 rule → only in L2', L2('on_select', 'order.x', 'At least one of', 'order.x, order.y'), 'Only in L2', /any of order.x, order.y/);
t('custom logic', L2('on_select', 'order.id', 'Custom logic'), 'Check manually');
t('only the condition differs (L2 conditional, L1 always) → Duplicate', L2('on_select', 'order.provider.id', 'Required', '', { onlyWhen: 'Only when order.status is ACTIVE' }), 'Already in L1', /L1 already covers it/, 'Duplicate');
t('strict: covered by a child field is a difference → not a duplicate', L2('on_select', 'order.items', 'Non-empty list'), 'Covered by L1', null, '-');
t('strict: L2 stricter is a difference → not a duplicate', L2('on_select', 'order.fulfillments[].type', 'Expected value', 'ROUTE'), 'L2 is stricter', null, '-');
t('both conditional → Duplicate (make sure conditions match)', L2('on_select', 'order.quote.ttl', 'Required', '', { onlyWhen: 'Only when x' }), 'Already in L1', /make sure the conditions match/, 'Duplicate');
l1.push(L1('on_select', '$.message.order.id', 'attr are present && attr follow regex rx', '^O', 'Always runs', 'ORDER_ID', 30));
t('strict: L1 rule checks more (presence + format) → not a duplicate', L2('on_select', 'order.id', 'Required'), 'Already in L1', /also checks more/, '-');
console.log(`\n${passed} L1-vs-L2 tests passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
