# prose-rewriter

prose-rewriter takes a text you wrote: a cover letter, an email, a follow-up or a WhatsApp message. It finds the patterns of generic text in it with slop-lint and returns the same text improved, with your CV as the only source of facts. The model never returns a whole text. It proposes edits over exact quoted spans, and code applies them, checks each one against the facts of your text and your CV, and reverts any edit that adds a fact or loses one.

This folder is at phase F0 of its design. It holds the contract of `rewrite()` as zod schemas (`src/types.ts`), two fictional CVs for the evals and the test that keeps real data out of the fixtures. The pure core comes in F4, and the stages through the gateway, with `rewrite()` and the CLI, in F5.

## Run it

Offline, no key, from the repository root:

```sh
npx vitest run prose-rewriter   # the contract and the fixture checks
npm run check                   # tsc --noEmit, strict
```

## The contract

- `RewriteInput` holds the text, its genre (`cover-letter`, `email`, `follow-up`, `whatsapp`), the language, the Spanish variety (`rioplatense` or `neutral`), the register, the mode, the CV as Markdown, the recipient, the goal, the phrases to keep and the `strict` switch. A variety with `lang: 'en'` is refused.
- `Edit` is what a model may propose. Its `before` is quoted exactly from the text. A missing fact is asked for with a labelled marker, `[COMPLETAR: what is missing]`. The schema refuses a bare `[COMPLETAR]`, which slop-lint reports at level 1.
- `RewriteResult` returns the text, the diff, each change with its reason and whether it was applied or reverted, the fact report, slop-lint's result before and after, the flags, a status (`ok`, `needs-review`, `blocked`) and the usage. `costUsd` is null when the gateway has no price for a model.
- The mode defaults to `minimo` on WhatsApp and to `pulido` in the other genres.

## Fixtures and data

The evals use two invented people: a freelance web developer in Córdoba (`evals/cases/cv/es-rioplatense.md`) and a support engineer in Leeds (`evals/cases/cv/en.md`). Each CV opens with a comment that marks it as fiction. `test/fixtures.test.ts` scans every eval case and the style-refs data. It fails on an address outside a reserved domain, a phone number that is not zero-filled, a web host outside the reserved names, a missing fiction marker, or one of the repository owner's identifiers. A witness test feeds it real-looking data, so a check that stopped matching would fail instead of passing. Your own CV never enters this repository.
