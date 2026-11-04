# evals

Tools for measuring a prompt change on the real model before it ships, and for attacking a chat handler the way a visitor would. I built the originals for a writing demo whose one promise was that it does not make things up. Measured on the real model, 60% of its pieces for short or unanswerable briefs had at least one invented fact. In the second round, the variant that shipped had 3% against 47% for the old prompt. [CASE-STUDY.md](CASE-STUDY.md) has the full record. This folder is a generic, tested version of those scripts, run against an invented bicycle workshop.

- **Variant runner**: sends the exact production prompt, changed by checked text edits, at the production call settings.
- **Blinding**: hides which variant wrote each piece, and keeps the key apart.
- **Judge**: goes line by line against the fact sheet with a written rubric, one or several judges per piece.
- **Aggregation**: unblinds and prints a results table with 95% intervals and every missing piece counted.
- **Red-team runner**: replays multi-turn and forged-history conversations against a chat handler.

Everything in `example/` is fictional: the workshop, its fact sheet, the sample cases and the attacks.

## Run it

Offline, no key, from the repository root:

```bash
npm test                                   # all folders; evals tests are evals/test/*.test.ts
npx vitest run evals                       # only this folder
npm run check                              # tsc --noEmit, strict
node evals/scripts/demo-offline.ts         # whole pipeline with scripted fake models
node evals/scripts/run-eval.ts /tmp/v4-prompts.json --variants V4 --cases all --dump   # the prompts a run would send
```

Live runs call the Anthropic API and cost money. They read `ANTHROPIC_API_KEY` and exit before any call if it is missing. None of them runs in the test suite.

```bash
node evals/scripts/run-eval.ts rows.jsonl --variants V0,V4 --cases probes --langs en,es --samples 3
node evals/scripts/blind.ts rows.jsonl pieces.jsonl key.json          # offline
node evals/scripts/judge.ts pieces.jsonl verdicts.jsonl --judges 3    # live
node evals/scripts/aggregate.ts pieces.jsonl key.json verdicts.jsonl  # offline, prints Markdown
node evals/scripts/redteam.ts evals/example/attacks.json redteam.jsonl
```

Every script refuses to write over an existing file. Node 24 runs the `.ts` files directly (type stripping), so there is no build step.

## Layout

| path | what |
|---|---|
| `src/index.ts` | the public entry for apps: the runner, variants, the model seam, JSONL files and `wilson` |
| `src/variants.ts` | `applyEdits`: exact-text edits on system blocks, exactly one match each |
| `src/runner.ts` | job planning, preflight, `--dump`, the concurrent runner |
| `src/blind.ts` | anonymize and shuffle, key kept apart, withheld rows |
| `src/judge.ts` | rubric, numbered lines, structured verdict, multi-judge consensus |
| `src/aggregate.ts` | unblinding, denominator checks, Wilson intervals, Markdown |
| `src/redteam.ts` | attack schema, the turn loop, automatic checks |
| `src/model.ts` | the `ModelClient` seam and the SDK adapter |
| `src/files.ts` | JSONL reading and appending, the fresh-output guard |
| `src/random.ts` | seeded generator and shuffle for reproducible blinding |
| `example/` | the fictional writer, its variants and cases, a signed-history chat handler, attacks, fake models |
| `scripts/` | command-line entry points |
| `test/` | offline unit tests with fake clients |

## Design decisions

**A variant is a list of edits on the production prompt, not a copy of it.** The target exports the function that builds its system blocks, and the runner calls it. V0 is therefore the production prompt by construction, and a variant differs from it only where its edits say. A copied prompt drifts from the product within days, and then the comparison is of something else.

**Every edit must match exactly once, and the run stops otherwise.** An edit that matches nothing would test the baseline under the variant's name. One that matches twice changes more than the variant claims. `preflight` builds every job's prompt before the first paid call, so a stale variant costs nothing. When a winning variant ships, its edits stop matching, so the next run that includes it fails, and so does the test that applies every sample variant. That is the reminder to delete it.

**String replacements are inserted literally.** `String.prototype.replace` reads `$&` and `$1` in a replacement string as patterns, so new prompt text that quotes a price like "$1,200" would be mangled without an error. Only a `RegExp` find gets group substitution, because only there was it asked for.

**The call settings are imported from the target, not restated.** `WRITER_CALL` is the object the product spreads into its own request. A hand copy in the eval kept measuring the old model or effort after the product moved, and nothing flagged it.

