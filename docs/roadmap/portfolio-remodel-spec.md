---
title: "applied-ai-toolkit — Portfolio Remodel Execution Spec"
subtitle: "Machine-oriented task specification for Claude Code agents"
date: "2026-11-26 · baseline commit origin/main ba15c68"
---

# 0. HOW TO USE THIS DOCUMENT (READ FIRST)

```text
AUDIENCE      : Claude Code agents working in github.com/Fedemedinilla/applied-ai-toolkit
LANGUAGE      : Spec in English. Talk to the user (Federico) in Rioplatense Spanish with voseo.
                Repository text you write (README, SECURITY, ADR, commits) stays in English.
BASELINE      : origin/main @ ba15c68 (2026-11-26). Line refs "path:N" are valid at baseline.
DRIFT RULE    : Line numbers drift. Every ref also has an ANCHOR string. Before editing,
                run `grep -n "<ANCHOR>" <path>` and use the current line. If the anchor is
                gone, STOP and report; do not guess.
UNIT OF WORK  : One task card (T-xx) = one branch `claude/<slug>` = one PR. Never merge.
SELECTION     : Pick the lowest-numbered task whose PRECONDITIONS all hold and whose
                STATUS is not DONE (check §9 status protocol).
DEFINITION OF DONE: Every ACCEPTANCE command was run and its output (pass/fail + counts) is
                pasted in the final message to the user. No output = not done.
```

## 0.1 Execution loop (per task)

```text
1. git fetch origin && git checkout -B claude/<slug> origin/main
2. Run §2 CONCURRENCY CHECK. If it reports a conflict with this task's FILES, STOP and tell the user.
3. Verify PRECONDITIONS. If one fails, STOP and report which.
4. Re-resolve every ANCHOR in the task (grep). Record current line numbers.
5. Implement STEPS in order. Touch only paths in FILES.ALLOWED.
6. Run ACCEPTANCE commands. On failure: fix, re-run. After 2 failed attempts with unknown
   cause: STOP and report hypotheses (user rule).
7. Commit per COMMIT PLAN (small commits, message says WHY, attribution trailer required).
8. git push -u origin claude/<slug> (retry network errors up to 4x with backoff).
9. Do NOT open a PR unless the user asks. Report: branch, commits, acceptance output.
10. Before any PR: run subagents named in REVIEW (revisor-seguridad, verificador-de-hechos,
    revisor-tests) and include their findings.
```

# 1. GLOBAL RULES (NON-NEGOTIABLE)

| ID | Rule | Source |
|---|---|---|
| R1 | Never push to `main`. Branch `claude/<topic>`, PR; the user merges. | user CLAUDE.md |
| R2 | Shared files (`package.json`, lockfiles, root `README.md`, root configs) are edited only by a task that names them in FILES.ALLOWED, in a separate commit. | user CLAUDE.md |
| R3 | Bugs: write a failing test first, then the fix, without editing the test. | user CLAUDE.md |
| R4 | Every claim about code in a document carries `path:line`. Unverified claims are tagged `[SIN VERIFICAR]` (in Spanish docs) / `[UNVERIFIED]` (in English repo docs must NOT ship; resolve or drop). | user CLAUDE.md |
| R5 | If a task would touch >20 files, propose it and wait for the user's OK. | user CLAUDE.md |
| R6 | No Workflow/ultracode orchestration unless the user asks. Subagents return short summaries. | user CLAUDE.md |
| R7 | If a network domain fails, do not look for alternatives: report the domain to the user. | user CLAUDE.md |
| R8 | `gh pr`/`gh issue` fail (GraphQL blocked). Use `gh api repos/<owner>/<repo>/...` (REST). CI status: skill `estado-ci`. | user CLAUDE.md |
| R9 | Node 24 must be on PATH. `node -v` must start with `v24`; otherwise warn the user before continuing. | user CLAUDE.md |
| R10 | No model identifiers in commits, code, PR bodies or repo docs. | harness |
| R11 | Fixtures are fictional. No real client data, keys, emails or account ids. | `README.md` ANCHOR "## Fixtures and data" |
| R12 | Do not invent badges, metrics or counts. Every number shown must come from a command run in this session or from CI. | this spec |
| R13 | All new prose committed to the repo must pass `npm run lint:docs` (slop-lint) at the time of the PR. | `package.json:21` ANCHOR `"lint:docs"` |
| R14 | GitHub actions in workflows are pinned to a full commit SHA with the version in a comment. | `.github/workflows/ci.yml:11` |

# 2. CONCURRENCY PROTOCOL (ANOTHER SESSION IS ACTIVE)

