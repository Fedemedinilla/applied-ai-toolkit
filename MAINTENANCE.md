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

## Dependencies

Two routines keep the pinned versions current and audited: Dependabot opens the update PRs, and the `audit` job of the weekly Quality workflow audits both lockfiles.

### What Dependabot opens

[.github/dependabot.yml](.github/dependabot.yml) checks four targets every Monday morning (Buenos Aires time), with a 7-day cooldown so a version published in the last week is not proposed yet:

| Target | Directory | Commit prefix | Open-PR limit |
|---|---|---|---|
| npm, the root lockfile (all workspaces) | `/` | `deps`, `deps-dev` for dev dependencies | 5 |
| npm, the docs site | `/docs-site` | `deps(docs-site)` | 3 |
| Composer, the plugin's dev tools | `/wp-hardening` | `deps(wp-hardening)` | 3 |
| GitHub Actions, the workflows and the three composite actions | `/`, `/csp-build-guard`, `/import-fences`, `/slop-lint` | `ci` | 3 |

Each target gets at most one grouped PR a week with all its minor and patch updates. A major update matches no group, so it arrives as its own PR. Both npm entries and the Composer one use `versioning-strategy: increase`, so an exact pin moves to another exact pin and never becomes a range. site-check has no entry, since its `pyproject.toml` declares no dependencies. The config sets no labels, because the repository has none for dependencies. `test/maintenance/dependabot.test.ts` fails when a tracked lockfile or composite action has no entry, or when an entry loses one of these settings.

### Reviewing a grouped PR

1. Read the PR body: it lists every package with its old and new version. Open the release notes of any runtime dependency (`@anthropic-ai/sdk`, `zod`, `pdf-lib`, `web-push`, Astro and Starlight for the docs site) and of any tool that changes what a test proves (Vitest, TypeScript, jsdom, PGlite, PHPUnit).
2. Check the lockfile diff for packages the PR body does not name. A new transitive package deserves a look at who publishes it.
3. Let CI run. A grouped PR passes or fails as a whole. When one package breaks it, comment `@dependabot ignore <package> minor version` (or `patch version`) on the PR, and Dependabot rebuilds the group without it. Then open a separate change for that package.
4. When the PR moves a tool that one of the slow checks depends on (Stryker, Vitest, Vite, TypeScript), run the Quality workflow by hand on the branch before merging.
5. For an actions PR, check that each new SHA is the commit of the release tag in the comment, on the action's own repository (`git ls-remote https://github.com/<owner>/<action> refs/tags/<tag>`), as CONTRIBUTING.md requires.
6. Update the version numbers in the root README's Dependencies section when a runtime or named development dependency moves.

A major PR gets the same steps plus the package's migration guide, and the README sections that describe that package's behaviour.

### What the audit job gates

The `audit` job in [.github/workflows/quality.yml](.github/workflows/quality.yml) runs once per lockfile, for the root and for `docs-site/`, weekly and by hand:

- **The gate** is `npm audit --omit=dev --audit-level=low`. Any advisory of any severity against a runtime dependency fails the job. Those are the packages the libraries and apps ship or run with.
- **The report** is the full `npm audit`, dev dependencies included. It never fails the job and is uploaded as the `npm-audit-root` and `npm-audit-docs-site` artifacts, in JSON and in text. Read it after each run. On 2026-11-15 it showed 3 moderate advisories at the root, all from `minimatch` under `@stryker-mutator/core`, with no fixed version Stryker accepts; the docs site showed none.

The same two commands run locally from the root and from `docs-site/`:

```sh
npm audit --omit=dev --audit-level=low   # the gate
npm audit                                # the report
```

When the gate fails, update the package (a Dependabot security PR may already be open), or replace it, or record in the PR why the advisory does not reach this code. Do not lower the audit level to make it pass. Composer has no audit step, since wp-hardening's Composer packages are dev tools only and Dependabot keeps them current.

## Quarterly review of risk areas

Once a quarter, run the full audit's method over the units most likely to break or with the most at stake, and then the live checks that CI cannot do. The units below were chosen from the full audit of 2026-11-15 and from what each unit touches, which is money, sign-in, untrusted input or an external service. "Confirmed" and "high fixed" come from that report's sections "1. Resumen por unidad" and "2. Altos y medios arreglados"; the gaps come from "4. Lo que quedó sin ejercitar". The report is not in this repository.

