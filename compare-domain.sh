#!/usr/bin/env bash
# compare-domain.sh - extract → gold (common validations) → compare ONE domain → business report, in one command.
#
#   bash compare-domain.sh <branch-to-check> <gold-branch,gold-branch,...> [out-dir]
#
#   e.g. bash compare-domain.sh draft-FIS12SL-2.3.0 draft-FIS12-2.3.0,draft-FIS12BL-2.3.0,draft-FIS12-PF-2.3.0
#
# Environment (optional):
#   REPO=../automation-specifications   spec repo folder
#   REMOTE=upstream                     git remote that points to ONDC-Official/automation-specifications
#   MIN_SHARE=1                         1 = a validation is "common" only if EVERY gold branch has it
#   WAIVERS=waivers.csv                 accepted exceptions (optional)
#
# Output (out-dir, default out/<branch>):
#   report/validations.json + one workbook per branch   (step 1 - extraction)
#   gold/<name>.csv + gold/index.yaml                   (step 2 - common validations)
#   compare/<branch>_vs_<gold>.xlsx + _fix-list.md      (step 3 - comparison, developer view)
#   <LABEL>_vs_common_validations.xlsx                  (step 4 - business view: Matching / Missing / Needs review / Extra)
set -uo pipefail
cd "$(dirname "$0")"
TARGET="${1:?usage: compare-domain.sh <branch-to-check> <gold-branch,gold-branch,...> [out-dir]}"
GOLD_BRANCHES="${2:?give the gold branches, comma-separated}"
OUT="${3:-out/$TARGET}"
REPO="${REPO:-../automation-specifications}"
REMOTE="${REMOTE:-upstream}"
MIN_SHARE="${MIN_SHARE:-1}"
LABEL="$(echo "$TARGET" | sed -E 's/^draft-//; s/-?[0-9]+\.[0-9]+\.[0-9]+$//; s/^FIS12-?//; s/^$/FIS12/')"
GOLD_NAME="common-for-${LABEL}"

REFS=(--ref "$REMOTE/$TARGET")
IFS=',' read -ra GB <<< "$GOLD_BRANCHES"
for b in "${GB[@]}"; do REFS+=(--ref "$REMOTE/$b"); done

echo "── 0/4 check branches in $REPO ($REMOTE)"
for b in "$TARGET" "${GB[@]}"; do
  git -C "$REPO" rev-parse --verify -q "$REMOTE/$b" >/dev/null || { echo "   missing: $REMOTE/$b  →  run: git -C $REPO fetch $REMOTE"; exit 2; }
  echo "   $b  $(git -C "$REPO" log -1 --format='%h %cs' "$REMOTE/$b")"
done

echo "── 1/4 extract validations"
node extract-validations.mjs --repo "$REPO" "${REFS[@]}" --out "$OUT/report" || exit 2

echo "── 2/4 build gold = validations common to: $GOLD_BRANCHES"
node gold.mjs build-gold --in "$OUT/report/validations.json" --branches "$GOLD_BRANCHES" \
     --name "$GOLD_NAME" --min-share "$MIN_SHARE" --gold-dir "$OUT/gold" || exit 2

echo "── 3/4 compare $TARGET with the gold"
CMP=(compare --in "$OUT/report/validations.json" --gold "$OUT/gold/$GOLD_NAME.csv" --branch "$TARGET" --max-warnings 0 --out "$OUT/compare")
[ -n "${WAIVERS:-}" ] && CMP+=(--waivers "$WAIVERS")
node gold.mjs "${CMP[@]}" > "$OUT/compare.log" 2>&1
RC=$?
[ $RC -gt 1 ] && { cat "$OUT/compare.log"; exit 2; }
head -1 "$OUT/compare.log" | sed 's/ -> .*//'

echo "── 4/4 business report"
python3 domain-report.py --in "$OUT/report/validations.json" --gold "$OUT/gold/$GOLD_NAME.csv" \
  --compare "$OUT/compare/${TARGET}_vs_${GOLD_NAME}.csv.xlsx" --branch "$TARGET" --label "$LABEL" \
  --out "$OUT/${LABEL}_vs_common_validations.xlsx" || exit 2

echo
echo "Open:  $OUT/${LABEL}_vs_common_validations.xlsx   (business view)"
echo "       $OUT/compare/${TARGET}_fix-list.md          (what developers must fix)"
echo "       $OUT/compare.log                           (full gate output)"
[ $RC -eq 1 ] && echo "Gate result: FAIL (missing or blocker validations found)" || echo "Gate result: PASS"
exit $RC
