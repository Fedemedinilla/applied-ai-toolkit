# import-fences

A config-driven checker that turns architecture rules about imports into a failing test. A rule in a contributing guide can be broken by a new teammate who never read it, or by a coding agent that lost it from context, and nothing fails. Here the build fails with the file, the line, the rule and the reason. Typical rules: browser code never reaches a Node built-in, even three files away; one file imports the API client and nobody re-exports it; one file reads the API key. I extracted it from production work, where each of these rules was a hand-written test over the import graph.

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

`--json` prints the same as JSON. Exit codes: 0 no violation, 1 at least one, 2 bad usage or an invalid config. Without `--config` the CLI loads `import-fences.config.ts` from the current folder. Node 24 runs the TypeScript sources directly (type stripping), so there is no build step, and the only dependencies are `typescript` (the parser) and `zod` (the config check).

## The config

A config is a TypeScript module. Groups name sets of files by glob; each rule applies to one group.

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

Globs use `**` across folders, `*` and `?` inside one name and `{a,b}` for alternatives. Paths are relative to `root`, which is relative to the config file. `node_modules`, `.git`, `dist` and `coverage` are ignored unless `ignore` says otherwise. Only `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files are read. Every rule takes an optional `why`, printed after the reason, so whoever breaks a fence reads why it exists.

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
| `test/glob.test.ts` | `**`, `*`, `?`, alternation, escaping and the folder matched by a trailing `/**` |
| `test/repo.test.ts` | This repository's fences, the witness and the folder-fence tree described above |

## Adopting it

1. Copy the folder; it needs `typescript` and `zod`.
2. Write a config with one group and one rule you already follow, and run the CLI. Fix or allow what it reports. An `allow` entry is an exception with a name, and `stale-allow` removes it from the list once the code no longer needs it.
3. Add a test like `test/repo.test.ts` so the suite enforces it, or run the CLI as a CI step; exit code 1 fails the job.
4. Add `why` to every rule. The reason in the output is what a teammate or an agent reads at the moment they break the fence.

## Limits

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