| Group | Units (audit ids) | Confirmed / high fixed on 2026-11-15 | Why it is here |
|---|---|---|---|
| Money | `gateway`, `amount-parser`, `grounded-assistant`, `idempotent-orders`, `apps-caja` | 12/0, 12/5, 12/1, 10/0, 10/0 | Spend caps and cost reservation, amounts read from text, the money guard over prices, one order and one stock take per key. amount-parser had 5 of the 18 high fixes. The gateway's advisory lock and the order races run only on PGlite in CI. |
| Sign-in | `wp-hardening`, `supabase-auth-hardening`, `fake-supabase-auth` | 19/1, 9/0, 17/0 | Login limiter, sign-up and email-change controls, the JWT fake the auth tests trust. The login lockout never applied without an object cache until the audit. Nothing ran against real WordPress or Supabase. |
| Untrusted input on a server | `safe-contact-form`, `safe-markdown`, `apps-chat-widget`, `apps-push-lab`, `apps-salon-assistant` | 16/1, 9/0, 15/1, 10/2, 10/1 | Request bodies, multipart, HTML rendered with innerHTML, request targets. Three servers crashed on a malformed request target, and push-lab's allowlist could be bypassed. |
| Paid calls and external services | `content-forge`, `evals`, `apps-writer`, `site-check` | 10/1, 20/0, 11/0, 14/1 | content-forge made a paid call on a missing `--dir`; evals had the most confirmed findings of any unit. site-check talks to sites it does not own and to PageSpeed, and a `Retry-After` header stopped it from backing off. |
| The gates | `csp-build-guard`, `agent-playbook`, `ci-workflows-actions`, `dependencies` | 17/1, 17/1, 8/0, 7/0 | Checks that the rest of CI trusts: CSP and secrets in builds, secrets in workflows, pinned actions, audited lockfiles. No workflow had run on a real runner when the audit ended. |

### Run the scoped audit

The `audit-diff` workflow takes any scope JSON. For a quarterly review, write one by hand from the scope against the first commit of the repository, where every file counts as changed. Keep only the units of the review and no dependents. From the root, with the work committed:

```sh
npm run -s audit:scope -- --base "$(git rev-list --max-parents=0 HEAD)" --json \
  | node -e 'const keep = process.argv.slice(1); let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => { const s = JSON.parse(t); s.units = s.units.filter((u) => keep.includes(u.id)); s.files = [...new Set(s.units.flatMap((u) => u.files))]; s.dependents = []; console.log(JSON.stringify(s, null, 2)); });' \
    gateway amount-parser grounded-assistant idempotent-orders apps-caja > scope.json
```

Then ask Claude to "run the audit-diff workflow with the contents of scope.json as args", as in the diff-scoped audit above. Each unit gets the two finders of a changed unit, over all its files. Run one group per scope, so a run stays near ten finders, and keep the groups in the order of the table when the quarter's budget does not cover all five.

### Live checks CI cannot do

Run the ones for the groups reviewed, from a machine with the service at hand. None of them runs in CI, and the scripts that call the API exit before any call when the key is missing.

- **Real Postgres (Money).** On a scratch PostgreSQL 16, `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f gateway/sql/test.sql`, then `PGHOST=localhost PGUSER=postgres bash gateway/sql/race.sh`, which creates and drops its own database. For orders, `DATABASE_URL=postgres://... bash idempotent-orders/sql/race.sh` against an empty scratch database. A database created before the audit also needs the gateway migration for the `> 0` checks and the read-only grant, which `schema.sql` covers only for new installs.
- **Real WordPress (Sign-in).** On a scratch site with WP-CLI, install the plugin and run `wp harden status`, `wp harden apply --only=<control> --dry-run`, `wp harden audit`, and the rules from `wp harden htaccess` (and `--server=nginx`) on a real Apache and nginx. Try the login limiter with and without an object cache.
- **Real Supabase (Sign-in).** On a local Supabase stack, reproduce each gap of `supabase-auth-hardening` without the migrations and check it closed with them, as its README describes for Auth v2.197.0. Note the Auth version used.
- **Real browsers (Untrusted input, The gates).** Push Lab installed on an iPhone (iOS 16.4 or later) and on Android, with a test push and the badge. The chat widget embedded on a page of another origin. One built app in Chrome, Firefox and Safari, to see that the CSP hashes csp-build-guard accepts are the ones the browsers accept.
- **Paid model calls (Paid calls).** With a key and a small budget set for the whole review before starting, run `node gateway/examples/live-call.ts`, `node apps/caja/server/live-check.ts`, `node apps/chat-widget/server/live-check.ts` and one small `content-forge generate` (its cap is US$1 per run). Run the writer's live evals only when its prompt changed, since they make 60 calls. Each prints what it got; compare by reading, since none records a score.
- **A real Actions run (The gates).** Push a branch and read the CI and Quality runs; run Quality by hand from the Actions tab.

Write down the date, the versions and the result of each live check in the README of the folder it covers, where the README already gives the last one.

## Before a release

Run through this list on the branch that will be merged before the "Version Packages" PR, with the work committed.

1. `npm ci`, then every command of "Run everything" in CONTRIBUTING.md passes as written, among them `npm run check`, `npm test`, the import fences, `npm run pack:check`, `npm run lint:docs` and `npm run build:docs`.
2. The audit gate passes from the root and from `docs-site/`: `npm audit --omit=dev --audit-level=low`. Read the full report for anything new.
3. No Dependabot PR for a runtime dependency is left open without a decision.
4. The last Quality run is green, with mutation scores at or above each threshold and no benchmark regression. When a release changes a mutation target, run it again and update the numbers in its README.
5. The diff-scoped audit has run since the last release: `npm run -s audit:scope -- --base <commit of the last release> --json > scope.json`, with the commit taken from the provenance of the last published version on npm. Before the first release, use 1448515, the head the full audit of 2026-11-15 ended on.
6. When the release touches a unit of the quarterly table, its live checks have run on this version.
7. Each published package that changed has a changeset (`.changeset/`), and the numbers and versions the READMEs state match a run made for this release.
8. CI on the release PR is green, and `SECURITY.md` names a reporting channel that is switched on.
