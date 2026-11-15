# @fedemedinilla/slop-lint

## 0.2.0

First published version. It holds everything the `slop-lint/` folder holds at this release: the rule catalog, the pure `lint()` function, the CLI, the config file and its schema, inline suppressions, SARIF output and the GitHub Action. Version 0.1.0 was never published; genres, described below, are part of this first release.

Genres. `lint()` takes `genre` (`cover-letter`, the default, `email`, `follow-up` or `whatsapp`), `variety` (`rioplatense` or `neutral`) and `previous`, and the CLI takes `--genre` (also `auto`), `--variety` and `--previous`. The config file and its overrides accept `genre` and `variety`, and the action has a `genre` input. Each genre's profile lives in `GENRE_PROFILES`; the three new ones are experimental. In `email` and `follow-up` list items are FMT-01-LIST at level 2, while bold and headings stay FMT-01 at level 1. With a variety, REG-01 names the register the variety uses. Without a genre the output is the same as before genres existed. New exports: `GENRES`, `GENRE_PROFILES`, `resolveRules` and `guessGenre`.
