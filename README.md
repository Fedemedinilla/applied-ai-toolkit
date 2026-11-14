# Applied AI Toolkit

Hi, I'm Federico Medinilla, a software developer in Buenos Aires, Argentina. I spent six years building websites and front ends. Since 2024 I have run KyndredAI, a small studio where I build AI assistants, n8n automations and web apps for schools, shops and small businesses.

This repository is the toolbox behind that work. When a client project needed something I knew I would need again, I pulled it out, wrote tests for it and put it here. You will find the code that keeps Claude API spending under a cap and the runner I use to measure a prompt change before it ships. Next to them are the security checks I run on the sites I build, and eight small apps that show the pieces working together. It is open source under the [MIT license](LICENSE), so you can download any part and use it in your own projects.

- **Try it in your browser:** [live demos](https://fedemedinilla.github.io/applied-ai-toolkit/). Four apps, no account, and nothing you type leaves your device.
- **See my client work:** [federicomedinilla.com](https://federicomedinilla.com) has my portfolio and case studies, and [kyndredai.com](https://kyndredai.com) is my studio.
- **Get in touch:** [LinkedIn](https://www.linkedin.com/in/federico-medinilla), or the contact form on [federicomedinilla.com](https://federicomedinilla.com).

## How this repository is organized

The parts put an LLM into an application under a spending cap and measure a prompt change on the real model before it ships. They check what the model writes before a visitor sees it, and they harden the sites and databases around it. Each library folder has its own README and tests, and uses another folder only through its public entry (`content-forge` uses `gateway`). Each app under `apps/` uses libraries only through their public entry. Every folder's README gives the design decisions with the reason for each, and its tests run offline with no API key. CI runs all of them on every push to `main` and every pull request.

## Where to start

- **Two minutes.** Open the [Caja live demo](https://fedemedinilla.github.io/applied-ai-toolkit/caja/) and type "vendí 5 tortas a 8000", then read [evals/CASE-STUDY.md](evals/CASE-STUDY.md), one prompt change measured on the real model before it shipped.
- **Ten minutes.** Read [gateway/README.md](gateway/README.md), the only code here allowed to call the Claude API, and then [apps/chat-widget/](apps/chat-widget/), a multi-tenant chat backend that calls it ([server/widget-api.ts](apps/chat-widget/server/widget-api.ts)).

## Live demos

The apps that work as static files are published on GitHub Pages at <https://fedemedinilla.github.io/applied-ai-toolkit/>, built and deployed by [.github/workflows/pages.yml](.github/workflows/pages.yml) on every push to `main`. Nothing typed in them leaves the device.

| Demo | Try this |
|---|---|
| [Caja](https://fedemedinilla.github.io/applied-ai-toolkit/caja/) | Type a sale in Spanish and answer its question when the amount has two readings. On Pages the optional model mode stays hidden, because it needs the app's server. |
| [Receipt](https://fedemedinilla.github.io/applied-ai-toolkit/receipt/) | Load the order with emoji and right-to-left names and download its PDF. |
| [Replay Lab](https://fedemedinilla.github.io/applied-ai-toolkit/replay-lab/) | Export a run, change one value in the file, and import it to see both hashes fail. |
| [Site checklist](https://fedemedinilla.github.io/applied-ai-toolkit/checklist/) | Mark a check Fails, then try to mark it Fixed before acknowledging the pre-change list. |

The chat widget, the writer, the salon assistant and push-lab need their own server, so they are not published; each README says how to run it. GitHub Pages cannot send response headers, so the published apps run without the Content-Security-Policy that their `csp-guard.config.json` checks the build against. To publish from a fork, enable Pages once in the repository: Settings > Pages > Source: GitHub Actions.

## Apps

Each app builds with `npm run build:<app>` into `dist/apps/<app>/`. Caja, Receipt, the writer, the chat widget, push-lab and the salon assistant have Spanish interfaces; Replay Lab and the site checklist are in English.

| App | What you can try | Builds on | Test |
|---|---|---|---|
| [`apps/caja/`](apps/caja/) | Type "vendí 5 tortas a 8000" into an offline cash book and answer its question: price each or total. An optional model mode adds the kind, category and date; the amount still comes from the parser. | `amount-parser`, `gateway` | `npx vitest run apps/caja` |
| [`apps/receipt/`](apps/receipt/) | Edit an order, load the sample with emoji and right-to-left names, and download its PDF. Built in the tab, with no server. | `pdf-receipt` | `npx vitest run apps/receipt` |
| [`apps/replay-lab/`](apps/replay-lab/) | Play a seed, export the run, edit and re-import it to see the hash fail, or run 1,000 runs in a worker with a histogram. Offline. | `deterministic-sim` | `npx vitest run apps/replay-lab` |
| [`apps/checklist/`](apps/checklist/) | Pick a platform, mark a check Fails then Fixed (refused until the pre-change list is acknowledged), load site-check's example [`datos.json`](https://raw.githubusercontent.com/Fedemedinilla/applied-ai-toolkit/main/site-check/examples/datos.json) (save it first), and export the before and after report. | none (its tests read site-check's published example run) | `npx vitest run apps/checklist` |
| [`apps/writer/`](apps/writer/) | Pick a role and a category at a fictional school, describe a message, and get titles and a draft with the missing facts marked `[COMPLETAR: ...]`. Needs a key for the drafts. | `gateway`, `evals` | `npx vitest run apps/writer` |
| [`apps/chat-widget/`](apps/chat-widget/) | Paste one script tag into a page and chat with a demo tenant, then edit what it knows in the owner panel. Many businesses, one deploy. Needs a key for replies; run `node apps/chat-widget/server/serve.ts` after the build. | `gateway` | `npx vitest run apps/chat-widget` |
| [`apps/salon-assistant/`](apps/salon-assistant/) | Ask a fictional salon for an appointment and get a booking card whose price, time and stylist come from its tables, never from the model. Needs a key for replies. | `gateway`, `grounded-assistant`, `safe-markdown` | `npx vitest run apps/salon-assistant` |
| [`apps/push-lab/`](apps/push-lab/) | Install it on a phone, iPhone included, and check that a push lands in Notification Center and sets the icon badge. Needs your own VAPID keys. | none (its own server) | `npx vitest run apps/push-lab` |

The Pages landing page is [`apps/index.html`](apps/index.html), and [`apps/pages.ts`](apps/pages.ts) assembles the site from the builds (`npm run build:pages`).

## Libraries and tools

Each folder has its own README, tests and public entry.

### LLM in production

| Folder | What it is | What it demonstrates | Test |
|---|---|---|---|
| [`gateway/`](gateway/) | The only code allowed to call the Claude API. Each call reserves its worst-case cost before it goes out. | Spending caps that hold through failed ledger inserts, cut streams and concurrent calls; output validated with zod; error codes that say whether a call was billed | `npx vitest run gateway` |
| [`evals/`](evals/) | A variant runner, blinding, a line-by-line judge, Wilson intervals, and a red-team runner. | On about 60 pieces per variant written from briefs built to provoke invention, the shipped variant invented a fact in 3% against 47% for the old prompt ([CASE-STUDY.md](evals/CASE-STUDY.md)) | `npx vitest run evals` |
| [`content-forge/`](content-forge/) | An LLM writes catalogue entries for a fictional card game as structured output; each candidate must pass the catalogue's zod schemas, range rules and cross-references before it is promoted. | Per-candidate verdicts, so one bad candidate does not void the batch; pass rate per prompt version with Wilson intervals; a promote that never overwrites hand-written files | `npx vitest run content-forge` |
| [`grounded-assistant/`](grounded-assistant/) | The code between a booking assistant's model and the visitor: `decide()` and a money guard over every `$` figure. | A booking card only after five checks against the salon's tables; a 55-reply corpus with 19 pinned known misses; signed conversation history | `npx vitest run grounded-assistant` |

### Security

| Folder | What it is | What it demonstrates | Test |
|---|---|---|---|
| [`csp-build-guard/`](csp-build-guard/) | A CLI that audits a built site before deploy. It runs over every app here, and is also a composite GitHub Action. | A Content-Security-Policy compared as sets; inlined secrets; lookbehind for older Safari; a JavaScript budget per page; a check that cannot run fails; `--sarif` output for code scanning | `npx vitest run csp-build-guard` |
| [`import-fences/`](import-fences/) | A config-driven checker that turns import rules into a failing test. | This repository's own fences: one SDK importer, one key reader per app server, browser code with no Node built-ins, apps that use only a library's public entry | `npx vitest run import-fences` |
| [`supabase-auth-hardening/`](supabase-auth-hardening/) | SQL that closes four gaps Supabase Auth leaves open: open sign-ups, pre-registered passwords, email changes, unlimited code guesses. | Each control tested in PGlite against Supabase's default grants, next to a test that reproduces the gap without it; a read-only audit of RLS, grants and `search_path` | `npx vitest run supabase-auth-hardening` |
| [`safe-markdown/`](safe-markdown/) | An escape-first Markdown renderer for model replies shown with `innerHTML`. One file, no dependencies. | Every tag in the output written by the renderer; an XSS battery; a fast-check property test in jsdom | `npx vitest run safe-markdown` |
| [`safe-contact-form/`](safe-contact-form/) | A contact endpoint whose acknowledgment to the visitor cannot carry their links. | A honeypot, a skew-tolerant clock, an origin check behind proxies, a destination never taken from the request | `npx vitest run safe-contact-form` |
| [`wp-hardening/`](wp-hardening/) | A WordPress plugin with the hardening controls that can be set from PHP, each with a toggle, a Site Health test and `wp harden`, plus a read-only audit. | A guard per control that keeps it from breaking a site (REST stays up, HSTS without preload, CSP in Report-Only); server rules generated and checked, never written | `npm run test:php` |
| [`site-check/`](site-check/) | A passive website audit with a plain-language report. 37 fixed rules, no model, Python standard library only. `--compare` turns two stored runs into a before and after report and refuses runs that are not comparable. | A scope guard in the network layer; every printed number traced to its measurement | `npm run test:python` |

### Data and correctness

| Folder | What it is | What it demonstrates | Test |
|---|---|---|---|
| [`amount-parser/`](amount-parser/) | A deterministic parser for one money amount in a Rioplatense Spanish sentence. Browser-safe, no dependencies. | A 165-phrase corpus as the spec; property tests with fast-check; `ambiguous: true` instead of a guess | `npx vitest run amount-parser` |
| [`idempotent-orders/`](idempotent-orders/) | Postgres functions and a TypeScript client for an order that survives a lost response and a double tap. | One order per client-made key with a fingerprint check; stock taken once however many confirms race; a four-way result that includes "unknown" | `npx vitest run idempotent-orders` |
| [`deterministic-sim/`](deterministic-sim/) | A replayable simulation core: seeded named streams, one rounding per formula, a canonical SHA-256 run hash. | A purity test on the syntax tree, fast-check replay properties, Claude Code guard hooks and a read-only reviewer agent | `npx vitest run deterministic-sim` |
| [`pdf-receipt/`](pdf-receipt/) | Delivery-note PDFs with pdf-lib alone, in Node or a browser tab. | A WinAnsi sanitizer that reports what it dropped; pagination; an amount size that fits the box | `npx vitest run pdf-receipt` |

### Testing, writing, automation and process

| Folder | What it is | What it demonstrates | Test |
|---|---|---|---|
| [`fake-supabase-auth/`](fake-supabase-auth/) | A fetch function that answers like Supabase Auth and PostgREST, for the real `@supabase/supabase-js` client. | Faking the wire instead of mocking `supabase.auth`; real ES256 and HS256 JWTs with a JWKS | `npx vitest run fake-supabase-auth` |
| [`slop-lint/`](slop-lint/) | A linter for the patterns that make writing read as generated, in English and Spanish. 52 rules, each with its source. Also a composite GitHub Action and the npm package `@fedemedinilla/slop-lint`. | A deterministic pass before a model judge; every doc in this repository passes it in CI; `--sarif` output for code scanning | `npx vitest run slop-lint` |
| [`n8n-templates/`](n8n-templates/) | Thirteen n8n workflows for small businesses, the English versions of the ones I publish at [kyndredai.com/templates](https://kyndredai.com/templates). | Payment signature checks, idempotency where a repeat costs money, tests that run the Code nodes | `npx vitest run n8n-templates` |
| [`agent-playbook/`](agent-playbook/) | How coding agents work in a repository without real credentials: session hook, test environment isolation, a CI-has-no-secrets check, edit hooks, a read-only reviewer, a CLAUDE.md template. | A pinned Node verified by SHA-256; a test that fails if a workflow reads a secret or can write beyond its policy; protected paths the agent cannot edit with the file tools | `npx vitest run agent-playbook` |

## Client work

These are production projects I built for clients and for my own sites. Their repositories are private; each line links the public case study and names the folder here that shows the same engineering.

- **B2B wholesale ordering app for Teia Bakery** ([case study](https://federicomedinilla.com/work/b2b-wholesale-ordering-app/)). The same engineering is in [`idempotent-orders/`](idempotent-orders/) and [`pdf-receipt/`](pdf-receipt/).
- **Bayard Writer for Colegio Bayard** ([case study](https://federicomedinilla.com/work/ai-writing-assistant-school/), [Kyndred AI case study](https://kyndredai.com/resources/bayard-writer-case-study/)). The same engineering is in [`apps/writer/`](apps/writer/). The eval method in [`evals/`](evals/) comes from my own site's demos, not from this project.
- **The Kyn assistant and the multi-tenant chatbot platform** at [kyndredai.com](https://kyndredai.com). The same engineering is in [`apps/chat-widget/`](apps/chat-widget/), [`gateway/`](gateway/) and [`safe-markdown/`](safe-markdown/).
- **[federicomedinilla.com](https://federicomedinilla.com) and [kyndredai.com](https://kyndredai.com)**, the two sites. The same engineering is in [`csp-build-guard/`](csp-build-guard/), [`safe-contact-form/`](safe-contact-form/) and [`grounded-assistant/`](grounded-assistant/).

## How I work

Each practice points to a file where it can be read.

- **A missing number never reads as zero.** Usage totals that come back null throw `invalid_usage_totals` instead of passing the cap check ([gateway/src/caps.ts](gateway/src/caps.ts)).
- **Every external boundary is validated.** Store reads return `unknown` and go through zod before use ([gateway/src/config.ts](gateway/src/config.ts)); model candidates go through the catalogue's own schemas ([content-forge/src/schemas.ts](content-forge/src/schemas.ts)).
- **Fake the wire, not the code.** The gateway tests drive the real Anthropic SDK client against a fake HTTP API that can cut a stream after any event ([gateway/test/helpers/fake-claude.ts](gateway/test/helpers/fake-claude.ts)).
- **What shipped is what was measured.** A variant is a list of exact edits on the production prompt, and a dump of the winner before release must equal a dump of the baseline after it ([evals/src/runner.ts](evals/src/runner.ts)).
- **A model only where a step needs judgment.** The model proposes a booking, and code decides whether it can happen and checks every price it wrote ([grounded-assistant/src/decide.ts](grounded-assistant/src/decide.ts)).
- **A fix comes with the test that reproduces the gap.** Each Supabase Auth control has a test that shows the hole without it ([supabase-auth-hardening/test/closed-signups.test.ts](supabase-auth-hardening/test/closed-signups.test.ts)).
- **Rules are tests.** The import fences, the no-secrets check on every workflow and the purity test of the simulation core fail the suite instead of relying on review ([agent-playbook/README.md](agent-playbook/README.md), [import-fences/repo.config.ts](import-fences/repo.config.ts)).
- **Departures from the source are written down.** When a rule differs from the research report it came from, the rule carries a `deviation` field ([slop-lint/src/rules.ts](slop-lint/src/rules.ts)).

## Run everything

```sh
npm ci                 # exact versions from package-lock.json
npm run check          # tsc --noEmit over every TypeScript folder (strict)
npm test               # Vitest suites of every TypeScript folder
node import-fences/cli.ts --config import-fences/repo.config.ts   # the import fences
npm run build:packages # compiles gateway and slop-lint to their dist/ folders, as npm pack does
npm run pack:check     # packs gateway and slop-lint as npm would, installs each tarball and checks it
npm run build:apps     # production build of each app under apps/, into dist/apps/
npm run guard:apps     # csp-build-guard over each app build, with its own config
npm run test:python    # site-check's unittest suite
npm run test:php       # wp-hardening: composer install from the lock, php -l, PHPUnit
npm run lint:docs      # slop-lint in Markdown mode over every README and doc a reader opens

# SARIF 2.1.0 logs for code scanning, from the two CLIs that write them
node slop-lint/cli.ts --lang en --format markdown --sarif README.md > slop-lint.sarif
node csp-build-guard/cli.ts --dir dist/apps/caja --config apps/caja/csp-guard.config.json --sarif --sarif-base . > caja.sarif
```

On 2026-11-14, `npm test` ran 3,255 tests in 158 files, `npm run test:python` ran 639 (one skipped) and `npm run test:php` ran 171 (one skipped). The fences checked 37 rules in 520 files with no violation. Tests never call a real API and never need a key. Live runs are opt-in scripts listed in each folder's README. The ones that call the Claude API read `ANTHROPIC_API_KEY` and exit before any call when it is missing, and the app servers start without it and answer "not available". [.github/workflows/ci.yml](.github/workflows/ci.yml) runs the same commands on every push to `main` and every pull request, with no secrets and with placeholder values for the apps' secret variables, so the guard searches each build for them. A separate job runs the two actions from this checkout (`uses: ./slop-lint` on the docs, `uses: ./csp-build-guard` on the Caja build) and checks that each SARIF file parses. It does not upload them, since that would need `security-events: write`.

## Requirements

Node 24 (the version is in `.node-version`), Python 3.11 or newer for site-check, and PHP 8.1 or newer with Composer for wp-hardening. Node 24 runs the TypeScript sources directly (type stripping), so working in the repository needs no build. The apps under `apps/` build with Vite, and the two npm packages (`gateway` as `@fedemedinilla/claude-gateway`, `slop-lint` as `@fedemedinilla/slop-lint`) compile to JavaScript only when they are packed, because Node does not strip types inside `node_modules`.

## Packages

Two folders are prepared as npm packages. Neither is published yet.

| Package | Folder | What it ships |
|---|---|---|
| `@fedemedinilla/claude-gateway` | [`gateway/`](gateway/) | The gateway's public entry, compiled to JavaScript with declarations |
| `@fedemedinilla/slop-lint` | [`slop-lint/`](slop-lint/) | `lint`, the rules and their types, and the `slop-lint` bin |

Each README has an Install section. Releases go through Changesets and the `release.yml` workflow with npm trusted publishing, so no npm token is stored; [.changeset/README.md](.changeset/README.md) gives the steps. `npm run pack:check` installs each tarball outside the repository and checks it, in CI on every run.

`slop-lint/` and `csp-build-guard/` are also composite GitHub Actions (`uses: Fedemedinilla/applied-ai-toolkit/slop-lint@<commit SHA>`). Each writes a SARIF file that `github/codeql-action/upload-sarif` can send to code scanning. Their READMEs document the inputs and give a full workflow.

## Dependencies

Runtime: `@anthropic-ai/sdk` 1.1.0 and `zod` 4.6.7, plus `pdf-lib` 1.17.1 for `pdf-receipt` and `web-push` 3.6.7 for the push-lab server. Development: TypeScript 5.9.3, Vitest 5.0.5, `@types/node` 24.19.2 and `@changesets/cli` 3.0.3 for releases. Vite 8.3.4 builds the apps, and jsdom 30.1.2 runs the DOM tests. fast-check 4.10.2 drives property tests in `amount-parser`, `pdf-receipt`, `idempotent-orders`, `deterministic-sim`, `safe-markdown` and Caja. `@electric-sql/pglite` 0.5.9 runs real Postgres in process for `idempotent-orders`, `supabase-auth-hardening` and the chat widget's store test. `fake-supabase-auth` is tested through the real `@supabase/supabase-js` 2.118.0 client, and `@types/web-push` 3.6.4 types the push-lab server. Versions are exact (`.npmrc` sets `save-exact`). wp-hardening's dev dependencies (PHPUnit 10.5.66, Brain Monkey 2.7.0, Mockery 1.6.15) are locked in `wp-hardening/composer.lock`. site-check, slop-lint, safe-markdown and deterministic-sim have no runtime dependencies.

## Fixtures and data

Every fixture is fictional, and no client data, real diagnostic run, conversation log, key or account identifier is included. The evals use an invented bicycle workshop, and Caja a fictional bakery. `pdf-receipt`, Receipt and the chat widget's demo tenant use a fictional plant nursery. The writer uses an invented bilingual school. The `grounded-assistant` library and the salon assistant use a fictional Buenos Aires salon, `content-forge` a fictional card game, and `deterministic-sim` an invented dice tournament. The `site-check` tests and the site checklist use a fictional school under the reserved `.test` domain; real suffixes and mail providers (`com.ar`, `edu.ar`, `gmail.com`) appear only where a test checks suffix, registry or webmail handling, or where the CLI refuses a `.test` address outside its test options. Phone numbers are zero-filled. The `supabase-auth-hardening` tests use addresses under `example.test` and a fake bcrypt string. The `wp-hardening` tests use `.example` hosts and documentation IP ranges, plus private addresses and the first address past a range for the boundary cases. The other folders use `.example` or `.test` hosts and `YOUR_...` placeholders.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Federico Medinilla.

To report a vulnerability, read [SECURITY.md](SECURITY.md); to send a change, read [CONTRIBUTING.md](CONTRIBUTING.md).
