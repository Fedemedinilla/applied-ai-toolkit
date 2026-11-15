---
'@fedemedinilla/slop-lint': patch
---

Fix config globs with a hyphen, which crashed the CLI with exit 1; a glob that cannot compile, starts with `./` or ends with a slash is now a config error. A `__proto__` key under ruleSettings is rejected as an unknown rule id instead of being dropped. A `--format` or `--lang` with no value is a usage error (exit 2). Markdown masking is linear in the number of paragraphs. A directive written inside inline code is no longer applied. Markdown with CRLF line endings masks tables, link definitions, setext underlines and thematic breaks as with LF. A multi-word anchor ("Power BI") counts only as whole words, so "power bill" no longer anchors a sentence.
