# import-fences

A config-driven checker that turns architecture rules about imports into a failing test. A rule in a contributing guide can be broken by a new teammate who never read it, or by a coding agent that lost it from context, and nothing fails. Here the build fails with the file, the line, the rule and the reason. Typical rules: browser code never reaches a Node built-in, even three files away; one file imports the API client and nobody re-exports it; one file reads the API key. I extracted it from production work, where each of these rules was a hand-written test over the import graph.

## Install

```sh
npm install --save-dev @fedemedinilla/import-fences
npx import-fences --config import-fences.config.json
```

```ts
import { check, defineConfig, diskSource, loadConfig, NODE_BUILTINS, toSarif } from '@fedemedinilla/import-fences';
```

The package entry is built from `src/index.ts`, and the `import-fences` bin is built from `cli.ts` and takes the same arguments as `node import-fences/cli.ts`. Inside this repository nothing changes. Node runs the `.ts` files directly, and the paths below stay as they are.

- **The package ships JavaScript.** Node does not strip types for files inside `node_modules`, so `npm pack` compiles `cli.ts` and `src/` to `dist/` with [`tsconfig.build.json`](tsconfig.build.json), with declarations and source maps that carry the text of the `.ts` sources, which are not shipped.
- **`typescript` is a dependency, pinned to 5.9.3, and not a peer.** The checker parses files with the compiler API and reads `importClause.phaseModifier` to tell `import type` from a value import. That field exists since 5.9. An older compiler would leave it undefined, and every `import type` would count as code with no error to show for it. The project's own TypeScript can be any version, since this copy is only a parser and is installed next to it. The cost is a second copy on disk, about 23 MB, when the versions differ.
- **`zod` is a dependency, pinned to 4.6.7.** It validates the config. A caller never passes a zod schema in, so nothing has to be shared with the project's copy.
- **A config written in TypeScript still works.** The config is the project's own file, outside `node_modules`, so Node 24 strips its types when the installed bin imports it. It can import `defineConfig` and `NODE_BUILTINS` from `@fedemedinilla/import-fences`. It has to be erasable TypeScript (no `enum`, no `namespace`), and anything it imports must be something Node can load. A project on an older Node, or one that prefers no code in its config, uses the JSON form.
- **`import` and `require()` both load it.** Each `exports` entry pairs `types` with `default`, and Node 24 loads an ES module through `require()`.
- **Node 24 or newer** (`engines`). That is the only version the tests and CI run.
- **The build is checked as installed.** [`test/packaging/pack-check.ts`](../test/packaging/pack-check.ts) packs the package, installs the tarball in an empty project, compares its exports with the source, and runs the installed bin and `node import-fences/cli.ts` on the same inputs to compare output and exit code. One of those inputs is a `.ts` config in that project that imports the installed package.

## Run it

From the repository root:

```sh
npm ci
npx vitest run import-fences                                   # offline, no API key
node import-fences/cli.ts --config import-fences/repo.config.ts # this repository's own fences
```

Output, one line per violation, then a summary:

```
web/a.ts:1:1  relative-extension  imports ./b without a file extension; Node does not resolve it (write ./b.ts)
web/a.ts:2:1  forbidden-import  imports node:fs, forbidden in group "browser". Why: browser code has no Node built-ins
import-fences: 2 violations in 3 files, 2 rules
```

`--json` prints the same as JSON, and `--sarif` prints a SARIF 2.1.0 log (see SARIF for code scanning). Exit codes: 0 no violation, 1 at least one, 2 bad usage or an invalid config. Without `--config` the CLI loads `import-fences.config.ts` from the current folder, or `import-fences.config.json` when there is no `.ts` one. Node 24 runs the TypeScript sources directly (type stripping), so there is no build step, and the only dependencies are `typescript` (the parser) and `zod` (the config check).

## The config

A config is a TypeScript module or a JSON file. Groups name sets of files by glob; each rule applies to one group.

