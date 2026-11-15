---
'@fedemedinilla/slop-lint': patch
---

Fix config globs with a hyphen, which crashed the CLI with exit 1; a glob that cannot compile is now a config error.
