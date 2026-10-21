// node test/l2-patterns.test.mjs - every entry of the pattern registry (lib/l2-patterns.mjs) must give its expected check.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyseFunction, showPath } from '../lib/l2-analyse.mjs';
import { PATTERNS, FAIL } from '../lib/l2-patterns.mjs';
const { parse } = createRequire(import.meta.url)('@babel/parser');
let passed = 0, failed = 0;
for (const p of PATTERNS) {
  const code = `function validate(targetPayload, sessionData) {\n${p.body}\n${p.raw ? '' : 'return { valid: true };'}\n}`;
  const r = analyseFunction(code, parse);
  const c = r.checks[0];
  const got = c ? [c.type, showPath(c.field), showPath(c.other), (c.values || []).join(',')].filter(Boolean).join(' | ') : '(none)';
  try {
    assert.equal(got, p.expect);
    if (p.when) assert.equal(c.when, p.when);
    passed++; console.log(`  ok  ${p.id.padEnd(4)} ${p.name}`);
  } catch { failed++; console.log(`  FAIL ${p.id} ${p.name}\n    got:      ${got}${p.when ? ` / ${c?.when}` : ''}\n    expected: ${p.expect}${p.when ? ` / ${p.when}` : ''}`); }
}
console.log(`\n${passed} pattern registry entries verified${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
