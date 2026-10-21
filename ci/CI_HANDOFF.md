# CI handoff: decisions for the sync with Vaibhav

The tool is ready and tested on FIS12 2.3.0. Plugging it into the pipeline needs these decisions.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Where the tool and gold baselines live | (a) a separate repo, checked out by every spec branch; (b) `tools/validation-extract` in each spec branch; (c) a step inside `@ondc/build-tools` | **(a)**. A domain branch must not be able to edit its own gold standard. `ci/validation-gate.yml` already does this through `vars.VALIDATION_TOOL_REPO`. |
| 2 | Gate mode at first | report only (never fails) / fail on MISSING+BLOCKER | Start in **report-only for one week**: run with `continue-on-error: true` while FIS12 owners clear or waive today's gaps. Then switch to fail. |
| 3 | Who approves a baseline | domain lead / QA (Rishabh) | Rishabh reviews `gold/FIS12@2.3.0.csv`, then `approved_by` is set in `families.yaml`. A change to a gold file needs a pull request with that approver. |
| 4 | Where waivers live | spec branch `config/validation-waivers.csv` / tool repo | **Spec branch.** The domain calls out its exception explicitly, next to the code, and it is reviewed in the same pull request. |
| 5 | Runner support for `runChecks` | `validationLib` appended to validate/requirements like `helperLib` is to generate? | Needs confirmation from the mock runner owner. Until then authors paste `runChecks` above `validate`. |
| 6 | L2 strict mode | per domain, through `vars.STRICT_L2` | Off now. Turn it on per domain once its legacy L2 is migrated. |
| 7 | Run on pull requests too | push only (today) / push + pull_request | Add `pull_request` to the workflow triggers so gaps are caught before merge. |

## Today's FIS12 2.3.0 result (upstream, 17-Oct)

| Branch | Result | MISSING | BLOCKER | CONDITIONAL | DIFFERENT VALUES | Cross-call |
|---|---|---|---|---|---|---|
| draft-FIS12-2.3.0 | OK | 0 | 0 | 0 | 0 | 13/33 |
| draft-FIS12BL-2.3.0 | FAIL | 7 | 0 | 15 | 0 | 11/33 |
| draft-FIS12SL-2.3.0 | FAIL | 16 | 10 | 14 | 0 | 12/33 |
| draft-FIS12-PF-2.3.0 | FAIL | 52 (48 are IGM) | 0 | 5 | 8 | 11/33 |

With the example IGM waivers, PF drops to 4 MISSING.
