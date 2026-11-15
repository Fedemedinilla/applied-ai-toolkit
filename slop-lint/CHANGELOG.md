# @fedemedinilla/slop-lint

## 0.2.0

First published version. It holds everything the `slop-lint/` folder holds at this release: the rule catalog, the pure `lint()` function, the CLI, the config file and its schema, inline suppressions, SARIF output and the GitHub Action. Version 0.1.0 was never published; genres, described below, are part of this first release.

Genres. `lint()` takes `genre` (`cover-letter`, the default, `email`, `follow-up` or `whatsapp`), `variety` (`rioplatense` or `neutral`) and `previous`, and the CLI takes `--genre` (also `auto`), `--variety` and `--previous`. The config file and its overrides accept `genre` and `variety`, and the action has a `genre` input. Each genre's profile lives in `GENRE_PROFILES`; the three new ones are experimental. In `email` and `follow-up` list items are FMT-01-LIST at level 2, while bold and headings stay FMT-01 at level 1. A config setting for FMT-01 applies to both, and one for FMT-01-LIST wins for the list part. With a variety, REG-01 names the register the variety uses. Without a genre the output is the same as before genres existed. New exports: `GENRES`, `GENRE_PROFILES`, `resolveRules` and `guessGenre`.

Rules only some genres run. They sit outside the catalog of 52, in `GENRE_RULES`, so a cover letter never runs them, and a config can name them under `ruleSettings`. MAIL-01 (email, follow-up, English) reports "thank you for your time and consideration" when it is the last sentence of the text, at level 1. MAIL-02 (email, follow-up, Spanish) reports "Estimado/a" and its other spellings with a slash, at level 2. MAIL-03 (email, follow-up, Spanish) reports "Oportunidad emocionante", the generic subject the report names, on a first line that starts with `Asunto:` or `Subject:`, at level 2.
