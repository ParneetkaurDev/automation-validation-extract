# standard/ — the L2 coding standard

| File | What it is |
|---|---|
| `L2_STANDARD.md` | The standard: how to write L2 `validate` / `requirements` code so it can be extracted exactly, plus the lint rules |
| `runChecks.js` | The shared runner that executes a declared list of checks (goes in the flow's `validationLib`, or pasted above `validate`) |
| `examples/on_select.validate.js` | A real function rewritten to the standard |
| `cross-call-catalog.json` | The 33 common cross-call checks (CX1–FM2) and the rules that map L2 checks onto them |
| `package.json` | Marks `runChecks.js` as CommonJS so it can be loaded by tests |

## Write a check in the standard shape

```js
function validate(targetPayload, sessionData) {
  return runChecks([
    { id: 'O04', desc: 'provider.id is required', path: '$.message.order.provider.id', rule: 'required' },
    { id: 'S03', desc: 'transaction_id must match the session', path: '$.context.transaction_id',
      rule: { eqSession: 'transactionId[0]' }, when: { session: 'transactionId[0]' } },
  ], targetPayload, sessionData);
}
```

Rules: `required`, `nonEmpty`, `absent`, `{eq}`, `{in}`, `{regex}`, `{contains}`, `{gte}`, `{lte}`, `{eqSession}`, `{eqPath}`, `{existsIn}`; `custom` + `reads` for anything else. Full details in `L2_STANDARD.md`.

## Check your code against the standard

```bash
cd ~/Documents/MyWorkingFolder/"Purchase Finance"/validation-extract
node lint-l2.mjs --config ../automation-specifications/config --out out/lint             # checked-out branch
node lint-l2.mjs --config ../automation-specifications/config --strict --out out/lint    # non-standard = error
```

Results: `out/lint/l2-lint.csv` (one row per issue) and `out/lint/l2-lint-summary.csv`.

## Try the runner

```bash
node -e '
const { runChecks } = require("./standard/runChecks.js");
console.log(runChecks([{ id: "O04", desc: "provider.id is required", path: "$.message.order.provider.id", rule: "required" }],
  { message: { order: { provider: {} } } }, {}));'
```
