# Applied AI Toolkit

I am Federico Medinilla, an applied AI engineer in Buenos Aires. This repository holds working parts extracted from my production work ([federicomedinilla.com](https://federicomedinilla.com), [kyndredai.com](https://kyndredai.com)). They cover integrating an LLM into an application and keeping its cost under a cap. They also cover measuring it on the real model before a prompt change ships, attacking it the way a visitor would, and automating business processes around it. Each library folder is self-contained, and each app under `apps/` uses libraries only through their public entry. Every folder's README gives the design decisions with the reason for each, and its tests run offline with no API key.

## Where to start

- **Two minutes:** read [evals/CASE-STUDY.md](evals/CASE-STUDY.md). One prompt change, measured on the real model before it shipped.
- **Ten minutes:** run an app with no key and no server, then read the library under it. `npm ci && npm run build:receipt && npx vite preview --config apps/receipt/vite.config.ts` opens an order you can edit and download as a PDF; [pdf-receipt/README.md](pdf-receipt/README.md) explains each input that once broke the document. For the model side, read [gateway/README.md](gateway/README.md) and then [apps/chat-widget/server/widget-api.ts](apps/chat-widget/server/widget-api.ts), which calls it.

## The apps

Each app is built on one or more library folders and reaches them only through their public entry. The interfaces are in Spanish. Each one builds with `npm run build:<app>` into `dist/apps/<app>/`.

| App | What you can try | Builds on | Test |
|---|---|---|---|
| [`apps/caja/`](apps/caja/) | Type "vendí 5 tortas a 8000" into an offline cash book and answer its question: price each or total. An optional model mode adds the kind, category and date; the amount still comes from the parser. | `amount-parser`, `gateway` | `npx vitest run apps/caja` |
| [`apps/receipt/`](apps/receipt/) | Edit an order, load the sample with emoji and right-to-left names, and download its PDF. Built in the tab, with no server. | `pdf-receipt` | `npx vitest run apps/receipt` |
| [`apps/writer/`](apps/writer/) | Pick a role and a category at a fictional school, describe a message, and get titles and a draft with the missing facts marked `[COMPLETAR: ...]`. Needs a key for the drafts. | `gateway`, `evals` | `npx vitest run apps/writer` |
| [`apps/chat-widget/`](apps/chat-widget/) | Paste one script tag into a page and chat with a demo tenant, then edit what it knows in the owner panel. Many businesses, one deploy. Needs a key for replies; run `node apps/chat-widget/server/serve.ts` after the build. | `gateway` | `npx vitest run apps/chat-widget` |
| [`apps/push-lab/`](apps/push-lab/) | Install it on a phone, iPhone included, and check that a push lands in Notification Center and sets the icon badge. Needs your own VAPID keys. | none (its own server) | `npx vitest run apps/push-lab` |

## Libraries and tools

Each folder is self-contained, with its own README, tests and public entry.

| Folder | What it is | What it demonstrates | Test |
|---|---|---|---|
| [`gateway/`](gateway/) | The only code allowed to call the Claude API. Each call reserves its worst-case cost before it goes out. | Spending caps that hold through failed ledger inserts, cut streams and concurrent calls; output validated with zod; error codes that say whether a call was billed | `npx vitest run gateway` |
| [`evals/`](evals/) | A variant runner, blinding, a line-by-line judge, Wilson intervals, and a red-team runner. | Measuring a prompt change on the real model: on about 60 pieces per variant written from briefs built to provoke invention, the shipped variant invented a fact in 3% against 47% for the old prompt; on the ordinary example briefs it went from 25% to 6% in Spanish and from 16% to 13% in English ([CASE-STUDY.md](evals/CASE-STUDY.md)) | `npx vitest run evals` |
| [`amount-parser/`](amount-parser/) | A deterministic parser for one money amount in a Rioplatense Spanish sentence. Browser-safe, no dependencies. | A 165-phrase corpus as the spec; property tests with fast-check; `ambiguous: true` instead of a guess | `npx vitest run amount-parser` |
| [`pdf-receipt/`](pdf-receipt/) | Delivery-note PDFs with pdf-lib alone, in Node or a browser tab. | A WinAnsi sanitizer that reports what it dropped; pagination; an amount size that fits the box | `npx vitest run pdf-receipt` |
| [`idempotent-orders/`](idempotent-orders/) | Postgres functions and a TypeScript client for an order that survives a lost response and a double tap. | One order per client-made key with a fingerprint check; stock taken once however many confirms race; a four-way result that includes "unknown" | `npx vitest run idempotent-orders` |
| [`slop-lint/`](slop-lint/) | A linter for the patterns that make writing read as generated, in English and Spanish. 52 rules, each with its source. | A deterministic pass before a model judge; regexes ported to JavaScript with Unicode boundaries | `npx vitest run slop-lint` |
| [`site-check/`](site-check/) | A passive website audit with a plain-language report. 37 fixed rules, no model. Python standard library only. | A scope guard in the network layer; every printed number traced to its measurement | `npm run test:python` |
| [`n8n-templates/`](n8n-templates/) | Thirteen n8n workflows for small businesses, the English versions of the ones I publish at [kyndredai.com/templates](https://kyndredai.com/templates). | Payment signature checks, idempotency where a repeat costs money, tests that run the Code nodes | `npx vitest run n8n-templates` |
| [`csp-build-guard/`](csp-build-guard/) | A CLI that audits a built site before deploy. It runs over every app here. | A Content-Security-Policy compared as sets; inlined secrets; lookbehind for older Safari; a JavaScript budget per page; a check that cannot run fails | `npx vitest run csp-build-guard` |
| [`import-fences/`](import-fences/) | A config-driven checker that turns import rules into a failing test. | This repository's own fences: one SDK importer, one key reader per app server, browser code with no Node built-ins, apps that use only a library's public entry | `npx vitest run import-fences` |
| [`fake-supabase-auth/`](fake-supabase-auth/) | A fetch function that answers like Supabase Auth and PostgREST, for the real `@supabase/supabase-js` client. | Faking the wire instead of mocking `supabase.auth`; real ES256 and HS256 JWTs with a JWKS | `npx vitest run fake-supabase-auth` |

## How I work

These practices repeat across the folders. Each one points to a file where it can be read.

- **A missing number never reads as zero.** Usage totals that come back null throw `invalid_usage_totals` instead of passing the cap check ([gateway/src/caps.ts](gateway/src/caps.ts)). In the chat widget, a turn count that fails, times out or parses as anything but a non-negative integer answers 503 with no model call ([apps/chat-widget/server/widget-api.ts](apps/chat-widget/server/widget-api.ts)).
- **Every external boundary is validated.** Store reads return `unknown` and go through zod before use ([gateway/src/config.ts](gateway/src/config.ts)). Judge verdicts are validated when the model returns them and again when they are aggregated ([evals/src/aggregate.ts](evals/src/aggregate.ts)).
- **Fake the wire, not the code.** The gateway tests drive the real Anthropic SDK client against a fake HTTP API that can cut a stream after any event ([gateway/test/helpers/fake-claude.ts](gateway/test/helpers/fake-claude.ts)). The idempotent-orders tests run the real SQL functions in an in-process Postgres (PGlite) instead of a mocked client ([idempotent-orders/test/helpers/db.ts](idempotent-orders/test/helpers/db.ts)).
- **What shipped is what was measured.** A variant is a list of exact edits on the production prompt, and a dump of the winner before release must equal a dump of the baseline after it ([evals/src/runner.ts](evals/src/runner.ts)).
- **A model only where a step needs judgment.** In Caja the model reads the sentence, but the amount always comes from the parser, and a disagreement becomes a question. In the writer, code picks the step, measures length and lists missing facts; the model writes only the prose. site-check has no model, because its reader cannot check its sentences.
- **Departures from the source are written down.** When a rule differs from the research report it came from, the rule carries a `deviation` field ([slop-lint/src/rules.ts](slop-lint/src/rules.ts)). Each extracted folder's README lists what it changed from the app it came from.

## Run everything

Requirements: Node 24 (the version is in `.node-version`) and Python 3.11 or newer for site-check. Only `apps/` has a build step. Everything else runs from source: Node 24 runs the TypeScript sources directly (type stripping), and site-check needs nothing outside the Python standard library.

```sh
npm ci                 # exact versions from package-lock.json
npm run check          # tsc --noEmit over every TypeScript folder (strict)
npm test               # Vitest suites of every TypeScript folder
node import-fences/cli.ts --config import-fences/repo.config.ts   # the import fences
npm run build:apps     # production build of each app under apps/, into dist/apps/
npm run guard:apps     # csp-build-guard over each app build, with its own config
npm run test:python    # site-check's unittest suite
npm run lint:docs      # slop-lint in Markdown mode over every README and the case study
```

All of it runs offline. Tests never call a real API and never need a key. On 2026-11-04, `npm test` ran 2,227 tests in 95 files and `npm run test:python` ran 591 (one skipped). Live runs are opt-in scripts listed in each folder's README; the ones that call the Claude API read `ANTHROPIC_API_KEY` and exit before any call when it is missing. The app servers start without it and answer "not available". `npm test` also builds each app into a temporary folder (`apps/*/test/build.test.ts`) and runs the import fences (`import-fences/test/repo.test.ts`). `.github/workflows/ci.yml` runs the same eight commands on every push and pull request, with no secrets. It sets placeholder values for the apps' secret variables so the guard searches each build for them.

## Fixtures and data

Every fixture is fictional. The evals folder uses an invented bicycle workshop, and slop-lint a fictional candidate writing to Microsoft's sample companies. The site-check tests run against a fictional school under the reserved `.test` domain, and the n8n templates use `YOUR_...` placeholders and `.example` hosts. Caja's sample entries are for a fictional bakery, and the amount-parser corpus is 165 short phrases with no person, business or contact detail in them. `pdf-receipt`, `apps/receipt` and the chat widget's demo tenant use a fictional plant nursery ("Vivero Ejemplo") with `.example` hosts. The writer uses an invented bilingual school with `.example` contact details. push-lab's fixtures use `push.example.test` endpoints and `mailto:lab@example.test`, and idempotent-orders uses invented products. The csp-build-guard fixtures are tiny builds of a fictional "Example Workshop" site, and the fake Supabase server uses hosts under `.test`. No client data is included, and no real diagnostic run, conversation log, key or account identifier.

## Dependencies

Runtime: `@anthropic-ai/sdk` 1.1.0 and `zod` 4.6.7, plus two used by one folder each: `pdf-lib` 1.17.1 by `pdf-receipt` and `web-push` 3.6.7 by the push-lab server. Development: TypeScript 5.9.3, Vitest 5.0.5 and `@types/node` 24.19.2. Vite 8.3.4 builds every app under `apps/`, and jsdom 30.1.2 runs the DOM tests. fast-check 4.10.2 drives property tests in `amount-parser`, `pdf-receipt`, `idempotent-orders` and Caja. `@electric-sql/pglite` 0.5.9 runs real Postgres in process for the idempotent-orders tests and the chat widget's store test. `fake-supabase-auth` is tested through the real `@supabase/supabase-js` 2.118.0 client, and `@types/web-push` 3.6.4 types the push-lab server. Versions are exact (`.npmrc` sets `save-exact`). site-check and slop-lint have no runtime dependencies.

## License

No license is granted yet; contact via federicomedinilla.com.
