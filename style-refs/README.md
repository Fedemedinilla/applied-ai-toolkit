# style-refs

style-refs holds the writing references of the prose rewriter (`prose-rewriter/`): the sources it draws on, the principles we wrote from them, short annotated excerpts and before and after examples per genre. It is data and a validator, with no I/O at runtime. The caller loads the JSON files and passes them to `validateRefs()`.

This folder is at phase F0 of its design: the shapes are in place and the data files are empty. Phase F3 fills them and adds a licensing test.

## Run it

Offline, no key, from the repository root:

```sh
npx vitest run style-refs    # the shapes and the validator, over the data on disk
npm run check                # tsc --noEmit, strict
```

## Layout

- `sources.json` lists each work or guide with its author, work, year of publication, year of the author's death, the translator and the year of their death for a translation, the legal status in Argentina, the United States, the European Union and Spain, the licence, a URL and the date the status was checked.
- `principles/es.json` and `principles/en.json` hold principles in our own words. Each one names its genres, the registers it applies to (`formal`, `neutral`, `casual`), the sentence a prompt shows, how a rewrite is checked against it, and its sources.
- `excerpts/es.json` and `excerpts/en.json` hold excerpts of one or two sentences, each with what it teaches and what not to imitate. They are not few-shot examples.
- `examples/<genre>.<es|en>.json` (from F3) holds before and after pairs we wrote over a fictional CV. They are the only few-shot examples, and each one is marked `fictional: true`.

## Design decisions

- **Principles, not passages.** A story from 1917 teaches sentence craft, not the register of an email in 2026. So the literature enters as principles we wrote, and the register comes from plain-language guides under open licences.
- **The prompt sentence and its check live in one object**, as in `content-forge/src/rules.ts`, so the prompt and the control cannot drift apart.
- **Only sources that are free where the repository is served.** GitHub serves from the United States, so a work still protected there stays out even when it is free in Argentina. `unverified` counts as not free.
- **No I/O in the module.** The validator takes the parsed JSON, so a test, a CLI or a browser can use it the same way.
- **The genre list is local for now.** `GENRES` matches the list slop-lint gains in phase F1. This folder imports no other library.
