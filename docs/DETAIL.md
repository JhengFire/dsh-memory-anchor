# Lightweight memory

## The problem it solves

An agent reads code, not intent. The reasoning behind an implementation — which approach was ruled out, on whose authority, after what incident — lives nowhere the agent can reach. It gets re-derived, re-argued, and sometimes re-broken.

The usual answer is to remember more. That answer fails in a predictable way: memory systems accumulate facts that other tools already answer, inject that material into every turn, and grow into noise nobody trusts. Six months later the library is large, unreadable, and worse than having nothing.

This plugin takes the opposite position. It remembers very little, on purpose.

## What actually gets stored

Only four kinds of entry, and nothing else:

| Kind | Example |
|---|---|
| `decision` | Timeouts are fixed at 15 seconds; per-endpoint overrides are not allowed |
| `constraint` | Production may not use SNAPSHOT dependencies |
| `gotcha` | On Windows, redirected output becomes GBK unless UTF-8 is set explicitly |
| `rejected` | Kafka was ruled out for cache invalidation; operational cost outweighed the benefit |

`rejected` is often the most valuable entry in the library. It is the one that stops a closed debate from reopening for the third time.

Each entry is a single assertion that can be judged true or false, plus a `why`, an optional path scope, and a `verify` step. Multi-sentence paragraphs are refused at write time, because an assertion that cannot be evaluated cannot be verified, and an unverifiable memory is a guess wearing a uniform.

## Why an entry can be trusted

Every entry is treated as a **hypothesis with an expiry**, never as a fact.

- `verify` holds one cheap check — a `rg` pattern, a config lookup, a path that should exist.
- Reading a memory that will affect an action means running that check first.
- A failed check marks the entry `stale` immediately; it drops out of default results rather than quietly misleading the next reader.
- Nothing is verified forever. Entries past `staleDays` decay on their own.

This is the single most important design choice in the plugin. A stale memory is worse than a missing one: missing memory prompts investigation, while stale memory produces confident wrong answers. Downgrading memory from knowledge to hypothesis costs one command and removes that entire failure mode.

## How it stays out of the way

- **No injection.** The system prompt gains one line about usage, never memory content.
- **A write gate.** Entries are created only when a decision was made, an approach was rejected with a reason, a root cause was found, or a wrong belief was corrected. Sessions are never summarised into memory automatically — that is the main source of noise in every system that does it.
- **Outcome-driven decay.** `use` and `miss` decide survival. Rarely used but still correct is not the same as useless.
- **One domain, one file.** Durable records sit in a storage domain with schema validation, so a corrupted record fails at open rather than silently at search time.

## Conflicts are escalated, not guessed

Two statements can contradict each other while sharing almost every character:

> Production may not use SNAPSHOT dependencies
> Production may use SNAPSHOT dependencies

Their similarity is very high — higher than many genuinely related pairs. A similarity measure cannot distinguish agreement from contradiction; it only reports that both concern the same subject. A system that resolves such a pair by picking the more recent one is substituting a timestamp for a judgement it is not entitled to make.

So the plugin separates two questions that sound like one:

1. *Are these about the same thing?* — answered by similarity.
2. *Do they contradict?* — answered by an explicit polarity rule, after normalising negation.

A detected conflict is **refused**, both sides are shown, and only `resolve` settles it. Until then both entries stay `provisional` and every search flags the conflict, because presenting a contested pair as a settled answer is the failure being avoided.

The one case that is applied automatically is a plain correction — a date changed from yesterday to the day before, a version bumped. The old entry is retained as `superseded`, so the change remains traceable rather than silently overwritten.

## Reporting its own failures

The plugin records every call it handles, so it can answer a question most memory systems never ask: **where did this memory fail to help?**

| | Failure | Detected from |
|---|---|---|
| F1 | Not recalled | Empty search, same topic added minutes later |
| F2 | Recalled but unused | Results returned, no `use` followed |
| F3 | Verification failed | `verify` said it no longer holds |
| F4 | Decision reopened | A second live decision under the same tags |
| F5 | Conflict | Two entries that contradict each other |
| F6 | Task unfinished | Needs an external outcome signal; off by default |
| F7 | No feedback | Results returned, never used or rejected |

F7 is reported on its own because it governs whether the rest can be believed. F2 is defined as "no `use` followed" — but F7 is "no feedback ever happens", and the two look identical from the data. If a session reports no feedback at all, the report says so at the top and labels the F2 figures unreliable, rather than publishing numbers built on a broken signal.

Suggestions produced from these failures are tracked, then re-checked two weeks later. A suggestion that did not lower its failure rate is marked `ineffective` and shown first next time. Without that step, a self-improving system reliably degenerates into an ever-growing list of plausible advice nobody applies.

## What it is not

- Not a semantic search engine. Retrieval is word-overlap similarity: it matches the same language with shared surface terms, and it does not match across languages or across synonyms that share no characters. That limit is why `verify` and path scoping exist.
- Not a transcript archive. Conversations are not summarised into memory.
- Not a global store. Each repository keeps its own records, because shared memory between unrelated projects is mostly contamination.
- Not a dashboard. Health is one command; there is no panel to maintain.

## Configuration

Every field is editable in the profile patch and survives upgrades.

| Field | Default | Meaning |
|---|---|---|
| `limit` | `5` | Results returned by `find` |
| `staleDays` | `180` | Days without verification before an entry turns stale |
| `retireMisses` | `3` | Misses without any use before an entry retires |
| `conflictWindowSec` | `1800` | Window in which a reversal counts as immediately decidable |
| `evalEnabled` | `true` | Record usage events for the failure report |
| `polarityPairs` | `[]` | Extra `affirmative=negated` pairs for conflict detection |
| `promptSection` | `true` | Add the one-line usage hint to the system prompt |