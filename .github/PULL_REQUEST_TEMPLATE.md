## What changed

<!-- One or two sentences. If this fixes a bug, say what the wrong behaviour was. -->

## Why

<!-- The reasoning. If this changes a threshold, weight, or ordering rule,
     include the measurement that justifies the new value — guessed constants
     have caused real regressions in this codebase. -->

## Checks

- [ ] `node scripts/test-all.mjs` passes
- [ ] `npm run check` passes (client bundle static validation)
- [ ] New or changed behaviour has a test
- [ ] A bug fix includes a test that fails without the fix

## Documentation

- [ ] `README.md` or `docs/DETAIL.md` updated if user-visible behaviour changed
- [ ] Added a note to design document appendix D if this was caused by a wrong assumption

## Notes for the reviewer

<!-- Anything you are unsure about, or deliberately left out of scope. -->