```ts
import { defineConfig, NODE_BUILTINS } from './import-fences/src/config.ts';

export default defineConfig({
  root: '.',
  groups: {
    browser: { include: ['apps/*/src/**'], exclude: ['**/*.test.ts'] },
    source: { include: ['**/*'], exclude: ['**/test/**', '**/*.test.ts'] },
  },
  rules: [
    { rule: 'forbidden-import', group: 'browser', specifiers: [...NODE_BUILTINS, '@anthropic-ai/sdk'], paths: ['server/**'], typeOnly: 'allow' },
    { rule: 'dynamic-import', group: 'browser' },
    { rule: 'single-importer', group: 'source', package: '@anthropic-ai/sdk', allow: ['server/llm/client.ts'] },
    { rule: 'single-reader', group: 'source', variable: 'ANTHROPIC_API_KEY', allow: ['server/llm/setup.ts'], why: 'the key is passed in, never read by library code' },
    { rule: 'relative-extension', group: 'source' },
  ],
});
```

Globs use `**` across folders, `*` and `?` inside one name and `{a,b}` for alternatives. Paths are relative to `root`, which is relative to the config file, and are written without a leading `./` or `/` and with forward slashes; a glob written otherwise, or with unbalanced braces, stops the run with exit code 2, since it would match nothing. `node_modules`, `.git`, `dist` and `coverage` are ignored unless `ignore` says otherwise. Only `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files are read. Every rule takes an optional `why`, printed after the reason, so whoever breaks a fence reads why it exists.

### A JSON config, and a minimal example

A path that ends in `.json` is read as JSON, with the same keys. A project that has `src/client`, `src/server` and one module that creates the SDK client can start from this file, saved as `import-fences.config.json` at its root:

```json
{
  "$schema": "https://raw.githubusercontent.com/Fedemedinilla/applied-ai-toolkit/main/import-fences/schema/config.schema.json",
  "groups": {
    "client": { "include": ["src/client/**"] },
    "source": { "include": ["src/**"], "exclude": ["**/*.test.ts"] }
  },
  "rules": [
    { "rule": "forbidden-import", "group": "client", "specifiers": ["node:*"], "paths": ["src/server/**"], "why": "client code ships to the browser" },
    { "rule": "single-importer", "group": "source", "package": "@vendor/sdk", "allow": ["src/server/llm/client.ts"], "why": "every call goes through one client" },
    { "rule": "single-reader", "group": "source", "variable": "VENDOR_API_KEY", "allow": ["src/server/llm/client.ts"] }
  ]
}
```

It says three things. No file under `src/client` reaches a `node:` built-in or a file under `src/server`, however many imports away. Only `src/server/llm/client.ts` imports values from `@vendor/sdk`. Only that file reads `VENDOR_API_KEY`. `test/schema.test.ts` runs this exact block over a tree with that layout and expects zero violations.

- **`$schema` is for the editor.** [`schema/config.schema.json`](schema/config.schema.json) is a JSON Schema (draft 2020-12) generated from the zod schema the CLI validates with, by `node import-fences/scripts/write-schema.ts`; a test fails when the two differ. An editor that reads it completes rule names and flags an unknown key while typing. The CLI ignores the key and validates the rest itself, so a config without `$schema` works the same.
- **The schema cannot say everything.** Three checks compare one part of the config with another: a rule names a group that exists, a `forbidden-import` rule has `specifiers` or `paths`, and `except` comes with `paths`. JSON Schema has no clean way to write them, so the editor accepts those mistakes and the CLI stops on them with exit code 2.
- **JSON has no `NODE_BUILTINS`.** `"node:*"` covers every import written with the prefix. The bare spellings (`fs`, `path`) have to be listed one by one in JSON; a `.ts` config spreads `NODE_BUILTINS`, which holds both.
- **JSON cannot compute.** This repository's own config lists the folders on disk and builds one rule per folder, so it is a `.ts` module. A config that is a fixed list fits in JSON.
- **Add `relative-extension` only where Node runs the sources.** A project whose bundler resolves `./x` to `./x.ts` would get one violation per import.

## Rule reference

| Rule | Options | Reports |
|---|---|---|
| `forbidden-import` | `specifiers`: package names (subpaths match) or prefixes ending in `*`. `paths`: repository globs. `except`: globs carved out of `paths`, such as a library's public entry. `typeOnly`: `forbid` (default) or `allow`. `transitive`: follow relative imports (default true). `external`: bare specifiers to accept as known, such as virtual modules. | `forbidden-import` at the line that imports a forbidden package or path, with the chain from the group file that reached it. `unresolved-import` when the walk cannot follow: a computed `import()`, a relative path that names no file, a bare specifier that is neither a built-in nor installed. |
| `single-importer` | `package`, `allow`: globs of the files that may import its values. `typeOnly`: `allow` (default) lets every file import its types. | `single-importer` for any other import of the package, in any form. `no-reexport` for any file of the group, allowed or not, that hands a value of the package to its importers. |
| `single-reader` | `variable`, `allow` | Every identifier or exact string with the variable's name outside the allowed files: `process.env.X`, `process.env['X']`, `import.meta.env.X`, `const { X } = process.env`, `const name = 'X'`. |
| `single-string` | `text`, `allow` | String and template literals containing `text` outside the allowed files, such as an API host. |
| `relative-extension` | none | A relative import, export, `import()`, `require()` or `import('./x')` type that has no extension, names a folder, or names a file that does not exist (`./x.js` for `x.ts`). Where the file can be found, the reason gives the fix. |
| `dynamic-import` | none | `import()`, `require()` and `new URL(x, import.meta.url)` with a computed argument, and `import.meta.glob()`. |

Two more ids come from the config itself. `empty-group` reports a group that matches no file (set `allowEmpty: true` for a group kept for code that does not exist yet). `stale-allow` reports an `allow` entry that matches no file of the group, or matches files that no longer do what it allows, and an `except` entry that no import of the group uses.

## SARIF for code scanning

`--sarif` prints one SARIF 2.1.0 log to stdout, the format GitHub code scanning reads. It replaces the text output. It cannot be combined with `--json`; asking for both is a usage error with exit code 2 and nothing on stdout. The exit codes do not change, so a job can upload the log and still fail on a violation.

```sh
node import-fences/cli.ts --config import-fences/repo.config.ts --sarif > import-fences.sarif
node ../import-fences/cli.ts --sarif --sarif-base .. > import-fences.sarif   # run inside a package of a monorepo
```

What the log holds:

- One run. `tool.driver` names import-fences and lists the ten rule ids of the rule reference, always all of them and in the same order, each with a name, a short and a full description, and a link to the rule reference.
- One result per violation, with level `error`, since every violation fails the CLI. `ruleId` is the id the text report prints, such as `forbidden-import`. The message is the reason, followed by the rule's `why` when it has one, exactly as in the text report.
- A violation in code points at the file that holds the import, with the line and the column of the statement. Columns count UTF-16 code units, and `columnKind` says so. For a crossing reached through other files, that is the file whose import crosses the fence, and the message names the chain.
- `stale-allow` and `empty-group` are results too, since they fail the run. They point at the config file and carry no line: the checker knows which entry is stale, not where in the file it is written.
- `artifactLocation.uri` is relative to `--sarif-base` (default: the current folder), with forward slashes and each segment percent-encoded. Code scanning resolves it against the repository root, so run the CLI from there or pass the root as `--sarif-base`. A file outside the base gets an absolute `file:` URI instead of a `../` path. `--sarif-base` without `--sarif` is a usage error.
- `partialFingerprints` holds one value under `importFencesViolation/v1`: a SHA-256 of the rule id, the uri and the reason, cut to 32 hex digits, plus `:1`, `:2` for the same violation repeated in one file. No line, column or `why` goes in, so code added above an import, or a reworded `why`, keeps its alert instead of closing it and opening a new one. Renaming the file, or a change in the chain that reaches it, makes a new alert.
- Results are sorted by uri, line, column, rule id and message, compared by code unit. The same tree gives the same bytes on any machine. No timestamp, host name, absolute path or tool version goes in.

## Use it in CI

The folder is also a composite GitHub Action, [`action.yml`](action.yml). It installs Node 24 with `actions/setup-node`, then `typescript` and `zod` into the action's own folder, and runs the checker over the workspace twice. The first run prints the text report to the job log. The second writes the SARIF log, with paths relative to the workspace. This workflow checks the fences on every pull request, uploads the violations to code scanning and then fails the job if a fence is broken:

```yaml
name: Import fences

