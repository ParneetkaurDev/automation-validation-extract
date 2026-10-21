# gold/ — gold baselines (the common validations every branch must have)

| File | What it is |
|---|---|
| `families.yaml` | Which branches form a family and how strict "common" is (`min_share`). Only `FIS12@2.3.0` is active; others are commented out. |
| `index.yaml` | Generated. Lists every baseline with its domains + versions; `compare --gold auto` picks from here. |
| `<name>.xlsx` | Excel copy of each baseline, written by `build-gold` / `build-all`: Summary, By API, Gold validations |
| `FIS12@2.3.0.csv` | The baseline: 980 validations present in ≥ 3 of 4 FIS12 2.3.0 branches. Open it in Excel to review. |

## Rebuild the baseline

```bash
cd ~/Documents/MyWorkingFolder/"Purchase Finance"/validation-extract
npm run fis12:extract                        # fresh validations.json
npm run fis12:gold                           # rebuilds every active family in families.yaml
```

Build one baseline by hand:

```bash
node gold.mjs build-gold --in out/report/validations.json \
  --branches draft-FIS12-2.3.0,draft-FIS12BL-2.3.0,draft-FIS12SL-2.3.0,draft-FIS12-PF-2.3.0 \
  --name FIS12@2.3.0 --min-share 0.75
```

## Add a new domain family

1. Uncomment (or add) the family in `families.yaml`, e.g.

   ```yaml
   - name: RET@1.2.5
     branches: [draft-RET10-1.2.5, draft-RET11-1.2.5, draft-RET12-1.2.5]
     min_share: 0.8
   ```

2. Extract those branches and rebuild:

   ```bash
   node extract-validations.mjs --repo ../automation-specifications --ref-pattern 'origin/draft-RET1*-1.2.5' --json-only --out out/report-ret
   node gold.mjs build-all --in out/report-ret/validations.json --families gold/families.yaml
   ```

## Rules used to build a baseline

- **Common** = present in at least `min_share` of the family's branches (FIS12: 0.75 = 3 of 4).
- **Runs** (Always / If present / Conditional) and **allowed values** = what the majority of branches do, so one branch's hidden skip never becomes gold.
- Every row keeps a working **example** (`Source`, `Code`) that is shown to developers when it is missing.

## Approving a baseline

The baseline is the standard CI enforces, so review it before relying on it: open the CSV, check the rows, then set `approved_by:` for the family in `families.yaml`. Change it only through a reviewed pull request.
