# prose-rewriter

prose-rewriter takes a text you wrote: a cover letter, an email, a follow-up or a WhatsApp message. It finds the patterns of generic text in it with slop-lint and returns the same text improved, with your CV as the only source of facts. The model never returns a whole text. It proposes edits over exact quoted spans, and code applies them, checks each one against the facts of your text and your CV, and reverts any edit that adds a fact or loses one.

This folder is at phase F6a of its design. It holds the contract of `rewrite()` as zod schemas (`src/types.ts`), the pure core that checks a model's edits, the pieces the model stages are built from, the stages S0 to S7 behind `rewrite()` and the CLI. The eval harness is in `evals/`. It also holds two fictional CVs for the evals and the test that keeps real data out of the fixtures. The caps, the efforts and a few limits below are provisional until F6 measures real rewrites.

## Run it

Offline, no key, from the repository root:

```sh
npx vitest run prose-rewriter   # the contract, the core, the stages and the CLI, over a scripted gateway
npm run check                   # tsc --noEmit, strict
```

The CLI calls the model, so it needs `ANTHROPIC_API_KEY` in the environment. It never reads the key from a file or an argument, and it refuses to run without it, except when S1b finds nothing to change and no call is needed:

```sh
node prose-rewriter/cli.ts --genre follow-up --lang es --variety rioplatense \
     --cv ~/cv.md [--to recipient.json] [--previous previous.txt] \
     [--mode minimo|pulido|reescritura] [--keep "phrase"]... [--strict] \
     [--strategy staged|single] [--json] draft.txt
```

