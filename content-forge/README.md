# content-forge

content-forge has Claude write entries for a fictional collectible card game's catalogue and keeps every one out until it passes the same zod schemas and cross-reference checks as the hand-written content. The share of requested candidates that pass is the metric for each prompt version. The pattern comes from a content pipeline I designed for another project; the domain, the schemas and the example content here are new.

`generate --entity card --count 8` asks the model, through [`gateway`](../gateway/), for eight candidates with the card schema as structured output. It judges each candidate on its own (schema, range rules, references against the catalogue), writes the accepted ones to `_candidates/` for review, and saves a report with every rejection and its reasons. `promote` moves reviewed candidates into the catalogue after checking them again, and refuses to overwrite any file marked hand-written.

The catalogue has five entity types, one JSON file per entity: keywords (printed game terms), factions, sets, cards (units, spells and relics) and starter decks. Cards reference a set, a faction and keywords; spells can summon token cards; decks reference cards; factions name a rival that must name them back.

## Run it

Offline, no key, from the repository root:

```sh
npm ci
npx vitest run content-forge                 # 75 tests, fake Anthropic API, no key
npm run check                                # tsc --noEmit, strict
node content-forge/cli.ts validate           # the example catalogue in content-forge/catalog/
node content-forge/cli.ts stats              # pass rate per entity type and prompt version
```

Generating needs a key and calls the real API. It is never part of the test suite. Without the key, `generate` exits 3 before any call:

```sh
ANTHROPIC_API_KEY=sk-ant-... node content-forge/cli.ts generate --entity card --count 8 --brief "cards for the grove faction"
node content-forge/cli.ts promote --entity card --all          # or a list of ids
node content-forge/cli.ts promote --entity card quick-study --replace
```

Every command takes `--dir` for another catalogue. The exit code is 0 when the command did its job. It is 1 when the catalogue or a promote has problems, when a run accepted nothing or could not write a candidate, and on an unexpected error, which prints one line with its code. It is 2 for bad usage, and 3 when the model could not be called (no key, a cap, the network, an API error).

This is the CLI's output for the test fixture `test/fixtures/responses/card-batch.json`, served by the fake API. The fixture was written by hand to fail in specific ways; it is not a real model response, and the cost is the fake's token counts at the listed price. Candidates are numbered from 1 in the order the model returned them. A test compares this block with the CLI's output line by line.

```text
card card@1: 2 of 8 accepted (25%), 7 returned
  1 requested candidate was not returned and counts as a failure
  accepted brine-scout
  accepted moss-lantern
  rejected storm-colossus
    [schema] candidate 2 (storm-colossus): cost: Too big: expected number to be <=10
    [schema] candidate 2 (storm-colossus): Unrecognized key: "flavor"
  rejected ember-tyrant
    [rules no-legendary] candidate 3 (ember-tyrant): is legendary
    [rules cost-curve] candidate 3 (ember-tyrant): spends 7 and its budget at cost 1 is 3
  rejected moon-oracle
    [references] candidate 4 (moon-oracle): set: unknown set "moonfall"
    [references] candidate 4 (moon-oracle): keywords.0.keyword: unknown keyword "frenzy"
    [references] candidate 4 (moon-oracle): keywords.1.value: keyword "echo" takes a value
  rejected scout-call
    [references] candidate 5 (scout-call): body.effects.0.card: summons "brine-scout", which is not a token unit
  rejected second-flare
    [references] candidate 6 (second-flare): name: card "flare" already has the name "FLARE"
  model claude-sonnet-5-5, cost US$0.031000, report 2026-11-04T15-00-00-000Z-card.json
```

## The schema is the contract

The model and the product meet at one definition. [`src/schemas.ts`](src/schemas.ts) declares each entity with zod, and every other part reads it from there:

- the TypeScript types come from `z.infer`, with no parallel interfaces;
- the JSON schema sent to the API as the output format is `z.toJSONSchema` of the same object, so the enums, required fields and nested unions the model is held to are the ones the code parses;
- the gateway moves the ranges and lengths the API does not accept into field descriptions, so the model reads "maximum 10" from the same `z.int().max(10)` the validator enforces;
- the validator, the generator and `promote` all parse with it, and `generate` and `promote` both apply the range rules.

A prompt that says "cost 0 to 10" while the validator allows 12, or a field the model is told about that the code drops, cannot happen. The range rules for generated content are the one part a schema cannot express. They follow the same idea. Each rule in [`src/rules.ts`](src/rules.ts) carries the sentence the prompt shows the model, and the prompt lists `RULES` directly. A test checks that every rule's text is in its entity's prompt.

## What is measured

Each run writes `_candidates/reports/<run>.json`, validated with zod when it is written and again when `stats` reads it back. The report has the prompt version, the model that answered, the cost, the gateway's ledger row id and the accepted ids. For every rejected candidate it lists each problem with its stage (`schema`, `rules`, `references`), path, message and rule id.

- **Pass rate = accepted / requested.** A candidate the model did not return counts as a failure, and so does every candidate of a response that could not be used at all (cut by `max_tokens`, a refusal, not JSON). Dividing by what came back would let a prompt that returns two careful candidates out of eight score 100%.
- **Infrastructure failures are not prompt failures.** On a reached cap, a 529 or a dropped connection, generate throws, exits 3 and writes no report, because none of them says anything about the prompt.
- **Versions never pool.** `PROMPT_VERSIONS` in [`src/prompt.ts`](src/prompt.ts) is bumped with any change to an entity's instructions, rules or schema. `stats` groups by entity and version, so a rate never mixes runs from before and after a change.
- **Small counts get an interval.** `stats` prints a 95% Wilson interval next to each rate. One run of eight with two accepted reads "25% (95% CI 7% to 59%)", which is the honest size of what one run shows.
- **Where candidates fail.** `stats` counts rejected candidates by stage and by rule id, so a prompt change aimed at the cost curve can be checked against `cost-curve` alone.

## Design decisions

**Each candidate gets its own verdict.** Suppose the entity schema also ran on the zod side of the output schema. The gateway would validate the whole response as one value, and one out-of-range number would fail the call with `invalid_output`. No candidate would be kept, and the report could not say which ones were good. A test sends the fixture batch through the gateway that way and gets `invalid_output`. `batchSchema` instead makes each element `z.unknown().meta(<the entity's JSON schema>)`. The API still receives the full entity schema for every element and constrains its shape, the gateway checks only the envelope, and generate parses each candidate with the entity schema itself.

**Never the first problem only.** The validator never stops at the first problem. A candidate that fails the schema is reported with every zod issue, and stops there, because rules and references need a parsed value. One that passes is checked against all range rules and all references, and every failure is recorded. A rejected candidate shows all of the faults its failing stage can see, so a prompt fix is not chasing them one run at a time.

**Strict objects at every level.** `z.strictObject` everywhere, so an extra key is an error, not a silently dropped field. Structured output should keep extra keys out of model responses already; strictness is what holds for hand-written files and for any response that is not constrained. The fixture's `flavor` field shows the message a reviewer gets.

**Nested defaults with prefault.** `limits` is `strictObject({ maxCopies: default 3, banned: default false }).prefault({})`. With `.default({})`, zod 4 returns `{}` without parsing it, so a card that left out `limits` would get no `maxCopies` even though its type says the field is there. `.prefault({})` parses the `{}`, so the inner defaults apply. A test shows both. Candidates and promoted entries are written as parsed, so each file on disk spells out the values the code uses.

**Cross-references checked from both sides.** A faction's rival must name it back, and the check runs from each faction, so a one-sided rivalry is reported where it was claimed. A spell's summon must target a token, and a token no card summons is reported too, since it could never enter play. Decks check copies against each card's limit, faction membership, tokens and banned cards; sets check their size, code and release order.

