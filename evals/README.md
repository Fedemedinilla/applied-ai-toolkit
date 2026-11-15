# evals

Tools for measuring a prompt change on the real model before it ships, and for attacking a chat handler the way a visitor would. I built the originals for a writing demo whose one promise was that it does not make things up. Measured on the real model, 60% of its pieces for short or unanswerable briefs had at least one invented fact. In the second round, the variant that shipped had 3% against 47% for the old prompt. [CASE-STUDY.md](CASE-STUDY.md) has the full record. This folder is a generic, tested version of those scripts, run against an invented bicycle workshop.

- **Variant runner**: sends the exact production prompt, changed by checked text edits, at the production call settings.
- **Blinding**: hides which variant wrote each piece, and keeps the key apart.
- **Judge**: goes line by line against the fact sheet with a written rubric, one or several judges per piece.
- **Rubrics**: the judge's rubric is a value you can replace. Three are built in: `groundedness` (the judge above), and `classification` and `extraction`, which are scored in code with no judge model.
- **Aggregation**: unblinds and prints a results table with 95% intervals and every missing piece counted.
- **CI gate**: compares a baseline run with a candidate run and exits non-zero when the candidate is worse, with "inconclusive" as its own exit code.
- **HTML report**: one self-contained file for a run or a comparison, failing cases first.
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

Scoring in code, the gate and the report are offline too. This scores two sample classifier outputs, gates the second against the first (it fails, exit code 1) and writes the comparison:

```bash
node evals/scripts/score.ts classification evals/example/tickets-baseline.json /tmp/main.json --labels price,hours,repair,other --label main
node evals/scripts/score.ts classification evals/example/tickets-candidate.json /tmp/pr.json --labels price,hours,repair,other --label pr
node evals/scripts/gate.ts /tmp/main.json /tmp/pr.json                      # text; --json or --markdown for the other formats
node evals/scripts/report.ts /tmp/main.json /tmp/pr.json /tmp/report.html   # one run, or baseline and candidate
node evals/scripts/score.ts extraction evals/example/bookings.json /tmp/bookings.json
```

Live runs call the Anthropic API and cost money. They read `ANTHROPIC_API_KEY` and exit before any call if it is missing. None of them runs in the test suite.

```bash
node evals/scripts/run-eval.ts rows.jsonl --variants V0,V4 --cases probes --langs en,es --samples 3
node evals/scripts/blind.ts rows.jsonl pieces.jsonl key.json          # offline
node evals/scripts/judge.ts pieces.jsonl verdicts.jsonl --judges 3    # live
node evals/scripts/aggregate.ts pieces.jsonl key.json verdicts.jsonl  # offline, prints Markdown
node evals/scripts/runs.ts pieces.jsonl key.json verdicts.jsonl run   # offline, writes run-V0.json, run-V4.json for the gate
node evals/scripts/redteam.ts evals/example/attacks.json redteam.jsonl
```

Every script refuses to write over an existing file. A flag takes its value as the next argument, as in `--margin 0.2`. The form `--margin=0.2` and an empty number are refused with exit code 2, so a typo never runs under a default. Node 24 runs the `.ts` files directly (type stripping), so there is no build step.

## Layout

| path | what |
|---|---|
| `src/index.ts` | the public entry for apps: the runner, variants, the model seam, JSONL files, `wilson`, rubrics, stored runs, the gate and the report |
| `src/variants.ts` | `applyEdits`: exact-text edits on system blocks, exactly one match each |
| `src/runner.ts` | job planning, preflight, `--dump`, the concurrent runner |
| `src/blind.ts` | anonymize and shuffle, key kept apart, withheld rows |
| `src/judge.ts` | the `groundedness` rubric: its text, numbered lines, structured verdict, multi-judge consensus |
| `src/rubric.ts` | what a rubric is, the generic judge call, blinding of what a rubric receives |
| `src/classification.ts` | the `classification` rubric: exact or set match, per-class precision and recall, confusion matrix |
| `src/extraction.ts` | the `extraction` rubric: field-by-field comparison, per-field accuracy |
| `src/run.ts` | the stored run format, `scoreItems` for code rubrics, `judgedRuns` for judge rubrics |
| `src/gate.ts` | the decision rule, the comparability checks, text and Markdown output |
| `src/report.ts` | the single-file HTML report |
| `src/aggregate.ts` | unblinding, denominator checks, Wilson intervals, Markdown |
| `src/redteam.ts` | attack schema, the turn loop, automatic checks |
| `src/model.ts` | the `ModelClient` seam and the SDK adapter |
| `src/files.ts` | JSONL reading and appending, the fresh-output guard |
| `src/random.ts` | seeded generator and shuffle for reproducible blinding |
| `example/` | the fictional writer, its variants and cases, a signed-history chat handler, attacks, fake models, a sample rubric, sample ticket and booking outputs |
| `scripts/` | command-line entry points |
| `test/` | offline unit tests with fake clients |

