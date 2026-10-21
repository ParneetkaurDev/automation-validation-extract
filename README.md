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

- **In L1?** — **Duplicate** when L1 already has this check, **-** when it doesn't
- **L1 remark** — a plain sentence saying why, ending with the matching L1 rule and its line in `index.yaml`,
  e.g. `[L1: REQUIRED_ITEM_ID, line 1541]`. For a Duplicate it also says if anything differs (L1 allows more values,
  treats the field as optional, checks it only in some cases, or rejects a value L2 accepts).

`validations.json` keeps the detailed result in `l1Detail` (Already in L1 · Covered by L1 · L2 is stricter ·
Conflicts with L1 → *Duplicate*; Only in L2 · L2 adds a check · Check manually → *-*).

The **L2 vs L1** tab counts these results per API, with the same explanations under the table.

Every validation has a **Key** = `Layer | API | Field | Check` (e.g. `L1 | search | context.bap_id | Required`); this
is what `common` and `compare` match on.

---

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
| `<branch>_vs_<common>.xlsx` | business view — tabs **Summary, Matching, Missing, Needs review, Extra** |
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
```

The before/after check of the L2 analyser on all 42 branches is in `out/baseline/BEFORE_AFTER.md`.