Another Claude session is developing `prose-rewriter` and `slop-lint` (branch history: `claude/eloquent-ride-jfq4ec`, PRs #36, #39 merged into main). Treat these paths as **LOCKED** unless the user says the other session is closed:

```text
LOCKED_PATHS:
  prose-rewriter/**
  style-refs/**
  slop-lint/**
  apps/rewriter/**
  apps/writer/**
  docs-site/scripts/site.ts        # NOT_DOCUMENTED + GROUPS; other session plans phase "F7"
SHARED_PATHS (edit only if task lists them, separate commit, mention in report):
  package.json  package-lock.json  README.md  tsconfig.json  vitest.config.ts
```

CONCURRENCY CHECK (run at step 2 of every task):

```bash
git fetch origin
for b in $(git branch -r | grep 'origin/claude/' | grep -v "$(git branch --show-current)"); do
  echo "== $b"; git log -1 --format='%ad %s' --date=short "$b"
  git diff --name-only origin/main..."$b"
done
```

Decision table:

| Observation | Action |
|---|---|
| Another branch changes a file in this task's FILES.ALLOWED | STOP, report to user |
| Another branch changes `slop-lint/src/rules*` or `slop-lint/**/config*` | Proceed, but re-run `npm run lint:docs` after rebasing right before reporting; warn user that slop-lint rules are moving |
| Only LOCKED_PATHS changed elsewhere and this task does not touch them | Proceed |

Indirect coupling: `lint:docs` runs slop-lint over every `*/README.md`, `SECURITY.md`, `docs-site/pages/*.md` and more (`package.json:21`), and CI runs it (`.github/workflows/ci.yml:107-108`, composite action at `:156-163`). A rule change in the other session can make a doc written here fail. Mitigation: rebase on `origin/main` and re-run `npm run lint:docs` immediately before the final report.

# 3. REPOSITORY FACTS (VERIFIED AT BASELINE)

| Fact | Value | Evidence / ANCHOR |
|---|---|---|
| First commit | 2026-11-16 | `git log --format=%ad --date=short \| tail -1` |
| Top-level library folders | 22 flat folders + `apps/` (9 apps) + `docs-site/` + `test/` | `ls` |
| Live demos on Pages | 5: caja, receipt, replay-lab, checklist, rewriter | `README.md:21-31` ANCHOR "## Live demos" |
| GitHub repo description | Says "eight small apps, four of them with live demos" — WRONG (9 / 5) | `gh api repos/Fedemedinilla/applied-ai-toolkit --jq .description` |
| Releases | 0 | `gh api repos/Fedemedinilla/applied-ai-toolkit/releases --jq length` |
| Domain grouping | Already exists in README and docs sidebar | `README.md:53-87` ANCHOR "## Libraries and tools"; `docs-site/scripts/site.ts:21-27` ANCHOR "export const GROUPS" |
| Folder independence is a design rule | Each top-level folder is self-contained, crossed only via public entry | `import-fences/repo.config.ts:17-26` ANCHOR "Library folders" |
| Composite actions public paths | `Fedemedinilla/applied-ai-toolkit/{slop-lint,csp-build-guard,import-fences}@<SHA>` | `slop-lint/README.md:137`, `csp-build-guard/README.md:155`, `import-fences/README.md:159` |
| Workflow write policy | Test scans every workflow; `NEVER_WRITE` includes `security-events`, `contents`, `checks`, `pull-requests`… | `agent-playbook/src/workflow-secrets.ts:67` ANCHOR "const NEVER_WRITE"; `agent-playbook/test/workflow-secrets.test.ts:22-25` |
| Existing policies | `DEFAULT_WORKFLOW_POLICY` (:40), `PAGES_DEPLOY_POLICY` allowWrite `['pages','id-token']` (:43-47), `RELEASE_POLICY` allowWrite `['id-token']` + allowRepositoryWrite `['contents','pull-requests']`, writeInJobsOnly (:56-61) | `agent-playbook/src/workflow-secrets.ts` |
| Policy map in test | `POLICIES = { 'pages.yml': PAGES_DEPLOY_POLICY, 'release.yml': RELEASE_POLICY }` | `agent-playbook/test/workflow-secrets.test.ts:11` ANCHOR "const POLICIES" |
| Release pipeline | Changesets + npm trusted publishing (OIDC, provenance); disabled until repo variable `NPM_RELEASE == 'enabled'` | `.github/workflows/release.yml:1-14`, `:40` ANCHOR "vars.NPM_RELEASE" |
| SARIF | slop-lint, csp-build-guard, import-fences produce SARIF; CI validates the files, does NOT upload | `.github/workflows/ci.yml:196-210` ANCHOR "Check the SARIF files" |
| Code scanning | None configured (no CodeQL, no upload-sarif) | `grep -rn "codeql\|upload-sarif" .github` → empty |
| Eval gate supports step summary | `node evals/scripts/gate.ts A.json B.json --markdown --summary "$GITHUB_STEP_SUMMARY"`; exit 0 pass, 1 fail, 2 refused, 3 inconclusive | `evals/README.md:181-216` ANCHOR "## The CI gate"; `evals/scripts/gate.ts:15` |
| Offline eval fixtures | `evals/example/tickets-baseline.json`, `tickets-candidate.json`; `evals/scripts/demo-offline.ts` (fake models, measures plumbing not a model) | `evals/scripts/demo-offline.ts:1-9` |
| Gateway structured output | Sends `output_config: { effort, format }` when a schema is given | `gateway/src/gateway.ts:464` ANCHOR "output_config: format" |
| grounded-assistant is NOT RAG | "The model proposes, code decides" for salon bookings | `grounded-assistant/README.md:44-57` ANCHOR "The model proposes, code decides" |
| Red-team evidence | HMAC-signed history, forged history refused with zero model calls, leaked rule flagged | `evals/README.md:293` ANCHOR "redteam.test.ts" |
| Vitest | 5.1.0; no `reporters` configured | `README.md:174`; `vitest.config.ts` |
| Test scripts | `npm test`, `npm run check`, `npm run test:python`, `npm run test:php`, `npm run lint:docs`, `npm run build:docs`, `npm run evals:gate` | `package.json` scripts |
| SECURITY.md | Report policy only (51 lines): Supported versions, Scope, How to report, What happens next | `SECURITY.md` ANCHOR "## Scope" |
| Open PRs at baseline-1 | Dependabot grouped minor/patch (#35) | `gh api repos/Fedemedinilla/applied-ai-toolkit/pulls?state=open` |

# 4. HARD CONSTRAINTS

**C1 — No folder reorganization.** Do not `git mv` top-level folders into domain folders (`ai-core/`, `security-hardening/`, …). Reasons: (a) breaks public composite action paths `owner/repo/<folder>@SHA` [S9]; (b) breaks the self-contained-folder rule enforced by import-fences; (c) `git log --follow` follows a single file only, so per-directory history is cut [S10]; (d) the grouping already exists (§3).

**C2 — Workflow permission changes need a policy + test + ADR.** Any workflow needing `id-token`, `security-events`, `contents` write must: add a named `*_POLICY` in `agent-playbook/src/workflow-secrets.ts`, map it in `POLICIES` in the test, add assertions like the existing ones for pages/release, and ship an ADR (T-08).

**C3 — CodeQL via default setup only** (user action in Settings). Do not add a CodeQL workflow (it needs `security-events: write`, blocked by `NEVER_WRITE`) [S2][S3].

**C4 — Claude Citations API is incompatible with `output_config.format`** (400). Any citations feature needs a new gateway mode without a schema [S23]. Default model in any new Claude code: `claude-opus-5-5`; load skill `claude-api` before writing API code.

**C5 — No fake evidence.** No static "passing" badges, no invented counts, no claims of production use beyond what READMEs already state.

# 5. DEPENDENCY GRAPH

```text
T-01 SECURITY threat model      requires: nothing
T-02 CI job summaries           requires: nothing
T-03 Scorecard workflow         requires: U-04, U-06; policy change per C2
T-04 ADRs                       requires: T-02, T-03 decided
T-05 README first screen        requires: U-01, T-01 (and T-03 for its badge)
T-06 Social preview PNG         requires: nothing (user uploads in U-07)
T-07 TL;DR on module READMEs    requires: nothing
T-09 Release v0.1.0 notes       requires: T-05
T-10 Profile README text        requires: T-05
T-11 Docs tour + before/after   LOCKED until the other session closes
T-12 npm publish                LOCKED for slop-lint; import-fences may go first
T-13 cited-answers library      requires: explicit user OK (>20 files), T-04
```

Recommended order: T-01 → T-02 → T-03 → T-04 → T-05 → T-06 → T-07 → T-09 → T-10 → (T-11, T-12 when unlocked) → T-13 (proposal first).

# 6. USER-ONLY ACTIONS (agent prepares, user executes)

The agent cannot change repository settings. For each item, give the user the exact click path and text; then verify with the command.

| ID | Action | Exact payload / path | Verify |
|---|---|---|---|
| U-01 | Fix repo description | Settings → General → Description: `Production patterns for LLM apps: a Claude API gateway with hard spending caps, evals with a statistical CI gate and a red-team runner, and security guards for LLM output and websites. Nine apps, five live demos. TypeScript, Python, PHP; every test runs offline.` (recount apps/demos before sending) | `gh api repos/Fedemedinilla/applied-ai-toolkit --jq .description` |
| U-02 | Topics | add `python`, `php`, `github-actions`, `sarif`; consider removing `pwa`; max 20 | `--jq .topics` |
| U-03 | Merge/close Dependabot PRs | follow `MAINTENANCE.md:29-46` ANCHOR "### What Dependabot opens" | `gh api .../pulls?state=open --jq length` |
| U-04 | CodeQL default setup | Settings → Code security → Code scanning → CodeQL analysis → Set up → Default. Languages: javascript-typescript, python, actions. PHP unsupported [S4] | `gh api repos/Fedemedinilla/applied-ai-toolkit/code-scanning/default-setup --jq .state` → `configured` |
| U-05 | Private vulnerability reporting | Settings → Code security → Private vulnerability reporting → Enable (`SECURITY.md:36` depends on it) | `gh api repos/Fedemedinilla/applied-ai-toolkit/private-vulnerability-reporting --jq .enabled` |
| U-06 | Ruleset on `main` | Settings → Rules → New branch ruleset: target default branch; require PR; require status checks `Check and test`, `Docs site`, `Composite actions`, `wp-hardening (PHP)`; block force pushes | `gh api repos/Fedemedinilla/applied-ai-toolkit/rulesets` |
| U-07 | Social preview | Settings → General → Social preview → upload PNG from T-06 (1280×640, <1 MB, solid background) [S15] | visual |

# 7. TASK CARDS

## T-01 · SECURITY.md threat model

```yaml
id: T-01
branch: claude/security-threat-model
type: docs
preconditions: [ "§2 check shows no other branch touching SECURITY.md" ]
files:
  allowed: [ SECURITY.md ]
  forbidden: [ LOCKED_PATHS, SHARED_PATHS ]
sources: [ S1, S17, S18, S7 ]
review: [ revisor-seguridad, verificador-de-hechos ]
```

**Goal.** Extend `SECURITY.md` with a threat model that maps each threat to the module that mitigates it and to the test proving it. Keep the existing sections ("Supported versions", "Scope", "How to report", "What happens next") unchanged in substance.

**Steps.**

1. Fetch OWASP Top 10 for LLM Applications 2026 (official PDF/page, S17) through the `web-fetch` agent. Record the 2026 IDs and names. If unreachable, use the 2025 list (S1) and say so to the user. Never guess the 2026 numbering.
2. Build table `## Threat model` with columns: `Threat | OWASP LLM ID | Mitigation (folder) | Evidence (test file)`. For every row, open the cited test file and confirm a test exists that asserts the behavior; cite as a relative link to the file. Drop any row you cannot prove.
3. Candidate rows (verify each):

| Threat | 2025 ID | Folder | Test to verify |
|---|---|---|---|
| Prompt injection (direct, forged history) | LLM01 | evals red-team | `evals/test/redteam.test.ts` |
| Excessive agency | LLM06 | grounded-assistant `decide()` | `grounded-assistant/test/decide.test.ts` |
| Improper output handling (XSS from model output) | LLM05 | safe-markdown | `safe-markdown/test/xss.test.ts`, `properties.test.ts` |
| Unbounded consumption (cost) | LLM10 | gateway reserve-before-call, idempotent ledger, deadline | `gateway/test/caps.test.ts` (find the "ceil(10 / reservation cost)" assertion) |
| System prompt leakage | LLM07 | red-team "leaked rule is flagged" | `evals/test/redteam.test.ts` |
| Supply chain | LLM03 | SHA-pinned actions, Dependabot cooldown, exact versions, npm trusted publishing | `test/maintenance/dependabot.test.ts`, `agent-playbook/test/workflow-secrets.test.ts` |
| Secrets/permissions in CI | platform | workflow-secrets policy | `agent-playbook/test/workflow-secrets.test.ts` |
| CSP regressions in app builds | web | csp-build-guard | `csp-build-guard/test/*` |
| Supabase Auth gaps | web | supabase-auth-hardening (PGlite) | `supabase-auth-hardening/test/closed-signups.test.ts` and siblings |
| WordPress hardening bypass | web | wp-hardening | `wp-hardening/tests/*` (PHPUnit) |

4. Add `## Trust boundaries`: list untrusted inputs (model output, visitor input, imported files, forged chat history) and the function/folder that validates each one.
5. Add `## Known gaps`: LLM04 (data/model poisoning) and LLM08 (vector/embedding) are out of scope (no retrieval index yet); PHP is not covered by CodeQL (tests only); demos on GitHub Pages run without CSP response headers (`README.md:33` ANCHOR "GitHub Pages cannot send response headers").
6. Add one line to "Scope" only if a new in-scope item is needed; otherwise leave it.

**Acceptance.**

```bash
npm ci
npm run lint:docs                      # must pass
npm run build:docs                     # link check must pass
grep -c "^| " SECURITY.md              # rows present
```

Plus: every linked test path exists (`for f in $(grep -o '([^)]*test[^)]*)' SECURITY.md | tr -d '()'); do test -e "$f" || echo MISSING $f; done` prints nothing).

**Commit plan.** 1) `Add the threat model to SECURITY.md` (table + sources) 2) `Add trust boundaries and known gaps`.

