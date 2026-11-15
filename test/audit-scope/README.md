# Audit scope

The first step of the diff-scoped audit: which audit units a branch touches. It lists the files the branch changed, maps each one to the unit of the full audit that owns it, and adds the units that import a changed file. The `audit-diff` workflow in `.claude/workflows/audit-diff.js` takes its JSON as input, and [MAINTENANCE.md](../../MAINTENANCE.md) has the whole procedure.

## Run it

From the repository root:

```sh
npm run audit:scope                          # short summary against origin/main
npm run -s audit:scope -- --json > scope.json  # the scope as JSON (-s keeps npm's banner out of the file)
npm run audit:scope -- --base main --out scope.json   # another base; writes the JSON, prints the summary
npm run audit:scope -- --all                 # every tracked file counts as changed
```

Exit code 0 on success, 2 when an option is wrong or git cannot answer, for example a base that does not exist. `scope.json` at the root is gitignored, so writing it does not add itself to the next scope.

## What counts as changed

The files of `git diff --name-only --no-renames <base>...HEAD`, which are the changes since the merge base and not the base's own later commits, plus uncommitted changes to tracked files and untracked files that git does not ignore. Uncommitted work sets `dirty: true` in the JSON. With `--all`, every file of `git ls-files` counts as changed instead of the diff, for a review of whole units such as the quarterly review in MAINTENANCE.md. Rename detection is off (`--no-renames`), so a renamed file counts as a deletion of the old path plus an addition of the new one. The unit of the old path stays changed, and the units that import the old path become dependents.

## Units

`units.ts` holds the 29 units and 4 cross-cutting areas of the full audit as data, each with its globs and the brief its finders get. One extra area, `repo-tooling`, covers what the full audit names no unit for: `test/bench/`, this folder, `.claude/workflows/` and the root configs. A file can belong to several areas: `apps/caja/vite.config.ts` is in `apps-caja` and in `apps-shell-and-pages`. `units.test.ts` fails when a tracked file or a top-level folder has no unit, so a new folder needs a line in `units.ts`. A changed file that no unit owns is listed under `unmapped` instead of being dropped.

## Dependents

A unit is a dependent when one of its files imports a file of another unit that reaches a changed file through its own imports. A change to `gateway/src/caps.ts` makes `content-forge` a dependent through its import of `gateway/src/index.ts`, and an app that imports `content-forge` becomes one in turn. Each dependent lists the imports that caused it, with file and line. A changed README or a test file that nothing imports adds no dependent.

Imports are read with the extractor of import-fences, from its public entry, so comments and strings that look like imports do not count. Only relative specifiers are followed. A bare package name and a file read at runtime with `readFileSync` are not followed, so a dependency of that kind does not show up.

## Output

The JSON has `root` (the absolute path of the checkout), `base`, `mergeBase`, `head`, `branch`, `dirty`, `files`, `units` (each with `id`, `kind`, `reason` changed or dependent, `files`, `paths` and `context`), `dependents` (each with the imports in `because`) and `unmapped`.