on:
  push:
    branches:
      - main
  pull_request:

jobs:
  fences:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # Only if a forbidden-import rule has to tell an installed package from a typo; see below.
      - run: npm ci --ignore-scripts

      - id: fences
        # Pin a full commit SHA of this repository, not a branch.
        uses: Fedemedinilla/applied-ai-toolkit/import-fences@<commit SHA>
        with:
          config: import-fences.config.json
          fail: false

      - uses: github/codeql-action/upload-sarif@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3
        with:
          sarif_file: ${{ steps.fences.outputs.sarif-file }}
          category: import-fences

      - name: Fail on a broken fence
        if: steps.fences.outputs.exit-code != '0'
        run: exit 1
```

With `fail: false` the action reports exit code 1 instead of failing, so the upload still runs and the last step fails the job. Exit code 2 (bad usage, a missing or invalid config) fails the action whatever `fail` says, and no SARIF is written. `security-events: write` is what the upload needs; in a private repository, upload-sarif also needs `actions: read`. A pull request from a fork gets a read-only token, so the upload fails there.

| Input | Meaning |
|---|---|
| `config` | Required. The config file, `.json` or `.ts`, relative to the workspace. |
| `sarif-file` | Where to write the SARIF log. Default: `import-fences.sarif` in the runner's temporary folder. A path that names a folder, or a log that cannot be written, is exit code 2. |
| `fail` | `true` (default) fails the step when a fence is broken. `false` only sets `exit-code`. |

| Output | Meaning |
|---|---|
| `sarif-file` | The path of the SARIF log, empty after exit code 2. |
| `exit-code` | 0, 1 or 2, as for the CLI. |

How it behaves, and why:

- **Inputs are data, never code.** They reach the shell only as quoted environment variables, never as `${{ inputs.* }}` inside a `run:` script, so a value such as `$(...)` is a file name and nothing else. `test/action.test.ts` reads `action.yml` and fails if that changes, and runs its shell step with hostile inputs.
- **Exit code 2 always fails the step.** A config that does not load means no fence was checked. `fail: false` is for violations; a broken config that passed would hide every violation from then on.
- **The config is the only input.** Which files are read comes from the config's `root`, groups and `ignore`, so the action and a local run check the same set.
- **`npm ci` is needed only for `unresolved-import`.** A `forbidden-import` rule reports a bare specifier that is neither a built-in nor a package under `node_modules`. Without an install step every package import of the group is reported that way. The other rules read source files alone.
- **A `.ts` config must be self-contained here.** It runs through Node's type stripping, which needs erasable TypeScript only (no `enum`, no `namespace`). The action is not installed in the workspace, so the config cannot import `defineConfig` from it. Export the plain object, or install the npm package and import from that.
- **Paths are relative to the workspace.** A repository checked out into a subfolder (the `path` input of `actions/checkout`) gets paths that code scanning cannot map. Run the CLI with `--sarif-base` set to that subfolder instead.
- **The checker runs twice**, once per output, so the step takes twice as long as one CLI run. The CLI prints one format per run, which kept the text and JSON outputs unchanged.
- **setup-node stays set up.** The composite step changes the job's Node to 24 for the steps after it too.

## Design decisions

**The AST, never a regex.** Files are parsed with the TypeScript compiler API, so a commented-out import never counts, while `import type`, `export * from`, a `require()` inside a function and a template-literal `import()` all do. A regular expression over file text can read `// import x from '../server/client'` as an import, and can miss `import{x}from'../server/client'` or an `import()` split across lines. Each file is parsed with `ts.createSourceFile` and only nodes count. Comments are not nodes, and strings only count where a rule asks for strings. Tests feed comments and strings that look like imports and expect nothing, and feed the compact and multi-line forms and expect them found.