## T-02 · CI job summaries

```yaml
id: T-02
branch: claude/ci-job-summaries
type: ci
preconditions: [ "T-01 not required", "§2 clean for .github/workflows/*" ]
files:
  allowed: [ .github/workflows/ci.yml, .github/workflows/quality.yml, scripts/ci-summary/** (new), test/ci-summary/** (new), vitest.config.ts (only if step 1 says so; SHARED → separate commit) ]
  forbidden: [ LOCKED_PATHS ]
sources: [ S5, S19 ]
review: [ revisor-tests ]
```

**Goal.** Each CI run shows Markdown tables in the run summary page: tests, eval gate, SARIF findings, mutation score, Python/PHP counts.

**Steps.**

1. Determine whether Vitest already writes a job summary. Vitest adds the `github-actions` reporter automatically when `GITHUB_ACTIONS=true`; recent versions write a job summary to `$GITHUB_STEP_SUMMARY` (option `jobSummary`) [S19]. Check the latest `ci.yml` run summary (via `estado-ci` skill / REST `GET /repos/{o}/{r}/actions/runs?branch=main&per_page=1`, then look at the run page). If present: do nothing for Vitest. If absent: set `reporters: ['default', 'github-actions']` in `vitest.config.ts` (SHARED, separate commit).
2. Add step in job `Check and test` after "TypeScript tests":

