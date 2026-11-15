---
'@fedemedinilla/import-fences': patch
---

Report lines the way git and editors count them: a U+2028 or U+2029 inside a string no longer shifts every later line, and a leading BOM no longer adds a column on line 1.

A repository glob that starts with `./` or `/`, contains a backslash or has unbalanced braces is now a config error naming its key (exit code 2), instead of matching nothing or failing later with a generic error.

A `specifiers`, `external` or `package` entry with a `*` anywhere but at the end (`node:**`, `@vendor/*-internal`) is now a config error; before, it was compared literally and matched nothing.
