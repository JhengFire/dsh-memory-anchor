# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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