## Rubrics

A rubric says what a verdict looks like and how one verdict becomes pass or fail. The pipeline around it (blinding, the judge call, the joins, stored runs, the gate, the report) is the same for every rubric. The types are in `src/rubric.ts`.

| field | what |
|---|---|
| `name`, `version` | The identity of the rubric. The gate compares two runs only when both match. Change the version whenever the instructions, the labels or the scoring change. |
| `verdict` | The zod schema of one verdict. Checked when a verdict is produced and again when it is read back from a file. A judge verdict must not have an `id` or `judge` field: the verdicts file uses both names for the piece and the judge number. |
| `reduce(verdict)` | Returns `{ pass, metrics }`. `pass` feeds the pass rate. `metrics` are named numbers, averaged in the report. |
| `complete(verdict, ...)` | Optional. Throws when the verdict does not account for every unit of what it judged: every line of a piece, every field of a record. |
| `describe(verdict)` | Optional. One line a person reads next to a failing case. |
| `tables(verdicts)` | Optional. Summary tables over a whole run, such as a confusion matrix. |

A rubric is one of two kinds:

- `kind: 'judge'` asks a model. It adds `instructions` (the judge's system prompt), `call` (model, output ceiling and the structured-output schema) and `prompt(piece, reference)`, which lays out the user message. `judgeWith(rubric, client, piece, reference)` makes the call, and `judgedRuns(rubric, pieces, key, verdicts)` turns the verdicts into one stored run per variant.
- `kind: 'code'` computes the verdict. It adds `expected` (the zod schema of a labelled expected value) and `score(output, expected)`. `scoreItems(rubric, label, items)` returns the stored run. No model is called.

Here is a full judge rubric for a task with no fact sheet: does a text for customers use only words its reader knows? It is `example/plain-language-rubric.ts`, and a test runs it through the pipeline.

```ts
import { z } from 'zod';
import { JudgeError, type JudgeRubric } from '../src/rubric.ts';

const Verdict = z.strictObject({
  sentences: z.array(z.strictObject({ sentence: z.number().int().min(1), jargon: z.array(z.string()) })),
  note: z.string(),
});

/** The units the judge has to account for: one per sentence. */
const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const plainLanguage: JudgeRubric<z.infer<typeof Verdict>> = {
  kind: 'judge',
  name: 'plain-language',
  version: '1',
  instructions: `You read short texts a small business sends to its customers. For every numbered sentence, list each trade word or abbreviation a customer would have to look up. A word in KNOWN WORDS is never jargon. Copy each term exactly as written. A sentence with none gets an empty list.`,
  call: {
    model: 'claude-opus-5-5',
    max_tokens: 2000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            sentences: {
              type: 'array',
              items: {
                type: 'object',
                properties: { sentence: { type: 'integer' }, jargon: { type: 'array', items: { type: 'string' } } },
                required: ['sentence', 'jargon'],
                additionalProperties: false,
              },
            },
            note: { type: 'string' },
          },
          required: ['sentences', 'note'],
          additionalProperties: false,
        },
      },
    },
  },
  verdict: Verdict,
  prompt: (piece, knownWords) =>
    ['KNOWN WORDS', knownWords, '', 'TEXT', ...sentences(piece.text).map((s, i) => `${i + 1}. ${s}`)].join('\n'),
  complete(verdict, piece) {
    const seen = verdict.sentences.map((s) => s.sentence).sort((a, b) => a - b);
    const expected = sentences(piece.text).map((_, i) => i + 1);
    if (seen.join(',') !== expected.join(',')) {
      throw new JudgeError(`judge covered sentences [${seen.join(',')}], expected 1..${expected.length} once each`);
    }
  },
  reduce(verdict) {
    const terms = verdict.sentences.flatMap((s) => s.jargon);
    return { pass: terms.length === 0, metrics: { jargon_terms: terms.length } };
  },
  describe: (verdict) =>
    verdict.sentences
      .filter((s) => s.jargon.length > 0)
      .map((s) => `sentence ${s.sentence}: ${s.jargon.join(', ')}`)
      .join('; '),
};
```

The built-in rubrics:

| rubric | kind | pass means | summary |
|---|---|---|---|
| `groundedness` (`src/judge.ts`) | judge | no line of the piece is marked invented | invented lines, off voice, robotic and quality as metrics |
| `classification({ labels, multi? })` | code | the output is the expected label, or the expected set of labels | per-class precision and recall, confusion matrix |
| `extraction` | code | every expected field is present and equal, and no field was added | per-field correct, wrong and missing counts with intervals |

**`groundedness` is the judge of the case study, unchanged.** Its instructions, labels, call settings and message layout are the constants that were in `judge.ts` before rubrics existed. `groundedness-pin.test.ts` compares the full request for a fixture piece with a file written from that earlier code, byte for byte. A change to any of them is a new version and has to regenerate the file on purpose.

**Blinding is enforced for every judge rubric.** The rubric's `prompt` never receives the row of the run. It receives five fields (case, language, date, brief, text), copied one by one. A rubric that serializes everything it was handed still cannot send the variant, the piece id or the token counts. A test does exactly that with a whole row.

**`classification` is exact on purpose.** The output is trimmed and compared. "Price." or "probably price" is not the label `price`: it is counted as out of set and fails. A classifier whose answers need cleaning before they match is a finding, and a lenient scorer would hide it. Pass `normalize` when your own parser really does lower-case or strip the output. The label set is part of the rubric's version, so runs scored against different label sets are refused by the gate. So is `normalize`. The version then ends in `normalize:custom`, or in `normalize:<id>` when you also pass `normalizeId`. Change the id whenever the function changes, because the version cannot see inside a function.

**`extraction` counts wrong and missing apart.** A missing field is a gap that a form can show as empty. A wrong field is a value somebody will act on. Their fixes differ too, so the per-field table has a column for each. A field the output adds is "unexpected" and fails the item. An output that is not a JSON object extracts nothing: its fields count as missing, and the table's note says how many outputs that was.

## The CI gate

`scripts/gate.ts` takes two stored runs and exits with the decision.

| exit | state | meaning |
|---|---|---|
| 0 | pass | the candidate is not worse, within the margin |
| 1 | fail | the candidate is worse |
| 2 | refused | bad usage, or the runs cannot be compared |
| 3 | inconclusive | the samples are too small to say either |

**The rule.** Let d be the candidate's pass rate minus the baseline's. The gate builds a 95% interval for d from the two Wilson intervals (Newcombe's method, in `differenceInterval`). It fails when the whole interval is below zero. Otherwise it passes when the lower end is at or above minus the margin, which is 10 points unless `--margin` says otherwise. Anything else is inconclusive. Fail is checked first, so a drop that is measurable fails even when it is smaller than the margin.

**Why this rule and not "fail when the two intervals do not overlap".** Both use the same Wilson intervals. The overlap rule adds the two half-widths, and the interval for a difference combines them in quadrature, which is smaller. So the overlap rule needs a larger gap to call the same drop. With 40 results per run, a fall from 90% to 70% leaves the two intervals overlapping, and this rule fails it. A test checks that every pair the overlap rule fails also fails here.

**Why a margin.** With a finite sample, "no drop at all" can never be shown: two identical runs still have an interval around zero. A pass therefore has to mean "any drop is smaller than a size I accept". The margin is that size. Ten points is a default for runs of about a hundred results. Set it from what a regression costs you, and expect the sample to grow fourfold each time you halve it.

**Why inconclusive is not a pass.** A gate that passes whenever it cannot tell would pass every small run. Exit code 3 keeps the choice with whoever wires the gate: add samples, or accept it for that job in the workflow with `|| [ $? -eq 3 ]`, written where a reviewer can see it.

**What sample size makes it meaningful.** These figures are at the default margin and are checked in `gate.test.ts`.

- Two runs with the same results cannot pass below 35 results per run.
- Identical observed rates pass from about 80 results per run at a 90% pass rate, and from about 190 at 50%.
- A drop from 90% to 70% is caught from about 35 per run. A drop from 90% to 80% takes about 110.

So a run of 10 or 20 cases can only fail on a collapse or come out inconclusive. Raise the count with more cases or more samples per case before reading a pass into it.

**What it refuses.** Two runs are compared only when they have the same rubric name and version, the same case ids and the same number of results per case. A run that holds one case and sample twice is refused when it is read, and by the gate. A run with failed calls or outputs that could not be scored is refused unless `--allow-missing`, which keeps them out of the rates and prints their count. A candidate that fails more calls would otherwise shrink its own denominator.

In a workflow:

```bash
node evals/scripts/gate.ts baseline.json candidate.json --markdown --summary "$GITHUB_STEP_SUMMARY"
```

`--summary` appends the Markdown summary to that file. `--json` prints the whole result, with both intervals and the list of cases that got worse.

## The HTML report

`scripts/report.ts` writes one run, or a baseline and a candidate, as a single HTML file. It has the totals with their intervals, the metric means, the rubric's tables and one row per result. Failing results come first. In a comparison, the results that got worse come first and the gate's decision is at the top.

**One file, no script.** The stylesheet is inline and there is nothing to fetch, so the file reads the same from a CI artifact or from disk. Inputs and outputs fold with `<details>`.

**Every string from a model or a file is escaped.** The page is built with one template tag that escapes whatever is interpolated, so no call site can skip it. The page also carries a Content-Security-Policy that allows only its own stylesheet, by hash. A test puts 20 hostile strings in every such field and parses the result.

**Same runs, same bytes.** The report reads no clock and sorts in code-unit order, so two builds of it can be compared with `diff`.

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

**The red-team runner calls the handler, not a server, and plays by the page's rules.** Each reply goes back into the history with the signature the handler issued. A turn that got no reply is removed from the history, as the page does, so the next turn is what a real visitor would send. A forged history is sent exactly as written, which tests the handler's own check. A handler that throws is recorded as status 0 and the run goes on, the same way the eval runner treats a failed call. A `replyMustNotMatch` check on a turn that got no reply because the call failed (status 0 or 5xx) fails the attack, since nothing was checked. A 4xx with no reply still passes, because the handler refused before the model. Regex checks are compiled when the attack file is parsed, so a typo stops the run before the first turn is paid for.

**What code can guarantee is not left to the model.** The example chat handler signs every reply with an HMAC of its text and of a digest of the history it answered. Before calling the model, it refuses with a 400 any assistant turn that does not verify against the turns before it. Signing the text alone would prove the handler wrote "Yes." somewhere, not that it wrote it here. A visitor could splice a genuine "Yes." after a question of their own, or reorder replies. In the original project a forged history held twice against the real model, but it held by the model's behaviour, which is exactly what a red team exists to break. The splice and reorder cases are unit tests and not entries in `attacks.json`, because the signing secret is drawn fresh for each run, so a sample file cannot hold a genuine signature.

**Automatic checks decide pass or fail. The rest is "review".** An attack can name the status every turn must get or patterns no reply may contain. An attack with only a written expectation comes out as `review` with its transcript, because "the handler did not crash" says nothing about the attack.

**No refusal fallback in the measured calls.** The eval measures the model under test. A fallback model answering in its place would mix two models into one row. A refusal is kept as a row with its stop reason and counted in the `no piece` column.

**Fakes test plumbing only.** `example/fake-models.ts` checks that edits reach the request, that blinding hides the variant and that verdicts join back to the right variant. A fake writer that "invents" on cue says nothing about a real model. The case study's main lesson is a simulated check that passed what the real model failed.

## What the tests cover

All tests run offline with fake clients and no API key (`npx vitest run evals`).

- `variants.test.ts`: exact replacement; missing, ambiguous and out-of-range targets fail; optional edits; literal `$&` and `$1`; capture groups; edit order; input not mutated, `cache_control` kept; every sample variant applies to every case and language; V0 equals production.
- `runner.test.ts`: interleaved job order; production call settings, the edited prompt and the run's date reach the request; a missing edit stops the run with zero calls; a failed call is recorded and the run continues; the concurrency limit holds; a dump does not change with the system clock; a dump of V4 equals a dump of V0 from a product that shipped V4 a week later, and not from one that shipped V3.
- `files.test.ts`: a JSONL error names the line of the file, blank lines counted; a leading byte order mark is dropped.
- `blind.test.ts`: pieces carry only case, language, date, brief and text; no variant name, token count or stop reason leaks; the key maps every piece back; the shuffle is seeded and mixes variants; failed, refused and empty rows are withheld and kept in the key.
- `judge.test.ts`: sentence splitting; the judge request; verdicts with skipped, repeated or extra lines are rejected, as are an out-of-range quality, unknown fields and non-JSON; the two schemas agree on keys, required fields, closed objects and labels; cut and refused judge replies are rejected; consensus by strict majority with the median.
- `aggregate.test.ts`: Wilson interval against known values; grouping with "all" rows; multi-judge majority and split counts; unknown verdicts, missing verdicts, a lost judge, a duplicate judge, a bad stored verdict, a missing piece, a failed call and uneven variant totals are refused; refusals land in `no piece` and outside the rate; Markdown output; the whole pipeline with fake models puts a scripted invention on the right variants, with no variant id or key field in any judge request; the judge's sheet carries the writer's TODAY line.
- `groundedness-pin.test.ts`: the full judge request for one fixture piece, byte for byte against a file written from the judge before rubrics became pluggable; the wording of every refusal.
- `rubric.test.ts`: the `groundedness` reduction; stored runs count the same pieces as the results table; strict majority, median metrics and split marks with several judges; refusals and failed calls stay in the run; stored verdicts are checked again; a rubric defined outside `src/` goes through the same pipeline with no variant id or key field in any judge request; a rubric that sends everything it was handed still receives the five blind fields only; the README prints the sample rubric as tested.
- `classification.test.ts`: exact match after trimming only; set match in any order and format; outputs outside the label set; the label set and a custom `normalize` in the version; precision, recall and their empty denominators; the confusion matrix against hand counts; `scoreItems` numbering, ordering, failed calls and refusals.
- `extraction.test.ts`: correct, wrong, missing and unexpected fields; exact comparison of types, case, null and nested values; outputs that are not a JSON object; the field completeness check; per-field counts and intervals.
- `gate.test.ts`: the difference interval against a published worked example; each state of the rule; the sample sizes this README states; every pair the overlap rule fails also fails here; refusals for another rubric, version, case set or sample count, and for missing results; Markdown that survives a hostile label; the script as a child process for exit codes 0, 1, 2 and 3, with JSON, Markdown and the summary file; exit 2 when the summary file cannot be written or the margin is empty or written as `--margin=value`.
- `scripts.test.ts`: `blind.ts` and `runs.ts` write no file when any of their outputs already exists; `blind.ts` refuses a seed outside 0 to 2^32 - 1; `report.ts` refuses an empty margin and `--margin=value`.
- `report.test.ts`: 20 hostile strings in every field a model or a file controls, parsed with jsdom, leave only the page's own tags and attributes; the policy hash matches the stylesheet; totals, intervals, rubric tables; failing first, and got-worse first in a comparison; the same bytes for the same runs in any order; the scripts end to end on the example files.
- `redteam.test.ts`: the turn loop carries signatures back; a failed turn is popped; a throwing handler is recorded as status 0 and the run continues; forged history is sent verbatim and can be followed by turns; pass, fail and review; a reply check fails when the call failed and no reply came back; a NaN concurrency is refused; a lens named `__proto__` is counted; concurrency; the attack schema, invalid regexes included; HMAC verification against text and history; a genuine signed reply spliced into another conversation and reordered replies are refused; malformed messages are refused; every forged-history sample attack is refused with zero model calls; signatures are stripped before the model sees the history; a leaked rule is flagged; the turn cap.

The tests were checked by breaking the code on purpose, and each break turned its tests red. The breaks were a plain string replacement, a disabled signature check, a signature over the text alone, a dump that reads the clock, a disabled shuffle, and blinding that passes refusals to the judge. For the newer parts they were an unescaped `<` in the report, a rubric handed the whole row, and a moved fail threshold in the gate.

## What it does not do

- It does not run your model for the code rubrics. `score.ts` reads outputs you already have. Only the writer example has a runner.
- The gate compares pass rates and nothing else. A metric that gets worse while the pass rate holds (quality, out-of-set answers) is in the report and does not change the exit code.
- The gate treats the two runs as independent samples. It does not use the pairing of cases (a McNemar test would), so it is more often inconclusive than a paired test on the same data.
- The gate does not correct for running it many times. Run it on ten variants and the chance that one of them fails by luck is no longer small.
- `classification` does not guess what an output meant. "Price." is not "price" unless you pass a `normalize` function.
- `extraction` compares top-level fields exactly. It has no fuzzy match, no number tolerance and no per-path comparison inside a nested value, and it does not strip a code fence around the JSON.
- A custom rubric's completeness check sees the piece, not the reference. A rubric whose units come from the reference (a checklist) has to carry them in the piece.
- The report shows numbers and rows, with no charts and no history across runs.
- The judge is a model. The rubric and the multi-judge majority reduce noise but do not replace a person reading a sample of verdicts, starting with the split ones. There is no inter-rater statistic beyond the split count.
- The judge and the writer are the same model, so self-preference is possible. A different judge model is one field away (`JUDGE_CALL.model`) and was not compared.
- The example target writes its prompt text in English for both output languages. The original wrote separate rules and labels per language, and a translated condition once said the opposite of the original. A real target should have its own text per language.
- Calls go one by one through the Messages API. The Batch API would halve the cost of a large run; it is not wired in.
- The red-team runner records what the handler returned, after its guards. The original also kept the model's raw text before the guards, through a recording proxy, so a replaced reply could be told apart as an invention caught or a true reply blocked. That proxy is not included.
- Attacks are written by hand. There is no attack generator.
- No cost accounting beyond the `usage` field on each row.