```yaml
      - name: Eval gate summary (fixtures, offline)
        if: always()
        run: |
          {
            echo "### Eval gate on the offline fixtures"
            echo "These runs come from scripted fake models and measure the gate's plumbing, not a model."
          } >> "$GITHUB_STEP_SUMMARY"
          set +e
          node evals/scripts/gate.ts evals/example/tickets-baseline.json evals/example/tickets-candidate.json --markdown --summary "$GITHUB_STEP_SUMMARY"
          code=$?
          set -e
          # Exit codes: 0 pass, 1 fail, 2 refused, 3 inconclusive (evals/README.md "## The CI gate").
          # The fixture pair's expected decision must be asserted, not ignored:
          test "$code" -eq "<EXPECTED>"   # resolve <EXPECTED> by running locally first
```

   Run the command locally first. Replace `<EXPECTED>` with the observed code and note in the commit why that code is expected. Do not use `|| true`.
3. Write `scripts/ci-summary/sarif-table.ts` (Node 24, ESM, no deps): reads N SARIF paths from argv and prints a Markdown table `Tool | Rules | Results | Errors | Warnings`. Add `test/ci-summary/sarif-table.test.ts` with fixture SARIF objects (empty run, 1 error, mixed levels, malformed file → non-zero exit). Wire it in job `Composite actions` after "Check the SARIF files", using the same env vars (`SLOP_SARIF`, `GUARD_SARIF`, `FENCES_SARIF`), `if: always()`, appending to `$GITHUB_STEP_SUMMARY`.
4. In `quality.yml` mutation job: after `npm run mutation:${{ matrix.target }}`, append the mutation score to the summary. Read Stryker's JSON report: `amount-parser`, `gateway` and `grounded-assistant` stryker configs already list `"json"` in `reporters` (`*/stryker.config.json:10`); locate the output path from the config (default `reports/mutation/mutation.json`) and compute Stryker's mutation score = (killed + timeout) / (killed + timeout + survived + noCoverage), or read the score Stryker prints in its clear-text report; state which one in the summary.
5. Python/PHP: append one line with the counts parsed from the runner output (`unittest` prints `Ran N tests`; PHPUnit prints `OK (N tests, M assertions)`).

