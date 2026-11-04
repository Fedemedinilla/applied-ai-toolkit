# CSP build guard

A CLI that audits a built static site (a `dist/` folder) or a Vercel Build Output folder before it is deployed. It catches five failures that only show in production, because a dev server neither bundles like the build nor sends the deploy's headers. An inline script whose hash went stale is blocked by the browser. A policy drifts from what was reviewed. A secret is inlined by the bundler. A regex lookbehind stops a whole module on older Safari. The JavaScript a page loads keeps growing. Each check reads the build and the deploy configuration from disk, with no server and no network. I extracted it from the build scripts of two production sites, where each check was added after one of those failures or to keep it from happening.

## Run it

From the repository root:

```sh
npm ci
npx vitest run csp-build-guard     # offline, no API key

# A passing fixture and a failing one
FIXTURE_SECRET=fixture-secret-value-0001 node csp-build-guard/cli.ts \
  --dir csp-build-guard/fixtures/pass/site --config csp-build-guard/fixtures/pass/csp-guard.config.json
FIXTURE_SECRET=fixture-secret-value-0001 node csp-build-guard/cli.ts \
  --dir csp-build-guard/fixtures/stale-hash/site --config csp-build-guard/fixtures/stale-hash/csp-guard.config.json --json
```

In this repository's CI it runs after the build of each app under [`apps/`](../apps/), with each app's own config. For [`apps/caja`](../apps/caja/), with [`apps/caja/csp-guard.config.json`](../apps/caja/csp-guard.config.json):

```sh
npm run build:apps
node csp-build-guard/cli.ts --dir dist/apps/caja --config apps/caja/csp-guard.config.json   # part of npm run guard:apps
```

```
csp-build-guard: dist/apps/caja (1 HTML page)
PASS inline-hashes  0 inline scripts and styles on 1 page, 0 distinct, all allowed by hash; no stale hash
PASS policy         1 page sends exactly the expected policy (9 directives)
SKIP headers        no headers in the config
PASS secrets        11 files searched, no value of ANTHROPIC_API_KEY
PASS lookbehind     2 browser files and 0 inline scripts, no regex lookbehind
PASS js-budget      1 page within budget, heaviest index.html at 18.6 kB gzip, 16.9 kB brotli
         18.6 kB gzip   16.9 kB brotli  index.html  (gzip <= 20, brotli <= 18 kB)
OK: 5 checks passed, 1 skipped
```

Caja has no deploy config yet, so it sends no policy of its own. Its config holds, as a `literal` policy, the strict one a host should send for it (`'self'` for scripts, styles, the manifest, the worker, the corpus fetch and the model-mode API, `data:` images, no plugins). The run shows that the build works under that policy with no inline script to hash. No module uses a regex lookbehind that older Safari cannot parse, and the JavaScript of `index.html` stays within its budget. Caja's optional server reads `ANTHROPIC_API_KEY`, so the config lists it under `secrets` with `missing: "skip"`. CI sets a placeholder value for it and for each other app's secret variables, so the search runs there; a local run without them skips it. In a project with real secrets, run the guard with the same environment the build had.

Without `--config` it looks for `csp-guard.config.json`, then `csp-guard.config.ts`, in the current folder. Exit codes: 0 when every check passed or was skipped, 1 when a check failed, 2 for bad usage, an invalid config or a missing input file. `--json` prints the full report, with per-page sizes and the files behind them.

The human report has one line per check, then one line per failure. This is the `stale-hash` fixture, cut after the first passing check:

```
csp-build-guard: csp-build-guard/fixtures/stale-hash/site (2 HTML pages)
FAIL inline-hashes  2 problems with inline scripts and styles
     - script-src does not list 'sha256-YSTNrpfIyqR0fDGCH3SuGJnsFBYz/88U40wl7pzYU9g=', the hash of an inline <script> on about/index.html and 1 more page. The browser blocks it. If the content changed on purpose, replace the old hash with this one.
     - script-src lists 'sha256-l2rlx9AdVltct3vNjFj7Ba2RsyBsJgijalc2DD9opMI=', which matches no inline content on about/index.html and 1 more page. A stale hash keeps allowing inline content nobody ships; remove it.
PASS policy         2 pages send exactly the expected policy (9 directives)
```

## The checks

The five checks below map to the five failures above. The report also has a sixth line, `headers`, for the optional check of other response headers described after check 2.

