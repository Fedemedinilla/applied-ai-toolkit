# slop-lint

slop-lint flags the patterns that make a cover letter read as generated, in English and Spanish. Among them are template phrases, overused vocabulary, negative parallelism, participle tails, throat-clearing openers, summary closers, Markdown in a plain-text field and flat sentence rhythm. It is a pure TypeScript function and a CLI with no runtime dependencies. It is meant as the deterministic first pass in a writing pipeline: it catches the mechanical failures for free, before a second model scores the letter against a rubric.

The 52 rules come from a deep-research report I commissioned and curated (what it covers is in [research/PROMPT.md](research/PROMPT.md)). Each keeps the report's id, evidence tag and source. Three checks the report gives without an id got one here (LEX-07, LEX-08, MED-01); OFI-01 applies the report's rule of that name with the section 8.2 threshold.

Porting the report's regexes to JavaScript turned up bugs in them. `\b` is ASCII-only, so its Spanish participle-tail pattern could never match "Lideré". Its placeholder pattern, compiled with `i`, read `<div>` as an unfilled placeholder and disqualified any text in brackets, "[sic]" included. Each fix is recorded in the rule's `deviation` field; see Design decisions.

## Install

```sh
npm install @fedemedinilla/slop-lint
npx slop-lint letter.txt --lang en
```

```ts
import { lint } from '@fedemedinilla/slop-lint';
import type { LintOptions, LintResult } from '@fedemedinilla/slop-lint/types';
```

The package entry is built from `src/lint.ts` (`lint`, `RULES`, `appliesTo`, `rawMatches`), and `@fedemedinilla/slop-lint/types` holds the types of `src/types.ts`. The `slop-lint` bin is built from `cli.ts` and takes the same arguments as `node slop-lint/cli.ts`. Inside this repository nothing changes. Node runs the `.ts` files directly, and the paths below stay as they are.

- **The package ships JavaScript.** Node does not strip types for files inside `node_modules`, so `npm pack` compiles `cli.ts` and `src/` to `dist/` with [`tsconfig.build.json`](tsconfig.build.json), with declarations and source maps. Its `rewriteRelativeImportExtensions` turns each `./x.ts` import into `./x.js`. The `.d.ts` files keep the `.ts` specifiers, which TypeScript resolves to the `.d.ts` next to them; `npm run pack:check` typechecks a strict consumer against them with TypeScript 5.9.
- **No runtime dependencies**, as in the repository.
- **Node 24 or newer** (`engines`). That is the only version the tests and CI run, from `.node-version`. The compiled output may run on older versions, but none is tested, so none is claimed.
- **The build is checked as installed.** [`test/packaging/pack-check.ts`](../test/packaging/pack-check.ts) packs the package, installs the tarball outside the repository, compares its exports with the source, and runs the installed bin and `node slop-lint/cli.ts` on the same files to compare output and exit code.

## Run it

Offline, no key, from the repository root:

```bash
npm test                                   # all folders
npx vitest run slop-lint                   # only this folder
npm run check                              # tsc --noEmit, strict
node slop-lint/cli.ts slop-lint/fixtures/cover-letters/en-before.txt --lang en
node slop-lint/cli.ts slop-lint/fixtures/cover-letters/es-rioplatense-after.txt --lang es --json
printf 'Uso dbt con el equipo de datos.' | node slop-lint/cli.ts - --lang es --anchors "dbt,Contoso Agro"
node slop-lint/cli.ts README.md slop-lint/README.md --lang en   # Markdown, one summary line per file
node slop-lint/cli.ts README.md slop-lint/README.md --lang en --sarif > slop-lint.sarif   # for code scanning
npm run lint:docs                          # every README and the case study; fails on a tier 1 finding
node slop-lint/scripts/rules-table.ts      # prints the rule table below from the catalog
```

The CLI exits 1 when a level 1 rule fires in any of its files, 0 otherwise, and 2 on bad usage or an unreadable file, so it can gate a pipeline. The first two findings of the first command, and its last line:

```text
slop-lint/fixtures/cover-letters/en-before.txt:2:1    L1 high       LEX-03    Banned cover-letter phrase.
    "I am writing to express" -> Replace it with a fact from the CV: a project, a tool, a number, a year.
slop-lint/fixtures/cover-letters/en-before.txt:2:28   L1 high       LEX-03    Banned cover-letter phrase.
    "keen interest" -> Replace it with a fact from the CV: a project, a tool, a number, a year.
...
11 findings (L1 5, L2 4, L3 2); slop score 0/15; fails tier 1
```

Input is plain text by default, the way a portal's text field receives it. A file whose name ends in `.md` is read as Markdown instead, and `--format text` or `--format markdown` overrides that choice. Standard input is always text unless `--format` says otherwise. See Markdown mode below.

From code, `lint` is a pure function:

```ts
import { lint } from './slop-lint/src/lint.ts';

const result = lint(letter, { lang: 'es', anchors: ['dbt', 'Contoso Agro'] });
const docs = lint(readme, { lang: 'en', format: 'markdown' });   // format defaults to 'text'
result.passesTier1;   // false if any level 1 rule fired
result.findings;      // [{ ruleId, level, severity, start, end, line, column, match, message, suggestion, detail? }]
result.score;         // { points, max: 15 }
result.stats;         // words, sentences, sentenceLengthCV, anchors, tier2Used, emDashes, ...
```