**Type-only is decided per declaration.** `import type A`, `export type { A } from 'x'` and `typeof import('x')` are erased. Everything else runs the module, including `import { type A, type B } from 'x'`: under `verbatimModuleSyntax` tsc emits it as `import {} from 'x'`, and Node's type stripping keeps it too (a probe file with only that import, run under `node`, printed its side module's log line). The checker reports that form with the hint to write `import type`. Getting this wrong goes one of two ways. Types reported as code are noise that teaches people to ignore the check, and a value import treated as a type is a hole. In TypeScript 5.9 `import type` is reported by `importClause.phaseModifier`; the older `isTypeOnly` is deprecated since `import defer` arrived, so the checker reads the new field.

**Forbidden means reachable, not imported.** The case that matters is indirect. A browser file imports a shared helper, which imports another file, which imports the server module. `forbidden-import` walks relative imports breadth first from every file of the group, into any file of the repository, and reports the line that crosses the fence with the chain that led there. Each file is read once and each crossing is reported once, however many entries reach it.

**A walk that cannot follow says so.** A computed `import()`, a path that names no file and an alias such as `~/lib/x` are places where the walk would otherwise stop silently and pass. They are reported as `unresolved-import`. The error goes toward reporting too much, so a virtual module that the bundler provides has to be declared in `external`.