### 1. Inline hashes (`inline-hashes`)

A policy that allows inline scripts by hash breaks the moment the script changes. In the source site, `vercel.json` listed one sha256 for a small theme script inlined in every page. Edit that script and the hash no longer matches: the browser blocks it, the wrong theme flashes, and nothing in the build fails. The check hashes every inline `<script>` and `<style>` of every page, the way the browser does (after the HTML parser turns CRLF into LF), and fails when:

- an inline script or style has no listed hash in the directive that governs it (`script-src-elem`, then `script-src`, then `default-src`, as CSP3 falls back);
- a listed hash matches no inline content on the pages served with that policy. A stale hash keeps allowing a script nobody ships. A hash in a directive that more specific ones shadow (`script-src` next to both `script-src-elem` and `script-src-attr`) is reported too, since it has no effect;
- that directive holds `'unsafe-inline'`. This fails even next to hashes: CSP3 browsers then ignore it, but browsers without hash support fall back to it, and it signals that the policy was loosened;
- an event handler (`onclick="..."`) or a `style="..."` attribute is present without `'unsafe-hashes'` and its hash, since a hash-only policy blocks it;
- a page has no policy at all, so there is nothing to compare against.

JSON-LD and other data blocks are skipped, since CSP does not apply to them. Import maps are hashed, since it does. An empty `<script></script>` is skipped, since the browser runs no CSP check on it; a whitespace-only one is hashed. sha256, sha384 and sha512 hashes are all recognized. As in the browser, the algorithm can be in any case and the digest in base64 or base64url.

### 2. Exact policy (`policy`)

The policy every page receives is compared with the expected one as sets: the same directives, and in each the same sources, except for hashes where the config allows them. An extra source (`https:`, `*`, a host, `'unsafe-inline'`) or a directive nobody listed fails even when everything expected is there. Comparing the header as text would fail an equivalent policy whose sources are reordered; checking only that the expected sources are present would pass one that was loosened.

The parser reads the header as the browser does (CSP3 and Chromium). A directive with a character outside ASCII is dropped whole. In Chromium 141, `script-src 'none'` followed by a no-break space and another source was dropped, so the page had no script restriction and an inline script ran. When a directive repeats, the browser uses the first one, so a stricter copy later in the header does nothing even though a reviewer reads it. Both are failures. So are two rules in the deploy config that both set the policy for one page. A `<meta>` policy fails when it comes after a script or style, since it only covers what follows it. It also fails when it holds `frame-ancestors`, `report-uri` or `sandbox`, which the browser ignores in a `<meta>`. Each `<meta>` content is read as one policy, where a comma separates nothing, and a page with two `<meta>` policies fails, since the browser enforces both.

### Other headers (`headers`, optional)

A `headers` map in the config checks other response headers (`X-Content-Type-Options`, `Referrer-Policy`) for exact values, from the same deploy config. It needs a header-based `csp.from`; with `meta` or `literal` there are no headers to read, and the check fails if the map is set.

### 3. Secrets (`secrets`)

A server-only value can end up in a client bundle through one wrong import, and the build does not complain. The check reads the value of each named environment variable and searches every file under `--dir` for it, server functions included. It also searches the JSON-escaped, URL-encoded, base64 and base64url forms, and the decompressed contents of `.gz` and `.br` files. A variable that is unset or shorter than `minLength` (default 8) fails, because a check that could not run must not pass. Reports name the variable and the file, never the value; a test checks that the value is absent from both the text and the JSON output.

### 4. Regex lookbehind (`lookbehind`)

Safari before 16.4 cannot parse a regex lookbehind, `(?<=` or `(?<!`. One in a module and the whole module fails to load, with no error the visitor can see. In the source site two interactive demos did nothing on an iPhone running iOS 15 for exactly this reason. The check scans the configured browser files and every inline script and reports file, line and column. Named groups, `(?<name>`, are fine since Safari 11.1 and are not flagged. With `targets`, it runs only when a target predates support: Chrome 62, Edge 79, Firefox 78, Safari and Safari on iOS 16.4, Opera 49, Samsung Internet 8.2 (MDN compatibility data).

### 5. JavaScript budget (`js-budget`)

