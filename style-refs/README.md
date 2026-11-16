# style-refs

style-refs holds the writing references of the prose rewriter (`prose-rewriter/`): the sources it draws on, the principles we wrote from them, short annotated excerpts and before and after examples per genre. It is data and a validator, with no I/O at runtime. The caller loads the JSON files and passes them to `validateRefs()`.

This folder is at phase F3 of its design. `sources.json` lists every author and register guide of the design, excluded ones included, and `validateRefs()` checks the licensing rules. `principlesFor()` picks the principles a prompt for one text may show. Principles, excerpts and examples come in the steps of F3.

## Run it

Offline, no key, from the repository root:

```sh
npx vitest run style-refs    # the shapes and the validator, over the data on disk
npm run check                # tsc --noEmit, strict
```

## Layout

- `sources.json` lists each work or guide with its author, work, year of publication (null when unverified), year of the author's death and the author's countries. A translation adds its translator and the year they died; `lang` and `originalLang` tell it apart.
- Each source has its legal status in Argentina, the United States, the European Union and Spain, and `freeFrom` for a place that becomes free on a known day. It names its licence, a URL, the date the status was checked and its evidence tag.
- Each source has a use, one of `excerpts`, `principles`, `link-only` or `excluded`. An Argentine work declares `paidPublicDomain`, and `scope` limits the genres and registers of the principles that cite a source.
- `principles/es.json` and `principles/en.json` hold principles in our own words. Each one names its genres, the registers it applies to (`formal`, `neutral`, `casual`), the sentence a prompt shows, how a rewrite is checked against it, and its sources. A Spanish one may name a `variety` (voseo is `rioplatense`), and `slopRules` names the slop-lint rules that check the same fault, such as OFI-01.
- A principle of `kind: "avoid"` is one item of the "no imitar" list of the design: the rewriter shows its text as a negative constraint (stage S4) and looks for its `terms` after the rewrite (stage S6). Its sources are the works whose trait it warns against.
- `excerpts/es.json` and `excerpts/en.json` hold excerpts of one or two sentences and at most 45 words. Each has what it teaches and what not to imitate, with the URL of the plain text it was checked against and the day it was fetched. They are not few-shot examples.
- `examples/<genre>.<es|en>.json` (from F3) holds before and after pairs we wrote over a fictional CV. They are the only few-shot examples, and each one is marked `fictional: true`.

## Licensing rules

`validateRefs()` enforces them and `test/licensing.test.ts` breaks each one on purpose:

- An excerpt comes only from a source marked `excerpts` and in the public domain in the United States. An open licence is not enough, and `unverified` is not free.
- No excerpt of an Argentine author while the paid public domain of Decreto-ley 1224/58 is unresolved (design decision D12). Quiroga, Arlt, Mansilla and Sarmiento give principles in our own words; Arlt only for the casual register of WhatsApp.
- A translation needs its translator and the year they died.
- An excerpt has at most two sentences and 45 words (D11), its text comes from gutenberg.org or wikisource.org without what they add, and it never names Project Gutenberg, whose licence allows the text to travel only without that name.
- A source under an open licence (the OGL v3.0 of GOV.UK, the CC BY 4.0 of argentina.gob.ar) carries its `attribution` before it gives principles. The principles adapt the guidance in our own words and never copy it.
- A principle never cites a `link-only` or `excluded` source. Baroja, Azorín, Orwell's essay and the Strunk and White edition of 1959 are recorded as excluded.
- Every legal status is REPORTADO. It comes from the public-domain research of 2026-11-15 and was not checked against each law.

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
