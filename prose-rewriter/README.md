# prose-rewriter

prose-rewriter takes a text you wrote: a cover letter, an email, a follow-up or a WhatsApp message. It finds the patterns of generic text in it with slop-lint and returns the same text improved, with your CV as the only source of facts. The model never returns a whole text. It proposes edits over exact quoted spans, and code applies them, checks each one against the facts of your text and your CV, and reverts any edit that adds a fact or loses one.

This folder is at phase F4 of its design. It holds the contract of `rewrite()` as zod schemas (`src/types.ts`), the pure core that checks a model's edits, two fictional CVs for the evals and the test that keeps real data out of the fixtures. The stages through the gateway, with `rewrite()` and the CLI, come in F5.

## Run it

Offline, no key, from the repository root:

```sh
npx vitest run prose-rewriter   # the contract, the pure core and the fixture checks
npm run check                   # tsc --noEmit, strict
```

## The contract

- `RewriteInput` holds the text, its genre (`cover-letter`, `email`, `follow-up`, `whatsapp`), the language, the Spanish variety (`rioplatense` or `neutral`), the register, the mode, the CV as Markdown, the recipient, the goal, the phrases to keep and the `strict` switch. A variety with `lang: 'en'` is refused.
- `Edit` is what a model may propose. Its `before` is quoted exactly from the text. A missing fact is asked for with a labelled marker, `[COMPLETAR: what is missing]`. The schema refuses a bare `[COMPLETAR]`, which slop-lint reports at level 1.
- `RewriteResult` returns the text, the diff, each change with its reason and whether it was applied or reverted, the fact report, slop-lint's result before and after, the flags, a status (`ok`, `needs-review`, `blocked`) and the usage. `costUsd` is null when the gateway has no price for a model.
- The mode defaults to `minimo` on WhatsApp and to `pulido` in the other genres.

## The pure core

Four modules with no model, no gateway and no I/O. `src/index.ts` exports all of them.

- **Voice** (`src/voice.ts`). `voiceProfile()` (`src/voice.ts:134`) measures the text by code. It counts voseo or tuteo, ¿ and ¡, accents, emoji, sentence length and its spread, greeting and sign-off, English contractions and the initial capital. `voicePromptLines()` (`:172`) states the profile as data for the prompt. `voiceViolations()` (`:230`) reports what a rewrite adds that the original did not have, except what the genre requires (`GENRE_REQUIRES`, `:217`).
- **Facts** (`src/facts.ts`). `extract()` (`src/facts.ts:172`) pulls normalized facts, such as numbers with units, amounts, dates, times, addresses, URLs, phones, names, acronyms, tools and the profile's anchors. `inventory()` (`:306`) labels each fact of the original by where the CV or the recipient states it and flags the ones only the user states. `checkEdit()` (`:345`) reverts an edit that invents a fact, loses one or changes a number. `factInvariant()` (`:386`) checks that the original's facts are in the rewrite and that the rewrite's facts are in the original or the CV. `factReport()` (`:407`) fills `FactReport`.
- **Edits** (`src/edits.ts`). `splitSentences()` (`src/edits.ts:169`) numbers the sentences, with subject, greeting, body and signature kept apart by `textParts()` (`:138`). `applyEdits()` (`:279`) places each edit by its exact quote and rejects one it cannot find, an ambiguous or overlapping one, a no-op and one that touches a `keep` phrase. `revertEdit()` (`:317`) takes one accepted edit back, and `diffHunks()` (`:328`) builds the diff from the accepted edits.
- **Injection** (`src/injection.ts`). `injectionFlags()` (`src/injection.ts:95`) flags the phrases of the text or the CV that read like an instruction to a model, in Spanish and English, with their span. `wrapData()` (`:121`) puts the data in a `<texto>` or `<perfil>` block and escapes any of those tags inside it, so the data cannot close its block; `unwrapData()` (`:131`) and `restoreData()` (`:126`) undo the escape. The flags are a heuristic. The real defence is the structured output checked with zod and every edit checked in code.

## Fixtures and data

The evals use two invented people: a freelance web developer in Córdoba (`evals/cases/cv/es-rioplatense.md`) and a support engineer in Leeds (`evals/cases/cv/en.md`). Each CV opens with a comment that marks it as fiction. `test/fixtures.test.ts` scans every eval case and the style-refs data. It fails on an address outside a reserved domain, a phone number that is not zero-filled (with or without separators), a web host outside the reserved names (with a scheme, or bare under a common top-level domain such as linkedin.com), a missing fiction marker, or one of the repository owner's identifiers. A witness test feeds it real-looking data, so a check that stopped matching would fail instead of passing. Your own CV never enters this repository.

## What the gateway records

Every model call of the rewriter will go through the gateway, and the CV travels in the prompt. Phase F0 reviewed what the gateway keeps or writes about a call, so the CV is known to stop at the request sent to the API (`gateway/src/gateway.ts:767` and `:770`). Lines are from the review of November 2026.

- **Ledger rows** (`UsageRow`, `gateway/src/ports.ts:62-99`; table `llm_usage`, `gateway/sql/schema.sql:113-152`) hold ids, the task, the prompt version, models, token counts, cost, stop reason, refusal category, request id, duration and an error code. There is no column for prompt or response text.
- **Event logs** (`EventLog`, `gateway/src/ports.ts:23-26`) carry ids, counts, codes and costs, never text. Each logged error goes through `errorName()` (`gateway/src/gateway.ts:389-395`), which keeps the error's code or class name and drops its message. `jsonLinesLog` writes to `console.warn` by default (`gateway/src/ports.ts:28-29`).
- **Spans** (`CallSpan`, `gateway/src/observe.ts:7-8` and `:17-64`) have no field for text, the user or the job. The OpenTelemetry status message is the error code, never the error's own message (`gateway/src/observe.ts:153-154`).
- **Errors** carry ids, codes, counts and costs (`gateway/src/errors.ts:1-5`). An `ApiError` message names the code, the HTTP status and the API's error type (`gateway/src/errors.ts:211-214`). A schema failure reports only the path and the zod code of each problem (`gateway/src/errors.ts:117-120`, `gateway/src/schema.ts:257-261`), and the JSON parse error, which quotes the text, is dropped (`gateway/src/schema.ts:256`).
- **`userId` and `jobId` must be UUIDs** (`gateway/src/gateway.ts:370-372`), so neither can carry a name or an address.

What the rewriter has to do on its side, from F5:

- **Fixed task names and prompt versions.** `task` and `promptVersion` are free strings that reach the ledger, the logs and the spans (`gateway/src/ports.ts:69` and `:72`; `gateway/sql/schema.sql:122` and `:125` only check that they are not blank). The rewriter uses the four constants `rewrite.plan`, `rewrite.edit`, `rewrite.style` and `rewrite.judge`, and never builds either from the input.
- **Never log `error.cause`.** An `ApiError` keeps the SDK's error as its cause (`gateway/src/gateway.ts:327` and `:836`), and that error holds the API's own message.
- **Output schemas with fixed keys.** A problem's path is built from the output's keys (`gateway/src/schema.ts:261`). With fixed keys and arrays, a path holds field names and indices, never text from the CV.
- **The result is the caller's.** The gateway returns the parsed output to the caller, and what the caller logs or stores is outside this review.
