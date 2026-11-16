# style-refs

style-refs holds the writing references of the prose rewriter (`prose-rewriter/`): the sources it draws on, the principles we wrote from them, short annotated excerpts and before and after examples per genre. It is data and a validator, with no I/O at runtime. The caller loads the JSON files and passes them to `validateRefs()`.

This folder is at phase F3 of its design. `sources.json` lists every author and register guide of the design, excluded ones included, and `validateRefs()` checks the licensing rules. `principlesFor()` picks the principles a prompt for one text may show. All three layers hold data.

## Three layers

The design keeps literature away from the register of a mail in 2026, so the references come in three layers, each with its own use in the prompt:

1. **Principles** (`principles/`) are sentences we wrote, each with its genres, registers, check and sources. They are the main way a source reaches a prompt.
2. **Annotated excerpts** (`excerpts/`) are one or two sentences of a public-domain work, each with what it teaches and what not to imitate. They are not few-shot examples, and they reach a prompt only once the eval shows they help (design section 5).
3. **Examples** (`examples/`) are before and after pairs we wrote over the fictional CVs of `prose-rewriter/evals/cases/cv/`. They are the only few-shot examples, so the rewriter imitates our own text and never a story.

## Run it

Offline, no key, from the repository root:

```sh
npx vitest run style-refs    # the shapes and the validator, over the data on disk
npx vitest run prose-rewriter/test/examples.test.ts   # the examples through slop-lint
npm run check                # tsc --noEmit, strict
```

## Layout

- `sources.json` lists each work or guide with its author, work, year of publication (null when unverified), year of the author's death and the author's countries. A translation adds its translator and the year they died; `lang` and `originalLang` tell it apart.
- Each source has its legal status in Argentina, the United States, the European Union and Spain, and `freeFrom` for a place that becomes free on a known day. It names its licence, a URL, the date the status was checked and its evidence tag.
- Each source has a use, one of `excerpts`, `principles`, `link-only` or `excluded`. An Argentine work declares `paidPublicDomain`, and `scope` limits the genres and registers of the principles that cite a source.
- `principles/es.json` and `principles/en.json` hold principles in our own words. Each one names its genres, the registers it applies to (`formal`, `neutral`, `casual`), the sentence a prompt shows, how a rewrite is checked against it, and its sources. A Spanish one may name a `variety` (voseo is `rioplatense`), and `slopRules` names the slop-lint rules that check the same fault, such as OFI-01. The text and the check are in English, like the rest of the folder; the Spanish words they quote stay in Spanish. No principle quotes a source: Quiroga, Mansilla and Arlt appear only as lessons we wrote.
- A principle of `kind: "avoid"` is one item of the "no imitar" list of the design: the rewriter shows its text as a negative constraint (stage S4) and looks for its `terms` after the rewrite (stage S6). Its sources are the works whose trait it warns against, or that warn against it.
- `excerpts/es.json` and `excerpts/en.json` hold excerpts of one or two sentences and at most 45 words. Each has what it teaches and what not to imitate, with the URL of the plain text it was checked against and the day it was fetched. They are not few-shot examples, and they reach a prompt only once the eval shows they raise `quality` without raising `literary-contamination` (design section 5). The English ones come from Strunk, Twain, Bierce, Franklin, Lincoln and Chekhov in Constance Garnett's translation; the Spanish ones from Galdós only, in neutral Spanish. No Argentine author gives an excerpt (D12). Each text was checked word for word, after collapsing whitespace, against the plain text fetched on 2026-11-16; the texts themselves are not stored here, so `test/excerpts.test.ts` checks what it can offline.
- `examples/es.json` and `examples/en.json` hold before and after pairs we wrote, one per genre and language. Each one names its genre and register, a Spanish one its variety (all are `rioplatense`, like the Spanish CV), and a follow-up carries `previousMessage`, the message it follows. Each is marked `fictional: true`. `prose-rewriter/test/examples.test.ts` lints them, since style-refs imports no library. The after has no level 1 finding of slop-lint for its genre and variety, and the before has more findings than the after. Every number comes from the CV of its language or from the earlier message, and no text carries a real address, phone, host or owner identifier. An after holds no `[COMPLETAR]`, because slop-lint reports it as FMT-04, at level 1.

## Licensing rules

`validateRefs()` enforces them and `test/licensing.test.ts` breaks each one on purpose:

- An excerpt comes only from a source marked `excerpts` and in the public domain in the United States. An open licence is not enough, and `unverified` is not free.
- That source was published in 1930 or earlier (`US_FREE_THROUGH`, what the United States frees as of 2026-01-01; it moves one year each January), and an unknown year counts as not free. A Gutenberg excerpt comes from the ebook its source names. Any other excerpt URL, a Wikisource page above all, is the source's `url` or one of its `excerptUrls`. Otherwise an excerpt could pass another work's text under a cleared source.
- No excerpt of an Argentine author while the paid public domain of Decreto-ley 1224/58 is unresolved (design decision D12). Quiroga, Arlt, Mansilla and Sarmiento give principles in our own words; Arlt only for the casual register of WhatsApp.
- A translation needs its translator and the year they died.
- An excerpt has at most two sentences and 45 words (D11), its text comes from gutenberg.org or wikisource.org (or a subdomain, never a lookalike host) without what they add, and it never names Project Gutenberg, whose licence allows the text to travel only without that name.
- A source under an open licence (the OGL v3.0 of GOV.UK, the CC BY 4.0 of argentina.gob.ar) carries its `attribution` before it gives principles. The principles adapt the guidance in our own words and never copy it.
- No source that gives principles or excerpts lives on cervantesvirtual.com, whatever its `kind`, because the Biblioteca Virtual Miguel de Cervantes claims rights over its database.
- A principle never cites a `link-only` or `excluded` source. Baroja, Azorín, Orwell's essay and the Strunk and White edition of 1959 are recorded as excluded.
- Every legal status is REPORTADO. It comes from the public-domain research of 2026-11-15 and was not checked against each law.

## Decreto-ley 1224/58 (D12)

Argentina charges a fee for the use of works in the public domain (the "dominio público pagante" of Decreto-ley 1224/58). Whether it reaches a free repository is unverified, so decision D12 starts with the English authors and Galdós. Each Argentine work in `sources.json` carries `paidPublicDomain: "unresolved"`, and while it does, `validateRefs()` refuses any excerpt of it, and the source itself if it declares `use: "excerpts"`. Quiroga gives principles in our own words, Arlt only principles for the casual rioplatense register of WhatsApp, and Mansilla and Sarmiento principles only. Changing the flag to `cleared` needs a reading of the decree first, recorded in the source's `note`.

## Adding a source

1. Add the work to `sources.json` with its status in each of `ar`, `us`, `eu` and `es`. A status taken from research is `REPORTADO`; a cell the research left unverified is `unverified`, never `public-domain`. A place that frees the work on a known day goes in `freeFrom`, with a status that is not free yet.
2. Give its year of publication, or `null` when it is unverified, and the year its author died. A translation names its translator and the year they died. An Argentine author needs `paidPublicDomain`.
3. Choose its use. `excerpts` needs `public-domain` in the United States and a year of 1930 or earlier, and a URL on gutenberg.org or wikisource.org. A source under an open licence needs its `attribution`.
4. For an excerpt, fetch the plain text outside the repository, check the excerpt is an exact substring after collapsing whitespace, and record the URL and the day it was fetched. A Wikisource variant of the source page (such as a manuscript copy) goes in the source's `excerptUrls`. Keep it to two sentences and 45 words, with what it teaches and what not to imitate.
5. Run `npx vitest run style-refs prose-rewriter`.

## Registers

A principle taken from a casual source never reaches a formal prompt, and three checks hold that:

- A source whose `scope` lists `casual` cannot list `formal` too.
- `validateRefs()` refuses a lesson whose genres or registers go beyond the scope of any source it cites. An `avoid` entry may name a casual source in a formal register, since it warns against it (no lunfardo in an email).
- `principlesFor()` checks the scope again when it picks, so data that skipped the validator still cannot leak a casual lesson into a formal prompt.

## Design decisions

- **Principles, not passages.** A story from 1917 teaches sentence craft, not the register of an email in 2026. So the literature enters as principles we wrote, and the register comes from plain-language guides under open licences.
- **The prompt sentence and its check live in one object**, as in `content-forge/src/rules.ts`, so the prompt and the control cannot drift apart.
- **Only sources that are free where the repository is served.** GitHub serves from the United States, so a work still protected there stays out even when it is free in Argentina. `unverified` counts as not free.
- **No I/O in the module.** The validator takes the parsed JSON, so a test, a CLI or a browser can use it the same way.
- **The genre list is local for now.** `GENRES` matches the list slop-lint gains in phase F1. This folder imports no other library.
