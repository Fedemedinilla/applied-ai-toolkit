# Maintenance

How this repository is kept in shape between releases. Each section is one routine, with the commands it runs.

## Diff-scoped audit

After a branch changes a few folders, audit only those folders and the folders that import them, instead of running the full audit over all 29 units and 4 cross-cutting areas. It has two steps.

1. From the repository root, with the branch checked out and its work committed, write the scope:

   ```sh
   npm run -s audit:scope -- --json > scope.json
   ```

   The base defaults to `origin/main`; `--base <ref>` takes another. `-s` keeps npm's banner out of the file, which would otherwise start with `> audit:scope` and not parse. `npm run audit:scope` alone prints a short summary to read first. `scope.json` is gitignored.

2. In Claude Code, run the `audit-diff` workflow with that JSON as args: ask Claude to "run the audit-diff workflow with the contents of scope.json as args". The workflow is `.claude/workflows/audit-diff.js`.

The scope lists the files changed since the merge base with the base, plus uncommitted and untracked files. It maps each file to its audit unit and adds every unit that imports a changed file, with the import that caused it. [test/audit-scope/README.md](test/audit-scope/README.md) explains the mapping, the dependents and the JSON.

The workflow sends two finders to each changed unit. Lens A runs the code to find bugs, and lens B checks security, tests and the truth of the docs. A dependent unit gets one finder that checks it still works with the changed code. Every finding is then verified by agents that try to refute it. A high finding goes to three verifiers with distinct focuses and needs a majority of the votes cast. A medium finding goes to one verifier that builds its own reproduction, and the low findings of each finder go to one batch verifier. Then one fixer per unit works test first in its own worktree, created with `git worktree add` under `.claude/worktrees/`. An integrator merges the fix branches and runs the full suite from a clean install, and the workflow ends with a short report in Spanish.

The workflow stops before fixing anything when a finder or a verdict is missing, so the run can be resumed, and when the scope had uncommitted changes, since the fixers branch from the committed head. Commit, write the scope again and rerun. `test/audit-scope/audit-diff-workflow.test.ts` runs the workflow with fake agents and checks each of these guards.
