---
'@fedemedinilla/import-fences': patch
---

Report lines the way git and editors count them: a U+2028 or U+2029 inside a string no longer shifts every later line, and a leading BOM no longer adds a column on line 1.

A repository glob that starts with `./` or `/`, contains a backslash or has unbalanced braces is now a config error naming its key (exit code 2), instead of matching nothing or failing later with a generic error.

A `specifiers`, `external` or `package` entry with a `*` anywhere but at the end (`node:**`, `@vendor/*-internal`) is now a config error; before, it was compared literally and matched nothing.

The text and JSON reports sort violations in code-unit order, as SARIF already did, so the same tree prints the same bytes under every locale.

A JSON config saved with a UTF-8 byte order mark now loads; before, it failed as invalid JSON with exit code 2.

`loadConfig` imports a `.ts` config again when the file changed since the last call in the same process, instead of returning Node's cached first version.

The CLI no longer skips a whole folder when an `ignore` glob only matches its name: `src/*` keeps `src/a/x.ts` and `**/*.js` keeps the files of a folder named `chart.js`. A glob ending in `/**`, or one that names the folder with no wildcard (`**/vendor`), still drops it, and the disk and in-memory sources now list the same files.

`no-reexport` now reports a value of the package that leaves inside an object or array literal (`module.exports = { Client }`, `export default { Client }`, `export const api = { Client }`), through `export import x = require()`, or through `export import C = sdk.Client`.

`require` calls written `(require)('x')`, made through a variable set to `createRequire(...)` from `module` or `node:module`, or as `createRequire(...)('x')` are now read as imports by every rule.

`forbidden-import` looks for an installed package above the config root too, as Node does, so a workspace package with hoisted dependencies no longer reports each one as `unresolved-import`. `FileSource` gains an optional `packageInstalled` method, which `diskSource` implements.
