# Agent playbook

How I work with AI coding agents (Claude Code, mostly in cloud sessions) in a production repository without giving them real credentials. The agent writes most of the code and runs every check, but it never holds the database host, the deploy token or the app's API key. The rules it must follow are tests, so a rule it forgets fails the suite instead of passing silently. A second agent that cannot edit files reviews each change before it is reported as done. Each file below is a generic version of one from two private repositories (a production web app and a game prototype) and has offline tests.

## What is here

| File | What it does |
|---|---|
| [`scripts/session-start.sh`](scripts/session-start.sh) | SessionStart hook. Installs the pinned Node after a SHA-256 check, writes an env file for subagents, runs `npm ci` only when the lock file changed |
| [`src/test-env.ts`](src/test-env.ts) | Keeps the session's `ANTHROPIC_*` and `CLAUDE_*` variables (and any prefix you add) out of the test suite |
| [`src/workflow-secrets.ts`](src/workflow-secrets.ts) | Findings for a GitHub Actions workflow that reads a secret, uses an environment, can write, or leaves the token in `.git/config` |
| [`claude/settings.json`](claude/settings.json) | The hook wiring, to copy to `.claude/settings.json` |
| [`claude/hooks/guard-protected-paths.ts`](claude/hooks/guard-protected-paths.ts) | PreToolUse hook. Refuses edits to the paths in [`claude/protected.json`](claude/protected.json) |
| [`claude/hooks/related-tests.ts`](claude/hooks/related-tests.ts) | PostToolUse hook. Runs `vitest related` on the edited file and shows the agent a failure in the same turn |
| [`claude/agents/reviewer.md`](claude/agents/reviewer.md) | A reviewer subagent with `Read`, `Grep` and `Glob` only |
| [`templates/CLAUDE.md`](templates/CLAUDE.md) | The project instructions, with the commands, the rule-to-test table and the lessons log |
| [`templates/verified-facts.md`](templates/verified-facts.md), [`templates/DESIGN.md`](templates/DESIGN.md) | One entry of each document that backs the rules, to show the shape |
| [`templates/vitest-config.ts`](templates/vitest-config.ts) | Where `applyTestEnv` goes, which is the Vitest config, before any worker starts |

To use them in a project, copy `claude/` to `.claude/`, `scripts/session-start.sh` to `scripts/`, `src/test-env.ts` next to the test helpers, and adapt `templates/CLAUDE.md`.

## Run it

From the repository root:

```sh
npm ci
npx vitest run agent-playbook   # offline, no API key; the session hook runs in bash against fakes
npm run check                   # tsc --noEmit, strict
```

The hooks run as Claude Code runs them, with the tool call as JSON on stdin:

```sh
d=$(mktemp -d) && mkdir "$d/.claude" && cp agent-playbook/claude/protected.json "$d/.claude/"
echo '{"tool_name":"Edit","tool_input":{"file_path":"test/golden/race.json"}}' \
  | CLAUDE_PROJECT_DIR="$d" node agent-playbook/claude/hooks/guard-protected-paths.ts; echo "exit $?"
```

The session hook does nothing outside a cloud session. To run it by hand in a project that has it, set `CLAUDE_CODE_REMOTE=true` and `CLAUDE_PROJECT_DIR` to the repository root.

## The environment

A cloud session starts from an image whose Node may not be the one the project pins. A build tool that refuses the image's version fails on the first command, and an agent that meets that failure mid-task may patch around it. The session hook settles the version before the agent starts.

**Pinned Node, checked before it runs.** The hook reads `.node-version`, downloads that release from nodejs.org with its `SHASUMS256.txt`, and unpacks it only after `sha256sum -c` passes. A file missing from the checksum list fails the same way. The check stops a truncated or corrupted download from becoming the interpreter for every command of the session. It does not stop a substituted release, because the checksum list comes from the same host in the same run (see Limits).

**An env file for shells that do not read the session's.** Claude Code applies `CLAUDE_ENV_FILE` to the main session's commands. A subagent's Bash calls each start from scratch and get the image's Node again. The hook also writes `.cache/session-env.sh`, and `CLAUDE.md` gives the one line that every subagent command starts with, `source <repo>/.cache/session-env.sh && npm test`. The file is written before `npm ci`, so a failed install still leaves the right Node at hand to look into it. It holds configuration only, because every command of the session can read it.