**The catalogue must be valid before a run.** generate refuses to call the model when the catalogue has a single problem, and prints them all. That makes the references stage attributable. Any problem in "catalogue plus accepted candidates plus this one" is caused by this candidate, even when it is reported on another entity, such as a set pushed past its size.

**Candidates are checked against the ones accepted before them.** Two candidates in one batch can be fine alone and conflict together, with the same id or name, or by filling one set between them. Each candidate is merged with the catalogue and the candidates accepted so far. In the fixture, `scout-call` summons `brine-scout`, accepted a moment earlier, and is rejected because `brine-scout` is not a token.

**Range rules only bind generated content.** The schemas say what any entry may be. The rules add limits for a generated one, at generate time and again at promote time. A card stays on the cost curve (budget 2 x cost + 1), is not legendary and has at most two keywords. A faction names no rival, since that would need an edit to another file. A new set is released after the last one, and no candidate says `handwritten: true`. A hand-written legendary such as The Drowned Queen is valid in the catalogue and would be rejected from the model; a test checks both.

**promote checks everything before it moves anything.** The catalogue may have changed since the run, and a file in `_candidates/` may have been edited or dropped there by hand. So promote runs the whole validator over the catalogue as it would be after the move. It also runs the range rules over each candidate, except "id not pending" and "not hand-written", which promote reports itself. A single problem moves no file. The checks are all or nothing; the writes are not a transaction. If a target changes between the check and the write, promote stops, names the file, and says how many were already moved.

**The hand-written guard.** A target with `handwritten: true` is never replaced, with or without `--replace`. A target that cannot be read as JSON is treated as hand-written. Only `handwritten: true` protects a file. The field defaults to false, so a hand-written file without it counts as generated and `--replace` can overwrite it. A generated target is replaced only with `--replace`, and is checked again right before the write. A new file is written to a temporary name and hard-linked into place. The link fails with `EEXIST` if anything appeared there since the check, so a new file never lands on top of another. Temporary names start with a dot, which the loader skips, so a file left by a crash does not make the catalogue invalid.

**A paid call always leaves a report.** generate refuses before the call when a pending file is not JSON or is named after another id, since either would hide an id from the pending check. If a candidate still cannot be written after the call (a file appeared at its path meanwhile), the report records it under `unwritten` with the error code, the command exits 1, and the cost stays counted.