**Constraints.** No new permissions. The workflow must still pass `agent-playbook/test/workflow-secrets.test.ts` under `DEFAULT_WORKFLOW_POLICY`. Pin any new action by SHA (R14), or better, add no new action at all.

**Acceptance.**

```bash
npm ci && npm run check && npm test            # paste counts
npx vitest run agent-playbook/test/workflow-secrets.test.ts test/ci-summary
node evals/scripts/gate.ts evals/example/tickets-baseline.json evals/example/tickets-candidate.json --markdown; echo "exit=$?"
```

After push: CI green on the branch (skill `estado-ci`); report the summary sections visible on the run page.

**Commit plan.** 1) SARIF table script + tests 2) eval gate summary step 3) SARIF summary step 4) mutation score 5) (optional, SHARED) vitest reporter.

## T-03 · OpenSSF Scorecard

```yaml
id: T-03
branch: claude/openssf-scorecard
type: ci+policy
preconditions: [ "U-04 done (SAST check counts CodeQL)", "U-06 done (Branch-Protection check)" ]
files:
  allowed: [ .github/workflows/scorecard.yml (new), agent-playbook/src/workflow-secrets.ts, agent-playbook/test/workflow-secrets.test.ts, .github/dependabot.yml (only if needed), test/maintenance/dependabot.test.ts (only if needed) ]
sources: [ S6 ]
review: [ revisor-seguridad, revisor-tests ]
```

**Spec.**

- `scorecard.yml`: triggers `push` to `main`, weekly `schedule`, `branch_protection_rule`. Top-level `permissions: read-all` or `contents: read` (follow repo style: `contents: read`, see `release.yml`). Single job: `permissions: { id-token: write }` (needed for `publish_results: true`) [S6]. Steps: `actions/checkout` (same SHA as ci.yml, `persist-credentials: false`), `ossf/scorecard-action@<SHA> # vX.Y.Z` with `results_file`, `results_format: sarif`, `publish_results: true`. **No** `upload-sarif` step (it would need `security-events: write`, C2/C3). Optionally `actions/upload-artifact` for the SARIF file.
- Scorecard job restrictions: only that job may hold `id-token: write`; it must not set job-level `env`/`defaults`, containers or services [S6]. Check repo `defaults: run: shell: bash` placement: put any `defaults` at workflow level only if Scorecard tolerates it; otherwise omit.
- Policy: add to `workflow-secrets.ts`:

```ts
/** The policy for .github/workflows/scorecard.yml: publishes OpenSSF Scorecard results, so its one job needs an OIDC token. */
export const SCORECARD_POLICY: WorkflowPolicy = { ...DEFAULT_WORKFLOW_POLICY, allowWrite: ['id-token'] };
```

  Map `'scorecard.yml': SCORECARD_POLICY` in the test's `POLICIES`; add a test asserting the only finding under the default policy is `id-token: write` (mirror the release.yml assertion style at `workflow-secrets.test.ts` ANCHOR "gives release.yml its write permissions").
- Dependabot: the `github-actions` entry covers `/.github/workflows` (`test/maintenance/dependabot.test.ts:50-51`); no change expected. Verify.
- Badge (for T-05): `[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Fedemedinilla/applied-ai-toolkit/badge)](https://scorecard.dev/viewer/?uri=github.com/Fedemedinilla/applied-ai-toolkit)` — only add to README after the first successful publish.

**Acceptance.** `npx vitest run agent-playbook/test/workflow-secrets.test.ts test/maintenance` passes; after merge by user, the first run succeeds and the badge URL returns a score. Report the score and the failing checks list.

## T-04 · Architecture Decision Records