**Computed imports are reported on their own.** Vite turns ``import(`../server/${name}.ts`)`` into a glob and bundles every file that matches, and the build gives no warning. `dynamic-import` flags every computed `import()`, `require()` and `new URL(..., import.meta.url)`, and every `import.meta.glob()`, in the group it is given. It is a separate rule because server code loads computed paths on purpose. The CLI of this folder loads its config that way.

**Single importer, and no second door.** One module creates the API client so that every call goes through the spending caps. A barrel file that does `export * from '@anthropic-ai/sdk'`, or a file that imports the client and exports it again as `export const make = Client`, hands the client to files that never import the package. `no-reexport` covers `export *`, `export * as` and `export { x } from`. It also follows a value bound from the package by `import`, `import x = require()` or `const x = require()`, through top-level aliases (`const k = Client`, `class K extends Client {}`), to where it leaves: `export { }`, `export default`, `export =`, an exported `const`, an exported subclass, or `module.exports`. Member access such as `sdk.Client` counts too. Types may leave, since they create nothing.

**A reader is anything that names the variable.** `process.env['KEY']`, a destructuring, `import.meta.env.KEY` and a name kept in a constant all read it. Matching only `process.env.KEY` would miss most of them. The rule therefore counts every identifier or exact string with the name, and nothing else. A comment, or an error message that mentions the name among other words, does not read it. The host of the API gets the same treatment through `single-string`, because a hand-written `fetch` to the API needs the host and the key, and fencing both closes the path that skips the SDK.

**Extensions because Node runs the sources.** Node 24 strips types and runs `.ts` files, and it does not resolve `./x` to `./x.ts` the way a bundler does. A missing extension passes under Vitest and fails under `node`. `relative-extension` reads the specifier as written and checks that it names an existing file, and the reason says which file a bundler would have picked.

**Configs fail closed.** The config is validated with zod and every object is strict. A misspelled rule name, an unknown group or an option such as `pakage` stops the run with exit code 2 instead of turning a fence off. Groups that match no file and allow entries that match nothing are reported, because both happen when a folder is renamed and both leave a rule checking nothing.

## This repository's fences

`repo.config.ts` holds the fences of this repository, and `test/repo.test.ts` runs the CLI with it on every CI run and expects zero violations.

