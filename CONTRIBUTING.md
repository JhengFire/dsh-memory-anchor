# Contributing to dsh-memory-anchor

Thanks for considering a contribution. This is a small, deliberately narrow plugin — please read the design notes below before adding features.

## The project's position

This plugin is built on one opinion: **most memory systems fail because they remember too much.** It records only four kinds of entry (decisions, constraints, gotchas, rejected approaches) and nothing else. Facts that other tools already answer — where a symbol lives, what git history says, which team rules always apply — deliberately stay out.

Before proposing a feature, ask whether it makes the library *smaller and more trustworthy* or merely *larger*. Features that add more storage, more automation, or more default injection usually run against the grain.

## Setting up

```bash
git clone https://github.com/JhengFire/dsh-memory-anchor.git
cd dsh-memory-anchor
node scripts/test-all.mjs
```

No `npm install` is needed for development: the plugin has no runtime dependencies beyond three peer packages that a DSH installation already provides.

### Running tests

```bash
node scripts/test-all.mjs      # all five suites
npm test                        # the three that plain node can run
npm run check                   # static validation of the client bundle
```

`plugin` and `ui` need the DSH Electron runtime because they read `zod` from inside the installation's `app.asar`. `scripts/test-all.mjs` locates it automatically on Windows; on other platforms set `DSH_NODE_EXECUTABLE` to the Electron binary.

## Adding a memory kind

Kinds are a closed set on purpose — `decision | constraint | gotcha | rejected`. A new kind needs an argument for why its entries could not be expressed as one of those four, and it must come with:

1. A schema entry in `lib/schema.mjs`
2. Handling in `store.mjs` `inspectWrite` (does it conflict with others? can it be duplicated?)
3. A display label in both `locale/en.json` and `locale/zh.json`, plus the `kind*` keys in `lib/client.js`
4. Tests covering conflict, duplicate, and retrieval behaviour

## Changing retrieval

Retrieval is the most fragile part. Read `docs/lightweight-agent-memory-design.md` appendix D before touching it — it documents measured results that contradicted the original design:

- A single absolute similarity threshold **does not work**. Real matches can score below false ones. The implementation uses a relative cutoff instead.
- Path scope must **down-weight**, never discard. Discarding looked correct on paper but meant "write a memory in one directory, lose it in another."
- Similarity cannot distinguish *related* from *contradictory*. Conflict detection is a separate rule pass; do not fold it into scoring.

If you change a threshold or weight, include the measurement that justifies it. Guessed constants have caused real regressions here.

## Client changes

The settings page registers through `ctx.slots`. Two rules that are easy to get wrong:

- Use only real `--dsw-alias-*` tokens. A token name that looks plausible but does not exist silently falls back to the hardcoded colour, so it degrades only when the theme changes.
- `npm run check` catches both of these classes of mistake. Run it before opening a PR.

## Pull requests

- Keep each PR to one concern.
- Add tests for behaviour changes; bug fixes should include a test that fails before the fix.
- If you fix a bug caused by a wrong assumption, consider adding a note to appendix D — the design document is as much a record of what did not work as what did.
- Update the relevant section of `README.md` or `docs/DETAIL.md` when user-visible behaviour changes.

## Reporting bugs

Include the plugin version, the DSH version, what you expected, what happened, and — if it concerns retrieval — the query and the entries you expected to match. Recall problems are usually about scoring, and the actual numbers matter.

## Licence

By contributing you agree your work is licensed under the MIT Licence.