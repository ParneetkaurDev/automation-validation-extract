#!/usr/bin/env bash
# validation-gate.sh - the whole CI check for one spec branch, in one command.
#
#   ci/validation-gate.sh <path-to-config> [out-dir]
#
#   1. extract   L1 + L2 validations from the checked-out config      (business workbook)
#   2. simplify  one-row-per-validation list                         (sheet for review)
#   3. lint      L2 code against the L2 standard                      (warn; STRICT_L2=1 makes it blocking)
#   4. compare   against the gold baseline registered for this domain+version (gold/index.yaml)
#                MISSING or BLOCKER fails the build; a Key in <config>/validation-waivers.csv waives it.
#
# Exit code: 0 pass, 1 gate failed, 2 tool error. Every report is written to out-dir (default ./validation-gate).
set -uo pipefail
TOOL="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$(cd "${1:?usage: validation-gate.sh <config-dir> [out-dir]}" && pwd)"
OUT="${2:-./validation-gate}"
mkdir -p "$OUT"
WAIVERS="$CONFIG/validation-waivers.csv"
status=0

echo "── 1/4 extract"
node "$TOOL/extract-validations.mjs" --config "$CONFIG" --out "$OUT/report" || exit 2

echo "── 2/4 simplify"
node "$TOOL/gold.mjs" simplify --in "$OUT/report/validations.json" --out "$OUT/simple" || exit 2

echo "── 3/4 lint L2"
LINT_ARGS=(--config "$CONFIG" --out "$OUT/lint")
[ "${STRICT_L2:-0}" = "1" ] && LINT_ARGS+=(--strict)
node "$TOOL/lint-l2.mjs" "${LINT_ARGS[@]}" || { echo "L2 lint: errors found"; status=1; }

echo "── 4/4 compare with gold baseline"
CMP_ARGS=(compare --in "$OUT/report/validations.json" --gold auto --gold-dir "$TOOL/gold" --out "$OUT/compare")
[ -f "$WAIVERS" ] && CMP_ARGS+=(--waivers "$WAIVERS")
node "$TOOL/gold.mjs" "${CMP_ARGS[@]}"
rc=$?
[ $rc -eq 1 ] && { echo "Baseline gate: MISSING or BLOCKER found - see $OUT/compare"; status=1; }
[ $rc -gt 1 ] && exit 2

[ $status -eq 0 ] && echo "Validation gate passed" || echo "Validation gate FAILED"
exit $status