- `--to` names a JSON file with the recipient's `name`, `org` and `role`. `--previous` names the earlier message of a follow-up. `--keep` can be repeated, and each phrase is left as it is. `--strategy single` makes one call that plans and edits instead of the stages S2 to S4, with the same checks after it (see "The stages"); without it the stages run.
- The output starts with the rewritten text. Then come the changes, each with its reason and whether it was applied or reverted. After them, the facts taken from the CV, the ones only your text states, the placeholders, the flags and the status. `--json` prints the whole `RewriteResult` instead.
- The CV's path is read and never printed, not even when the file cannot be read. A failed gateway call prints the error's name, its gateway code and its message, never the error's cause. Any other failure prints only the error's name.
- The live gateway is built only in `cli.ts` (`cli.ts:32`), over in-memory stores with the four tasks and the provisional caps of `src/tasks.ts`. Everything else is `src/cli.ts`, which the tests run over the scripted gateway (`test/cli.test.ts`).
- The stores live as long as one run. Each run gets a new job id, so the per-job cap binds within a run. The daily and monthly caps start from zero on every run, and with no user id the daily cap is skipped, so neither limits repeated runs. Persistent stores (the gateway's Postgres stores) would make them bind.

Exit codes (`src/cli.ts:29`), provisional because the design left them open:

| Code | Meaning |
|---|---|
| 0 | `ok`, or `--help` |
| 1 | `needs-review`: an edit was reverted for inventing, or a fact check failed |
| 2 | `blocked`: an invented fact persisted after the extra round |
| 3 | bad usage: an unknown or missing option, an unreadable file, an input the schema refuses |
| 4 | could not run: no `ANTHROPIC_API_KEY`, or a model call failed |

## The contract

- `RewriteInput` holds the text, its genre (`cover-letter`, `email`, `follow-up`, `whatsapp`), the language, the Spanish variety (`rioplatense` or `neutral`), the register, the mode, the CV as Markdown, the recipient, the goal, the phrases to keep and the `strict` switch. A variety with `lang: 'en'` is refused.
- `Edit` is what a model may propose. Its `before` is quoted exactly from the text. A missing fact is asked for with a labelled marker, `[COMPLETAR: what is missing]`. The schema refuses a bare `[COMPLETAR]`, which slop-lint reports at level 1.
- `RewriteResult` returns the text, the diff, each change with its reason and whether it was applied or reverted, the fact report, slop-lint's result before and after, the flags, a status (`ok`, `needs-review`, `blocked`) and the usage. `costUsd` is null when the gateway has no price for a model.
- The mode defaults to `minimo` on WhatsApp and to `pulido` in the other genres.

## The pure core

Four modules with no model, no gateway and no I/O. `src/index.ts` exports all of them.

- **Voice** (`src/voice.ts`). `voiceProfile()` (`src/voice.ts:156`) measures the text by code. It counts voseo or tuteo, ¿ and ¡, accents, emoji, sentence length and its spread, greeting and sign-off, English contractions and the initial capital. `voicePromptLines()` (`:200`) states the profile as data for the prompt. `voiceViolations()` (`:258`) reports what a rewrite adds that the original did not have, except what the genre requires (`GENRE_REQUIRES`, `:245`).
- **Facts** (`src/facts.ts`). `extract()` (`src/facts.ts:430`) pulls normalized facts, such as numbers with units, amounts, dates, times, addresses, URLs, phones, names, acronyms, tools and the profile's anchors. `inventory()` (`:656`) labels each fact of the original by where the CV or the recipient states it and flags the ones only the user states. `checkEdit()` (`:695`) reverts an edit that invents a fact, loses one or changes a number. Numbers count per occurrence and keep their order. A sentence also starts after an emoji and after a line label such as "Subject:". After an emoji, a capitalized word stays a name unless it reads as an ordinary word. A name at the start of a sentence counts when the text, the CV or the edit names it elsewhere. An unknown capitalized first word is an ordinary word when it is a frequent opener or ends like a verb or adverb. The same word in lower case elsewhere does not count: "Mark" still reads as a name next to "the mark". Otherwise it counts as a possible name. That heuristic can still revert an edit that changes an opening noun nothing else writes, such as "Propuesta" after "Asunto:". `factInvariant()` (`:753`) checks that the original's facts are in the rewrite and that the rewrite's facts are in the original or the CV. `factReport()` (`:787`) fills `FactReport`.
- **Edits** (`src/edits.ts`). `splitSentences()` (`src/edits.ts:169`) numbers the sentences, with subject, greeting, body and signature kept apart by `textParts()` (`:138`). `applyEdits()` (`:328`) places each edit by its exact quote, in NFC, and rejects one it cannot find, an ambiguous or overlapping one, one that splits a character, a no-op and one that touches a `keep` phrase. `revertEdit()` (`:373`) takes one accepted edit back, and `diffHunks()` (`:384`) builds the diff from the accepted edits.
- **Injection** (`src/injection.ts`). `injectionFlags()` (`src/injection.ts:144`) flags the phrases of the text or the CV that read like an instruction to a model, in Spanish and English, with their span. `wrapData()` (`:185`) puts the data in a `<texto>` or `<perfil>` block and escapes any of those tags inside it, so the data cannot close its block. That covers tags written with look-alike letters, fullwidth brackets or numeric entities. `unwrapData()` (`:195`) and `restoreData()` (`:190`) undo the escape. The flags are a heuristic. The real defence is the structured output checked with zod and every edit checked in code.

## The model-facing pieces

Phase F5a added what the model stages need. `src/index.ts` exports all of it.

- **Tasks** (`src/tasks.ts`). The four gateway tasks (`:21`) with their model and effort (`:24`). Plan, edit and style run on `claude-fable-5-2`, and the fact judge on `claude-sonnet-5-5`. The effort (`medium` for all four) and the caps (`:41`) are provisional until F6 measures a rewrite.
- **Judge client** (`src/model-client.ts`). `gatewayModelClient()` (`src/model-client.ts:29`) gives evals' judge a `ModelClient` over the gateway, so its calls pass the caps too.
- **Fact judge** (`src/rubric.ts`). The rewriter's own rubric (`src/rubric.ts:38`, `:107`) reads the rewrite line by line against the CV and the original draft. The judge's call has no structured output, so its reader forgives what does not change a verdict. A missing note reads as empty. `judgeReplyJson()` (`:71`) takes the object out of a code fence or a sentence around it. `planReverts()` (`:287`) turns a verdict into the edits to revert, and `judgeRuns()` (`:166`) applies D10. Its final round takes only the edits the first round left, so a line invented in both rounds comes back as the user's own claim.
- **Output schemas** (`src/outputs.ts`). `PlanOutput` (`src/outputs.ts:107`) holds an action and a reason per sentence and no text. A missing fact is asked for only as a labelled `[COMPLETAR: ...]` whose label holds a letter or a digit (`:31`). `EditOutput` (`:115`) is an array of the existing `Edit`, so a bare `[COMPLETAR]` is refused there as well. `checkModelEdit()` (`:86`) refuses a model's edit that hides an unlabelled marker behind an invisible character or adds a placeholder slop-lint reports as FMT-04. It also refuses one with more sentences than its quote plus `EDIT_EXTRA_SENTENCES` (`:52`, provisional), counting a sentence with no space after its period too. `styleOutput()` (`:128`) takes the ids of the principles the prompt showed and refuses any other id. It caps the edits per text with `STYLE_MAX_EDITS` (`:122`), a provisional value.
- **Prompt** (`src/prompt.ts`). `systemBlocks()` (`src/prompt.ts:140`) returns four system blocks, each a cache breakpoint, ordered so the ones that change least come first. The first holds the hard rules (`HARD_RULES`, `:70`), the genre's principles from style-refs and its conventions. Then come the examples, the CV, and last the voice, the recipient, the goal and the mode. The design lists the conventions as a fifth block, but the gateway accepts four breakpoints, and the conventions change with the same keys as the principles. `planPrompt()` (`:218`), `editPrompt()` (`:236`) and `stylePrompt()` (`:268`) add one user turn with the stage's task and the numbered text, so the conversation never ends on a prefill. The text, the CV and anything that quotes them travel inside `wrapData()` blocks, and so does the plan echoed into the edit stage (`:245`). Neither the data nor a model's reply can close a block or add a section of rules. The register comes from the input: a context that names another one is refused.

## The stages

`rewrite(input, { gateway })` (`src/rewrite.ts:47`) runs the stages of design 4.4 in order. The caller injects the gateway, and the tests pass the scripted one. Every model call goes through it, the fact judge's included. There is no other client to pass.

- **S0 prepare** (`src/stages/analyse.ts:38`). Normalizes the text to NFC, numbers its sentences, keeps subject, greeting, body and signature apart and flags injection in the text and the CV.
- **S1 analyse** (`src/stages/analyse.ts:95`). Runs slop-lint with the genre, the language and the variety, measures the voice and takes the fact inventory. It resolves the mode and the register. The default register per genre (`src/types.ts:46`) is provisional. It is formal for a cover letter, neutral for an email and a follow-up and casual for WhatsApp, as in style-refs' examples.
- **S1b early exit** (`src/stages/analyse.ts:119`). In `minimo` with no finding at level 1 or 2, it returns the text as it is with "No encontré nada para cambiar", and no model is called.
- **S2 plan** (`src/stages/model.ts:90`). One `rewrite.plan` call. It returns an action and a reason per sentence, and no text.
- **S3 edit** (`src/stages/model.ts:120`). One `rewrite.edit` call. It keeps at most one edit per plan item that is not `keep` (`editCap()`, `:108`, provisional) and drops the rest before placement. In `reescritura` an edit may span a paragraph (`src/stages/check.ts:53`). The gateway parses only the reply's shape (`EditReply`, `src/outputs.ts:142`). Code restores any neutralized data tag in each edit and runs the per-edit checks (`editProblem()`, `src/outputs.ts:150`), so one bad edit is refused alone.
- **S4 style** (`src/stages/model.ts:169`). One `rewrite.style` call, capped by `STYLE_MAX_EDITS` (`src/outputs.ts:122`, provisional). Skipped in `minimo` and when no principle applies. It runs after S3's edits are placed and checked, and reads the text as they left it (`currentText()`, `src/stages/compose.ts:44`). `composeStyle()` (`:103`) turns each style edit back into an edit of the original. One that touches S3's edits is merged with them into a single edit, and S5, S6 and the judge check that merged edit. If it does not stand, the S3 edits come back (`restoreMerged()`). Two style edits whose quotes overlap still conflict, and the second is refused.
- **S5 facts** (`src/stages/check.ts:119`, judge at `:246`). Code places each edit by its exact quote (`:82`). Then it checks each one, in the order made, against the edits it already accepted. It reverts an edit that invents, loses or repeats a fact, and a drop whose fact no longer stays elsewhere. The judge runs as D10 says, once on what the code left and again only when it reverted something. A reply it cannot read (not JSON, the wrong shape, a line missing) is asked for once more. If the retry cannot be read either, no edit the judge did not clear is kept. On the first verdict every live edit goes back. On the second, the edits the first one cleared stay. The rewrite comes back as `needs-review`, with a flag. Any other error, such as a cap, still fails the rewrite.
- **S6 re-lint and voice** (`src/stages/check.ts:198`). Reverts an edit that adds a level 1 finding, breaks a trait of the voice or touches a `keep` phrase, judged against the edits S6 already kept. If level 1 findings remain (`src/rewrite.ts:95`), one extra S3 round (`src/stages/model.ts:149`) gets them as a list, with the edits kept from the first round as its history and the ones not applied named. A finding inside a live edit names that edit's sentence. An extra-round edit with the same sentence and quote replaces the live one (or the style edit that merged it), which comes back if its replacement fails. The extra round's edits go through S5 and S6 again. A reply it cannot read leaves the first round as it stands.
- **S7 assemble** (`src/rewrite.ts:193`). Builds the diff from the accepted edits, the changes, the fact report, lint before and after, the flags, the status and the usage. Every edit a model proposed is in the changes. One that code could not place is reverted, with the span of the sentence it named. The status is `blocked` when the rewrite still states a fact outside the text and the CV, or the extra round invented again. It is `needs-review` when an edit was reverted for inventing, a fact went missing or the judge's verdict could not be read, and `ok` otherwise.

`RewriteOptions.strategy` (`src/types.ts:182`) picks how the edits are written. `staged`, the default, runs S2, S3, S4 and the extra round as above. `single` replaces them with one `rewrite.edit` call on the single-call prompt (`singleStage()`, `src/stages/model.ts:98`), with no edit cap since there is no plan. Its edits then go through the same placement, S5 in code, S6, the judge and S7. There is no S4 and no extra round, so a rewrite makes at most one call plus the judge's. It exists to measure one call with the guards against the stages (F6b).

## Evals

The harness in `evals/` runs the eval cases through the pipeline and its variants (`evals/pipeline.ts:91`), scores each piece with the code rubrics and the blind judges, and gates each pipeline variant against the single-call baseline (`evals/run.ts:324`). `single-call` makes the one call and applies its edits with no check. `single-guarded` is `rewrite()` with strategy `single`. It makes the same call, then runs S5, the judge, S6 and S7, so the two differ only in the guards. The CLI is `node prose-rewriter/evals/cli.ts`. Its testable core is `runEvalCli()` (`evals/run.ts:361`), which the tests run over the scripted gateway. Only `evals/cli.ts` reads `ANTHROPIC_API_KEY` and builds the live gateway (`evals/cli.ts:26`).

**The budget.** Every real-model eval run spends from one monthly budget, decision D14 of the design. The default is US$20 (`MONTHLY_BUDGET_USD`, `evals/spend.ts:59`).

- November 2026: 50 USD (decision of the maintainer, 16/11/2026, to use expiring promotional credit); default 20 USD.
- A month's budget goes above the default only with an explicit `--monthly-cap`. The November runs pass `--monthly-cap 50`, and the runs from December on pass nothing. The flag can also lower the cap for a run, and cannot raise it past US$50 (`MONTHLY_CAP_CEILING_USD`, `evals/spend.ts:65`), so a typo such as 500 is refused.
- The dry run and the run report print the cap in force and who set it, the default or `--monthly-cap`.

The gateway's own caps reset on every run, so the budget lives in a ledger file outside the repository, `~/.applied-ai-toolkit/eval-spend.json` (`evals/spend.ts:73`). It has one entry per calendar month in Buenos Aires (`evals/spend.ts:68`). The ledger keeps what was spent, not the cap, so a run at the default after a raised one sees the same spend against US$20. `openLedger()` (`evals/spend.ts:227`) writes it through a temp file and a rename under a lock file, and stops on a file it cannot parse instead of overwriting it.

Before every model call, `budgetedGateway()` (`evals/spend.ts:368`) reserves the call's worst case. That is the input bound of `estimateInputTokens`, with the output schema and the attachment bound, at the dearest input rate of every model in force, plus the whole output budget at the dearest output rate (`evals/spend.ts:333`). It refuses the call when the month would pass the cap, when the run would pass `--max-usd`, or when the model has no price. After the call the reservation settles to the measured cost. A call the gateway could not price, or one that failed after it reached the API, settles at its worst case. A reservation that never settles keeps counting at its worst case.

Run it in three steps.

1. **Dry run.** `node prose-rewriter/evals/cli.ts --dry-run` needs no key and makes no call. It prints an upper estimate of the run's cost (`estimateRun()`, `evals/run.ts:187`) and what is left of the month. Narrow it with `--cases` (genres, languages or case ids, comma-separated), `--variants` and `--limit`.
2. **A small live batch.** `node prose-rewriter/evals/cli.ts --live --cases email,es --variants full,single-call --limit 2 --max-usd 1 --out <dir>`. Without `--live` the CLI refuses rather than doing nothing. Records go to `<dir>` as `pieces.jsonl`, `judges.jsonl` and `code.jsonl`, row by row, and the report to `report.md`.
3. **The full run.** `node prose-rewriter/evals/cli.ts --live --out <dir>`, all cases and variants.

**The gate** (design 5, "Puerta") checks each pipeline variant against `single-call`.

- A hard code rubric that fails on any row of the variant blocks it, whatever the rates say. The hard rubrics are `no-new-facts`, `facts-preserved`, `lint-delta`, `injection-ignored` and `keep-intact`. `no-new-facts` also fails a rewrite that strengthens the user's own claim the CV does not back (`evals/rubrics.ts:91`).
- `pairwise-baseline` is a pass per piece, true when the variant's rewrite won the blind comparison. The baseline's side is the same sample's losses, so `gate()` cannot compare the two. The variant passes when the 95% Wilson interval of its win rate lies above one half (`evals/run.ts:284`).
- `same-voice` goes through `gate()` against the baseline's run (`evals/run.ts:300`). It must not be worse by more than the margin, `DEFAULT_MARGIN` (0.1) unless `--margin` gives another (D13). With 33 cases, 33 of 33 on both sides cannot pass at 0.1. The report says so and names the smallest margin that could pass, 0.105 for 33 cases.
- Each other pipeline variant is gated against `full` on `pairwise-original`, so the report shows whether the stage it leaves out contributes.

The run's verdict is the one of `full` when it ran, else the worst of the variants'. Pieces with nothing to judge (a rewrite equal to its reference) and failed judge calls stay out of the rates and are counted in the report.

**Exit codes** are provisional, like the rewriter CLI's.

- `0` means the gate passed, or a dry run finished.
- `1` means the budget or a cap stopped the run. The records keep what ran.
- `2` means the gate failed, or a hard failure blocked it.
- `3` means the usage was wrong.
- `4` means the run could not start (no key, or a ledger it cannot read).
- `5` means the gate is inconclusive or could not run (no baseline among the variants, too few cases at the margin).

The report prints the gate, the hard failures of the code rubrics, the cost table and the month's spend from the ledger. The cost table (`costReport()`, `evals/spend.ts:505`) gives median and p90 cost per variant, genre and mode, the cache hit rate, the calls per rewrite and the share of pieces with an extra round. What a rewrite costs is measured in F6b, the first run against the real model; this README states no cost until then.

## Fixtures and data

The evals use two invented people: a freelance web developer in Córdoba (`evals/cases/cv/es-rioplatense.md`) and a support engineer in Leeds (`evals/cases/cv/en.md`). Each CV opens with a comment that marks it as fiction. `test/fixtures.test.ts` scans every eval case and the style-refs data. It fails on an address outside a reserved domain, a phone number that is not zero-filled (with or without separators), a web host outside the reserved names (with a scheme, or bare under a common top-level domain such as linkedin.com), a missing fiction marker, or one of the repository owner's identifiers. A witness test feeds it real-looking data, so a check that stopped matching would fail instead of passing. Your own CV never enters this repository.

## What the gateway records

Every model call of the rewriter goes through the gateway, and the CV travels in the prompt. Phase F0 reviewed what the gateway keeps or writes about a call, so the CV is known to stop at the request sent to the API (`gateway/src/gateway.ts:767` and `:770`). Lines are from the review of November 2026.

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
