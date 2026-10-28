# validation-extract

Extracts the ONDC **L1** and **L2** validations from any branch of
[ONDC-Official/automation-specifications](https://github.com/ONDC-Official/automation-specifications), finds the
validations **common** to a group of branches (use cases), and **compares** a branch with that common set.

- **L1** = rules in `config/validations/index.yaml` (YAML)
- **L2** = the `validate` JavaScript in each flow step (`config/flows/**`, base64 in `mock.validate`)

No AI is involved: the same branch always gives the same output.

---

## 1. Setup (once)

Needs **Node 18+**, **git** and (for the business report in `compare`) **python3** with `openpyxl`.

```bash
cd ~/Documents/MyWorkingFolder/"Purchase Finance"/automation-validation-extract
npm install
```

You do **not** need a local clone of the spec repo. Every command downloads the branches it needs straight from
GitHub into the `.spec-cache/` folder (only the latest commit of each branch; later runs only fetch what changed).

---

## 2. The three commands

| Command | What it does | Output |
|---|---|---|
| `npm run extract -- <branch> [<branch> …]` | L1 + L2 validations of each branch | `out/extract/<branch>/` |
| `npm run common -- <GROUP \| branch branch …>` | validations common to the branches, the ones shared by some, and the ones specific to each | `out/common/<name>/` |
| `npm run compare -- <branch> [<common>]` | compares a branch with a common set (auto-picked when left out) | `out/compare/<branch>_vs_<common>/` |

Shortcuts for the domain groups: `npm run common:trv`, `npm run common:ret`, `npm run common:fis`.

> Always put `--` after the script name; everything after it is passed to the command.

### Options (all commands)

| Option | Meaning |
|---|---|
| `--from <owner/repo>` | read from another repo, e.g. your fork: `--from ParneetkaurDev/automation-specifications` (default: ONDC-Official) |
| `--no-fetch` | don't download; use what is already in `.spec-cache/` (offline) |
| `--name <name>` | (`common` only) name of the output folder |
| `--json-only` | (`extract` only) only `validations.json`, no Excel |
| `--l1-only` | (`extract` only) skip L2 |

---

## 3. Branches

Draft branches in the main repo (as of 20 Oct 2026). The **TRV**, **RET** and **FIS** groups are stored in
`branch-groups.json`; edit that file to add or remove branches or to add a group (e.g. `LOG`, `NTS`).

| Group | Branches |
|---|---|
| **TRV** (9) | draft-TRV10-2.0.1, draft-TRV10-2.1.0, draft-TRV11-2.0.0, draft-TRV11-2.0.1, draft-TRV11-2.1.0, draft-TRV12-2.0.0, draft-TRV13-2.0.0, draft-TRV13-2.0.1, draft-TRV14-2.0.0 |
| **RET** (18) | draft-RET10-1.2.0, draft-RET10-1.2.5, draft-RET11-1.2.0, draft-RET11-1.2.5, draft-RET12-1.2.0, draft-RET12-1.2.5, draft-RET13-1.2.0, draft-RET13-1.2.5, draft-RET14-1.2.0, draft-RET14-1.2.5, draft-RET15-1.2.0, draft-RET15-1.2.5, draft-RET16-1.2.0, draft-RET16-1.2.5, draft-RET18-1.2.0, draft-RET18-1.2.5, draft-RETINVL-1.2.5, draft-RETeB2B |
| **FIS** (15) | draft-FIS10-GIFTCARD-2.1.0, draft-FIS11-2.0.0, draft-FIS12-2.0.3, draft-FIS12-2.3.0, draft-FIS12-GD-2.0.2, draft-FIS12-PF-2.2.0, draft-FIS12-PF-2.2.1, draft-FIS12-PF-2.3.0, draft-FIS12-PL-2.0.1, draft-FIS12BL-2.3.0, draft-FIS12SL-2.3.0, draft-FIS13-HEALTH-2.0.0, draft-FIS13-HEALTH-2.0.1, draft-FIS13-sachet, draft-FIS14-2.1.0 |
| Logistics (not a group yet) | draft-logistics-1.2.0, draft-logistics-1.2.5, draft-LOG11-1.2.5 |
| NTS (not a group yet) | draft-NTS10-2.0.0, draft-NTS10-RSF-1.0 |

Any branch name works in the commands, not only these. If a name is wrong, the command lists the draft branches
with a similar name.

---

## 4. Extract — L1 and L2 of a branch

```bash
npm run extract -- draft-TRV11-2.1.0                         # one branch
npm run extract -- draft-RET10-1.2.5 draft-RET11-1.2.5       # several branches (one folder each)
npm run extract -- draft-FIS12SL-2.3.0 --from ParneetkaurDev/automation-specifications   # from your fork
```

Output in `out/extract/<branch>/`:

| File | Contents |
|---|---|
| `ONDC_<DOMAIN>_<VERSION>_<branch>_validations.xlsx` | tabs **L1 Validations**, **L2 Validations**, **L2 vs L1** |
| `validations.json` | all rows, machine-readable, sorted (branch → API → Key) |

Columns: API, Field, Check, Values, Runs, Validation. The **L2 Validations** tab also has:

- **In L1?** — **Duplicate** when L1 has the same validation (same field, check and values, and the L1 rule checks nothing more) - also when L1 runs it only conditionally (or only when the field is sent) or L2 runs it conditionally; the remark then names the condition difference. **-** when L1 does not have it or the check itself differs (other values, L1 rule checks more, covered by another field)
- **L1 remark** — a plain sentence saying why, ending with the matching L1 rule and its line in `index.yaml`,
  e.g. `[L1: REQUIRED_ITEM_ID, line 1541]`. For a Duplicate it also says if anything differs (L1 allows more values,
  treats the field as optional, checks it only in some cases, or rejects a value L2 accepts).
- **L2 layout** — one tab, one block per **use case** ("Use case: X · N validations · M flows"). Each block lists **every** L2 validation that runs in that use case (a check used in several use cases appears in each of their blocks), with the **Action ID**s and **Flow ID**s of that use case only. The L2 vs L1 totals count each validation once.
- **Flow ID** / **Use case ID** — every flow the L2 validation appears in (one per line) and its use case (from the flow's `meta`, else `config/flows/index.yaml`). L2 sheet only.

`validations.json` keeps the detailed result in `l1Detail` (Already in L1 · Covered by L1 · L2 is stricter ·
Conflicts with L1 → *Duplicate*; Only in L2 · L2 adds a check · Check manually → *-*).

The **L2 vs L1** tab has one row per API (call): **L1 total**, **L2 total**, how many L2 checks are already in L1 (Duplicate) and how many are not (-), with a Total row and the same explanations under the table.

Every validation has a **Key** = `Layer | API | Field | Check` (e.g. `L1 | search | context.bap_id | Required`); this
is what `common` and `compare` match on.

---


### Workbook tabs (one per branch: `out/extract/<branch>/…_validations.xlsx`)

| Tab | What it shows |
|---|---|
| **L1 Validations** | every L1 rule, one colour band per API |
| **L2 Validations** | one block per **use case** with every L2 validation that runs there (Action ID, In L1?, L1 remark, Flow ID) |
| **L2 Common** | L2 validations in **every** use case of the branch |
| **L2 Intersection** | in more than one but not all use cases - one block per set of use cases ("In 4 of 5 use cases … missing in …") |
| **L2 Specific** | only in one use case - one block per use case |
| **Use cases** | per use case: flows, L2 validations, common / intersection / specific, with a Total row |
| **L2 vs L1** | per API: L1 total, L2 total, L2 already in L1 (Duplicate) / not exactly (-) |

A use case comes from the flow (`meta.use_case_id`, else `usecase` in `config/flows/index.yaml`). L1 rules belong to a call,
not a flow, so they apply to every use case and are only in the L1 tab.

**Several branches** (`npm run extract -- <branch> <branch> …` or a group such as `FIS`): besides one workbook per branch you also get
`out/extract/combined-<branches>/combined_<n>-branches_validations.xlsx` (name it with `--name`), with the same L2 tabs where every
**branch · use case** is one use case - so you can see the L2 validations common to, shared by, or specific to each branch's use cases.

The workflow is two phases: **1. `npm run extract`** (this workbook) → **2. `npm run compare`** (a branch against a common set built with `npm run common`).

## 5. Common — validations shared across use cases

Each branch is treated as one use case of the domain.

```bash
# a whole domain group (from branch-groups.json)
npm run common:trv                    # same as: npm run common -- TRV   → out/common/TRV-common/
npm run common:ret                    #                                   → out/common/RET-common/
npm run common:fis                    #                                   → out/common/FIS-common/

# your own choice of 2, 3 or more branches
npm run common -- draft-TRV11-2.0.0 draft-TRV11-2.0.1 draft-TRV11-2.1.0 --name TRV11-common
npm run common -- draft-FIS12-2.3.0 draft-FIS12BL-2.3.0 draft-FIS12-PF-2.3.0 --name FIS12-2.3.0-common
npm run common -- draft-RET10-1.2.5 draft-RET11-1.2.5 --name RET-1.2.5-common
```

Without `--name` the folder is called `<GROUP>-common` for a group, or `common-<branch>+<branch>…` for a list.

Output in `out/common/<name>/`:

| File | Contents |
|---|---|
| `1_common/<name>_common.*` | validations present in **all** use cases. *Remarks* says where values or run conditions differ |
| `2_intersection/<name>_intersection.*` | present in **more than one but not all** (e.g. 3 of 5): *In branches*, *Present in*, *Missing in*, one column per use case, *Remarks* |
| `3_specific/<name>_specific.*` | **one file**, one tab per use case and layer (e.g. `TRV11-2.1.0 L1`) with the validations only that use case has |
| `<name>_summary.*` | per use case: total = common + intersection + specific, also split by L1 / L2 |
| `source/validations.json` | the extraction the report was built from |

Every report comes as **.xlsx** (separate `L1` / `L2` tabs), **.csv** (`_L1.csv` / `_L2.csv`) and **.json**
(`{ "L1": [...], "L2": [...] }`, keys sorted, rows in a fixed order for clean diffs).

The **.xlsx** files use the same format as the L1 / L2 extraction workbook, so they can be read side by side:
columns **API · Field · Check · Values · Runs · Validation** first (same order, same colour band per API, Runs coloured),
then the report's own columns (*Cross-call check* on L2 only, *In branches*, *Present in*, *Missing in*, one column per use case,
*Remarks*). *Key*, *Layer*, *Depends on* and *Use case* are kept in the .csv / .json (in the workbook the layer and use case are the tab name).
Each common / intersection workbook also has a **Total** tab (L1 total, L2 total and Total per API, with a Total row); the specific workbook's Total tab has one row per use case. The summary workbook shows **L1 total** and **L2 total** per use case and how many are common / in the intersection / specific per layer.

Good to know:
- With **2 branches** the intersection is always empty (a validation is either in both or in one).
- L2 code is written per service, so across a whole domain few or no L2 checks are common (TRV: 98 L1, 0 L2).
  For L2, build the common set per service, e.g. the three TRV11 branches (61 common L2 checks).

---

## 6. Compare — a branch against a common set

Build a common set first (section 5), then:

```bash
npm run compare -- draft-TRV11-2.1.0                    # auto-pick the best common set in out/common/
npm run compare -- draft-TRV11-2.1.0 TRV11-common       # a common set by its --name
npm run compare -- draft-TRV13-2.0.1 TRV                # the group's set (out/common/TRV-common)
npm run compare -- draft-FIS12SL-2.3.0 FIS12-2.3.0-common
npm run compare -- draft-TRV11-2.1.0 out/common/TRV11-common/1_common/TRV11-common_common.json   # a file
```

**Auto-pick** (no common set given): the branch's domain is read from its `config/index.yaml` and the best report in
`out/common/` is chosen — all use cases have the same domain › some do › same family (FIS12:SL ↔ FIS12) › same
prefix (TRV11 ↔ TRV10). A set built from the branch itself is only used if nothing else fits. The command prints
which set it picked, why, and the other candidates.

Output in `out/compare/<branch>_vs_<common>/`:

| File | Contents |
|---|---|
| `<branch>_vs_<common>.xlsx` | business view in the same format as the extraction workbook — tabs **Summary** (result PASS / WARN / FAIL, L1 / L2 / Total per result, the kinds of review, key findings), **Per API** (one row per call: in common set, matching, needs review, blockers, missing, extra, Total row), **Needs review** (blockers first, with *What's different* and *What to do*), **Missing**, **Matching**, **Extra**, **Common set**. Every detail tab starts with API · Layer · Field · Check · Values · Runs · Validation |
| `compare/<branch>_fix-list.md` | developer view — what to add or fix and where |
| `compare/<branch>_vs_<common>.xlsx` | row-by-row comparison with a status per validation |
| `report/` | the extraction of the branch |

Result (last line in the terminal, also the exit code):

| Status | Meaning | Result |
|---|---|---|
| MISSING | common validation not in the branch | **FAIL** |
| BLOCKER | in the branch but hidden behind a skip condition the common set doesn't have | **FAIL** |
| CONDITIONAL | skipped in more cases than in the common set | warning |
| DIFFERENT VALUES | branch doesn't accept all the common values | warning |
| OK / EXTRA | matches / only in this branch | pass |

---

## 6b. Fix - remove L2 checks that repeat L1

```bash
npm run extract -- <branch> --from ParneetkaurDev/automation-specifications      # or extract from your local clone
npm run fix-duplicates -- <branch> --repo ../automation-specifications           # dry run: report only
npm run fix-duplicates -- <branch> --repo ../automation-specifications --include-covered --apply --git-branch fix/<name>
```

Reads `out/extract/<branch>/validations.json` (must be the same commit as the repo) and removes, from the flow-step
`validate` code, the `if (…) return { valid: false }` blocks whose checks L1 already does ("Already in L1"; with
`--include-covered` also "Covered by L1"). It keeps: guards that later code reads through (removing them would crash the
validator), `if`s that also check something L1 doesn't, and checks where both layers are conditional. Every edit must
still parse and leave all other checks unchanged. Report: `out/fix/<branch>/fix-report.md` + `.csv`. With
`--git-branch` the change is committed on a new local branch; nothing is pushed. L1 is never touched.

## 6d. Check generators - requirements, generator validations, static vs dynamic (analysis only)

```bash
npm run check-generators -- draft-FIS12SL-2.3.0                  # one branch
npm run check-generators -- draft-FIS12SL-2.3.0 --flow drawdown  # only flows whose path contains "drawdown"
npm run check-generators -- draft-FIS12SL-2.3.0 --full           # also the full report (requirement gaps, code quality …)
```

Reads every flow in `config/flows/**` (IGM steps - issue, on_issue, issue_status, on_issue_status - are left out; they get their own report later). Per step it decodes `mock.requirements`, `mock.generate` (+ helperLib), `mock.validate`
and `saveData`, and reads the validations with the **same L2 extractor** (`lib/l2-analyse.mjs`) used for `validate()`.
The code is parsed, never executed, and nothing in the spec repo is changed.
Output: `out/generators/<branch>/generator-checks.xlsx` + `.json`

| Tab | What it lists |
|---|---|
| Requirements validations | every validation in `requirements.js` (`meetsRequirements`): field, check type, validation, error message |
| Generator validations | every validation in `generate()` and the functions it calls: `if (…) throw new Error(…)` and `if (…) return defaultPayload`. **Duplicate** when `requirements.js` or `validate()` already has the same check (`Duplicate (covered)` = requirements checks a deeper field), with the source and the matching check |
| Could be dynamic | only the static values that could come from an earlier call: flow, Action ID, field, today's value and the `sessionData` value to use instead |
| Static vs Dynamic | one row per field with all APIs and flows combined: **Dynamic** (from sessionData / user input / generated in every API), **Static** (hardcoded / defaultPayload in every API) or **Mixed** (dynamic in some APIs, static in others), with the Action IDs where it is static and where it is dynamic, and the flow names. Static values of the first search / on_search of each flow are left out (always static). The ones that could be dynamic are in the "Could be dynamic" tab; per-step detail is in `--full` |
| Summary (last tab) | total requirements validations, total generator validations, duplicates (requirements.js / Validator), static vs dynamic counts and %, static values that could be dynamic, and the same per flow |

The L2 extractor got an opt-in generator mode (`analyseFunction(code, parse, { mode: 'generator', fnName, paramRoots })`);
without these options it behaves exactly as before. Keys the runtime adds itself (transactionId, mockBaseUrl, sessionId,
user_inputs, …) are not expected in saveData; add more with `--runtime-keys a,b`. Tests: `node test/generator-checks.test.mjs`.

## 6e. Restructure x-validations - common blocks defined once at the top (any domain)

```bash
npm run restructure-xval:current                                                           # checked-out branch of ../automation-specifications (dry run)
npm run restructure-xval:apply                                                             # same, and write it back (not committed)
npm run restructure-xval -- --repo "../automation-specifications"                          # the checked-out branch (dry run)
npm run restructure-xval -- --repo "../automation-specifications" --apply                  # write it back (not committed)
npm run restructure-xval -- --repo "../automation-specifications" --branch draft-TRV11-2.1.0,draft-RET11-1.2.5   # other domains, read with git show
npm run restructure-xval -- --repo "../automation-specifications" --branch FIS             # a group from branch-groups.json
```

Rewrites `config/validations/index.yaml` so that every validation used in more than one place is defined **once** in a
`_COMMON_` section at the top (named YAML anchors) and reused below with `*NAME`:

| Block | What it is | Name |
|---|---|---|
| Rule group | a whole `_RETURN_` list shared by several APIs (e.g. the context checks) | `<shared part of the parent names>_CHECKS`, e.g. `CONTEXT_CHECKS` |
| Rule | one rule (`_NAME_` + variables + `_CONTINUE_` + `_RETURN_`) | its `_NAME_` (+ `_<API>` when two different rules share a name) |
| Value list | an enum / regex / tag list used as a variable | `ENUM_` / `REGEX_` / `TAGS_` / `LIST_` + the field it checks, e.g. `ENUM_ORDER_FULFILLMENTS_TYPE` |

Biggest blocks first, so a rule that only repeats inside a repeated group is not split out again. Existing anchors
(`&a1` …) are expanded and rebuilt under readable names. Nothing about a domain is hard-coded.
**Check:** before and after are loaded with `yaml` and `js-yaml` and `_TESTS_` / `_SESSION_DATA_` must be identical value by
value; `--apply` only writes when that holds. The code generator reads only `_TESTS_` and `_SESSION_DATA_` (and deep-copies
the config first), so the generated validators do not change.
Output: `out/restructure-xval/<branch>/`:
- `index.yaml` (restructured) and `original.yaml` (the input, for comparing)
- `changes.xlsx` - **what changed in the current x-validations**: tabs *Changes* (one row per place: API, rule path, old text,
  change, `*NAME` that replaced it, common block, note), *Common blocks* (each `_COMMON_` entry with its YAML), *Per API*,
  *Old anchors* (`&a1` → new name, times used)
- `changes.diff` (line diff original → new), `report.md` (per API / per change as markdown, plus the summary and the comments that were only in a duplicate copy), `report.json`. Options: `--min-uses 2`, `--kinds RULES,RULE,LIST`, `--out`.
Tests: `node test/xval-restructure.test.mjs`.

## 7. Typical workflows

**Common validations for a domain**
```bash
npm run common:trv
# open out/common/TRV-common/TRV-common_summary.xlsx, then the 1_common / 2_intersection / 3_specific files
```

**Check a new version against the previous ones**
```bash
npm run common -- draft-TRV11-2.0.0 draft-TRV11-2.0.1 --name TRV11-common
npm run compare -- draft-TRV11-2.1.0          # auto-picks TRV11-common
```

**Find L2 checks that repeat L1**
```bash
npm run extract -- draft-RET11-1.2.5
# open the workbook → "L2 vs L1" tab, then filter "In L1?" on the L2 Validations tab
```

---

## 8. Troubleshooting

| Message | What to do |
|---|---|
| `branch not found on GitHub` | check the name (the command lists similar draft branches) or use `--from` for a fork |
| `fetch failed — using the cached copy` | no network; the command continues with `.spec-cache/`. Use `--no-fetch` to skip the download |
| `common set not found` | build it with `npm run common …`; the message lists the sets you have |
| `no common report fits` | no set in `out/common/` matches the branch's domain; build one or name one explicitly |
| empty L2 tab in a common file | no L2 check is in every use case — see the intersection file |

`out/` and `.spec-cache/` can be deleted at any time; running the commands recreates them.

---

## 9. For developers

| File / folder | What it is |
|---|---|
| `run-branch.mjs` | the three npm commands (fetch from GitHub, call the scripts below) |
| `extract-validations.mjs` | L1 + L2 extractor (`--repo <git dir> --ref <branch>` or `--config <dir>`) |
| `lib/l2-analyse.mjs` | reads L2 JavaScript as a syntax tree (never runs it) and turns each failure into a check |
| `lib/l2-patterns.mjs` | registry of every L2 pattern the analyser understands, with examples (tested) |
| `lib/l1-vs-l2.mjs` | the L2 vs L1 comparison (*In L1?* column) |
| `gold.mjs` | `partition` (common / intersection / specific), `compare`, `simplify`, `crosscall` |
| `domain-report.py` | business workbook of `compare` |
| `branch-groups.json` | TRV / RET / FIS branch groups |
| `lint-l2.mjs`, `standard/`, `ci/`, `gold/` | L2 coding standard, CI gate and older FIS12 gold baselines |

### How L2 is read

The base64 code of each flow step is decoded and parsed with Babel into a syntax tree - it is never run. Three steps,
the same for every domain:

1. **Failure points** - every way the code says "invalid":
   `return { valid: false }`, a local reporter such as `pushError(400, "…")` or `errors.push({ … })` into the list that
   decides `valid` (`return { valid: errors.length === 0 }`), and `throw new Error("…")` inside a `try` whose `catch`
   returns `{ valid: false }`.
2. **When it runs** - the enclosing `if`s plus earlier exits in the same block (`if (x) return { valid: true }`,
   `if (x) continue;`). Shown in plain words in the **Runs** column: *Conditional (Only when order.items has entries)*.
3. **What it checks** - the condition is mapped to a check type (Required, Non-empty list, Expected value, Allowed
   values, Matches, Exists in, Must contain, At least one of, Data type, Format, Comparison, Must be absent).
   Anything not recognised is reported as *Custom logic*, never guessed.

Every supported pattern is listed, with an example, in `lib/l2-patterns.mjs` and verified by
`test/l2-patterns.test.mjs`. To support a new pattern, add the rule in `lib/l2-analyse.mjs` and an entry there.

When `extract` runs, each branch gets one **L2 coverage** line in the terminal: validate functions, pass-through,
functions where no failure point was recognised (listed), failure points per kind, conditional / custom / untraced checks.

### Recommendation for new validators

Write **new** L2 code in the declarative `runChecks` style described in `standard/L2_STANDARD.md`: every check is a
data row `{ id, desc, path, rule, when }`, so this tool reads it exactly and nothing has to be inferred. Existing
validators do not need to change.

Tests (no network needed):
```bash
node test/run-tests.mjs          # runner, lint, extractor, compare
node test/l2-analyse.test.mjs    # L2 patterns
node test/l1-vs-l2.test.mjs      # L2 vs L1 comparison
node test/l2-patterns.test.mjs   # every pattern in the registry
node test/generator-checks.test.mjs   # generator / requirements checks
```

The before/after check of the L2 analyser on all 42 branches is in `out/baseline/BEFORE_AFTER.md`.
