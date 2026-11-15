---
'@fedemedinilla/slop-lint': patch
---

Fix config globs with a hyphen, which crashed the CLI with exit 1; a glob that cannot compile, starts with `./` or ends with a slash is now a config error.
