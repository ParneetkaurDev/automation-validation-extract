# test/ — automated tests

`run-tests.mjs` runs 23 self-contained tests (no spec repo needed): the `runChecks` runner, every lint rule, the extractor (standard shape, skip conditions, legacy code), gold compare, waivers and the developer messages.

```bash
cd ~/Documents/MyWorkingFolder/"Purchase Finance"/validation-extract
npm test                  # same as: node test/run-tests.mjs
```

Expected last line: `23 tests passed`. Run it after any change to the scripts.
