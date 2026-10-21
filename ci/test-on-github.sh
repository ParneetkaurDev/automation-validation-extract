#!/usr/bin/env bash
# test-on-github.sh - puts the validation gate on a throw-away branch and pushes it, so you can watch a real build.
#
#   bash ci/test-on-github.sh <spec-repo-folder> <source-branch> [fail-demo]
#   e.g. bash ci/test-on-github.sh ../automation-specifications draft-FIS12-PF-2.3.0
#
# It creates  test-validation-gate-<source-branch>  from the source branch, adds
#   tools/validation-extract/                  (this tool + gold baseline)
#   .github/workflows/validation-gate-test.yml (gate only - no parse / push-to-db)
# and pushes it. Your source branch is not changed. Pass "fail-demo" to also remove one gold
# validation (context.transaction_id on search) so you can see a failing build and its messages.
set -euo pipefail
TOOL="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "${1:?spec repo folder}" && pwd)"
SRC="${2:?source branch, e.g. draft-FIS12-PF-2.3.0}"
TEST="test-validation-gate-${SRC}"

cd "$REPO"
if [ -n "$(git status --porcelain)" ]; then echo "Your spec repo has uncommitted changes - commit or stash them first."; exit 1; fi
START="$(git rev-parse --abbrev-ref HEAD)"
git fetch origin "$SRC"
git checkout -B "$TEST" "origin/$SRC"

mkdir -p tools/validation-extract .github/workflows
( cd "$TOOL" && tar --exclude=node_modules --exclude=out --exclude=validation-report* --exclude=simple --exclude=compare -cf - . ) | ( cd tools/validation-extract && tar -xf - )
cp "$TOOL/ci/validation-gate-test.yml" .github/workflows/validation-gate-test.yml
# (the branch name does not match main / draft-*, so the real Spec Workflow does not run on it)
git add tools/validation-extract .github/workflows/validation-gate-test.yml

if [ "${3:-}" = "fail-demo" ]; then
  python3 - <<'PY'
p = 'config/validations/index.yaml'; s = open(p).read()
a = "            - _NAME_: REQUIRED_CONTEXT_TRANSACTION_ID\n              attr: $.context.transaction_id\n              _RETURN_: attr are present\n"
if a in s: open(p, 'w').write(s.replace(a, '', 1)); print('fail-demo: removed REQUIRED_CONTEXT_TRANSACTION_ID from search')
PY
  git add config/validations/index.yaml
fi

git commit -m "test: validation gate (throw-away branch, do not merge)"
git push -u origin "$TEST"
git checkout "$START"
echo
echo "Pushed $TEST. Open GitHub → Actions → 'Validation Gate (test)' to watch the build."
echo "Delete it afterwards:  git push origin --delete $TEST && git branch -D $TEST"