The JavaScript a page makes the browser download on load is measured against a budget per page glob. It counts external scripts, `modulepreload` links, Astro island URLs and inline scripts, then follows every static `import` and `export ... from` in those files. Dynamic `import()` does not count, since it loads later, on demand. Each file is measured compressed with gzip (level 9) and brotli (quality 11); a budget can limit either or both, in kB of 1000 bytes. A script from another origin, a bare specifier or a URL missing from the build is a failure, since an unmeasured file would read as zero.

## Configuration

`csp-guard.config.json`, or a `.ts` module whose default export is the same object. Relative paths resolve against the config file's folder. Every key is optional; a check without its section is skipped and the report says so.

```json
{
  "basePath": "/",
  "csp": { "from": "vercel-json", "file": "vercel.json" },
  "policy": {
    "default-src": ["'self'"],
    "script-src": { "sources": ["'self'"], "hashes": true },
    "style-src": { "sources": ["'self'"], "hashes": true },
    "img-src": ["'self'", "data:"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"]
  },
  "headers": { "X-Content-Type-Options": "nosniff" },
  "secrets": { "env": ["DATABASE_SECRET_KEY", "LLM_API_KEY"] },
  "lookbehind": { "files": ["_astro/**/*.js"], "targets": { "safari": "15.6" } },
  "budgets": [
    { "pages": "index.html", "gzipKb": 60 },
    { "pages": "**/*.html", "gzipKb": 100, "brotliKb": 90 }
  ]
}
```

| Key | Meaning |
|---|---|
| `basePath` | URL prefix the site is served under, such as `/app`. Stripped when mapping script URLs to files. Default `/`. |
| `exclude` | Globs of HTML pages to leave out of every check. |
| `csp.from` | Where pages get their policy. `vercel-json`: the `headers` rules of `file` (default `vercel.json` next to the config). `vercel-output`: the routes of a Build Output `config.json` (default the one in `--dir`). `netlify-headers`: a `_headers` file (default the one in the static root). `meta`: a `<meta http-equiv="Content-Security-Policy">` in each page. `literal`: `value`, the same for every page. |
| `policy` | Directive name to its sources. An array is the exact source list. `{ "sources": [...], "hashes": true }` also allows any number of hashes. |
| `inline.styles` | `hash` (default): inline styles need hashes like scripts. `skip`: styles are not checked, for a policy that keeps `'unsafe-inline'` in `style-src` on purpose. |
| `headers` | Other response headers with their exact values. Needs a header-based `csp.from`. |
| `secrets.env` | Environment variable names whose values must not appear. `minLength` (default 8) and `missing` (`fail` by default, or `skip`) tune what happens with a short or unset one. |
| `lookbehind` | `false` disables the check. `files`: globs of browser files under the static root (default `**/*.js` and `**/*.mjs`). `targets`: oldest version per browser (`chrome`, `edge`, `firefox`, `safari`, `ios`, `opera`, `samsung`), as a string such as `"16.4"` or a whole number. Versions compare part by part, so `"16.10"` is newer than `"16.4"`; a fractional number is rejected because `16.10` would read as `16.1`. Without `targets` any lookbehind fails. |
| `budgets` | A list of `{ "pages": glob, "gzipKb"?, "brotliKb"? }`. Each page uses the first entry whose glob matches its path relative to the static root. Pages that match none are counted in the summary and not measured. |

When `--dir` holds a `config.json` with a numeric `version` and a `static/` folder, it is read as a Vercel Build Output. Pages, browser files and budgets then come from `static/`, and the secrets search covers the whole folder, functions included.

## Design decisions

**Exact sets, not substrings.** In one source site, the build check only asked whether `script-src` held the right hashes and no `'unsafe-inline'`. A policy that also gained `https:` passed it. Comparing every directive and every source against a written-down policy makes loosening the policy a visible diff in the config, reviewed like code.

**Read the header the way the browser does.** A text comparison and a browser disagree on repeated directives and on non-ASCII characters. The parser follows CSP3 and Chromium on both, and its tests are the cases where a reader and the browser would see different policies.

**Stale hashes fail.** Leaving an old hash costs nothing on the day it goes stale, so old hashes pile up. Each one keeps allowing a script the site no longer ships, so anyone who can inject markup can replay that exact old script, and the policy no longer says what the site runs. Hashes are matched per group of pages that share one policy, so a hash used on one page of the group is not stale.