`start` and `end` are UTF-16 offsets, so `text.slice(start, end) === match`. Node 24 runs the `.ts` files directly (type stripping), so there is no build step and no dependency beyond the repository's dev tooling.

## SARIF for code scanning

`--sarif` prints one SARIF 2.1.0 log to stdout for every input file, which is the format GitHub code scanning reads. It replaces the text output. It cannot be combined with `--json`, and asking for both is a usage error with exit 2 and nothing on stdout. The exit codes do not change, so a job can upload the log and still fail on a level 1 finding.

```bash
node slop-lint/cli.ts README.md docs/guide.md --lang en --sarif > slop-lint.sarif
printf 'I am passionate about data.' | node slop-lint/cli.ts - --lang en --sarif --sarif-uri letters/draft.txt
```

What the log holds:

- One run. `tool.driver` names slop-lint and lists, in catalog order, each rule that has a finding, with its id, its name as `shortDescription`, its message as `fullDescription`, its suggestion as `help`, the web address in its source as `helpUri` when the source has one, and its default level.
- One result per finding, with `ruleId`, `ruleIndex`, the level below, and a message that quotes the matched text and ends with the suggestion.
- `artifactLocation.uri` is the path as given on the command line, with forward slashes, without a leading `./`, each segment percent-encoded. An absolute path is made relative to the working directory, and a path on another Windows drive is a usage error. Code scanning resolves the uri against the repository root, so run the CLI from there. Standard input gets the uri `stdin`, or the one `--sarif-uri` gives (only with `--sarif` and a `-` input).
- Lines and columns are 1-based, and `endColumn` is the column after the match. `lint()` counts columns in UTF-16 code units, as JavaScript strings do, and the text output prints those. The log counts Unicode code points, and its `columnKind` says so, because SARIF allows either unit and a reader has to know which one it gets. An emoji such as `🎉` is two columns in the text output and one in the log.
- `partialFingerprints` holds a SHA-256 of the rule id, the uri, the matched text, and how many times that rule already matched that text earlier in the file. No line or column goes in, so a paragraph added above a finding keeps its alert instead of closing it and opening a new one. A file named twice in one run (`a.md` and `./a.md`, or two globs that overlap) is reported once, under its first name, since its results would repeat with the same fingerprints.
- The same input gives the same bytes. No timestamp, host name or tool version goes in.

Each finding gets a SARIF level:

| finding | SARIF level |
|---|---|
| level 1, any severity | `error` |
| level 2 or 3 with severity high or disqualify | `error` |
| level 2, severity medium or low | `warning` |
| level 3, severity medium or low | `note` |

Level 1 fails the CLI, so it is an error. A high finding costs 3 of the 15 score points even when it is budgeted, so it is shown as strongly as a level 1 finding. Today that is ESP-02, anchor density, the one level 2 rule with severity high. It stays out of the exit code, which follows level 1 alone. Level 2 findings are tolerated up to a budget, which makes them warnings. Level 3 context words pass next to an anchor, so the reader decides, which is what a note is for.

## Use it in CI

This folder is also a composite GitHub Action. It installs Node 24 with `actions/setup-node`, pinned by commit SHA, expands the file patterns, and runs `cli.ts` once for the job log and, when `sarif-file` is set, once more for the SARIF log. A workflow that lints the docs on every pull request and uploads the findings to code scanning:

```yaml
name: Prose

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  slop-lint:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # Pin a commit of this repository, the same way as any other action.
      - id: slop
        uses: Fedemedinilla/applied-ai-toolkit/slop-lint@<commit-sha>
        with:
          files: |
            README.md
            docs/**/*.md
          lang: en
          sarif-file: results/slop-lint.sarif
          fail: false

      - uses: github/codeql-action/upload-sarif@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3
        if: always() && steps.slop.outputs.sarif-file != ''
        with:
          sarif_file: ${{ steps.slop.outputs.sarif-file }}
          category: slop-lint
```

With `fail: false` the findings arrive as alerts and the job passes. With the default `fail: true` the lint step fails on a level 1 finding, and `if: always()` still uploads the log.

Inputs:

| input | required | what |
|---|---|---|
| `files` | yes | Paths or globs, separated by spaces or newlines. `**` matches across folders, skips hidden ones and does not skip `node_modules`. Only regular files count, and a pattern that matches none fails the step. A path cannot contain a space. |
| `lang` | yes | `en` or `es`. |
| `format` | no | `text` or `markdown`. Empty, the default, reads a `.md` file as Markdown and anything else as text. |
| `anchors` | no | Comma-separated anchor terms, passed to `--anchors`. |
| `sarif-file` | no | A path to write the SARIF log to, as well as the text output. Its folder is created. |
| `fail` | no | `true` (the default) fails the step on a level 1 finding. `false` never fails on findings. |

Outputs:

| output | what |
|---|---|
| `sarif-file` | The path the SARIF log was written to, or empty when `sarif-file` was not set. |
| `exit-code` | The CLI's exit code: 0, 1 or 2, as in Run it. It is 2 when the SARIF file could not be written, and empty when the step stopped before running the CLI. |

How it behaves, and why:

- **Inputs are data, never code.** No `${{ inputs.* }}` expression appears inside the run script. Each input reaches it through `env:` and is quoted there, so a value such as `$(touch pwned)` is a pattern that matches nothing. `test/action.test.ts` reads `action.yml` and fails if an expression ever lands in a run block.
- **Exit 2 always fails the step.** A pattern that matches nothing, a bad `lang` or `format`, or an unreadable file means the lint did not run. `fail: false` is for findings, and a broken configuration that passes would hide every finding from then on.
- **Paths are relative to the workspace.** The step runs in the checkout, so the uris in the log match the repository. A checkout into a subfolder (`path:` on actions/checkout) would need the patterns and the uris to start from that folder, which this action does not do.
- **A path that starts with `-` gets `./` in front**, so the CLI reads it as a file and not as an option.
- **setup-node stays set up.** The composite step changes the job's Node to 24 for the steps after it too.

## Markdown mode

The rules were written for a cover letter, but this repository also lints its own docs with them (`npm run lint:docs`, which CI runs after the tests). Read as plain text, a README fails on its own syntax: FMT-01 fires on every list marker, and the rules match inside code blocks, tables and the quoted examples of this file. With `format: 'markdown'`, `lint()` first builds a masked copy of the document:

- Fenced code blocks, inline code, tables, HTML comments, inline HTML, images, link URLs and the brackets around link text are replaced by spaces. The link text stays.
- So are heading, list and quote markers, emphasis markers and the backslash of an escape.
- Newlines are kept and nothing is deleted, so the copy has the same length as the file. Every finding's offsets, line and column point into the original, and its `match` is the original text.

The rules then run on that copy, with three differences from text mode:

- Rules marked `plainTextOnly` are skipped. Today that is FMT-01, Markdown in a plain-text field, which is the point of a Markdown file. FMT-02 (emoji), FMT-04 (placeholders) and FMT-05 (revelation colons) still apply, because they are about the prose, not the syntax.
- Sentences are split block by block. In plain text, a line that starts in lowercase continues the sentence above it. Once the markers are gone, the lowercase list in The section 15 letters below would read as one sentence of 51 words. A sentence that starts with inline code is also split from the one before it.
- EST-10, the long-sentence check, reads paragraphs, plus list items that hold two or more prose sentences. A list item with one sentence is usually a label and an inventory, like the test files listed under What the tests cover, and its length is the length of what it lists. Headings and quotes are left out.

Inline code counts as an anchor. It names a file, a command or a field, which is something a reader can check, and masking it would otherwise drop it from the anchor density (ESP-02).

A quoted example of a banned phrase is still a match. To lint a document that lists banned phrases on purpose, as this one does, wrap the examples in directives:

```markdown
Words such as <!-- slop-lint-disable -->"robust" and "seamless"<!-- slop-lint-enable --> are reported.

<!-- slop-lint-disable-next-line -->
- SIN-EN-01 flags "actually" in its English sense.
```

Everything between `slop-lint-disable` and `slop-lint-enable` is masked like code, inside a line or across paragraphs; a `disable` without an `enable` runs to the end of the file. `slop-lint-disable-next-line` masks the line after the comment. Directives are HTML comments, so they do not show on a rendered page, and they only work in Markdown mode. Inside a code block they are code, which is why the example above is not applied.

The Tier 2 budget, the colon budget and the em dash budget stay at their cover-letter sizes. A README of 2,000 words spends them early, so it gets level 2 findings that a letter of the same density would not. They are reported, and they do not fail the run.

## Layout

| path | what |
|---|---|
| `src/rules.ts` | the catalog: every rule as data, with its regex per language, level, budget, message, suggestion, source, deviations from the report, known false positives, and a positive and near-miss example |
| `src/lint.ts` | `lint()`: matching, anchor and quote exemptions, overlap resolution, budgets, score |
| `src/structural.ts` | checks that count instead of match: anchor density, rhythm, long sentences, em dash and raya use, register mixing, nominalizations |
| `src/text.ts` | sentence splitting, words, anchors, offsets |
| `src/markdown.ts` | Markdown mode: masks code, tables, comments, link URLs and markers with spaces, reads the disable directives, splits the document into blocks |
| `src/regex.ts` | Unicode-aware word boundaries |
| `src/sarif.ts` | `toSarif()`: the SARIF 2.1.0 log, levels, code point columns, relative uris, fingerprints |
| `cli.ts` | command-line entry point |
| `action.yml` | the composite GitHub Action (Use it in CI) |
| `fixtures/cover-letters/` | the six letters of the report's section 15, all fictional |
| `research/PROMPT.md` | what the research report covers and where its rules live |
| `test/` | offline tests; `test/golden/` holds the CLI output that `output-regression.test.ts` pins |

## Levels

The report sorts vocabulary into three tiers and gives every catalog rule a threshold and a severity. The linter turns that into three levels:

- **Level 1, banned.** Any hit is reported, the text fails, and the CLI exits 1. A rule is level 1 when the report gives it threshold 0 and severity "disqualify" or "high".
- **Level 2, budgeted.** Hits are tolerated up to a budget and reported after it. The Tier 2 word lists share one budget of two per text, with no word used twice. Other rules have their own budget from the report (one intensifier, one abstract triad, one em dash in English) or a budget of 0 when their severity is medium or low.
- **Level 3, context words.** Words such as "team", "impact" or "experiencia" pass when their sentence holds an anchor: a number, a tool, a proper noun, a year. Without one, they count against the Tier 2 budget, as the report's decision rule says.

The shared budget is spent in reading order, so context words without an anchor can use it up before a Tier 2 word appears. <!-- slop-lint-disable -->In the English "before" letter, "drive" and "impactful" take the two free slots, and "dynamic", "fostering" and "align with" are reported.<!-- slop-lint-enable -->

## Design decisions

**Levels come from the report's columns, with two documented exceptions.** A rule's level follows from its threshold and severity, so a reviewer can check it against the source. The first exception is ESP-01, kept at level 2 because a regex cannot see the CV (see below). The second is EST-04, checked at every sentence start because a model also clears its throat in the middle of a paragraph. The participle-tail rule (EST-08) has threshold 0 but medium severity and known false positives, so it is a level 2 warning. The report's own English "after" letter shows why: "cutting it from three days to four hours" is a participle tail with the number in it, and it should not fail the letter.

**Word boundaries are Unicode lookarounds, not `\b`.** In JavaScript, `\b` only knows ASCII word characters, even with the `u` flag, so `/Lideré\b/u` never matches "Lideré la". The report's Spanish participle-tail regex uses `é\b` and `ó\b`, so it could not match a preterite such as "Lideré" or "logró". Every pattern uses `(?<![\p{L}\p{N}])` and `(?![\p{L}\p{N}])` instead, and a test pins the difference. With the boundary fixed, the report's regex still missed both of its own section 15 examples, so EST-08 adds a short list of consequence gerunds after a comma or dash. Each change of this kind is written in the rule's `deviation` field.

**The catalog carries its own tests.** Every rule has at least one example that must fire and one near-miss that must not. The near-miss for the Tier 2 word "clave" is "palabra clave", the one for <!-- slop-lint-disable -->"pivotal"<!-- slop-lint-enable --> is "pivot table", and the one for the dequeísmo rule is "Me alegro de que". The test suite iterates over the catalog, so a new rule without both examples fails the suite. The same test compiles every regex with `giu` and with the rule's declared flags. Rules that do not need case folding compile without `i`, and two must not have it. Under `iu`, `\p{Lu}` also matches lowercase letters, so the Title Case check would fire on every line, and `<[A-Z_ ]{3,}>` would treat `<div>` as an unfilled placeholder. A test pins the missing flag on both, and each carries the near-miss that would catch it coming back.

**A disqualifying rule has to be narrow.** FMT-04 sets the score to 0, so a false positive costs the whole letter. The report's bracket pattern matched any bracketed text: "[sic]", "[2023]", "[pandas, numpy]", a citation "[12]". Here a bracket counts only when it looks like a placeholder. It starts with a capital, holds only letters, spaces and `_`, and has at most five words, as in <!-- slop-lint-disable -->"[Company Name]" or "[Nombre de la empresa]"<!-- slop-lint-enable -->.

**A closer is judged by its position.** "In conclusion" is a closing formula wherever it appears, but <!-- slop-lint-disable -->"Overall," and "Ultimately,"<!-- slop-lint-enable --> also open ordinary sentences. EST-05 counts those two only in the last two prose sentences. Earlier in the letter, <!-- slop-lint-disable -->"ultimately"<!-- slop-lint-enable --> is still a Tier 2 word.

**An anchor is whatever a reader could check.** A sentence has an anchor when it holds a digit, a number word, an acronym, a capitalized word that is not the sentence's first word (and not "I"), or a term the caller passes in. The caller's terms matter for tools written in lowercase, such as dbt or pandas, which the proper-noun test cannot see. The same test exempts the self-assessment rule (ESP-04) and the flattery rule (RET-01): "proactiva" fails alone and passes next to "en 2023 automaticé el cierre con Python".

**Each span of text is charged once.** "passionate about" is a Tier 1 phrase and contains the self-assessment adjective "passionate"; <!-- slop-lint-disable -->"Ultimately," is a summary closer and contains the Tier 2 word "ultimately".<!-- slop-lint-enable --> When one hit covers another, the stricter level keeps it, and on an identical span the earlier rule in the catalog does. Without this, a single phrase would cost the score twice and the counts in the report's annotations would not match.

**Sentence splitting is built for letters.** A line break ends a sentence, because salutations, signatures and portal text fields put one paragraph per line. The exception is a next line that starts in lowercase, which is how a hard-wrapped paragraph continues. Periods after "Sra.", "Ms.", initials, dotted abbreviations ("U.S.", "EE.UU.", "e.g.") and decimals do not split. Rhythm, anchor density and question placement only look at prose sentences (terminal punctuation and at least three words), so "Dear Ms. Reyes," and the signature do not distort the coefficient of variation.

