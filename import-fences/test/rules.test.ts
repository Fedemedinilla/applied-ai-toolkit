import { describe, expect, it } from 'vitest';
import { NODE_BUILTINS } from '../src/config.ts';
import { places, run } from './helpers.ts';

describe('forbidden-import', () => {
  const browser = { include: ['web/**'] };
  const rule = { rule: 'forbidden-import' as const, group: 'browser', specifiers: [...NODE_BUILTINS, 'sdk'], paths: ['server/**'] };

  it('reports a built-in in both spellings, with subpaths', () => {
    const v = run(
      { 'web/a.ts': ["import { readFileSync } from 'node:fs';", "import path from 'path';", "import { readFile } from 'fs/promises';"].join('\n') },
      { groups: { browser }, rules: [rule] },
    );
    expect(places(v)).toEqual(['web/a.ts:1 forbidden-import', 'web/a.ts:2 forbidden-import', 'web/a.ts:3 forbidden-import']);
    expect(v[0]?.reason).toBe('imports node:fs, forbidden in group "browser"');
  });

  it('follows relative imports out of the group and shows the chain', () => {
    const v = run(
      {
        'web/island.ts': "import { make } from '../shared/make.ts';",
        'shared/make.ts': "export { make } from './inner.ts';",
        'shared/inner.ts': "import { client } from '../server/client.ts';\nexport const make = client;",
        'server/client.ts': "import Sdk from 'sdk';\nexport const client = new Sdk();",
      },
      { groups: { browser }, rules: [rule] },
    );
    expect(places(v)).toEqual(['shared/inner.ts:1 forbidden-import']);
    expect(v[0]?.reason).toBe('imports server/client.ts, a path forbidden in group "browser", reached from web/island.ts -> shared/make.ts');
  });

  it('forbids type-only imports by default and lets them through with typeOnly: allow', () => {
    const files = {
      'web/a.ts': "import type { Message } from 'sdk';\ntype T = typeof import('../server/types.ts');",
      'server/types.ts': 'export const x = 1;',
    };
    expect(places(run(files, { groups: { browser }, rules: [rule] }))).toEqual(['web/a.ts:1 forbidden-import', 'web/a.ts:2 forbidden-import']);
    expect(run(files, { groups: { browser }, rules: [rule] })[0]?.reason).toContain('(type-only; this rule forbids types too)');
    expect(run(files, { groups: { browser }, rules: [{ ...rule, typeOnly: 'allow' }] })).toEqual([]);
  });

  it('does not follow a file reached only through types when they are allowed', () => {
    const files = {
      'web/a.ts': "import type { Shape } from '../shared/shape.ts';",
      'shared/shape.ts': "import { readFileSync } from 'node:fs';\nexport interface Shape { n: number }",
    };
    expect(run(files, { groups: { browser }, rules: [{ ...rule, typeOnly: 'allow' }] })).toEqual([]);
  });

  it('sees export * from, require() inside a function, a ?raw suffix and new URL()', () => {
    const cases = {
      exportStar: "export * from '../server/client.ts';",
      requireInFunction: "export function lazy() {\n  return require('../server/client.ts');\n}",
      raw: "import code from '../server/client.ts?raw';",
      url: "const worker = new URL('../server/client.ts', import.meta.url);",
      template: 'const m = await import(`../server/client.ts`);',
    };
    for (const [name, code] of Object.entries(cases)) {
      const v = run({ 'web/a.ts': code, 'server/client.ts': '' }, { groups: { browser }, rules: [rule] });
      expect(places(v), name).toHaveLength(1);
      expect(v[0]?.rule, name).toBe('forbidden-import');
    }
  });

  it('resolves .js written for .ts, extensionless paths and index files the way a bundler does', () => {
    for (const specifier of ['../server/client.js', '../server/client', '../server']) {
      const v = run({ 'web/a.ts': `import x from '${specifier}';`, 'server/client.ts': '', 'server/index.ts': '' }, { groups: { browser }, rules: [rule] });
      expect(v.map((x) => x.rule), specifier).toEqual(['forbidden-import']);
    }
  });

  it('reports what the walk cannot follow: a computed import(), a missing file, an unknown package', () => {
    const v = run(
      {
        'web/a.ts': ['const m = await import(`./locale/${lang}.ts`);', "import { x } from './missing.ts';", "import { y } from '~/alias';", "import { z } from 'installed';"].join('\n'),
        'node_modules/installed/package.json': '{}',
      },
      { groups: { browser }, rules: [rule] },
    );
    expect(places(v)).toEqual(['web/a.ts:1 unresolved-import', 'web/a.ts:2 unresolved-import', 'web/a.ts:3 unresolved-import']);
    const declared = run({ 'web/a.ts': "import { y } from 'virtual:env';" }, { groups: { browser }, rules: [{ ...rule, external: ['virtual:*'] }] });
    expect(declared).toEqual([]);
  });

  it('reports a group file that lives in a forbidden path', () => {
    const v = run({ 'web/server/x.ts': '' }, { groups: { browser }, rules: [{ ...rule, paths: ['**/server/**'] }] });
    expect(places(v)).toEqual(['web/server/x.ts:1 forbidden-import']);
  });

  it('with transitive: false, checks only the group files and ignores computed imports', () => {
    const files = {
      'web/a.ts': "import '../shared/b.ts';\nconst m = await import(name);",
      'shared/b.ts': "import '../server/c.ts';",
      'server/c.ts': '',
    };
    expect(run(files, { groups: { browser }, rules: [{ ...rule, transitive: false }] })).toEqual([]);
  });

  describe('except', () => {
    const app = { include: ['app/**'] };
    const fence = { rule: 'forbidden-import' as const, group: 'app', paths: ['lib/**'], except: ['lib/src/index.ts', 'lib/data/*.json'], transitive: false };
    const lib = { 'lib/src/index.ts': "export { parse } from './parse.ts';", 'lib/src/parse.ts': 'export const parse = 1;', 'lib/test/data.ts': '' };

    it('lets the group import the public entry and point new URL() at published data', () => {
      const files = {
        ...lib,
        'app/a.ts': "import { parse } from '../lib/src/index.ts';",
        'app/b.ts': "const data = new URL('../lib/data/cases.json', import.meta.url);",
      };
      expect(run(files, { groups: { app }, rules: [fence] })).toEqual([]);
    });

    it('still forbids internals and test helpers next to the public entry', () => {
      const files = {
        ...lib,
        'app/a.ts': "import { parse } from '../lib/src/index.ts';\nimport { parse as p } from '../lib/src/parse.ts';",
        'app/b.ts': "import '../lib/test/data.ts';\nconst data = new URL('../lib/data/cases.json', import.meta.url);",
      };
      const v = run(files, { groups: { app }, rules: [fence] });
      expect(places(v)).toEqual(['app/a.ts:2 forbidden-import', 'app/b.ts:1 forbidden-import']);
      expect(v[0]?.reason).toBe('imports lib/src/parse.ts, a path forbidden in group "app"');
    });

    it('reports an except entry that nothing in the group uses', () => {
      const files = { ...lib, 'app/a.ts': "import { parse } from '../lib/src/index.ts';" };
      const v = run(files, { groups: { app }, rules: [fence] });
      expect(places(v)).toEqual(['fences.config.ts:0 stale-allow']);
      expect(v[0]?.reason).toBe('except entry lib/data/*.json matches nothing that group "app" imports; remove it');
    });
  });

  it('reports a forbidden import reached from many entries once', () => {
    const files = { 'web/a.ts': "import '../lib/x.ts';", 'web/b.ts': "import '../lib/x.ts';", 'lib/x.ts': "import 'node:fs';" };
    expect(places(run(files, { groups: { browser }, rules: [rule] }))).toEqual(['lib/x.ts:1 forbidden-import']);
  });
});