```yaml
id: T-04
branch: claude/adr
type: docs
preconditions: [ "T-02/T-03 merged or decided (ADR 0005/0007 reference them)" ]
files:
  allowed: [ docs/adr/** (new), package.json (SHARED: only the lint:docs glob, separate commit) ]
  forbidden: [ LOCKED_PATHS ]
sources: [ S8, S20 ]
review: [ verificador-de-hechos ]
```

**Format.** MADR (minimal variant) [S8]. File name `docs/adr/NNNN-kebab-title.md`. Sections exactly: `# NNNN. Title`, `- Status: accepted`, `- Date: YYYY-MM-DD`, `## Context`, `## Decision`, `## Considered options` (each with why rejected), `## Consequences` (positive and negative), `## Evidence` (path:line links). Each ADR LINKS to the folder README's "Design decisions" section instead of copying it. 30–80 lines each. Plus `docs/adr/README.md` index table.

| File | Decision | Must cite |
|---|---|---|
| 0001-record-decisions-with-madr.md | Use MADR; why over Nygard (explicit rejected options) | S8, S20 |
| 0002-gateway-is-the-only-way-to-the-claude-api.md | Single egress; reserve worst-case cost before the call; withhold response when the ledger write fails | `gateway/README.md` ANCHORS "Reserve before calling", "No row, no result", "Idempotent retries" |
| 0003-every-test-runs-offline.md | Scripted fakes, PGlite, no keys; why not recorded HTTP or live calls in CI | `README.md:14`, `evals/scripts/demo-offline.ts:1-9` |
| 0004-flat-self-contained-folders.md | Why not domain folders (C1) | `import-fences/repo.config.ts:17-26`, S9, S10 |
| 0005-workflows-without-secrets-or-writes.md | NEVER_WRITE, per-workflow policies, how to add one | `agent-playbook/src/workflow-secrets.ts:40-67` |
| 0006-eval-gate-newcombe-and-inconclusive.md | Difference interval, margin, inconclusive ≠ pass | `evals/README.md` ANCHOR "## The CI gate" |
| 0007-codeql-default-setup-and-scorecard.md | Default setup (no write permission), Scorecard without SARIF upload; when to revisit | C2, C3, S2, S6 |

Do NOT write an ADR for prose rewriting (owned by the other session).

**SHARED edit.** Append ` docs/adr/*.md` to the file list in `lint:docs` (`package.json:21`). Separate commit: `Lint the ADRs with the docs`.

**Acceptance.** `npm run lint:docs` passes including `docs/adr/*.md`; every `path:line` in ADRs resolves (`verificador-de-hechos` report clean).

## T-05 · Root README first screen

```yaml
id: T-05
branch: claude/readme-first-screen
type: docs (SHARED file)
preconditions: [ "U-01 done", "T-01 merged (README links SECURITY#threat-model)", "§2 clean for README.md" ]
files:
  allowed: [ README.md, MAINTENANCE.md, docs/media/** (new), test/readme/** (new, optional) ]
  forbidden: [ LOCKED_PATHS, docs-site/scripts/site.ts ]
sources: [ S11, S12, S13, S14, S16 ]
review: [ verificador-de-hechos ]
```

**Target layout (top to bottom).**

1. H1 + 2-sentence value proposition (code first, person second). Keep the honest tone; keep links to federicomedinilla.com, kyndredai.com, LinkedIn (`README.md:1-10`).
2. Badges (real only, C5): CI `actions/workflows/ci.yml/badge.svg?branch=main`, Pages `pages.yml`, License MIT, Scorecard (only after T-03 published).
3. `## Start here by role`: table `Role | Open | What it proves | Test that backs it`, 3–4 rows (AI/LLM; Application security; Backend correctness; Automation/full-stack). Each cell links to a folder and to one test file. Every claim gets a test link.
4. `## How the parts fit`: Mermaid `flowchart LR` [S16]. Edges MUST be derived from `import-fences/repo.config.ts` (`LIBRARY_USES`, `APP_USES`, `PUBLIC_SURFACE`). Optional: `test/readme/diagram.test.ts` parses the mermaid block and asserts every edge exists in the fence config.
5. `## Live demos` (move up; keep the existing table `README.md:21-33`).
6. Screenshots: 2–3 PNG in `docs/media/` (Caja ambiguous amount question; Replay Lab hash failure). Capture with preinstalled Playwright, `deviceScaleFactor: 2`, against `npm run build:pages` output served locally; compress to <300 KB each.
7. `## Verify it yourself`: exact commands from `package.json` + the test count from a CI run (R12).
8. Existing sections stay below. Move "Dependencies" and "Fixtures and data" detail to `MAINTENANCE.md` with a one-line link, only if the README stays readable; do not delete content.

**Do not** duplicate the domain grouping (already at `README.md:53-87`); the role table links to it. Do not mention the rewriter beyond the existing demo row (LOCKED owner writes that story, T-11).

**Acceptance.** `npm run lint:docs`, `npm run build:docs` (link check), `npm test` (if diagram test added). Render check: `pandoc README.md -o /tmp/readme.html` or GitHub preview; report first-screen line count (target ≤ 45 rendered lines before "## Live demos").

## T-06 · Social preview image

```yaml
id: T-06
branch: (none — artifact for the user)
type: asset
output: scratchpad PNG 1280x640 sent with SendUserFile; user uploads (U-07)
```

