# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-23

The first release with the settings page fully working end to end, which is
what 1.0 is meant to mark: the switches, the list and the embedding
configuration all do what the page says.

### Fixed

- **Save on the embedding configuration returned 405.** The read and the write
  of `/lwm/embedding` were registered as two routes with the same path. The
  route registry keys routes by `(kind, path)` and rejects a duplicate, and the
  rejection happened inside an `inject` callback, so both routes were dropped
  except the first — the page could read the configuration but never save it.
  They are one handler now, dispatching on the request method.

  0.5.0 fixed the client half of this (object bodies never reaching `fetch` as
  JSON); the host half was still broken, which is why save kept returning 405
  even after that release was installed.

### Changed

- The settings-page suites now exercise the embedding routes, and the route
  existence test asserts every route the page uses rather than only three of
  them. The missing assertions are why the 405 shipped: the suite tested the
  read and never the write.
- `test/plugin.test.mjs` and `test/ui.test.mjs` write their rewritten copies to
  a temporary directory when `lib/` is not writable, instead of failing with
  `EPERM` on read-only checkouts and in sandboxes.

### Notes

- 245 tests across fourteen suites.

## [0.5.0] — 2026-11-23

### Fixed

- **Test connection returned 400 and Save returned 405.** The api() helper passed
  `init` straight to fetch, and fetch accepts only a string, Blob, FormData or
  URLSearchParams as body. A plain object was coerced to the string
  `"[object Object]"`, so the server failed to parse it and answered with status
  codes that pointed nowhere near the cause. api() now serialises object bodies
  itself, so no call site has to remember.

### Notes

- 222 tests across fourteen suites. The new suite runs api() against a stubbed
  fetch and asserts what it actually hands over — the previous tests only exercised
  the Host routes with curl, which is why this shipped.

## [0.4.0] — 2026-11-23

### Changed

- Version bump to make the registration fix available under a fresh version.
  0.3.1 carries the same code; this release exists because a transient registry
  propagation delay made 0.3.1 briefly unresolvable right after publishing.

### Notes

- 213 tests across thirteen suites, unchanged from 0.3.1.

## [0.3.1] — 2026-11-23

### Fixed

- **The client plugin never registered, so the Settings section disappeared.**
  The module ended in a bare `try/catch` that swallowed every error, including a
  failed `__ModuleLoader__.load()`. The browser then reported only
  "loaded without registering", with the real cause discarded — the section simply
  was not there and nothing explained why. A missing loader now throws instead of
  passing silently.

- The Settings menu label read a top-level `title` while both dictionaries nest it
  under `meta`, and the inline title still carried the pre-rename name.

### Notes

- 213 tests across thirteen suites. New checks cover registration itself: that
  `load()` is called exactly once, that an empty `catch` never returns, and that the
  registered id matches the package name.

## [0.3.0] — 2026-11-23

### Added

- **Semantic retrieval via a third-party embedding API.** Off by default; configure a
  provider in Settings and writes produce real embeddings. Measured on the same probes,
  paraphrase matching goes from 0.081 to 0.674 and cross-language from 0.000 to 0.604.
- **Provider registry.** Volcengine Ark ships as the first entry. Adding another provider
  means one module plus one registry row — the request shape, response parsing and URL
  normalisation all live behind that seam.
- **Settings section** for the provider, API URL, model, dimensions and API key. The key
  is masked, toggleable, and never echoed back in full.
- **`reindex` action** to recompute vectors after enabling an API or switching models.
  Defaults to a dry run and resumes where it stopped.
- Per-model relevance floors (`lib/thresholds.mjs`). Hash and remote vectors occupy
  different score ranges, so one shared floor either drops real hits or admits noise.

### Fixed

- **`quantize` and `cosineQuantized` hard-coded 512 dimensions.** A 1024- or 2048-dim
  vector was silently truncated to its first 512 components, producing a plausible but
  meaningless score. Added dimension-agnostic variants.
- **Ark returns `data` as an object, not an array.** OpenAI-shaped responses nest one
  level deeper; parsing Ark's by the OpenAI shape yielded a 200 OK with no vector — the
  hardest kind of failure to notice.