**An inflated figure is a candidate, not a verdict.** The report makes "más de cuatro años" disqualifying when the CV says four. A regex cannot see the CV, so ESP-01 reports every "more than" or "más de" before a number, spelled-out numbers included, as a level 2 finding for the judge to confirm.

**The score is one rubric dimension, not the rubric.** The report's rubric has 100 points, and "absence of slop" is 15 of them. It is scored as 15 minus 3 per high finding, 1.5 per medium and 0.5 per low, and 0 with three or more high findings. That is the only part a linter can score without the CV and the posting, so it is the only part it scores.

**Dashes follow each language's norm.** The raya is a normative sign in Spanish (RAE, Diccionario panhispánico de dudas). The linter accepts one aside between rayas per letter. It flags a raya glued between two words, which is the English em dash copied over, and an aside that never closes. In English the em dash is correct punctuation and the problem is density, so the budget is one per letter.

**Quoted text is exempt from the lexical bans.** A letter that writes `the posting asks for a "proven track record"` is quoting the phrase, not using it. The Tier 1 phrase rules, the summary closer and the self-assessment rule skip matches inside straight, curly or angle quotes. A quotation stays inside one sentence and under 80 characters, so one stray quote mark cannot pair with a later one and exempt everything in between.

## What the tests cover

208 tests in 10 files, all offline and without an API key:

- `rules.test.ts`: catalog integrity (unique ids, every regex compiles with `giu` and with its flags, no `i` on FMT-03 and FMT-04, a pattern per declared language, level 1 only for high or disqualifying rules, a source and section on every rule, one structural check per structural rule, every id listed in this README), and the positive and near-miss example of every rule.
- `lint.test.ts`: the shared Tier 2 budget and the no-repeat rule, Tier 3 words with and without anchors, caller anchors, overlap resolution, quote exemption and stray quote marks, closers by position, language filtering, the Unicode boundary, offsets, line and column, score weights, disqualification, purity, empty input, and the structural checks (register mixing, em dash and raya budgets, opening signs per sentence, openers at every sentence start).
- `text.test.ts`: sentence splitting with abbreviations, initials, dotted abbreviations, decimals, line breaks and closing quotes; prose detection; anchor counting; offsets to line and column.
- `cover-letters.test.ts`: the six letters of section 15 (below).
- `markdown.test.ts`: the masked copy keeps length and newlines; code blocks, inline code, tables, comments, link URLs and markers are masked; findings point into the original file; FMT-01 is skipped and the other rules still fire; list items do not merge into one sentence; EST-10 scope; inline code as an anchor; the three directives; text mode unchanged.
- `cli.test.ts`: exit codes 0, 1 and 2, text and JSON output, stdin, `--anchors`, `--format` and the `.md` default, several files with one summary line each.
- `output-regression.test.ts`: the text and JSON output for one file and for two, byte for byte against `test/golden/`, on a fixture with accents, emoji and a ZWJ sequence.
- `sarif.test.ts`: the level mapping for every level and severity, `helpUri` from the source references, uri normalization (`./`, absolute paths, Windows separators and drives, percent-encoding, the paths it refuses), code point columns on the multibyte fixture, regions across a line break, the log against a zod schema of what code scanning requires (`sarif-schema.ts`), clean input, several files, the same file given twice, determinism, and fingerprints that survive moved lines and columns, tell repeated matches apart, and count them again from 0 in each file.
- `cli-sarif.test.ts`: `--sarif` as a child process. The log validates, the exit codes stay, the bytes repeat and columns are code points. Several files share one run, uris are relative, and stdin is `stdin` or the `--sarif-uri` value. `--json` with `--sarif`, a misused `--sarif-uri`, an unreadable file or a Windows path exit 2 with nothing on stdout.
- `action.test.ts`: `action.yml` as text (no expression in the run block, every input through `env:`, setup-node pinned to the SHA in ci.yml, every input and output in this README), then its script, run with bash in a temporary workspace, against `**` globs, space and newline separators, `fail: false`, exit 2 on a pattern with no match or an unwritable SARIF file even with `fail: false`, inputs that look like shell code, a file named `-letter.txt`, the SARIF file and the outputs, and a `sarif-file` with a line break.

## The section 15 letters

The report ends with three pairs of cover letters for one fictional candidate, Lucía Ferreyra, a data analyst in Rosario. She applies to three companies, one per variety: a fintech (Rioplatense Spanish), a regional distributor (neutral Spanish) and a US analytics firm hiring remotely (English). The "before" letter of each pair is what a model writes with no instructions; the "after" letter is the rewrite that passes the rubric. They are the fixtures, with two changes. Every company is renamed to one of Microsoft's sample names (Woodgrove Pagos, Distribuidora Fabrikam, Northwind Analytics, and Contoso Agro as her employer), so no name can belong to a real business. The contact lines keep only an example.com address.

The report scored each letter by hand on its 100-point rubric (section 15.4). Its slop dimension is out of 15, the same scale as the linter's score:

| letter | findings | linter score | report's slop score | tier 1 |
|---|---|---|---|---|
| Rioplatense, before | 19 (12 level 1) | 0/15 | 0 | fails |
| Rioplatense, after | 0 | 15/15 | 14 | passes |
| Neutral, before | 5 (2 level 1) | 5.5/15 | 2 | fails |
| Neutral, after | 0 | 15/15 | 14 | passes |
| English, before | 11 (5 level 1) | 0/15 | 0 | fails |
| English, after | 1 (EST-08, level 2) | 13.5/15 | 14 | passes |

The linter is more lenient on the neutral "before" letter because two of its failures, "inglés avanzado" against a B2 CV and "amplios conocimientos", need the CV. The report takes a point off each "after" letter for things a regex cannot see, such as the slight generalization in "las tres cosas son mi trabajo diario".

The report annotates the failures of each "before" letter. For the Rioplatense one it lists twelve, and the linter catches nine:

- the template phrases (LEX-01, eight hits, where the report counts six)
- the negative parallelism (EST-01)
- the inflated "más de cuatro años", as a candidate for the judge (ESP-01)
- the "logrando" tail (EST-08)
- the self-assessment adjectives (ESP-04)
- the chained possessives (SIN-11)
- the flattery (RET-01)
- the summary closer (EST-05)
- the "posición" calque (REG-02)

It misses three. The report reads "mi experiencia, mi compromiso y mi pasión" as an abstract triad (EST-03); the suffix-based pattern cannot see it through the possessives, and SIN-11 flags the phrase instead. The formal "usted" in reply to a posting that uses "vos" (REG-03) and the silence about dbt, a requirement the candidate lacks (CAR-02), both need the job posting, which the linter does not receive. In the neutral letter, the inflated "inglés avanzado" (the CV says B2) and the unsupported "amplios conocimientos" need the CV, and the closing without a request needs the judge.

## Rules

Generated with `node slop-lint/scripts/rules-table.ts`. A test checks that every rule id in the catalog appears here. Evidence tags are the report's: MEDIDO (measured, primary source), NORMA (normative reference), REPORTADO (press, blogs, unaudited surveys), CONSENSO (common editorial practice), SÍNTESIS (the researcher's own conclusion).