Build a local HTML (solid background, title, 3 short lines: spending caps · measured prompt changes · model output treated as untrusted; repo URL), screenshot with Playwright at viewport 1280×640, deviceScaleFactor 1, PNG < 1 MB [S15]. No logos of third parties.

## T-07 · TL;DR blocks on star module READMEs

```yaml
id: T-07
branch: claude/readme-tldr
files:
  allowed: [ gateway/README.md, evals/README.md, safe-markdown/README.md, csp-build-guard/README.md, import-fences/README.md, idempotent-orders/README.md, grounded-assistant/README.md ]
  forbidden: [ slop-lint/README.md, prose-rewriter/README.md, style-refs/README.md ]
```

Insert directly under each H1 a 3-line block: `**Problem:** …` `**Key decision:** … (link to its Design decisions entry)` `**Run:** \`<one offline command>\``. The command must exist and pass; run each one. Do not shorten or remove existing sections (rejected: 30–45 line mini-READMEs). Acceptance: `npm run lint:docs`, `npm run build:docs`, and each Run command executed with output pasted.

## T-08 · (reserved) Policy changes

Any future permission change (SARIF upload with `security-events: write`; `createGithubReleases` needing `contents: write` in the publish job) follows C2: policy constant + test + ADR. Do not implement without the user's request.

## T-09 · Release v0.1.0 (manual repo release)

```yaml
id: T-09
type: user action + agent-drafted notes
preconditions: [ "T-05 merged" ]
output: release notes Markdown in scratchpad, sent to user
```

Draft notes: what's inside (libraries by group, apps, 5 demos), how to verify (commands), security model link, known limits. The user creates tag `v0.1.0` on `main` and the release in the UI. Do not enable `NPM_RELEASE` (that is T-12). Note for the user: the Changesets release job stays dormant until `vars.NPM_RELEASE == 'enabled'` (`release.yml:40`).

## T-10 · GitHub profile README (`Fedemedinilla/Fedemedinilla`)

```yaml
id: T-10
type: content for user (no repo access in this session: 403)
output: docs text in scratchpad; user creates public repo named exactly like the username with README.md at root [S21]
```

Content: 3 lines (what you build, where, for whom) · links (site, demos, docs, LinkedIn) · table of 4 deep links (gateway, evals CASE-STUDY, SECURITY threat model, live demos). No visit counters, streak or language-stat widgets. Pinned repos: `applied-ai-toolkit` first; pin `new-website-medinilla` only if it has a README and green CI [UNVERIFIED].

## T-11 · Docs tour + before/after of the rewriter — LOCKED

Precondition: user confirms the other session is closed and `prose-rewriter` was removed from `NOT_DOCUMENTED` (`docs-site/scripts/site.ts:60`). Extend "Where to start" (`README.md:16-19`) and `docs-site/pages/index.md` with the diagram and one edge case per demo. The before/after content must come from `prose-rewriter/README.md` "Measured" section; link, do not rewrite.

## T-12 · Publish slop-lint and import-fences to npm — LOCKED for slop-lint

Follow `.changeset/README.md`. User configures npm trusted publisher (workflow `release.yml`, no environment) and sets repo variable `NPM_RELEASE=enabled`. Provenance is generated automatically with trusted publishing; npm CLI ≥ 11.5 required; `actions/setup-node` with `registry-url` can inject `NODE_AUTH_TOKEN` and break OIDC — verify the workflow does not set `registry-url` [S7]. import-fences can go first (not locked).

## T-13 · `cited-answers` library — PROPOSAL ONLY (needs user OK, >20 files)

```yaml
id: T-13
branch: claude/cited-answers (after OK)
type: new library + gateway mode + app
sources: [ S22, S23, S13, S14 ]
first deliverable: a written proposal (docs/roadmap/cited-answers-proposal.md) with file list and estimate
```

**Design spec.**

| Component | Spec |
|---|---|
| Corpus | Fictional (R11), e.g. the invented bicycle workshop used by evals; Markdown/plain text documents |
| Retrieval | In-memory BM25, deterministic; baseline = naive keyword match; report recall@k for both |
| Generation | Claude Citations: `document` blocks with `citations: { enabled: true }` (all or none); response text blocks carry `citations[]` with `cited_text`, `document_index`, `start_char_index`/`end_char_index` [S23] |
| Gateway | New mode "text with citations": no `output_config.format` (C4). Public API change → changeset + ADR. Caps/ledger semantics identical |
| Verification (code) | For each citation: `docs[i].slice(start, end) === cited_text`; each answer sentence containing a factual claim has ≥1 citation; otherwise ABSTAIN |
| Abstention | Fixed response + code `no_evidence` when retrieval score < threshold or verification fails ("model proposes, code decides") |
| Evals | Answerable + unanswerable cases (UAEval4RAG categories [S22]); metrics: correct-abstention rate, false-abstention rate, citation precision (deterministic), answer pass rate; gate with existing `evals/scripts/gate.ts` |
| Tests | All offline with scripted fake responses containing citation blocks, including forged/misaligned citations that must be rejected |
| Demo | Static app on Pages with recorded responses (like Rewriter); no key, no server |
| Fences | Register in `import-fences/repo.config.ts` PUBLIC_SURFACE / LIBRARY_USES; docs-site GROUPS ("LLM in production") — `site.ts` is LOCKED, coordinate |

# 8. REJECTED PROPOSALS (DO NOT IMPLEMENT)

