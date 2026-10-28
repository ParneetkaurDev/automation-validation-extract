// node test/l1-grouping.test.mjs - fixtures for every detector of lib/l1-grouping.mjs, positive and negative.
import assert from 'node:assert/strict';
import { analyseL1, canon } from '../lib/l1-grouping.mjs';
let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n    ${e.message.split('\n')[0]}`); } };
const run = (yaml) => analyseL1(yaml).findings;
const has = (rows, det) => rows.filter(r => r.detector.startsWith(det));
const rule = (name, attr, extra = '', ind = '        ') => `${ind}- _NAME_: ${name}\n${ind}  attr: ${attr}\n${extra}${ind}  _RETURN_: attr are present\n`;
const dedupe = (ind = '        ', op = 'any in') => `${ind}  ft: $.message.order.fulfillments[*].type\n${ind}  dd:\n${ind}    - DEDUPE\n${ind}  _CONTINUE_: '(ft ${op} dd)'\n`;
const doc = (body, api = 'on_select') => `_TESTS_:\n  ${api}:\n${body}`;
const grp = (name, kids, extra = '') => `    - _NAME_: ${name}\n${extra}      _RETURN_:\n${kids}`;

// canonical form
t('canon: variables resolved, spacing and variable names do not matter', () => {
  assert.equal(canon('!(a all in  b)', { a: '$.message.order.x', b: ['B', 'A'] }), canon('!(zz all in yy)', { zz: '$.message.order.x', yy: ['A', 'B'] }));
  assert.notEqual(canon('(a any in b)', { a: '$.x', b: ['A'] }), canon('(a all in b)', { a: '$.x', b: ['A'] }));
  assert.notEqual(canon('!(a are present)', { a: '$.x' }), canon('(a are present)', { a: '$.x' }));
});
// 1
const sib = (op2 = 'any in', f2 = '') => doc(grp('STOPS', rule('S_ID', '$.message.order.fulfillments[*].stops[*].id', dedupe()) + rule('S_TYPE', '$.message.order.fulfillments[*].stops[*].type', f2 + dedupe('        ', op2))));
t('1 sibling rules with the same condition → Safe', () => { const o = has(run(sib()).opportunities, '1'); assert.equal(o.length, 1); assert.equal(o[0].verdict, 'Safe'); assert.match(o[0].lines, /\d+, \d+/); });
t('1 negative: any in vs all in is not the same condition', () => assert.equal(has(run(sib('all in')).opportunities, '1').length, 0));
t('1 own action filter differs → Needs decision', () => assert.equal(has(run(sib('any in', '          action:\n            - on_init\n')).opportunities, '1')[0].verdict, 'Needs decision'));
t('1 negative: self-presence guards are never grouped', () => {
  const y = doc(grp('V', rule('A', '$.message.order.a', "          _CONTINUE_: '!(attr are present)'\n") + rule('B', '$.message.order.b', "          _CONTINUE_: '!(attr are present)'\n")));
  assert.equal(has(run(y).opportunities, '1').length, 0);
});
// 2
const ref = (n) => `    - _NAME_: G${n}\n      r: $.message.order.ref_order_ids[*]\n      _CONTINUE_: '(r are present)'\n      _RETURN_:\n${rule('X' + n, '$.message.order.x' + n)}`;
t('2 same condition in 3 places (different APIs)', () => assert.equal(has(run(`_TESTS_:\n  init:\n${ref(1)}  on_init:\n${ref(2)}  confirm:\n${ref(3)}`).opportunities, '2').length, 1));
t('2 negative: declared twice only', () => assert.equal(has(run(`_TESTS_:\n  init:\n${ref(1)}  on_init:\n${ref(2)}`).opportunities, '2').length, 0));
t('1 top-level rules of one API with the same condition', () => { const f = run(doc(ref(1) + ref(2) + ref(3), 'init')); assert.equal(has(f.opportunities, '1').length, 1); assert.equal(has(f.opportunities, '2').length, 0); });
// 3
const parentChild = (childPath) => doc(`    - _NAME_: TAGS\n      p: $.message.order.items[*].tags[*].descriptor.code\n      _CONTINUE_: '!(p are present)'\n      _RETURN_:\n        - _NAME_: ITEM_TAGS\n          q: ${childPath}\n          _CONTINUE_: '!(q are present)'\n          _RETURN_: q are present\n`, 'select');
t('3 child repeats the parent condition', () => assert.equal(has(run(parentChild('$.message.order.items[*].tags[*].descriptor.code')).opportunities, '3').length, 1));
t('3 negative: child condition on another path', () => assert.equal(has(run(parentChild('$.message.order.items[*].id')).opportunities, '3').length, 0));
// 4
const block = (name) => `    - _NAME_: ${name}\n      _RETURN_:\n${rule('A', '$.message.order.a')}${rule('B', '$.message.order.b')}`;
t('4 same block written twice', () => assert.equal(has(run(`_TESTS_:\n  on_init:\n${block('F1')}  on_status:\n${block('F2')}`).opportunities, '4').length, 1));
t('4 negative: second use is an alias (already shared)', () => {
  const y = `_TESTS_:\n  on_init:\n    - &F\n      _NAME_: F\n      _RETURN_:\n${rule('A', '$.message.order.a')}${rule('B', '$.message.order.b')}  on_status:\n    - *F\n`;
  assert.equal(has(run(y).opportunities, '4').length, 0);
});
t('4 negative: one rule differs', () => assert.equal(has(run(`_TESTS_:\n  on_init:\n${block('F1')}  on_status:\n    - _NAME_: F2\n      _RETURN_:\n${rule('A', '$.message.order.a')}${rule('B', '$.message.order.c')}`).opportunities, '4').length, 0));
// 5, 6, 8 - category groups
const form = (name, code, fields, base = '$.message.intent.provider.items[*].xinput', prop = 'value') =>
  `    - _NAME_: ${name}\n      u: ${base}.head.descriptor.code\n      h:\n        - ${code}\n      _CONTINUE_: '!(u all in h)'\n      _RETURN_:\n${fields.map(f => rule('F_' + f, `${base}.form.data.${f}.${prop}`)).join('')}`;
t('5 two values with the same field list', () => assert.equal(has(run(doc(form('T', 'TERM', ['pan', 'dob']) + form('BT', 'BUSINESS_TERM', ['pan', 'dob']), 'search')).opportunities, '5').length, 1));
t('5 negative: different field lists', () => assert.equal(has(run(doc(form('T', 'TERM', ['pan', 'dob']) + form('BT', 'BUSINESS_TERM', ['pan', 'gst']), 'search')).opportunities, '5').length, 0));
t('6 same field in 3 category groups', () => assert.equal(has(run(doc(form('A', 'A', ['pan', 'x']) + form('B', 'B', ['pan', 'y']) + form('C', 'C', ['pan', 'z']), 'search')).opportunities, '6').length, 1));
t('6 negative: field in 2 groups only', () => assert.equal(has(run(doc(form('A', 'A', ['pan', 'x']) + form('B', 'B', ['pan', 'y']), 'search')).opportunities, '6').length, 0));
const twoPayloads = (prop) => `_TESTS_:\n  search:\n${form('S', 'GOLD', ['pan', 'dob'])}  on_search:\n${form('O', 'GOLD', ['pan', 'dob'], '$.message.catalog.providers[*].items[*].xinput', prop)}`;
t('8 same list for search and on_search → Needs decision (scope semantics)', () => { const o = has(run(twoPayloads('value')).opportunities, '8'); assert.equal(o.length, 1); assert.equal(o[0].verdict, 'Needs decision'); });
t('8 negative: .value vs .type → a difference, not an opportunity', () => { const f = run(twoPayloads('type')); assert.equal(has(f.opportunities, '8').length, 0); assert.match(has(f.differences, '8')[0].detail, /different property/); });
// 7
t('7 same category tested with all in and any in', () => {
  const y = doc(form('A', 'A', ['p']) + form('B', 'B', ['q']).replace("'!(u all in h)'", "'!(u any in h)'"), 'search');
  assert.equal(has(run(y).differences, '7 Operators').length, 1);
});
t('7 negative: one operator, one variable name', () => assert.equal(has(run(doc(form('A', 'A', ['p']) + form('B', 'B', ['q']), 'search')).differences, '7').length, 0));
// 9
const pay = (label2) => doc(`    - _NAME_: P\n      _RETURN_:\n        - _NAME_: COLLECTED_BY\n          attr: $.message.order.payments[*].collected_by\n          u: $.message.order.payments[*].time.label\n          l:\n            - LOAN_DISBURSMENT\n          _CONTINUE_: '!(u all in l)'\n          _RETURN_: attr are present\n        - _NAME_: BANK\n          _SCOPE_: $.message.order.payments[*][?(@.time.label=='${label2}')]\n          _RETURN_:\n${rule('BANK_CODE', '$.params.bank_code', '', '            ')}`, 'init');
t('9 condition and _SCOPE_ filter for the same value', () => assert.equal(has(run(pay('LOAN_DISBURSMENT')).differences, '9').length, 1));
t('9 negative: different value', () => assert.equal(has(run(pay('INSTALLMENT')).differences, '9').length, 0));
t('9 negative: _SCOPE_ nested inside the conditioned group', () => {
  const y = doc(`    - _NAME_: TAGS\n      u: $.message.order.items[*].tags[*].descriptor.code\n      v:\n        - LOAN_INFO\n      _CONTINUE_: '!(u all in v)'\n      _RETURN_:\n        - _NAME_: INFO\n          _SCOPE_: $.message.order.items[*].tags[?(@.descriptor.code=='LOAN_INFO')]\n          _RETURN_:\n${rule('X', '$.list', '', '            ')}`, 'on_select');
  assert.equal(has(run(y).differences, '9').length, 0);
});
// 10
t('10 anchor declared twice', () => assert.equal(has(run(`_TESTS_:\n  on_init:\n    - &X\n      _NAME_: A\n      attr: $.message.order.a\n      _RETURN_: attr are present\n    - &X\n      _NAME_: B\n      attr: $.message.order.b\n      _RETURN_: attr are present\n`).risks, '10 Anchor').length, 1));
t('10 absolute path inside _SCOPE_', () => assert.equal(has(run(doc(`    - _NAME_: S\n      _SCOPE_: $.message.order.payments[*]\n      _RETURN_:\n${rule('A', '$.message.order.payments[*].id')}`, 'init')).risks, '10 Absolute').length, 1));
t('10 negative: relative path inside _SCOPE_', () => assert.equal(has(run(doc(`    - _NAME_: S\n      _SCOPE_: $.message.order.payments[*]\n      _RETURN_:\n${rule('A', '$.id')}`, 'init')).risks, '10 Absolute').length, 0));
t('10 path from another payload (catalog in search)', () => assert.equal(has(run(doc(rule('A', '$.message.catalog.providers[*].id', '', '    '), 'search')).risks, '10 Path').length, 1));
t('10 negative: intent in search, catalog in on_search', () => { assert.equal(has(run(doc(rule('A', '$.message.intent.provider.id', '', '    '), 'search')).risks, '10 Path').length, 0); assert.equal(has(run(doc(rule('A', '$.message.catalog.providers[*].id', '', '    '), 'on_search')).risks, '10 Path').length, 0); });
// 11
const lbl = (cond) => `_TESTS_:\n  init:\n${rule('LABEL', '$.message.order.payments[*].time.label', '', '    ')}  on_init:\n${rule('LABEL', '$.message.order.payments[*].time.label', cond, '    ')}`;
t('11 same rule, different conditions per API', () => assert.equal(has(run(lbl("      t: $.message.order.payments[*].type\n      s:\n        - ON_ORDER\n      _CONTINUE_: '(t any in s)'\n")).differences, '11').length, 1));
t('11 negative: same rule, same (no) condition', () => assert.equal(has(run(lbl('')).differences, '11').length, 0));
// analysis only
t('analysis never changes the input text', () => { const y = sib(); const before = y; run(y); assert.equal(y, before); });
console.log(`\n${passed} L1 grouping tests passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