### Notes

- 190 tests across nine suites.
- Memory writes never fail because of the API: on error the entry is stored with a local
  vector and `needsEmbedding: true`.
- Cross-model vectors are never compared. A mismatched entry is down-weighted, not dropped,
  so upgrading the model cannot make existing memories disappear.

## [0.2.0] — 2026-11-23

### Added

- **`workspace` scope.** A memory can now be scoped to the current workspace and everything
  under it: `scope: ["workspace"]`. It resolves against the working directory at recall time,
  so it survives moving the repository to another folder or machine — an absolute path would not.
- **Scope is shown in search results.** Each hit now carries a `scope:` line. Without it,
  a workspace-scoped constraint looked identical to a global one, and you could not tell
  whether it still applied after switching projects.
- `lib/render.mjs`: output rendering extracted from the Host entry point, so it can be
  tested without a DSH runtime.

### Fixed

- **`**` did not match the prefix itself.** `D:/repo/**` failed to match `D:/repo`,
  and `src/**` failed to match `src` — the pattern only matched from one level down.
  The separator before `**` was compiled as a literal character instead of being optional.
- **Duplicate ids in the failure report.** F2 subjects are comma-separated id lists, so
  two findings covering `t2,t3` and `t2` were concatenated into `t2,t3, t2`
  instead of being de-duplicated per id.

### Notes

- 149 tests across seven suites.
- The settings page and the live tool were re-verified after the change; existing
  memories and their scope values are unaffected.

## [0.1.0] — 2026-11-23

First release.

### Added

- **The `memory` tool** — one tool dispatched by `action`, rather than seven separate tools, to keep the per-turn schema cost low. Actions: `find`, `add`, `verify`, `resolve`, `use`, `miss`, `stats`, `eval`.
- **A four-kind write gate** — only `decision`, `constraint`, `gotcha` and `rejected` entries may be created. Conversations are never summarised into memory.
- **Falsifiable entries** — every entry carries a `verify` command and a `lastVerified` stamp. A failed check marks it `stale` immediately.
- **Conflict detection that escalates** — polarity rules detect contradictions (which similarity alone cannot), refuse the write, and require an explicit `resolve`. Until then both entries stay `provisional` and every search flags them.
- **Correction handling** — slot changes such as a date moving from yesterday to the day before are applied automatically, with the old entry kept as `superseded`.
- **A settings page** — a switch, plus saved memories at ten per page with kind, status badges, verify command and path scope. Turning memory off refuses reads and writes through the tool but keeps `stats`, `eval` and this page working.
- **Failure reporting** — F1 (not recalled), F2 (recalled but unused), F3 (verification failed), F4 (decision reopened), F5 (conflict) and F7 (no feedback, a meta-indicator that invalidates F2 when high).

### Notes on the retrieval design

Three measured findings shaped the implementation, each contradicting an earlier design assumption. They are recorded in `docs/lightweight-agent-memory-design.md` appendix D:

- SQLite FTS5 scores 30% top-1 on Chinese text against 80% for the character n-gram vector used here, because `unicode61` does not segment Chinese. Full-text search is kept only as an exact-identifier fallback.
- Path scope down-weights rather than filters. Filtering was correct on paper but meant a memory written in one directory could not be found from another.
- No single similarity threshold separates related from unrelated text. A relative cutoff, derived per query, replaced it.

### Known limitations

- Retrieval is word-overlap similarity, not semantic understanding. It does not match across languages, nor synonyms sharing no characters.
- F6 (task unfinished) is not implemented; it needs an external outcome signal.
- The settings page has not been visually verified in a browser. Its routes, pagination and switch behaviour are covered by tests, but rendering, dark-theme appearance and interaction feel were not confirmed.

[0.1.0]: https://github.com/JhengFire/dsh-memory-anchor/releases/tag/v0.1.0
[0.2.0]: https://github.com/JhengFire/dsh-memory-anchor/releases/tag/v0.2.0
[0.3.0]: https://github.com/JhengFire/dsh-memory-anchor/releases/tag/v0.3.0