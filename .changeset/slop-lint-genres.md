---
'@fedemedinilla/slop-lint': minor
---

Add genres. `lint()` takes `genre` (`cover-letter`, the default, `email`, `follow-up` or `whatsapp`), `variety` (`rioplatense` or `neutral`) and `previous`, and the CLI takes `--genre` (also `auto`), `--variety` and `--previous`. The config file and its overrides accept `genre` and `variety`, and the action has a `genre` input. Each genre's profile lives in `GENRE_PROFILES`; the three new ones are experimental. Without a genre the output is unchanged. New exports: `GENRES`, `GENRE_PROFILES`, `resolveRules` and `guessGenre`.