describe('single-importer and no-reexport', () => {
  const groups = { src: { include: ['src/**'] } };
  const rule = { rule: 'single-importer' as const, group: 'src', package: '@vendor/sdk', allow: ['src/gateway/client.ts'] };

  it('lets the allowed file import values and others import types', () => {
    const files = {
      'src/gateway/client.ts': "import Sdk from '@vendor/sdk';\nexport function create() { return new Sdk(); }",
      'src/gateway/models.ts': "import type { Model } from '@vendor/sdk/resources';\nexport type M = Model;",
      'src/app.ts': "import type { Message } from '@vendor/sdk';",
    };
    expect(run(files, { groups, rules: [rule] })).toEqual([]);
  });

  it('reports an import with only inline type bindings, because the module still runs', () => {
    const files = {
      'src/gateway/client.ts': "import Sdk from '@vendor/sdk';",
      'src/app.ts': "import { type Message } from '@vendor/sdk';",
    };
    const v = run(files, { groups, rules: [rule] });
    expect(places(v)).toEqual(['src/app.ts:1 single-importer']);
    expect(v[0]?.reason).toBe(
      'imports only inline types from @vendor/sdk; only src/gateway/client.ts may (the module still runs; write import type to erase it)',
    );
  });

  it('reports a value import anywhere else, also through require() and import()', () => {
    const files = {
      'src/gateway/client.ts': "import Sdk from '@vendor/sdk';",
      'src/a.ts': "import { APIError } from '@vendor/sdk';",
      'src/b.ts': "function late() {\n  return require('@vendor/sdk/client');\n}",
      'src/c.ts': "const sdk = await import('@vendor/sdk');",
      'src/d.ts': "import { z } from 'zod'; // '@vendor/sdk'",
    };
    const v = run(files, { groups, rules: [rule] });
    expect(places(v)).toEqual(['src/a.ts:1 single-importer', 'src/b.ts:2 single-importer', 'src/c.ts:1 single-importer']);
    expect(v[0]?.reason).toBe('imports values from @vendor/sdk; only src/gateway/client.ts may');
  });

  it('with typeOnly: forbid, types count too', () => {
    const files = { 'src/gateway/client.ts': "import Sdk from '@vendor/sdk';", 'src/a.ts': "import type Sdk from '@vendor/sdk';" };
    expect(places(run(files, { groups, rules: [{ ...rule, typeOnly: 'forbid' }] }))).toEqual(['src/a.ts:1 single-importer']);
  });

  it('reports a re-export even from the allowed file, and lets types out', () => {
    const files = {
      'src/gateway/client.ts': "import Sdk from '@vendor/sdk';\nexport { Sdk };\nexport type { Message } from '@vendor/sdk';",
      'src/gateway/index.ts': "export * from '@vendor/sdk';",
    };
    const v = run(files, { groups, rules: [{ ...rule, allow: ['src/gateway/*.ts'] }] });
    expect(places(v)).toEqual(['src/gateway/client.ts:2 no-reexport', 'src/gateway/index.ts:1 no-reexport']);
    expect(v[1]?.reason).toBe("re-exports a value of @vendor/sdk (export * from '@vendor/sdk';), which opens a second way in");
  });

  it('reports an allow entry that no longer matches an importer', () => {
    const v = run({ 'src/gateway/client.ts': "import type Sdk from '@vendor/sdk';" }, { groups, rules: [{ ...rule, allow: ['src/gateway/client.ts', 'src/gone.ts'] }] });
    expect(v.map((x) => `${x.rule}: ${x.reason}`)).toEqual([
      'stale-allow: allow entry src/gateway/client.ts matches no file that imports @vendor/sdk values; remove it',
      'stale-allow: allow entry src/gone.ts matches no file of group "src"',
    ]);
  });
});

