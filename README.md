# Applied AI Toolkit

I am Federico Medinilla, an applied AI engineer in Buenos Aires. This repository holds working parts extracted from my production work ([federicomedinilla.com](https://federicomedinilla.com), [kyndredai.com](https://kyndredai.com)). They cover integrating an LLM into an application and keeping its cost under a cap. They also cover measuring it on the real model before a prompt change ships, attacking it the way a visitor would, and automating business processes around it. Each library folder is self-contained, and each app under `apps/` uses libraries only through their public entry. Every folder's README gives the design decisions with the reason for each, and its tests run offline with no API key.

## The folders

| Folder | What it is | Language | What it demonstrates | Test |
|---|---|---|---|---|
| [`gateway/`](gateway/) | The only code in an app allowed to call the Claude API. Each call reserves its worst-case cost in a ledger before it goes out, then closes the reservation with the cost measured per attempt. | TypeScript, SQL | Spending caps that hold through failed ledger inserts, cut streams, unpriced fallback models and concurrent calls; structured output validated with zod on both sides; error codes that say whether a call was billed | `npx vitest run gateway` |
| [`evals/`](evals/) | A variant runner, blinding, a line-by-line judge, aggregation with Wilson intervals, and a red-team runner for a chat handler. | TypeScript | Measuring a prompt change on the real model. In the case study, on short or unanswerable briefs, the variant that shipped invented a fact in 3% of pieces against 47% for the old prompt ([CASE-STUDY.md](evals/CASE-STUDY.md)) | `npx vitest run evals` |
| [`slop-lint/`](slop-lint/) | A linter for the patterns that make a cover letter read as generated, in English and Spanish. 52 rules, each with its source and examples. | TypeScript | A deterministic first pass before a model judge; porting regexes to JavaScript correctly (Unicode boundaries, flag pinning) | `npx vitest run slop-lint` |
| [`site-check/`](site-check/) | A passive website audit that writes a plain-language report on security, speed, visibility and contact paths. 37 fixed rules, no language model. | Python (standard library only) | A scope guard enforced in the network layer; reports rebuilt byte for byte from stored measurements; every printed number traced to its measurement | `npm run test:python` |
| [`n8n-templates/`](n8n-templates/) | Thirteen n8n workflows for small businesses, the English versions of the ones I publish at [kyndredai.com/templates](https://kyndredai.com/templates). | n8n JSON, TypeScript tests | Payment signature checks, idempotency where a repeat costs money, closed-set structured output, tests that walk the node graph and run the Code nodes | `npx vitest run n8n-templates` |
| [`amount-parser/`](amount-parser/) | A deterministic parser that reads one money amount from a sentence typed or dictated in Rioplatense Spanish, and returns `ambiguous: true` with a reason when a sentence has two readings. | TypeScript (browser-safe, no runtime dependencies) | A 165-phrase corpus as the spec; property tests with fast-check; asking instead of guessing | `npx vitest run amount-parser` |
| [`apps/caja/`](apps/caja/) | An installable, offline cash book for a small shop, built on `amount-parser`. The interface is in Spanish. | TypeScript, HTML, CSS (Vite) | The parser where it is meant to run, in the browser on every entry with no model call; a hand-written service worker with a generated precache; validated localStorage | `npx vitest run apps/caja` |
| [`csp-build-guard/`](csp-build-guard/) | A CLI that audits a built static site before deploy: stale inline hashes, policy drift, inlined secrets, regex lookbehind for older Safari, and a JavaScript budget per page. | TypeScript | Comparing a Content-Security-Policy as sets, parsed the way the browser parses it; a check that cannot run fails | `npx vitest run csp-build-guard` |
| [`import-fences/`](import-fences/) | A config-driven checker that turns architecture rules about imports into a failing test, with the file, line, rule and reason. | TypeScript | This repository's own fences: one SDK importer, one key reader, browser code with no Node built-ins, and apps that reach a library only through its public entry | `npx vitest run import-fences` |
| [`fake-supabase-auth/`](fake-supabase-auth/) | A fetch function that answers like Supabase Auth and PostgREST, driven through the real `@supabase/supabase-js` client. | TypeScript | Faking the wire instead of mocking `supabase.auth`; real ES256 and HS256 JWTs with a JWKS; knobs for the failures an app's session code must survive | `npx vitest run fake-supabase-auth` |

## How I work

These practices repeat across the folders. Each one points to a file where it can be read.

- **A missing number never reads as zero.** Usage totals that come back null throw `invalid_usage_totals` instead of passing the cap check ([gateway/src/caps.ts](gateway/src/caps.ts)). In site-check, a green result without its evidence file is downgraded to "not verified" ([site-check/sitecheck/gate.py](site-check/sitecheck/gate.py)).
- **Every external boundary is validated.** Store reads return `unknown` and go through zod before use ([gateway/src/config.ts](gateway/src/config.ts)). Judge verdicts are validated when the model returns them and again when they are aggregated, because the verdicts file is the last step before the results table ([evals/src/aggregate.ts](evals/src/aggregate.ts)).
- **Fake the wire, not the code.** The gateway tests drive the real Anthropic SDK client against a fake HTTP API that can cut a stream after any event ([gateway/test/helpers/fake-claude.ts](gateway/test/helpers/fake-claude.ts)). The site-check tests run the real CLI against a fake site on 127.0.0.1 that records every request it receives ([site-check/tests/fakesite.py](site-check/tests/fakesite.py)).
- **What shipped is what was measured.** A variant is a list of exact edits on the production prompt. Prompt dumps render at a fixed date, so a dump of the winning variant before release must equal a dump of the baseline after it ([evals/src/runner.ts](evals/src/runner.ts)).
- **A model only where a step needs judgment.** site-check has no model, because its reader cannot check its sentences. Eight of the thirteen n8n templates have none. slop-lint is the free deterministic pass that runs before a model scores a letter ([slop-lint/src/lint.ts](slop-lint/src/lint.ts)).
- **Departures from the source are written down.** When a rule differs from the research report it came from, the rule carries a `deviation` field that says how and why ([slop-lint/src/rules.ts](slop-lint/src/rules.ts)).

## Run everything

Requirements: Node 24 (the version is in `.node-version`) and Python 3.11 or newer for site-check. Only `apps/` has a build step (`npm run build:apps`). Everything else runs from source: Node 24 runs the TypeScript sources directly (type stripping), and site-check needs nothing outside the Python standard library.

```sh
npm ci                 # exact versions from package-lock.json
npm run check          # tsc --noEmit over every TypeScript folder (strict)
npm test               # Vitest suites of every TypeScript folder
npm run build:apps     # production build of each app under apps/, into dist/apps/
npm run guard:apps     # csp-build-guard over that build
npm run test:python    # site-check's unittest suite
npm run lint:docs      # slop-lint in Markdown mode over every README and the case study
```

All of it runs offline. Tests never call a real API and never need a key. Live runs are opt-in scripts listed in each folder's README. The ones that call the Claude API read `ANTHROPIC_API_KEY` and exit before any call when it is missing. `npm test` also runs the production build of each app into a temporary folder (`apps/caja/test/build.test.ts`) and this repository's import fences (`import-fences/test/repo.test.ts`, the same as `node import-fences/cli.ts --config import-fences/repo.config.ts`). `.github/workflows/ci.yml` runs the same seven commands on every push and pull request.

## Fixtures and data

Every fixture is fictional. The evals folder uses an invented bicycle workshop, and slop-lint a fictional candidate writing to Microsoft's sample companies. The site-check tests run against a fictional school under the reserved `.test` domain, and the n8n templates use `YOUR_...` placeholders and `.example` hosts. Caja's sample entries are for a fictional bakery. The amount-parser corpus is 165 short phrases of the kind a shop owner says about a sale or an expense, with no person, business or contact detail in them. The csp-build-guard fixtures are tiny builds of a fictional "Example Workshop" site, and its tests and the fake Supabase server use hosts under `.test` (`api.example.test`, `supabase.test`). No client data is included, and no real diagnostic run, conversation log, key or account identifier.

## Dependencies

Runtime: `@anthropic-ai/sdk` 1.1.0 and `zod` 4.6.7. Development: TypeScript 5.9.3, Vitest 5.0.5 and `@types/node` 24.19.2. Four more are used by one folder each. Vite 8.3.4 builds `apps/caja`, and jsdom 30.1.2 runs its DOM tests. fast-check 4.10.2 drives the property tests of `amount-parser`, and `fake-supabase-auth` is tested through the real `@supabase/supabase-js` 2.118.0 client. Versions are exact (`.npmrc` sets `save-exact`). site-check and slop-lint have no runtime dependencies.

## License

No license is granted yet; contact via federicomedinilla.com.
