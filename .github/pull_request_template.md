## What changed

<!-- The folders touched and what each change does. -->

## Why

<!-- The problem it solves, or the issue it closes (Closes #123). -->

## How it was verified

<!-- The commands you ran and the result line of each, for example:
npm run check: no errors
npx vitest run gateway: 202 passed
-->

## Checklist

See [CONTRIBUTING.md](../CONTRIBUTING.md) for each rule.

- [ ] Tests run offline, with no API key and no network call.
- [ ] A bug fix comes with a test that fails without it; no existing test was weakened, skipped or deleted.
- [ ] `npm run check` and the tests of every folder touched pass.
- [ ] The import fences pass, and no library imports another folder's files.
- [ ] New or changed Markdown docs are in `lint:docs` and pass `npm run lint:docs`.
- [ ] New dependencies use exact versions, with the lockfile committed.
- [ ] New or changed actions are pinned to a full commit SHA with the version tag in a comment.
- [ ] Workflows still pass the policy in `agent-playbook/src/workflow-secrets.ts`.
- [ ] Fixtures are fictional: no client data, keys or personal details.
- [ ] A change to `@fedemedinilla/slop-lint` or `@fedemedinilla/claude-gateway` has a changeset (`npx changeset`).
