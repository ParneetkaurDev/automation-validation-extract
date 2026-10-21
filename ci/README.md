# ci/ — CI gate (build fails when validations fail)

| File | What it is |
|---|---|
| `validation-gate.sh` | Runs the whole check for one branch: extract → simple list → L2 lint → compare with gold. **Exit 0 = pass, 1 = fail, 2 = tool error.** |
| `validation-gate.yml` | GitHub Actions job to add to `.github/workflows/spec-workflow.yml` |
| `validation-gate-test.yml` | Test workflow: runs **only** the gate, only on `test-validation-gate*` branches (no parse, no push-to-DB) |
| `test-on-github.sh` | Creates a throw-away test branch with the tool + test workflow and pushes it |
| `CI_HANDOFF.md` | Decisions needed from the CI owner (Vaibhav) |

## Test locally (no push)

```bash
cd ~/Documents/MyWorkingFolder/"Purchase Finance"/automation-specifications
git checkout draft-FIS12-PF-2.3.0                 # the branch to test
bash ../validation-extract/ci/validation-gate.sh config ../validation-extract/out/local-gate
echo "exit code: $?"                              # 0 = build would pass, 1 = build would fail
```

Reports: `validation-extract/out/local-gate/` (`compare/<branch>_fix-list.md` = what to fix).

Make L2 lint blocking too:

```bash
STRICT_L2=1 bash ../validation-extract/ci/validation-gate.sh config ../validation-extract/out/local-gate
```

See the GitHub annotations it would print:

```bash
GITHUB_ACTIONS=true bash ../validation-extract/ci/validation-gate.sh config ../validation-extract/out/local-gate | grep "^::error"
```

## Waive an intended exception

Create `config/validation-waivers.csv` **in the spec branch** (the Key comes from the gate message; `*` is allowed):

```csv
Key,Reason,Approved by
L2 | issue | *,PF has no IGM mock steps - covered by the shared IGM flow,Rishabh
L1 | search | context.city | Required,city not used in this use case,Rishabh
```

## Test on GitHub (throw-away branch)

```bash
cd ~/Documents/MyWorkingFolder/"Purchase Finance"/validation-extract
bash ci/test-on-github.sh ../automation-specifications draft-FIS12-PF-2.3.0              # real result
bash ci/test-on-github.sh ../automation-specifications draft-FIS12-2.3.0 fail-demo       # removes 1 rule to show a failing build
```

Watch it under GitHub → **Actions → Validation Gate (test)**. Delete afterwards:

```bash
cd ../automation-specifications
git push origin --delete test-validation-gate-draft-FIS12-PF-2.3.0
git branch -D test-validation-gate-draft-FIS12-PF-2.3.0
```

## Add to the real pipeline

1. Copy the tool into the spec repo: `cp -r validation-extract automation-specifications/tools/validation-extract` (without `node_modules` and `out`).
2. Add the `validation-gate` job from `validation-gate.yml` to `spec-workflow.yml` (for a tool inside the repo, use `run: bash tools/validation-extract/ci/validation-gate.sh config validation-gate`).
3. Add `needs: validation-gate` to the `process-spec` job, so parse / push-to-DB only run when the gate passes.
4. GitHub → Settings → Branches → protection rule → **Require status checks** → `validation-gate` (blocks merging).
5. First week: add `continue-on-error: true` to the gate step (report only), then remove it to enforce.