describe('single-reader', () => {
  const groups = { src: { include: ['src/**'] } };
  const rule = { rule: 'single-reader' as const, group: 'src', variable: 'VENDOR_API_KEY', allow: ['src/entry.ts'], why: 'the entry point passes it in' };

  it('reports a read outside the allowed file, with the why from the config', () => {
    const files = {
      'src/entry.ts': 'const key = process.env.VENDOR_API_KEY;',
      'src/lib.ts': ["// VENDOR_API_KEY comes from the entry point", "const k = import.meta.env['VENDOR_API_KEY'];", "throw new Error('Set VENDOR_API_KEY');"].join('\n'),
    };
    const v = run(files, { groups, rules: [rule] });
    expect(places(v)).toEqual(['src/lib.ts:2 single-reader']);
    expect(v[0]?.reason).toBe("reads VENDOR_API_KEY (import.meta.env['VENDOR_API_KEY']); only src/entry.ts may");
    expect(v[0]?.why).toBe('the entry point passes it in');
  });

  it('catches destructuring and a name kept in a constant', () => {
    const files = {
      'src/entry.ts': 'const key = process.env.VENDOR_API_KEY;',
      'src/a.ts': 'const { VENDOR_API_KEY: key } = process.env;',
      'src/b.ts': "const name = 'VENDOR_API_KEY';\nexport const key = process.env[name];",
    };
    expect(places(run(files, { groups, rules: [rule] }))).toEqual(['src/a.ts:1 single-reader', 'src/b.ts:1 single-reader']);
  });
});