**A check that cannot run fails.** An unset secret variable fails, and so do a script URL that is not in the build and a page with no policy. A guard in CI that turns green because its input was missing is worse than no guard.

**Unreadable deploy rules are config errors.** vercel.json `source` patterns are converted from a subset of path-to-regexp. A pattern outside that subset, or a rule with `has` or `missing` conditions, exits with code 2 instead of being treated as a rule that never matches, which would leave pages unchecked.

**No browser, no server.** Every check reads files. That keeps the guard fast (a 90-page Astro build took about 4 seconds in my test run) and runnable in any CI job, at the cost of the checks listed under Limits.

## What the tests cover

103 tests in 6 files, all offline.

| File | Covers |
|---|---|
| `test/csp.test.ts` | The parser: whitespace, empty and repeated directives, non-ASCII drops, comma-joined policies; the exact comparison: extra and missing sources, hashes only where allowed, unlisted directives, case; CSP3 fallback lists |
| `test/html.test.ts` | Inline script and style extraction with CRLF normalization, empty scripts, data blocks, import maps, comments, quoted `>` in attributes, event handlers, meta policies and their position |
| `test/routes.test.ts` | vercel.json `source` patterns, Build Output routes, Netlify `_headers`, unsupported syntax, globs |
| `test/fixtures.test.ts` | Every committed fixture through the full run, with the exact failures each one must produce |
| `test/checks.test.ts` | Each encoded form of a secret found in a built file, a `.br` file decompressed, minified static imports with dynamic `import()` left out, version targets compared part by part (`"16.10"`, `"16.3"`), an empty inline script, uppercase and base64url hashes, a hash in a shadowed directive, commas and repeats in `<meta>` policies |
| `test/cli.test.ts` | Exit codes, the text and JSON reports, a secret value absent from all output, config errors, a `.ts` config |

The fixtures under `fixtures/` are tiny fictional builds, each with its own config. `pass`, `meta` and `netlify` pass every check that applies (`meta` has no header source, so `headers` is skipped). `stale-hash`, `unsafe-inline`, `inline-handler`, `policy-drift`, `secret-leak`, `lookbehind`, `over-budget` and `meta-misplaced` each fail one check in a known way. `vercel-output` is a Build Output folder whose server function holds the secret.

## Layout

```
cli.ts                 argument parsing, exit codes
src/
  csp.ts               the parser, the exact comparison, CSP3 fallback lists
  html.ts              inline content, script URLs and meta policies of a page
  routes.ts            header rules from vercel.json, Build Output config.json, Netlify _headers
  site.ts              build folder layout, page URLs, URL to file mapping
  config.ts            the config schema (zod) and loader
  run.ts               builds the context and runs the checks
  report.ts            the human report
  checks/              one file per check
test/                  Vitest suites
fixtures/              small builds that pass and fail each check
```

## Limits

- Two checks of the source scripts were left out because they need the app's own server. One ran the server function with marker values in place of each secret and searched the rendered responses. The other checked that the session cookie carries `Secure` on a real redirect. A secret that only reaches a page at request time is not caught here.
- Pages are found as `.html` files. Pages rendered on demand by a server function are not seen, nor are headers a server sets at runtime.
- The HTML reader is a tokenizer for what build tools emit, not a full HTML parser. It ignores `<base href>` and `<template>` contents.
- vercel.json patterns support a path-to-regexp subset. They are matched case-insensitively against each URL a page can be served at (`/blog/`, `/blog`, `/blog/index.html`). When two rules set the policy for one page the guard fails instead of guessing how the host merges them.
- Netlify `_headers` support covers path lines with `*` and `:placeholder` and indented header lines. It does not read `netlify.toml`.
- The lookbehind check searches text, so a lookbehind inside a string or a comment is also reported. That one only throws if the string reaches `new RegExp`, and the message says the whole script fails only for a regex literal.
- The secrets search finds standalone encoded forms; a value embedded inside a larger base64 blob at an unaligned offset is not found.
- Static imports are found with a regex, not a JavaScript parser. Any quoted specifier after `import` or `export ... from` is followed, so a query string (`./x.js?v=1`) still finds its file and an extensionless one fails as not in the build. Text in a string literal that looks like an import is followed too, and fails the same way. Inline scripts are compressed one by one, which slightly overcounts them.
- Nonces and `'strict-dynamic'` are outside the model, so a policy that relies on them fails the inline check.
