# lib/ — shared modules (used by gold.mjs, not run directly)

| File | What it does |
|---|---|
| `crosscall.mjs` | Loads `standard/cross-call-catalog.json` and maps each extracted L2 check to a common cross-call ID (CX1…FM2) with fixed matching rules. Used by `simplify`, `compare` and `crosscall`. |
| `messages.mjs` | Builds the developer messages when the gate fails: what is missing, where to add/fix it (file + line), a working example, how to waive. Also the GitHub `::error` annotations and the markdown fix list (`<branch>_fix-list.md`, run summary). |

See them in action:

```bash
cd ~/Documents/MyWorkingFolder/"Purchase Finance"/validation-extract
node gold.mjs crosscall --in out/report/validations.json --out out/crosscall          # crosscall.mjs
node gold.mjs compare --in out/report/validations.json --gold auto \
  --branch draft-FIS12-PF-2.3.0 --max-warnings 5 --out out/compare                     # messages.mjs
```
