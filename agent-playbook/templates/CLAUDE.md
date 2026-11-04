# <Project name>

<One paragraph: what the app does, who uses it, and the one or two properties that must never break
(for example: every model call goes through the gateway and is recorded with its cost).>

Plan and status: `docs/ROADMAP.md`. Design and decisions: `docs/DESIGN.md`. Verified facts about the
stack's APIs: `docs/verified-facts.md`. If a document and the code disagree, the code wins and the
document is corrected. Before using an API that is not in the facts document, verify it in the
installed package or the official documentation and add it there, with the source and the date.
The shape of an entry is in `verified-facts.md` and `DESIGN.md` next to this template.

## Environment

- Sessions run in the cloud. They never receive production credentials, which means no database
  host, no deploy token and no app API key. Tests and builds use placeholders from `.env.test`.
- The session network blocks the production hosts, and that stays as it is.
- CI holds no secrets (`test/ci-has-no-secrets.test.ts`). The host deploys `main` through its own
  Git integration after the merge and builds previews for branches.
- The app's API key is `APP_ANTHROPIC_KEY`, never the SDK's default name, so the agent's key and the
  app's key are never the same variable.

## Commands

The project uses the Node version in `.node-version`. The session hook (`scripts/session-start.sh`,
wired in `.claude/settings.json`) installs it, runs `npm ci` when the lock file changed and writes
`.cache/session-env.sh`. Shells that do not read the session's env file load it before each command.
That covers subagents, where every Bash call starts from scratch:

```bash
source <absolute path to the repo>/.cache/session-env.sh && npm test
```

If that file is missing, the hook did not run. Create it with
`CLAUDE_PROJECT_DIR=<repo root> CLAUDE_CODE_REMOTE=true bash scripts/session-start.sh`.

| Command | What it does |
|---|---|
| `npm run check` | Type check. A warning fails it. |
| `npm test` | Every test, offline. `vitest.config.ts` cleans the environment first (`test/helpers/test-env.ts`). |
| `npm run build` | Production build. Needs the public variables; use placeholders. |
| `<db reset>` | Rebuilds the local database from every migration. Run it after any migration change. |

A change is finished when it passes what CI runs, in the order of `.github/workflows/ci.yml`. Passing
`check` and `test` alone is not enough.

## Rules and the tests that enforce them

Every rule here has a test. A rule without one is a wish. Add the test in the same change, or move
the rule to the design document as an open item.

| Rule | Enforced by |
|---|---|
| Only the gateway imports the model SDK; one module reads the API key | `test/single-gateway.test.ts` |
| Browser code imports no Node built-in and no server module | `test/browser-guard.test.ts` |
| Tests never see the session's credentials | `test/test-env.test.ts` |
| CI holds no secrets and cannot write | `test/ci-has-no-secrets.test.ts` |
| Every table has row-level security and minimal grants | `<db tests>` |

## Protected paths

`.claude/protected.json` lists them, and `.claude/hooks/guard-protected-paths.ts` refuses edits to them.
When an edit is refused, stop and ask. Do not reach the file another way.

## Database changes

- Migrations are additive, such as a new table, a nullable column or a new function. What old code uses is
  removed in a later migration, once nothing uses it. Each migration must work with the code that is
  already deployed, because it is applied before the merge.
- A migration that ran in production is never edited. Fix it with a new one.
- A session applies migrations to production only when the person asks for it in the chat, for a
  branch about to be merged, through the database connector. It lists the applied migrations first,
  applies the missing ones in order under their file version, lists them again and reports.

## Review

Before reporting a change as done, hand its diff to the `reviewer` agent (`.claude/agents/reviewer.md`,
read-only). Fix or answer each finding. A finding you disagree with goes into the report with the reason.

## Writing

Plain, specific language. No rhetorical triads, no hype words. Numbers only from a source or from a
run you made, with the date.

## Lessons learned

(At the end of each task, add one line with what is worth remembering. Never delete an entry.)

- <example> The fences config lists folders from disk, so a new folder gets its fence without editing the config.