**Spending goes through the gateway.** [`src/model.ts`](src/model.ts) is the only file that imports the gateway, through its public entry. It sets `claude-sonnet-5-5` at medium effort, `max_tokens` 16,000 (the gateway's limit without streaming) and a US$1 cap per process. The gateway reserves each call's worst case first: for the card request in the tests (7,728 estimated input tokens) that is about US$0.18. The key is read only in [`cli.ts`](cli.ts) and passed in. Failures print the gateway's error code, never the model's text or the API's message.

**The brief is data.** `--brief` is limited to 400 characters, goes inside `<brief>` tags with angle brackets removed, and the prompt says an instruction inside it is ignored. Whatever it says, the output can only be candidates, and candidates reach the catalogue only through the checks and a person running promote.

## What the tests cover

| File | Covers |
|---|---|
| `test/generate.test.ts` | The full generate path over the real gateway and the real SDK client against a fake Anthropic HTTP API ([`test/helpers/fake-anthropic.ts`](test/helpers/fake-anthropic.ts)): a card batch with two good candidates and five bad ones, each rejected for all of its reasons; a deck batch and a faction batch; the files written and the report read back; the ledger rows and cost; the output format (enums kept, ranges in descriptions, no extra keys); the rule texts and catalogue ids in the system blocks; pending ids; the strict envelope that loses the batch; truncated and malformed responses as failed runs; extra candidates ignored; a 529 and a spent cap with no report; an invalid catalogue refused before any request; bad counts and briefs; a misnamed pending file refused before the call; a candidate file that appears during the call, recorded as unwritten with the report still written |
| `test/catalog.test.ts` | The example catalogue; prefault defaults, and `.default({})` leaving them out; unknown keys at three levels; discriminated bodies; single-entity refinements reported together; every cross-reference, both sides of rivalries and summons, set limits, deck limits, duplicate ids and names, schema problems next to the references they break |
| `test/promote.test.ts` | Moving all or some candidates; a hand-written target kept even with `--replace`, with nothing moved; `--replace` for a generated target; an unreadable target; a candidate that claims to be hand-written; a catalogue that changed after the run; range rules applied again to an edited candidate; a set replaced with its own release order; the hard-link write that refuses to overwrite; a leftover temporary file that the loader skips |
| `test/rules-report.test.ts` | The cost curve for each card type, token exemption, the hand-written legendary, set order, keyword count, rule texts in every prompt; the output schema's lenient elements; the Wilson interval; pooling by version; unusable runs and unknown costs; reports whose numbers do not add up; invalid report files listed and not counted |
| `test/cli.test.ts` | The whole loop through `runCli` (validate, generate, stats, promote, validate), with the generate output compared to the sample above; exit codes 1, 2 and 3; error output with codes only, also for an unexpected error; `cli.ts` run as a child process |

75 tests, all offline. The fixture responses in `test/fixtures/responses/` are written by hand in the shape of a structured-output response, with candidates that are wrong on purpose. None is a recorded model response.

## Layout

```
cli.ts              the command line, and the only reader of ANTHROPIC_API_KEY
src/
  schemas.ts        the five entity schemas, the only definition of the data
  catalog.ts        the index validator: parsing, cross-references, every problem at once
  rules.ts          range rules for generated content, with the text the prompt shows
  prompt.ts         output schema, instructions, catalogue block, prompt versions
  generate.ts       one run: call, judge each candidate, write candidates and the report
  report.ts         run reports, pass rate, Wilson interval, stats
  promote.ts        the checked move into the catalogue
  files.ts          the catalogue on disk, the hand-written guard, writes that cannot overwrite
  model.ts          the gateway setup, the only import of gateway/
  commands.ts       argument parsing and exit codes
  index.ts          public exports
catalog/            the example catalogue: 5 keywords, 3 factions, 2 sets, 13 cards, 2 decks
test/               Vitest suites, the fake API, fixture responses
```

## Limits

- **No real pass rate yet.** The prompt has not been run against the real API, so there is no measured pass rate, cost per run or latency. Every number in this README comes from the fixtures and the fake API.
- **Validity is not quality.** A candidate can pass every check and still be dull, off-theme or a near copy of an existing card with another name. Duplicates are caught by id and by case-folded name only. The review between generate and promote is a person; there is no model judge.
- **A batch cannot introduce a new token.** Candidates are judged one at a time, in the order the model returned them. A new token and the spell that summons it each fail without the other. The token has no summoner yet, and the spell summons a card that is not in the catalogue. Tokens are written by hand. More generally, of two candidates that conflict, the one returned first is kept.
- **The cap holds per process.** The gateway's ledger here is its in-memory store, so the US$1 is per CLI run. Holding a monthly budget across runs needs the gateway's Postgres schema and an adapter, which neither folder has.
- **One call per run, without streaming.** `--count` is capped at 8 so a batch fits in 16,000 output tokens with thinking; that fit was not measured. No Message Batches, since the gateway does not support them.
- **No locking, no transaction.** Two promotes at the same time are not serialized. The hard-link write keeps a new file from overwriting one that appeared meanwhile, but a `--replace` race between two promotes is not covered. `--replace` re-checks the target and then renames over it, so a file a person marks hand-written in that window is replaced. New files use link(2), which some filesystems do not support. A promote that stops partway leaves the files it already moved in the catalogue.
- Prices are the ones in `gateway/examples/live-call.ts`; check the current pricing page before relying on a computed cost.
