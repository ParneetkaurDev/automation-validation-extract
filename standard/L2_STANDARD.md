# L2 coding standard (v1)

Every L2 function (`mock.validate` and `mock.requirements` in a flow step) is written as a **list of declared checks** run by one shared runner, `runChecks` (`standard/runChecks.js`). Domains still differ, but only in the **data** (paths, values, conditions), never in the code shape. Because of that the extractor reads every check exactly, nothing is guessed, and `lint-l2.mjs` enforces it in CI.

## Shape

```js
function validate(targetPayload, sessionData) {
  return runChecks([
    { id: 'S02', desc: 'context.action must be on_select', path: '$.context.action', rule: { eq: 'on_select' } },
    { id: 'S03', desc: 'transaction_id must match the session', path: '$.context.transaction_id',
      rule: { eqSession: 'transactionId[0]' }, when: { session: 'transactionId[0]' } },
    { id: 'BL_SEL_01', desc: 'loan items need a LOAN_INFO tag', path: '$.message.order.items[*].tags[*].descriptor.code',
      rule: { contains: 'LOAN_INFO' }, when: { path: '$.message.order.items[*].category_ids', includes: 'LOAN' } },
    { id: 'BL_SEL_02', desc: 'offer amount must not exceed the sanctioned limit',
      reads: ['$.message.order.quote.price.value', 'session:sanction_limit'],
      custom: (p, s) => !s.sanction_limit || Number(p.message.order.quote.price.value) <= Number(s.sanction_limit) },
  ], targetPayload, sessionData);
}
```

A function with no checks just returns `{ valid: true }` (pass-through). It is allowed and counted separately.

## Fields of a check

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the function. Use the common ID (S01–S15, R01–R07, O01–O16, CX1…) for a common check; use `<DOMAIN>_<API>_<nn>` for a domain-specific one. |
| `desc` | yes | The business sentence shown in the sheet and in the error message. |
| `path` | yes (unless `custom`) | JSONPath into the payload: `$.a.b`, `$.a[*].b`, `$.a[0].b`. |
| `rule` | yes (unless `custom`) | One rule from the table below. |
| `when` | no | The **skip condition**, as data. The check runs only when every condition holds. |
| `custom` + `reads` | escape hatch | A function for logic no rule covers. It must list every field it reads in `reads`. |

## Rules

| Rule | Example | Sheet check type |
|---|---|---|
| `'required'` | `rule: 'required'` | Required |
| `'nonEmpty'` | `rule: 'nonEmpty'` | Non-empty list |
| `'absent'` | `rule: 'absent'` | Must be absent |
| `{ eq: v }` | `{ eq: 'on_select' }` | Expected value |
| `{ in: [..] }` | `{ in: ['ONLINE','SEMI_ONLINE'] }` | Allowed values |
| `{ regex: '..' }` | `{ regex: '^IND$' }` | Format |
| `{ contains: v }` | `{ contains: 'LOAN_INFO' }` | Must contain |
| `{ gte: n }` / `{ lte: n }` | `{ gte: 0 }` | Comparison |
| `{ eqSession: 'key' }` | `{ eqSession: 'transactionId[0]' }` | Matches (continuity) |
| `{ eqPath: '$.x' }` | `{ eqPath: '$.message.order.quote.price.currency' }` | Matches |
| `{ existsIn: '$.x' \| 'session:key' }` | `{ existsIn: 'session:item_ids' }` | Exists in |

A path with `[*]` means every element must pass, and at least one must exist (except `absent`).

## `when` (skip conditions)

| Form | Runs when |
|---|---|
| `{ path: '$.x' }` | x is present |
| `{ path: '$.x', eq: 'A' }` | x is A |
| `{ path: '$.x', in: ['A','B'] }` | x is A or B |
| `{ path: '$.x', includes: 'A' }` | the list x contains A |
| `{ session: 'key' }` | the session has key |
| `[ {...}, {...} ]` | all of them hold |

Because the condition is data, the baseline compare can check that the field it depends on is part of the common baseline. If it isn't, the result is a **BLOCKER (hidden skip)**.

## Lint rules (`lint-l2.mjs`)

| Rule | Severity | What it catches |
|---|---|---|
| L2-001 | WARN (ERROR with `--strict`) | Function is not in the standard shape (hand-written `if … return {valid:false}`) |
| L2-002 | ERROR | `return {valid:false}` outside `runChecks` in a standard function |
| L2-003 | ERROR | `runChecks` not given an inline array of object literals |
| L2-004 | ERROR | Missing or duplicate `id`, or missing `desc` |
| L2-005 | ERROR | `path` missing or not a `$.`-string literal |
| L2-006 | ERROR | Unknown `rule`, or a rule value that is not a literal |
| L2-007 | ERROR | `custom` without `reads`, or `custom` that is not a function |
| L2-008 | ERROR | A `catch` returns `valid: true` (errors silently pass) |
| L2-009 | WARN | Legacy code: a failure nested in 2+ `if`s (a hidden skip state) |
| L2-010 | ERROR | `when` is not a literal condition object (inline JS) |

## Migration

1. **Now:** lint runs in warning mode. The extractor already reads legacy code (pattern rules) and standard code (exactly), so the sheet and baseline work on both.
2. **Per domain:** rewrite legacy functions into the shape above, starting with the "L2 Custom logic" rows and the L2-009 warnings. Then switch that domain's CI to `--strict`.
3. **Runner hook:** each flow file has a `validationLib` key next to `helperLib`. Today `helperLib` holds helpers that are appended below every generate function, and `validationLib` is empty in every flow checked. `runChecks` belongs in `validationLib`, once the mock runner team confirms that it is appended to `validate`/`requirements` the same way. Until then, paste `runChecks` above `validate`; the extractor and lint accept both.