**The date is an argument, never a clock read inside the target.** The writer's prompt ends with a TODAY line, so "next Thursday" can become a date. A run reads the clock once and builds every prompt with that date, so a run that crosses midnight still asks every variant the same question. The date is stored on each row and travels with each blind piece. It is one value for the whole run, so it tells the judge nothing about the variant.

**The judge reads the date the writer read.** The rubric marks a date invented unless it is in the sheet or the brief. Without the TODAY line in the judge's sheet, a writer that correctly turned "next Thursday" into a date would be marked as inventing it, on every variant. Two of the sample cases ask for exactly that.

**`--dump` closes the loop.** It writes the prompts a run would send, keyed by language and case but not by variant. Dump the winning variant before changing the product and V0 after it. The files must be identical, or what shipped is not what was measured. Every dump renders the date block at one fixed date (`DUMP_NOW`), so the two dumps compare equal even when they are made days apart. `dumpPrompts` refuses to mix two variants with different prompts in one file.

**Jobs run sample-major, variant-minor.** A run stopped halfway has every variant equally covered for the samples it finished. Rows are appended as they arrive, and an existing output file is refused, so a cut run keeps what it paid for and two runs never mix in one file.

**Blinding hides the variant name and the metadata around the text.** The judge gets case, language, the run's date, brief and text. Word count, token usage, latency, sample number and stop reason go to the key, because a variant that removes a word floor spends fewer tokens, and any of those fields would identify it. Ids are drawn from a seeded generator, the seed is stored with the key, and the order is shuffled across variants. The text itself still carries its length and phrasing, so the judge is blind to the variant name, not to its effect.

**Variants change rules, never facts.** The judge reads one fact sheet per case, the one the target exports. If a variant could edit the facts, the judge would need a different sheet per variant and would learn which one it is reading. A fixture fix goes into the target and applies to every variant. In the case study, one brief went from 6 of 6 invented to 2 of 6 by fixing the fixture alone.

**Line by line is enforced in code.** The piece is split into numbered sentences before the judge sees it, and a verdict that does not account for every line exactly once is rejected. Asked about a whole piece, a judge skims. Asked whether line 3 is in the sheet, it has to look. The rubric names the inventions that slipped through before: plausible procedures, and a yes or no about something the sheet never mentions.

**The verdict shape is checked three times.** The API's structured output constrains the reply to a JSON schema, and zod validates it after parsing. Aggregation validates each stored verdict again, line coverage included, because the verdicts file is the last thing between the judge and the table. The JSON schema is written by hand because structured output does not accept numeric bounds (`quality` is an enum there and a bounded integer in zod). A test checks that the two agree on keys, required fields, closed objects and labels.

**Several judges, strict majority, splits reported.** `--judges 3` asks for independent verdicts. A piece counts as invented when most judges found an invented line, quality is the median, and pieces where the judges split are counted in their own column. Those are the pieces a person should read first.

**Every rate carries a 95% Wilson interval.** In the case study, 0 errors in 14 was read as "fixed", and a larger sample later gave 3 in 10. On this table, 0 of 14 reads as 0% to 22%: an error rate of one in five is still inside it.

**Nothing leaves a denominator without a trace.** A dropped piece changes one variant's denominator and not the others', and the drops are not random. A variant that writes longer pieces times out more, and one that refuses more would look cleaner. So:

- A failed call is written to the rows file with an `error` field. Blinding keeps it in the key, and aggregation stops on it unless `--allow-missing`, which counts it in a `failed` column.
- A refusal or an empty reply has nothing to judge. It never reaches the judge, and it is counted in a `no piece` column, outside the invention rate. Judged as a zero-line piece, it would have passed as a clean one.
- A piece with no verdict, or with fewer judges than the rest, stops aggregation. With three judges, a piece that lost one would otherwise be held to a two-judge majority. Two verdicts from the same judge number stop it too.
- Variants with different row counts (a cut run, two files mixed) stop aggregation unless `--allow-missing`.

**The red-team runner calls the handler, not a server, and plays by the page's rules.** Each reply goes back into the history with the signature the handler issued. A turn that got no reply is removed from the history, as the page does, so the next turn is what a real visitor would send. A forged history is sent exactly as written, which tests the handler's own check. A handler that throws is recorded as status 0 and the run goes on, the same way the eval runner treats a failed call. Regex checks are compiled when the attack file is parsed, so a typo stops the run before the first turn is paid for.