| id | rule | lang | level | severity | budget | kind | evidence | source |
|---|---|---|---|---|---|---|---|---|
| LEX-01 | Tier 1 phrases (Spanish) | es | 1 | high | 0 | pattern | SÍNTESIS | Section 12, Spanish Tier 1 list |
| LEX-02 | Tier 2 vocabulary (Spanish) | es | 2 | medium | Tier 2: 2, no repeats | pattern | SÍNTESIS | Section 12, Spanish Tier 2; Spanish analogues of Kobak et al. 2025 |
| LEX-03 | Tier 1 phrases (English) | en | 1 | high | 0 | pattern | MEDIDO, CONSENSO | Kobak et al. 2025, Science Advances (arxiv.org/pdf/2406.07016); section 12, English Tier 1 |
| LEX-04 | Tier 2 vocabulary (English) | en | 2 | medium | Tier 2: 2, no repeats | pattern | MEDIDO | Liang et al. 2024, ICML (arxiv.org/html/2403.07183v2); Kobak et al. 2025 |
| LEX-05 | Intensifiers | both | 2 | low | 1 | pattern | SÍNTESIS | Section 3 audit of the earlier rule set |
| LEX-06 | Self-proclaimed honesty or humility | both | 1 | high | 0 | pattern | CONSENSO | Section 3 audit; section 12 |
| LEX-07 | Tier 3 context words (Spanish) | es | 3 | medium | anchor, else Tier 2 | pattern | SÍNTESIS | Section 12, Tier 3 decision rule |
| LEX-08 | Tier 3 context words (English) | en | 3 | medium | anchor, else Tier 2 | pattern | SÍNTESIS | Section 12, Tier 3 decision rule |
| ESP-01 | Inflated quantity (candidate for the judge) | both | 2 | medium | 0 | pattern | SÍNTESIS | Section 1.4; rubric disqualifiers, section 10 |
| ESP-04 | Self-assessment without proof | both | 1 | high | 0 | pattern | CONSENSO | Sections 1.4 and 13.1 |
| EST-01 | Negative parallelism | both | 1 | high | 0 | pattern | REPORTADO | Wikipedia, Signs of AI writing (en.wikipedia.org/wiki/Signs_of_AI_writing) |
| EST-02 | "Not only... but also" | both | 2 | medium | 0 | pattern | REPORTADO | Wikipedia, Signs of AI writing (en.wikipedia.org/wiki/Signs_of_AI_writing) |
| EST-03 | Abstract triad | both | 2 | medium | 1 | pattern | CONSENSO, SÍNTESIS | Wikipedia talk, Signs of AI writing, Archive 4 |
| EST-04 | Throat-clearing opener | both | 1 | high | 0 | pattern | CONSENSO | Sections 1.1 and 4.2 |
| EST-05 | Summary closer | both | 1 | high | 0 | pattern | REPORTADO | erkansaka.net summary of Wikipedia, Signs of AI writing |
| EST-07 | False range | both | 2 | low | 0 | pattern | REPORTADO | Wikipedia, Signs of AI writing (en.wikipedia.org/wiki/Signs_of_AI_writing) |
| EST-08 | Participle tail | both | 2 | medium | 0 | pattern | NORMA, SÍNTESIS | NGLE (RAE/ASALE) on the gerund of posteriority; section 5.1 |
| EST-09 | Process narration | both | 2 | medium | 0 | pattern | REPORTADO | Wikipedia talk, Signs of AI writing, Archive 8 |
| RET-01 | Flattery without a fact | both | 2 | medium | 0 | pattern | SÍNTESIS | Section 4.3 |
| RET-03 | Vague attribution | both | 2 | medium | 0 | pattern | REPORTADO | Wikipedia, Signs of AI writing (en.wikipedia.org/wiki/Signs_of_AI_writing) |
| RET-04 | Excessive hedging | both | 2 | low | 1 | pattern | CONSENSO | Section 4.3 |
| FMT-01 | Markdown in plain text | both | 1 | high | 0 | pattern | REPORTADO | Wikipedia, Signs of AI writing, October 2026 |
| FMT-02 | Emoji | both | 1 | high | 0 | pattern | CONSENSO | Section 4.4 |
| FMT-03 | Title Case (Spanish) | es | 2 | medium | 0 | pattern | NORMA | RAE, Ortografía 2010 |
| FMT-04 | Unfilled placeholder or chat residue | both | 1 | disqualify | 0 | pattern | SÍNTESIS | Sections 1.4 and 10 |
| ORT-02 | English quotes in Spanish | es | 2 | low | 0 | pattern | NORMA | RAE, Ortografía 2010 |
| ORT-03 | Dash glued between words (Spanish) | es | 2 | medium | 0 | pattern | NORMA | RAE, Diccionario panhispánico de dudas, "raya" (rae.es/dpd/raya) |
| ORT-06 | Accents removed in 2010 | es | 2 | low | 0 | pattern | NORMA | RAE, Ortografía 2010 |
| SIN-01 | Dequeísmo | es | 1 | high | 0 | pattern | NORMA | RAE, Diccionario panhispánico de dudas |
| SIN-02 | Queísmo | es | 2 | medium | 0 | pattern | NORMA | RAE, Diccionario panhispánico de dudas |
| SIN-05 | Periphrastic passive | es | 2 | low | 1 | pattern | CONSENSO | Section 1.1, item 11 |
| SIN-06 | "En base a" | es | 2 | low | 0 | pattern | NORMA | RAE, Diccionario panhispánico de dudas, "base" |
| SIN-07 | "A nivel de" without a level | es | 2 | low | 0 | pattern | NORMA | RAE, Diccionario panhispánico de dudas, "nivel" |
| SIN-08 | "El mismo" as a pronoun | es | 2 | low | 0 | pattern | NORMA | RAE, Diccionario panhispánico de dudas, "mismo" |
| SIN-11 | Chained possessives | es | 2 | low | 0 | pattern | CONSENSO, NORMA | Section 1.1, item 10 |
| REG-02 | Workplace calques (Spanish) | es | 2 | medium | 0 | pattern | CONSENSO | Section 11, item 4 |
| CAR-03 | Apologizing for a gap | both | 2 | medium | 0 | pattern | SÍNTESIS | Section 1.4, item 3 |
| SIN-EN-01 | False friends | en | 2 | medium | 0 | pattern | CONSENSO | Section 6.2 |
| SIN-EN-03 | Prepositions | en | 2 | medium | 0 | pattern | CONSENSO | Section 6.2 |
| SIN-EN-04 | Pluralized uncountables | en | 2 | medium | 0 | pattern | CONSENSO | Section 6.2 |
| SIN-EN-06 | Lowercase languages, days and months | en | 2 | low | 0 | pattern | CONSENSO | Section 6.2, SIN-EN-06 |
| ESP-02 | Anchor density | both | 2 | high | at least 1 anchor per 35 words | structural | SÍNTESIS | Section 10, specificity dimension; Galdin and Silbert 2025 |
| EST-06 | Rhetorical question as a hook | both | 2 | medium | 0 in the first half | structural | CONSENSO | Section 4.2 |
| EST-10 | Long sentence | both | 2 | medium | 35 words (en), 40 (es) | structural | MEDIDO | Anthropic, prompting guide for Claude Fable 5.1 (density) |
| EST-11 | Flat rhythm | both | 2 | low | CV at least 0.25 with 8+ sentences | structural | SÍNTESIS | Section 8.2; no validated threshold for letters exists |
| FMT-05 | Revelation colons | both | 2 | low | 2 per text | structural | REPORTADO | Wikipedia, Signs of AI writing (en.wikipedia.org/wiki/Signs_of_AI_writing) |
| ORT-01 | Missing opening ¿ or ¡ | es | 2 | medium | 0 | structural | NORMA | RAE, Ortografía 2010 |
| ORT-04 | Unclosed or extra inciso dash (Spanish) | es | 2 | medium | 1 aside per text, all closed | structural | NORMA | RAE, Ortografía básica, la raya como signo delimitador |
| ORT-05 | Em dash density (English) | en | 2 | medium | 1 per text | structural | REPORTADO | Wikipedia, Signs of AI writing (en.wikipedia.org/wiki/Signs_of_AI_writing) |
| REG-01 | Mixed voseo and tuteo | es | 1 | high | 0 | structural | SÍNTESIS | Section 7.3 |
| OFI-01 | Nominalization density | both | 2 | low | 1 per 12 words | structural | SÍNTESIS | Section 5, OFI-01 (actions as verbs); section 8.2, suffix approximation |
| MED-01 | Adverbs in -mente | es | 2 | low | 2 per text | structural | SÍNTESIS | Section 8.2 |

