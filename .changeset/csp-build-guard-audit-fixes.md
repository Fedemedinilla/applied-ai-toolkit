---
'@fedemedinilla/csp-build-guard': patch
---

Fix audit findings. inline-hashes fails an empty delivered policy, checks `<meta>` policies next to a header policy, and no longer calls a script blocked when `'unsafe-inline'` lets it run. A `<meta>` policy outside `<head>`, in `<noscript>` or in `<template>` is ignored and reported. Attribute values are hashed with CRLF normalized. A `style-*` or `script-*` custom element is an ordinary tag. js-budget leaves out classic `nomodule` scripts and skips import-like text in comments and literals. It reports an invalid URL instead of crashing, and fails a budget glob that matches no page. The secrets search finds a value inside a larger base64 blob. A build folder with no HTML page exits 2. An empty `lookbehind.targets` is a config error. A byte order mark in config and rule files is ignored, and dangling symlinks are skipped.