**What code can guarantee is not left to the model.** The example chat handler signs every reply with an HMAC of its text and of a digest of the history it answered. Before calling the model, it refuses with a 400 any assistant turn that does not verify against the turns before it. Signing the text alone would prove the handler wrote "Yes." somewhere, not that it wrote it here. A visitor could splice a genuine "Yes." after a question of their own, or reorder replies. In the original project a forged history held twice against the real model, but it held by the model's behaviour, which is exactly what a red team exists to break. The splice and reorder cases are unit tests and not entries in `attacks.json`, because the signing secret is drawn fresh for each run, so a sample file cannot hold a genuine signature.

**Automatic checks decide pass or fail. The rest is "review".** An attack can name the status every turn must get or patterns no reply may contain. An attack with only a written expectation comes out as `review` with its transcript, because "the handler did not crash" says nothing about the attack.

**No refusal fallback in the measured calls.** The eval measures the model under test. A fallback model answering in its place would mix two models into one row. A refusal is kept as a row with its stop reason and counted in the `no piece` column.

**Fakes test plumbing only.** `example/fake-models.ts` checks that edits reach the request, that blinding hides the variant and that verdicts join back to the right variant. A fake writer that "invents" on cue says nothing about a real model. The case study's main lesson is a simulated check that passed what the real model failed.

## What the tests cover

All tests run offline with fake clients and no API key (`npx vitest run evals`).

- `variants.test.ts`: exact replacement; missing, ambiguous and out-of-range targets fail; optional edits; literal `$&` and `$1`; capture groups; edit order; input not mutated, `cache_control` kept; every sample variant applies to every case and language; V0 equals production.
- `runner.test.ts`: interleaved job order; production call settings, the edited prompt and the run's date reach the request; a missing edit stops the run with zero calls; a failed call is recorded and the run continues; the concurrency limit holds; a dump does not change with the system clock; a dump of V4 equals a dump of V0 from a product that shipped V4 a week later, and not from one that shipped V3.
- `blind.test.ts`: pieces carry only case, language, date, brief and text; no variant name, token count or stop reason leaks; the key maps every piece back; the shuffle is seeded and mixes variants; failed, refused and empty rows are withheld and kept in the key.
- `judge.test.ts`: sentence splitting; the judge request; verdicts with skipped, repeated or extra lines are rejected, as are an out-of-range quality, unknown fields and non-JSON; the two schemas agree on keys, required fields, closed objects and labels; cut and refused judge replies are rejected; consensus by strict majority with the median.
- `aggregate.test.ts`: Wilson interval against known values; grouping with "all" rows; multi-judge majority and split counts; unknown verdicts, missing verdicts, a lost judge, a duplicate judge, a bad stored verdict, a missing piece, a failed call and uneven variant totals are refused; refusals land in `no piece` and outside the rate; Markdown output; the whole pipeline with fake models puts a scripted invention on the right variants, with no variant id or key field in any judge request; the judge's sheet carries the writer's TODAY line.
- `redteam.test.ts`: the turn loop carries signatures back; a failed turn is popped; a throwing handler is recorded as status 0 and the run continues; forged history is sent verbatim and can be followed by turns; pass, fail and review; concurrency; the attack schema, invalid regexes included; HMAC verification against text and history; a genuine signed reply spliced into another conversation and reordered replies are refused; malformed messages are refused; every forged-history sample attack is refused with zero model calls; signatures are stripped before the model sees the history; a leaked rule is flagged; the turn cap.

The tests were checked by breaking the code on purpose, and each break turned its tests red. The breaks were a plain string replacement, a disabled signature check, a signature over the text alone, a dump that reads the clock, a disabled shuffle, and blinding that passes refusals to the judge.

## Limits and what is not included

- The judge is a model. The rubric and the multi-judge majority reduce noise but do not replace a person reading a sample of verdicts, starting with the split ones. There is no inter-rater statistic beyond the split count.
- The judge and the writer are the same model, so self-preference is possible. A different judge model is one field away (`JUDGE_CALL.model`) and was not compared.
- The example target writes its prompt text in English for both output languages. The original wrote separate rules and labels per language, and a translated condition once said the opposite of the original. A real target should have its own text per language.
- Calls go one by one through the Messages API. The Batch API would halve the cost of a large run; it is not wired in.
- The red-team runner records what the handler returned, after its guards. The original also kept the model's raw text before the guards, through a recording proxy, so a replaced reply could be told apart as an invention caught or a true reply blocked. That proxy is not included.
- Attacks are written by hand. There is no attack generator.
- No cost accounting beyond the `usage` field on each row.