| Proposal (origin: Gemini plans) | Reason |
|---|---|
| Reorganize into `ai-core/`, `security-hardening/`, `backend-primitives/`, `automation-and-apps/` | C1 |
| Consolidate into `ai-core/content-pipeline/` | Already composed in `prose-rewriter`; LOCKED |
| Shrink module READMEs to 30–45 lines | Removes design decisions (the main evidence); use T-07 instead |
| Static badge "CI offline verified" | C5 |
| "749+ commits" claim | False (111 at analysis time) |
| ADR for prose cohesion | Owned by prose-rewriter README; LOCKED |
| Separate `resilient-agent` module | Gateway already validates structured output with zod and leaves retries to the caller (`gateway/README.md` ANCHOR "The gateway owns timeouts and retries"); fold any retry-with-feedback example into T-13 |
| CodeQL workflow file | C3 |
| Separate "3-minute tour" section | Duplicates "Where to start"; extend it in T-11 |

# 9. STATUS PROTOCOL

Status lives in Git, not in this PDF. A task is DONE when its branch was merged into `main`. Check:

```bash
git fetch origin
git log origin/main --oneline --grep "<task commit subject>"   # or:
gh api "repos/Fedemedinilla/applied-ai-toolkit/pulls?state=closed&per_page=50" --jq '.[] | select(.merged_at) | .head.ref'
```

If the user tracks continuity, read `docs/traspaso/ACTUAL.md` first when it exists (user rule). At the end of a long task suggest `/cerrar-sesion`.

# 10. REPORT TEMPLATE (final message to the user, in Spanish with voseo)

```text
Tarea: T-xx <título>   Rama: claude/<slug>   Commits: <n> (<hashes>)
Archivos tocados: <lista>   Compartidos: <sí/no, cuáles>
Verificación:
  $ <comando>  → <pasa/falla, cantidades>
  ...
Chequeo de concurrencia: <limpio / conflicto con …>
Pendiente / [SIN VERIFICAR]: <…>
Acción tuya: <U-xx si aplica>
```

# 11. SOURCES

| ID | Source | URL |
|---|---|---|
| S1 | OWASP Top 10 for LLM Applications 2025 | https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/ |
| S2 | GitHub Docs — Code scanning setup types | https://docs.github.com/en/code-security/concepts/code-scanning/setup-types |
| S3 | GitHub Changelog — Default setup for all CodeQL languages | https://github.blog/changelog/2023-06-28-code-scanning-default-setup-is-now-available-for-all-codeql-supported-languages-excluding-swift/ |
| S4 | CodeQL supported languages and frameworks | https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/ |
| S5 | GitHub Blog — Job summaries | https://github.blog/news-insights/product-news/supercharging-github-actions-with-job-summaries/ |
| S6 | OpenSSF Scorecard Action / checks | https://github.com/marketplace/actions/ossf-scorecard-action · https://github.com/ossf/scorecard |
| S7 | npm trusted publishers / GA changelog | https://docs.npmjs.com/trusted-publishers · https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ |
| S8 | MADR / ADR templates | https://adr.github.io/madr · https://adr.github.io/adr-templates |
| S9 | GitHub Docs — Create a composite action | https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action |
| S10 | Git list — `--follow` works on a single file | https://lore.kernel.ime.usp.br/git/20080129022141.GF24004@spearce.org/t/ |
| S11 | What hiring managers look for on GitHub | https://underdog.io/blog/what-hiring-managers-look-for-on-github |
| S12 | What hiring managers look for in a GitHub portfolio | https://soltech.net/what-do-hiring-managers-actually-look-for-in-a-github-portfolio/ |
| S13 | 1,000+ AI Engineer job descriptions (2026) | https://alexeyondata.substack.com/p/what-1000-job-descriptions-reveal |
| S14 | AI Engineer skills, 3,449 postings | https://dev.to/gnana_6392e836fd500a957dc/ai-engineer-skills-companies-want-in-2026-3449-posting-analysis-5f9l |
| S15 | GitHub Docs — Social media preview | https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview |
| S16 | GitHub Docs — Creating diagrams (Mermaid) | https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams |
| S17 | OWASP GenAI LLM Top 10 2026 | https://genai.owasp.org/home/resources/owasp-genai-llm-top-10-2026/ |
| S18 | Help Net Security — OWASP 2026 LLM Top 10 | https://www.helpnetsecurity.com/2026/08/06/owasp-2026-llm-top-10-released/ |
| S19 | Vitest — Reporters (github-actions, job summary) | https://vitest.dev/guide/reporters |
| S20 | Martin Fowler — Architecture Decision Record | https://www.martinfowler.com/bliki/ArchitectureDecisionRecord.html |
| S21 | GitHub Docs — Managing your profile README | https://docs.github.com/en/account-and-profile/how-tos/profile-customization/managing-your-profile-readme |
| S22 | UAEval4RAG — Unanswerability Evaluation for RAG (ACL 2025) | https://arxiv.org/abs/2412.12300 |
| S23 | Claude API — Citations | https://platform.claude.com/docs/en/build-with-claude/citations |

Source reliability note for agents: S11–S14 are blogs/job-board analyses (indicative, not rigorous). S1–S9, S15–S16, S19, S21, S23 are primary documentation; re-fetch them before relying on exact parameters, since they change.