The full Tier 1 and Tier 2 lists, with each regex, are in `src/rules.ts`.

## Known false positives

Each rule lists its own in `falsePositives`. The ones that matter in practice:

<!-- slop-lint-disable-next-line -->
- EST-08 flags gerunds of simultaneous manner ("Trabajé en Rosario, viviendo en Funes") and "-ing" nouns after a past verb ("I worked on X, including Y"). That is why it is a level 2 warning.
- LEX-02 matched "clave" in "palabra clave" and "clave fiscal" until those were excluded; "dinámica" as a noun and "integral" in mathematics still match.
- FMT-03 flags three-word proper names ("Universidad Nacional Rosario"). A list of names from the CV would fix it; it is not implemented.
<!-- slop-lint-disable-next-line -->
- SIN-EN-01 flags "actually" and "eventually" used in their English sense. It is a warning for Spanish speakers, not an error.
- LEX-03 flags "unlock" and "embark" in their literal sense.
<!-- slop-lint-disable-next-line -->
- EST-07 flags literal movement ("from the office to the client").
- EST-06 flags any question in the first half of the prose, a real one too ("Hola, ¿cómo estás vos?").
- EST-05 flags "Overall," when the last fact of a letter starts with it and only one sentence follows.
<!-- slop-lint-disable-next-line -->
- FMT-04 flags a capitalized aside in brackets ("[Translated from Portuguese]") and, in plain text, a Markdown link label. With severity "disqualify", that costs the whole score, which is why the pattern is narrow.
- A quotation that opens with a straight quote and closes with one later in the same sentence is exempt even when the first mark was a typo.
- The proper-noun anchor test counts any capitalized word that is not the first in its sentence, so "English" or a capitalized job title counts as an anchor. That errs toward letting context words through.
- The Tier 2 budget and the em dash budget are set for a cover letter of 150 to 300 words. They do not scale with length; lint a longer text section by section.

## What needs a model judge

The linter covers the mechanical part of the report's rubric (section 10). The rest needs a second model that has the CV and the posting, or a person:

- **Specificity and truth (25 points).** Whether each claim about the candidate is backed by a line of the CV. Inflated figures (ESP-01) and invented skills disqualify the letter regardless of score. The linter counts anchors (ESP-02) but cannot tell a real one from an invented one.
- **Fit to the posting (20).** Whether the heaviest requirements are addressed, whether a missing requirement is stated plainly (CAR-02), whether the register mirrors the posting (REG-03), and whether the role and company appear early (CAR-01).
- **Craft (15) and voice (10).** Mannered prose and decorative metaphor (RET-02), the main risk the report identifies for the model it targets. No regex finds "a dial worth turning".
- **The closing request (CAR-04).** Whether the letter ends by asking for something concrete.
- **Disqualifiers outside the text.** Wrong company or role name, the wrong language variety, a length over the portal's field limit (CAR-05, whose limits the report could not verify for the Argentine portals).

The report gives the human reviewer two questions for this part. The first is "Can I point, for each sentence about the candidate, to the line of the CV that proves it?" The second is "If I cover the company name, does the letter still work for another company?"

## Limits and what is not included

- The readability formulas of section 8.1 (Szigriszt-Pazos and INFLESZ for Spanish, Flesch for English) are not implemented. The report caps their weight at 2 points because they only count syllables and sentence length.
- Lexical diversity (MTLD) is not implemented; the report records it without scoring it.
- ESP-03 (copying 9 or more words of the posting) needs the posting text, and is not implemented.
- "Thank you for your time and consideration" is Tier 1 only as the sole closing line, which needs a model of the letter's structure; it is not implemented.
- Word lists age. The report tracks the marker vocabulary changing with each model generation (GPT-4, GPT-4o, GPT-5 eras), so these lists carry a version, 2026-10. Structural rules age more slowly.
- MED-01 counts Spanish adverbs in -mente only. The report lists -ly as the English suffix but gives no threshold for it, and "only", "early", "family" and "daily" end in -ly too.
- Markdown mode covers the syntax these docs use: ATX and setext headings, lists, quotes, fenced code, GFM tables, links, images, emphasis and inline HTML. It does not recognize indented code blocks, footnotes, or the text inside a multi-line HTML block.
- This is not an AI detector and should not be used as one. The report cites an average false-positive rate of 61.22% for seven detectors on human-written TOEFL essays (Liang et al. 2023). People who learned to write from templates, or in a second language, produce these same patterns. The messages talk about the quality of the text, never about who wrote it.
- The report itself is not in this repository. Only the rules implemented here are, with their sources.
