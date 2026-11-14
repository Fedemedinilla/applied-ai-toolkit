# Contributing

Issues and pull requests are welcome. Read the root [README.md](README.md) first, and the README of each folder you change. Every folder states its design decisions with the reason for each, and a change that goes against one should say why in the pull request.

To report a vulnerability, do not open an issue; follow [SECURITY.md](SECURITY.md).

## Run everything

Node 24 (the version is in `.node-version`), Python 3.11 or newer for site-check, and PHP 8.1 or newer with Composer for wp-hardening. From the repository root:

```sh
npm ci                 # exact versions from package-lock.json
npm run check          # tsc --noEmit over every TypeScript folder (strict)
npm test               # Vitest suites of every TypeScript folder
node import-fences/cli.ts --config import-fences/repo.config.ts   # the import fences
npm run build:apps     # production build of each app under apps/, into dist/apps/
npm run guard:apps     # csp-build-guard over each app build, with its own config
npm run test:python    # site-check's unittest suite
npm run test:php       # wp-hardening: composer install from the lock, php -l, PHPUnit
npm run lint:docs      # slop-lint in Markdown mode over every README and doc a reader opens
```

One folder at a time: `npx vitest run <folder>`. CI runs the same commands on every pull request.

## Rules for a change

CI enforces most of these, so a pull request that breaks one fails before review.

- **Tests run offline.** No test calls a real API, opens a connection beyond 127.0.0.1 or needs a key. Fake the wire, as `gateway/test/helpers/fake-claude.ts` does, instead of mocking the code under test. A live run is an opt-in script that exits before any call when its key is missing.
- **A bug fix comes with the test that reproduces it.** The test fails without the fix. Do not weaken, skip or delete an existing test to make a change pass.
- **Library folders stay self-contained.** A library never imports another folder's files, and an app uses a library only through its public entry. The rules live in `import-fences/repo.config.ts`; add one there when a change needs a new boundary.
- **TypeScript stays strict.** `npm run check` passes with the settings in `tsconfig.json`, among them `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` and `verbatimModuleSyntax`. No `any` to get past an error.
- **Docs pass slop-lint.** Every Markdown file a reader opens is listed in the `lint:docs` script and passes `npm run lint:docs`. A new doc goes on that list. Code, comments and docs are in English.
- **Dependencies use exact versions.** `.npmrc` sets `save-exact`, and `package-lock.json` and `wp-hardening/composer.lock` are committed. Say in the pull request why a new dependency is needed.
- **Actions are pinned to a full commit SHA**, with the version tag in a comment, as in `.github/workflows/ci.yml`. Resolve the SHA from the release tag on the action's own repository; never copy one from an unverified source.
- **Workflows hold no secrets.** `agent-playbook/src/workflow-secrets.ts` checks every workflow for secret reads and write permissions. A workflow that needs more gets its own named policy in that module, with a test.
- **Fixtures are fictional.** No client data, real diagnostic run, conversation log, key or account identifier. Use `.example` or `.test` hosts, `YOUR_...` placeholders and zero-filled phone numbers, as the root README describes under Fixtures and data.

## Commits and pull requests

Keep a commit to one verified step. Write the subject in the imperative. The body says why the change was made and which command verified it, with its result. The pull request template asks for the same.

## Releasing a package

Two folders are released to npm under the `@fedemedinilla` scope: `@fedemedinilla/slop-lint` from `slop-lint/` and `@fedemedinilla/claude-gateway` from `gateway/`. Their release flow uses [Changesets](https://github.com/changesets/changesets). A pull request that changes what one of these packages does adds a changeset:

```sh
npx changeset
```

The prompt asks which packages changed and whether the change is a patch, a minor or a major. It writes a short Markdown file under `.changeset/`, which you commit with the change. At release time the maintainer turns the pending changesets into version bumps and changelog entries. A change that touches only tests, docs or a folder that is not published needs no changeset.
