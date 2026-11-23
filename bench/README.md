# Benchmarks

These scripts produced the measurements cited in `docs/lightweight-agent-memory-design.md`
appendix D. They are kept so the numbers can be reproduced and re-checked, not as a
test suite — none of them run in CI.

Run them from the repository root:

```bash
node bench/sweep2.mjs          # embedding parameter sweep
node bench/check-client.mjs    # client bundle static validation (also `npm run check`)
```

## What each measures

| Script | Measures | Cited in |
|---|---|---|
| `sweep.mjs` | Early threshold separability attempt. **Superseded** by `sweep2.mjs`; kept because its failure is instructive — optimising a two-class separation gap on a handful of pairs overfits the sample. | D.1.3 |
| `sweep2.mjs` | Embedding configuration sweep using a Top-K ranking metric over 30 corpus entries and 30 queries. This is what selected `dim=512, unigram 0.7, bigram 0.8, 1–2 grams`. | D.2 |
| `sweep3.mjs` | Lists every query that misses Top-1 under the chosen configuration, to establish the capability boundary rather than hide it. | D.3 |
| `repro-recall.mjs` | Replays retrieval against the **live stored data** in a DSH profile and prints per-entry similarity. Used to diagnose the "written but not findable" scope bug. | D.13 |
| `replay-eval.mjs` | Replays the failure detectors against live stored events, to check F2/F7 detection on real data rather than fixtures. | D.14 |
| `check-client.mjs` | Static validation of `lib/client.js`: module format, forbidden imports, theme-token usage, accessibility attributes, state coverage. Runs in CI. | D.15 |

## A note on method

The first attempt (`sweep.mjs`) searched for a similarity threshold that cleanly separated
related from unrelated text. It found configurations reporting perfect separation — with a
margin of 0.012. That result was fragile, not real: a handful of pairs will always admit
some cut that separates them.

`sweep2.mjs` switched to a Top-K ranking metric, which is what retrieval actually does.
The right question was never "is this pair above a line" but "does the answer come back
near the top of a library".

`sweep.mjs` is kept precisely because the wrong approach looked successful. Deleting it
would make the same mistake easier to repeat.