- Every relative import in the repository carries its extension and names an existing file.
- Outside tests, only `gateway/src/client.ts`, `gateway/src/errors.ts` (which classifies the SDK's error classes) and `evals/scripts/cli.ts` (the opt-in live runner) import values from `@anthropic-ai/sdk`. Other files import its types. No file re-exports it.
- Outside tests, only `gateway/examples/live-call.ts` and `evals/scripts/cli.ts` read `ANTHROPIC_API_KEY`, and only `gateway/src/client.ts` contains the API host.
- `amount-parser/src` (documented as importable by a browser app) and any future `apps/*/src` reach no Node built-in, no SDK and no gateway file, and use no computed import.
- Shipped code imports nothing under `test/`, `tests/` or `fixtures/`.
- Library folders (every top-level folder except `apps/`) import nothing from another folder, so each one can be copied out alone.
- An app under `apps/` is built on libraries and may use one only through what it publishes, which is its public entry and its published data (`amount-parser/src/index.ts` and `amount-parser/corpus/*.json`). `PUBLIC_SURFACE` in the config lists what each library publishes, and `APP_USES` lists the published entries each app uses, each one taken from `PUBLIC_SURFACE`. A library's internals, every folder's `test/` and other apps stay closed. No library imports an app.
- The config builds one rule per library and per app by listing the folders on disk, which is the reason it is TypeScript rather than JSON.

The app rule exists because the alternative rules both fail. A rule that forbids every crossing fails on the first app, since apps are meant to be built on the libraries. A rule that allows an app to import a whole library lets it import `amount-parser/test/corpus-data.ts` or an internal module. After that, the library cannot rename its own files without breaking an app it has never heard of. The public entry and the published data are the interface; the rest is free to change. Each crossing is checked as written (`transitive: false`), because the walk would otherwise follow `index.ts` into the library's own files, which the library may import freely. `APP_USES` names entries, not whole libraries, because the run reports every `except` entry nothing matches as stale. An app that used only `amount-parser/src/index.ts` would otherwise fail for never reading the corpus. Each app lists what it uses, an entry it stops using is reported, and so `APP_USES` stays a true list of dependencies.

The same test removes `gateway/src/client.ts` from the SDK exception and checks that exactly that file and line are reported, so a fence that stopped seeing the code would fail instead of passing. It also runs the folder fences, with the real `PUBLIC_SURFACE` and `APP_USES`, on a small tree shaped like this repository. An app that imports the public entry and points `new URL()` at the corpus passes, and so does an app that names and imports only the public entry. An entry the app no longer uses is reported as stale, and naming an entry the library does not publish stops the config. The test expects a report for an app that imports an internal module, a test helper, another app or an undeclared library, and for a library that imports an app or another library. On this repository (210 files; one rule per library folder and per app, plus eight others) a run took about one second in a cloud container in November 2026.

## What the tests cover

| File | Covers |
|---|---|
| `test/extract.test.ts` | Every import form with its line; type-only detection case by case, including inline `type` bindings that still load the module; `require()` inside a function; templates with and without `${}`; `new URL()` and `import.meta.glob`; comments and strings that look like imports; JSX files; every re-export form, through `require()`, `import = require()`, local aliases, subclasses and `module.exports`, and the type re-exports that are allowed; every way to read an environment variable and the mentions that are not reads |
| `test/rules.test.ts` | One small in-memory tree per case: built-ins in both spellings, the transitive chain, type-only allowed or forbidden, files reached only through types, `export * from`, `?raw`, `new URL()`, bundler-style resolution, unresolved imports and `external`, deduplication, `except` (the public entry passes, the internal file next to it does not, an unused entry is stale), the single-importer and re-export cases, stale allow entries, readers and strings, extension hints, computed imports, empty groups |
| `test/config.test.ts` | Defaults; eight malformed configs that must stop the run; specifier patterns and `NODE_BUILTINS` |
| `test/cli.test.ts` | Exact text output and exit code 1, JSON and exit code 0, exit code 2 for bad usage, a missing config and an invalid one, on trees written to a temporary folder |
| `test/sarif.test.ts` | The log against a zod schema of what code scanning requires; one result per violation at the same file, line and column; config violations at the config file; order and byte-identical reruns; `--sarif-base`, a config in a subfolder and paths that need encoding; fingerprints that survive moved lines and a reworded `why`; the usage errors |
| `test/output-regression.test.ts` | The text and JSON output of a tree with eight of the ten rule ids, and of a clean one, byte for byte against `test/golden/`, written by the CLI before `--sarif` existed |
| `test/schema.test.ts` | The committed JSON Schema equals the generated one; a JSON config gives the result of the same config as a module; default lookup; malformed JSON configs; the README's JSON example on the layout it describes |
| `test/action.test.ts` | `action.yml` read as text: no expression in a run block, inputs only through `env:`, the pinned setup-node, the dependency versions; the run step executed in bash on passing, failing, invalid and hostile inputs |
| `test/glob.test.ts` | `**`, `*`, `?`, alternation, escaping and the folder matched by a trailing `/**` |
| `test/repo.test.ts` | This repository's fences, the witness and the folder-fence tree described above |

## Adopting it

1. Install the package, or copy the folder; a copy needs `typescript` 5.9 and `zod`.
2. Write a config with one group and one rule you already follow, and run the CLI. Fix or allow what it reports. An `allow` entry is an exception with a name, and `stale-allow` removes it from the list once the code no longer needs it.
3. Add a test like `test/repo.test.ts` so the suite enforces it, or run the CLI or the action as a CI step; exit code 1 fails the job.
4. Add `why` to every rule. The reason in the output is what a teammate or an agent reads at the moment they break the fence.

## What it does not do

- It does not type-check, lint style or find unused code. It reads imports, the names of environment variables and string literals, and nothing else.
- It does not prove that code cannot reach something at runtime. A fence holds for what is written as an import; the items below list what gets around one.
- It does not draw the dependency graph or find cycles.
- It does not upload SARIF. The action writes the file, and the workflow uploads it.
- No `.svelte`, `.vue` or `.astro` files. The source handled them with `svelte/compiler` and by splitting Astro frontmatter from `<script>` tags; both need a dependency or a parser this folder does not have. A component that imports a module is invisible, though the modules it imports are still checked if they belong to a group.
- `no-reexport` does not follow a value through a function. `export function make() { return new Client(); }` is not reported, and this repository's gateway does exactly that on purpose. Aliases are followed only at the top level of the file. The single-importer rule still reports any other file that imports the package.
- Symbolic links are not followed when the CLI lists files. A linked file or folder is not checked.
- The walk does not enter `node_modules`. A package that itself imports `node:fs` is not seen; forbid the package by name.
- Resolution is relative paths, root paths starting with `/`, `.js` written for `.ts`, `.tsx` or `.d.ts`, extensionless paths and `index` files. `tsconfig` `paths` aliases, package `exports` maps and `#imports` are not resolved. An alias is reported as unresolved until it is declared in `external`, and then it is not followed.
- `require` is any call to an identifier named `require`. A `require` obtained from `createRequire` under another name, or `require.resolve`, is not read.
- `single-reader` sees names, not values. `new Anthropic()` with no arguments reads `ANTHROPIC_API_KEY` inside the SDK, and so does any code that passes `process.env` whole to a library. In this repository `evals/scripts/cli.ts` does the first; it is in the allow list because it also checks the variable by name before calling.
- Only imports and `new URL(x, import.meta.url)` are seen. A file read through `node:fs` with a path built by `join` or `resolve` is not an import and is not fenced, so `readFileSync(join(here, '../../amount-parser/test/reference-output.json'))` in an app would pass. In this repository `apps/caja/vite.config.ts` reads the corpus through `new URL()` so the fence sees it. `apps/caja/test/app.dom.test.ts` still joins a path, because under jsdom the global `URL` is jsdom's and `node:fs` does not accept it; that read is of published data, but no rule checks it.
- A rule with `transitive: false` checks only literal imports in the group's own files. Pair it with `dynamic-import` where computed imports matter.
- The checker reports, it does not fix, and it has no inline suppression comments on purpose. An exception lives in the config, under review, with its file named.