**`npm ci` only when something changed.** The hook stores the SHA-256 of `package-lock.json`, `.node-version` and itself in `node_modules/`, and reinstalls only when `sha256sum --check` fails. A resume of a session runs the hook again, and an unconditional install would cost the wait every time.

## Credentials stay out of reach

The arrangement has layers, and each one covers a way a credential could reach code the agent controls.

**Sessions get no production credentials.** The session environment holds placeholders. The network of the session blocks the production database and the deploy host. The agent can build, test and run a local database, and neither a bug nor an injected instruction can reach the real ones.

**Tests see none of the session's credentials (in the production app).** A session still carries its own. There is the agent's API key, a proxy base URL, and sometimes a database token. A test that reads `process.env` sees them, and the Anthropic SDK reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_LOG` even when it is given an explicit key (a test here shows it). `applyTestEnv` runs in the Vitest config before any worker starts. Variables under an isolated prefix reach the tests only when the committed `.env.test` (placeholders) or the ignored `.env.test.local` (deliberate overrides, such as a local database) sets them. A few names under an isolated prefix configure a local tool and grant nothing, and the policy keeps those by name. `envLeaks` returns names, never values, so a failing test prints no secret. This repository's root config does not call it yet (see Limits).

**The app's key is not the agent's key.** If the app reads the SDK's default variable name, the agent's key and the app's key are the same variable, and whichever is set wins without anyone noticing. In the production app the key has a name of its own, and `crossingNames` flags an app variable under an isolated prefix. The demo apps of this repository read `ANTHROPIC_API_KEY`, because a reader runs them with their own key and no agent.

**CI holds no secrets, as a test.** A workflow that reads a repository secret runs on every branch that triggers it, and agents push branches. A branch could change the workflow and print the secret, or point it at production. The production app's CI verifies and holds nothing. The host deploys `main` through its own Git integration, and database changes are applied as described below. [`test/workflow-secrets.test.ts`](test/workflow-secrets.test.ts) points `workflowFindings` at this repository's own `.github/workflows/`. It reports a `secrets` or `github.token` expression, `secrets: inherit`, a deployment `environment`, and the `pull_request_target` and `workflow_run` triggers. It also reports write permissions and a missing top-level `permissions` block. Then it reports a checkout that persists the token, an action pinned to a tag, and a credential-shaped variable without a `ci-placeholder-` value. Adding a secret to CI fails the suite, so the decision is made in review, not by accident. Two workflows get a policy of their own. `pages.yml` deploys the static demos, and the test checks it with `PAGES_DEPLOY_POLICY`, which allows the `pages` and `id-token` write permissions and the `github-pages` environment and nothing else. `release.yml` versions and publishes the npm packages, and the test checks it with `RELEASE_POLICY`. Its version job may write `contents` and `pull-requests`, to push a branch and open the "Version Packages" pull request, and its publish job may write `id-token`. Those repository writes go through a separate list, `allowRepositoryWrite`, and count only in a job's own permissions block, never at the top level and never in a job that also holds `id-token: write`. So the job that can publish cannot push. Listed in `allowWrite`, `contents` and the other permissions that can change the repository stay findings. Permissions are read under quoted keys and in a flow mapping too, and a value the check cannot read is a finding.

**Production database changes only on request.** Migrations are additive, such as a new table, a nullable column or a new function. Each one works with the code already deployed, and what old code uses is dropped in a later migration. A session applies them to production through the database connector, only when I ask for it in the chat, for a branch about to be merged. It compares the applied list with the repository, applies the missing files in order under their file version, lists them again, runs the security advisors and reports. I merge after that report. A migration that ran in production is never edited.

## Rules are tests

A rule in `CLAUDE.md` can drop out of the agent's context in a long session, and a rule nobody checks is broken by the first change that finds it in the way. In the production app, the conventions document summarizes what the repository enforces, and most rules name the test that enforces them. When the document and the code disagree, the document is corrected. The template's rule table has that shape, with one more rule. A rule without a test is an open item, not a rule.

This repository works the same way. Three of its folders are rules enforced as tests.

- [`import-fences`](../import-fences/) turns import rules into a failing test. Here the only source modules that import the Claude SDK are the gateway's and the opt-in eval runner. The only ones that read the API key are one env module per app server and the opt-in live scripts. Tests are exempt, since one here builds a real SDK client offline. Browser code imports no Node built-in, and an app reaches a library only through its public entry. [`import-fences/repo.config.ts`](../import-fences/repo.config.ts) holds this repository's fences.
- [`csp-build-guard`](../csp-build-guard/) audits each app build after CI builds it. It checks the Content-Security-Policy, inlined secrets, regex lookbehind and a JavaScript budget per page. A check that cannot run fails.
- [`slop-lint`](../slop-lint/) runs over every README in CI (`npm run lint:docs`), this one included, and a tier 1 finding fails the job.

Two documents back the rules. A document of verified facts records what the stack's APIs do, each fact checked in the installed package or the official documentation, with the version and the date. An agent asked to use an API that is not in it verifies it first and adds it. A design document records each decision with its options, the cost of each and the one taken, so a later session does not reopen a settled question or quietly undo it. The templates folder has one entry of each.

**Protected paths.** Some files are valuable because nobody changed them to make a test pass. Golden outputs, hand-written content and versioned rule sets are examples. `guard-protected-paths.ts` refuses an edit to any path in `.claude/protected.json`, or to a JSON file marked `"handwritten": true`, with exit code 2 and a message that tells the agent to stop and ask. It protects its own config, the project and local settings, the hooks, the agents and the session hook, and it refuses a Claude Code settings file outside the project. It matches each path as written and after resolving symbolic links, so a link cannot hide a protected target. Claude Code lets a tool call through when a PreToolUse hook exits with any code other than 2. So the guard turns every error into exit 2, and the settings command adds `|| exit 2` for a Node that cannot run the file. A config it cannot parse blocks every edit instead of allowing all of them. The override is `AGENT_ALLOW_PROTECTED=1` in the environment the person starts Claude Code with, and the files that could set it for hooks are among the protected paths.

**Tests next to the edit.** `related-tests.ts` runs `vitest related` on each edited TypeScript file. A pass prints nothing. A failure exits 2, which Claude Code shows to the agent, so the broken test arrives in the turn that broke it instead of at the end of the task.

## Review by independent agents

The agent that wrote a change is a poor reviewer of it, because it reads its own intent into the code. Before a change is reported as done, its diff goes to [`reviewer.md`](claude/agents/reviewer.md), a subagent with `Read`, `Grep` and `Glob` and no tool that can write. It checks correctness with a concrete failing input, the rules of `CLAUDE.md` (and why a test missed a broken one), credentials, tests that pass for the wrong reason, and departures that are not written down. Each finding has `path:line` and a severity, and the review ends in one verdict line. The author fixes each finding or answers it in the report.

**Lessons learned.** `CLAUDE.md` ends with a log. At the close of each task the agent adds one line with what is worth remembering, and no entry is deleted. The next session starts with it in context. In the game prototype, the entries are things like a test that also reads string literals, or a library type missing from the configured `lib`.

## How a change gets merged

1. I describe the change in the chat. For a change to a core module, the agent presents a plan first and waits for approval.
2. The session starts with the hook, which installs the pinned Node and the dependencies and writes the env file for subagents.
3. The agent writes a failing test, then the code. The PostToolUse hook runs the related tests after each edit, and the PreToolUse hook refuses protected paths.
4. The agent runs what CI runs, in the order of `.github/workflows/ci.yml`. Passing `check` and `test` alone is not finished.
5. The reviewer agent reads the diff. The author fixes or answers each finding.
6. The agent pushes the branch. CI runs with no secrets, and the host builds a preview of the branch.
7. If the change has a migration, I ask in the chat, and a session applies it to production through the connector and reports what it applied.
8. I read the report, open the preview, and merge. The host deploys `main`.

## What the tests cover

- `session-start.test.ts` runs the real script in bash in a temporary project, with fake `curl`, `npm`, `node` and `uname` on `PATH` and the real `tar`, `sha256sum` and `grep`. Outside a cloud session nothing happens, and a matching Node downloads nothing. A download is checked, unpacked and put first on `PATH`. A tampered tarball, or one missing from the checksum list, stops the script before unpacking and before `npm ci`. `npm ci` runs once, and again only after the lock file changes, also when the script lives at another path. Env lines are never duplicated on resume, and the subagent env file exists even when the install fails.
- `test-env.test.ts` checks that leaks are reported by name and never by value, that test values win, that kept names and unrelated variables pass through, that local overrides stay and that a missing `.env.test` throws. Against the real SDK, it shows the client takes the base URL and log level from the environment despite an explicit key, and returns to its defaults once they are removed.
- `workflow-secrets.test.ts` finds nothing in any workflow of this repository, and checks that `ci.yml` really carries credential-shaped placeholders, so that check is not vacuous. Each finding is produced by breaking a clean workflow in one way, quoted values, quoted keys and flow mappings included. `RELEASE_POLICY` gets its own cases: the release jobs pass, and each way of putting `id-token` next to a repository write fails. A comment that a rule would otherwise match produces none.
- `hooks.test.ts` runs both hooks as Claude Code runs them, with JSON on stdin, the exit code and stderr. For the guard it covers protected globs, the JSON flag, `NotebookEdit`, the override, its own config and settings, and settings outside the project. It also covers symbolic links (dangling ones included), malformed input, a broken config, and the settings command with a Node that cannot run the file. For the related-tests hook, a fake `npx` shows exit 2 with the tail of the output on a failure and a silent exit 0 on a pass. It also checks that every command in `settings.json` points at a file this folder ships and that the reviewer's tools are read-only.

On 2026-11-14, `npx vitest run agent-playbook` ran 65 tests in 4 files.

## What changed from the private originals

Each item is a hole found while turning the originals into generic files.

- The protected-path override was a marker file in `.claude/`. An agent can create a file with one shell command, so the override is now an environment variable of the Claude Code process.
- The guard now also protects its own config, the settings, the hooks and the agents, resolves symbolic links, and blocks when its config or its input is broken.
- The related-tests hook exited 0 on a failure, so the agent never saw it. It now exits 2 with the tail of the output.
- The isolated prefixes were the model provider's and the database's. The default is now `ANTHROPIC_` and `CLAUDE_` (Claude Code's own variables, an OAuth token among them), and a project adds its database prefix in its policy, as `templates/vitest-config.ts` shows.
- The session hook's database variables and Linux user setup are now an empty `EXTRA_ENV` list. It detects arm64 as well as x64, and hashes itself by its own path.
- The source's CI test checked for secrets, environments and two deploy commands of its stack. The deploy commands are left out as stack-specific, and `workflowFindings` adds permissions, privileged triggers, the job token, persisted checkout credentials, unpinned actions and placeholder values.

## Limits

- The guard covers the file tools. A shell command can still write a protected file, a settings file outside the project included, and managed or command-line settings are out of its reach. The backstops are the reviewer and the tests over those files, since a golden test fails on any change.
- Claude Code reads hook settings at session start, so a change that got past the guard would take effect in the next session. The reviewer and the protected-path list are the backstop.
- The hooks need a Node with TypeScript type stripping on the `PATH` Claude Code runs hooks with, which may be the image's Node and not the pinned one. Node 24 runs the files as they are, and so does the Node 22.22 of the current cloud image (checked on 2026-11-04). With an older Node, the `|| exit 2` in the settings blocks every edit until that is fixed, and the related-tests hook reports an error after every edit.
- The Node checksum list comes from the same host and the same run as the tarball, so a compromised mirror or an intercepting proxy could swap both. A project that needs more can pin the tarball's hash next to `.node-version`, or check `SHASUMS256.txt.sig` against the Node release keys.
- The workflow check reads block-style YAML line by line. A workflow in flow style (`{ a: b }`) or with a `#` inside a quoted value can hide text from it. It does not resolve reusable workflows or composite actions in other repositories.
- `applyTestEnv` cleans the environment of the test process. A test that spawns a child process with an explicit `env` decides that child's environment itself.
- This repository's root Vitest config does not call `applyTestEnv` yet. In a repository where agents run the suite with their own key loaded, it should.
- The session hook targets Linux on x64 and arm64, with `curl`, `tar`, `xz`, `sha256sum` and `realpath` present, as in the cloud image.