describe('single-string', () => {
  it('reports the host outside the allowed file, in strings and templates only', () => {
    const files = {
      'src/client.ts': "export const BASE = 'https://api.vendor.test';",
      'src/other.ts': "// talks to api.vendor.test through the client\nexport const u = `https://api.vendor.test/${path}`;",
    };
    const v = run(files, { groups: { src: { include: ['src/**'] } }, rules: [{ rule: 'single-string', group: 'src', text: 'api.vendor.test', allow: ['src/client.ts'] }] });
    expect(places(v)).toEqual(['src/other.ts:2 single-string']);
  });
});

describe('relative-extension', () => {
  const config = { groups: { all: { include: ['**/*'] } }, rules: [{ rule: 'relative-extension' as const, group: 'all' }] };

  it('reports a relative import without an extension, with the fix when the file exists', () => {
    const v = run({ 'src/a.ts': "import { b } from './b';\nimport { c } from '../lib/c';", 'src/b.ts': '', 'lib/c.ts': '' }, config);
    expect(v.map((x) => `${x.line} ${x.reason}`)).toEqual([
      "1 imports ./b without a file extension; Node does not resolve it (write ./b.ts)",
      "2 imports ../lib/c without a file extension; Node does not resolve it (write ../lib/c.ts)",
    ]);
  });

  it('reports .js written for a .ts file, a folder import and a missing file', () => {
    const v = run({ 'src/a.ts': ["import './b.js';", "import '../lib';", "import './gone.ts';"].join('\n'), 'src/b.ts': '', 'lib/index.ts': '' }, config);
    expect(v.map((x) => `${x.line} ${x.reason}`)).toEqual([
      '1 imports ./b.js, which is not a file: only a bundler maps it to src/b.ts',
      '2 imports ../lib without a file extension; Node does not resolve it (write ../lib/index.ts)',
      '3 imports ./gone.ts, which is not a file: no such file',
    ]);
  });

  it('checks export from, import type, typeof import(), require() and import(), not new URL() or packages', () => {
    const code = [
      "export * from './x';",
      "import type { T } from './x';",
      "type M = typeof import('./x');",
      "const r = require('./x');",
      "const d = await import('./x');",
      "const u = new URL('../data/', import.meta.url);",
      "import { z } from 'zod';",
      "import ok from './x.ts';",
      "import data from './x.ts?raw';",
    ].join('\n');
    expect(places(run({ 'src/a.ts': code, 'src/x.ts': '' }, config))).toEqual([1, 2, 3, 4, 5].map((n) => `src/a.ts:${n} relative-extension`));
  });
});

describe('dynamic-import', () => {
  it('reports computed import(), require(), new URL() and import.meta.glob, not literal ones', () => {
    const code = [
      'const a = await import(`./locale/${lang}.ts`);',
      "const b = await import('./pages/' + page);",
      'const c = require(name);',
      'const d = new URL(`./img/${n}.png`, import.meta.url);',
      "const e = import.meta.glob('./routes/*.ts');",
      'const f = await import(`./fixed.ts`);',
      "type G = import('./types.ts').T;",
    ].join('\n');
    const v = run({ 'web/a.ts': code }, { groups: { web: { include: ['web/**'] } }, rules: [{ rule: 'dynamic-import', group: 'web' }] });
    expect(places(v)).toEqual([1, 2, 3, 4, 5].map((n) => `web/a.ts:${n} dynamic-import`));
    expect(v[0]?.reason).toBe('import() with a computed argument: a bundler turns it into a glob and bundles every file that matches');
  });
});

describe('groups', () => {
  it('reports a group that matches nothing, unless allowEmpty is set', () => {
    const rules = [{ rule: 'dynamic-import' as const, group: 'web' }];
    expect(places(run({ 'src/a.ts': '' }, { groups: { web: { include: ['apps/*/src/**'] } }, rules }))).toEqual(['fences.config.ts:0 empty-group']);
    expect(run({ 'src/a.ts': '' }, { groups: { web: { include: ['apps/*/src/**'], allowEmpty: true } }, rules })).toEqual([]);
  });

  it('applies exclude after include, and skips node_modules and non-code files', () => {
    const files = {
      'src/a.ts': 'await import(x);',
      'src/a.test.ts': 'await import(x);',
      'src/notes.md': 'await import(x);',
      'node_modules/p/index.js': 'await import(x);',
    };
    const v = run(files, { groups: { src: { include: ['**/*'], exclude: ['**/*.test.ts'] } }, rules: [{ rule: 'dynamic-import', group: 'src' }] });
    expect(places(v)).toEqual(['src/a.ts:1 dynamic-import']);
  });
});
