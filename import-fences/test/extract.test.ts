import { describe, expect, it } from 'vitest';
import { moduleRefs, namesOf, parse, reexports, stringsContaining } from '../src/extract.ts';

const refs = (code: string, path = 'a.ts') => moduleRefs(parse(path, code)).map((r) => ({ kind: r.kind, specifier: r.specifier, typeOnly: r.typeOnly }));

describe('moduleRefs', () => {
  it('reads every static form, with its line', () => {
    const code = ["import a from 'pa';", "import 'side-effect';", "export * from 'pb';", "export { x } from 'pc';", "import x = require('pd');"].join('\n');
    expect(refs(code)).toEqual([
      { kind: 'import', specifier: 'pa', typeOnly: false },
      { kind: 'import', specifier: 'side-effect', typeOnly: false },
      { kind: 'export', specifier: 'pb', typeOnly: false },
      { kind: 'export', specifier: 'pc', typeOnly: false },
      { kind: 'import-equals', specifier: 'pd', typeOnly: false },
    ]);
    expect(moduleRefs(parse('a.ts', code)).map((r) => r.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('marks what the compiler erases as type-only, and nothing else', () => {
    const typeOnly = (code: string) => refs(code)[0]?.typeOnly;
    expect(typeOnly("import type A from 'p';")).toBe(true);
    expect(typeOnly("export type { A } from 'p';")).toBe(true);
    expect(typeOnly("type M = typeof import('p');")).toBe(true);
    expect(typeOnly("let m: import('p').T;")).toBe(true);
    expect(typeOnly("import { type A, b } from 'p';")).toBe(false);
    expect(typeOnly("import A, { type B } from 'p';")).toBe(false);
    expect(typeOnly("import {} from 'p';")).toBe(false);
    expect(typeOnly("import * as p from 'p';")).toBe(false);
    expect(typeOnly("export * from 'p';")).toBe(false);
  });

  it('treats inline type bindings as loading the module, because tsc and Node keep the import', () => {
    // verbatimModuleSyntax emits `import {} from 'p'`; Node type stripping keeps the import too.
    const first = (code: string) => {
      const ref = moduleRefs(parse('a.ts', code))[0];
      return { typeOnly: ref?.typeOnly, inlineTypesOnly: ref?.inlineTypesOnly };
    };
    expect(first("import { type A } from 'p';")).toEqual({ typeOnly: false, inlineTypesOnly: true });
    expect(first("import { type A, type B } from 'p';")).toEqual({ typeOnly: false, inlineTypesOnly: true });
    expect(first("export { type A } from 'p';")).toEqual({ typeOnly: false, inlineTypesOnly: true });
    expect(first("import { type A, b } from 'p';")).toEqual({ typeOnly: false, inlineTypesOnly: false });
    expect(first("import type { A } from 'p';")).toEqual({ typeOnly: true, inlineTypesOnly: false });
  });

  it('finds require() inside a function and import() inside an expression', () => {
    const code = ["function load() {", "  if (x) return require('deep');", "}", "const m = cond ? await import('lazy') : null;"].join('\n');
    expect(refs(code)).toEqual([
      { kind: 'require', specifier: 'deep', typeOnly: false },
      { kind: 'dynamic', specifier: 'lazy', typeOnly: false },
    ]);
  });

  it('treats a template without ${} as a literal and one with ${} as computed', () => {
    expect(refs('await import(`./fixed.ts`);')[0]?.specifier).toBe('./fixed.ts');
    expect(refs('await import(`./locale/${lang}.ts`);')[0]?.specifier).toBeNull();
    expect(refs("await import('./locale/' + lang);")[0]?.specifier).toBeNull();
    expect(refs('require(name);')[0]?.specifier).toBeNull();
  });

  it('reads new URL(x, import.meta.url) and import.meta.glob, and only with import.meta.url', () => {
    expect(refs("const u = new URL('./worker.ts', import.meta.url);")).toEqual([{ kind: 'url', specifier: './worker.ts', typeOnly: false }]);
    expect(refs("const u = new URL('./x', base);")).toEqual([]);
    expect(refs("const all = import.meta.glob('./pages/*.ts');")).toEqual([{ kind: 'glob', specifier: null, typeOnly: false }]);
  });

  it('is not fooled by comments or strings that look like imports', () => {
    const code = [
      "// import a from 'commented';",
      "/* const m = await import('blocked'); */",
      "const text = \"import x from 'quoted'\";",
      "const other = 'require(\"also-quoted\")';",
    ].join('\n');
    expect(refs(code)).toEqual([]);
  });

  it('finds the compact and the multi-line forms', () => {
    expect(refs("import{x}from'compact';export*from'star'")).toEqual([
      { kind: 'import', specifier: 'compact', typeOnly: false },
      { kind: 'export', specifier: 'star', typeOnly: false },
    ]);
    expect(refs("const m = await import(\n  'split'\n);\nimport {\n  a,\n  b,\n} from 'multi';")).toEqual([
      { kind: 'dynamic', specifier: 'split', typeOnly: false },
      { kind: 'import', specifier: 'multi', typeOnly: false },
    ]);
  });

  it('keeps a Vite query suffix in the specifier', () => {
    expect(refs("import code from './x.ts?raw';")[0]?.specifier).toBe('./x.ts?raw');
  });

  it('parses JSX in .tsx and .jsx files', () => {
    expect(refs("import { h } from 'ui';\nexport const A = () => <div>{h}</div>;", 'a.tsx')).toHaveLength(1);
    expect(refs("import { h } from 'ui';\nexport const A = () => <div>{h}</div>;", 'a.jsx')).toHaveLength(1);
  });
});

describe('reexports', () => {
  const leaks = (code: string) => reexports(parse('index.ts', code), (s) => s === 'sdk' || s.startsWith('sdk/')).map((l) => l.text);

  it('reports every way a value of the target leaves the file', () => {
    expect(leaks("export * from 'sdk';")).toEqual(["export * from 'sdk';"]);
    expect(leaks("export * as sdk from 'sdk';")).toEqual(["export * as sdk from 'sdk';"]);
    expect(leaks("export { default as Client } from 'sdk';")).toEqual(["export { default as Client } from 'sdk';"]);
    expect(leaks("import Client from 'sdk';\nexport { Client };")).toEqual(['Client']);
    expect(leaks("import Client from 'sdk';\nexport { Client as default };")).toEqual(['Client as default']);
    expect(leaks("import Client from 'sdk';\nexport default Client;")).toEqual(['export default Client;']);
    expect(leaks("import * as sdk from 'sdk';\nexport const make = sdk.Client;")).toEqual(['make = sdk.Client']);
    expect(leaks("import { Client } from 'sdk/client';\nexport const C = Client;")).toEqual(['C = Client']);
  });

  it('follows import = require(), const = require() and CommonJS exports', () => {
    expect(leaks("import sdk = require('sdk');\nexport const C = sdk.Client;")).toEqual(['C = sdk.Client']);
    expect(leaks("import sdk = require('sdk');\nexport = sdk;")).toEqual(['export = sdk;']);
    expect(leaks("const sdk = require('sdk');\nmodule.exports = sdk;")).toEqual(['module.exports = sdk;']);
    expect(leaks("const { Client } = require('sdk');\nexports.Client = Client;")).toEqual(['exports.Client = Client;']);
    expect(leaks("module.exports.Client = require('sdk').Client;")).toEqual(["module.exports.Client = require('sdk').Client;"]);
  });

  it('follows local aliases and subclasses to the export', () => {
    expect(leaks("import { C } from 'sdk';\nconst k = C;\nexport { k };")).toEqual(['k']);
    expect(leaks("import { C } from 'sdk';\nconst a = C;\nconst b = a;\nexport default b;")).toEqual(['export default b;']);
    expect(leaks("import { C } from 'sdk';\nexport class X extends C {}")).toEqual(['export class X extends C {}']);
    expect(leaks("import { C } from 'sdk';\nexport default class extends C {}")).toEqual(['export default class extends C {}']);
    expect(leaks("import * as sdk from 'sdk';\nclass X extends sdk.C {}\nexport { X };")).toEqual(['X']);
  });

  it('lets types and unrelated modules leave', () => {
    expect(leaks("export type { Message } from 'sdk';")).toEqual([]);
    expect(leaks("import type Client from 'sdk';\nexport type C = Client;")).toEqual([]);
    expect(leaks("import { type Client } from 'sdk';\nexport { type Client };")).toEqual([]);
    expect(leaks("export { type Message } from 'sdk';")).toEqual([]);
    expect(leaks("import { C } from 'sdk';\nclass X extends Base {}\nexport { X };")).toEqual([]);
    expect(leaks("import { C } from 'sdk';\nexport function make() { return 1; }")).toEqual([]);
    expect(leaks("export * from './local.ts';")).toEqual([]);
    expect(leaks("import Client from 'sdk';\nexport const n = 1;\nconst c = new Client();")).toEqual([]);
  });
});

describe('namesOf', () => {
  const reads = (code: string) => namesOf(parse('a.ts', code), 'API_KEY').length;

  it('finds the variable in every form a read takes', () => {
    expect(reads('const k = process.env.API_KEY;')).toBe(1);
    expect(reads("const k = process.env['API_KEY'];")).toBe(1);
    expect(reads('const k = process.env[`API_KEY`];')).toBe(1);
    expect(reads('const { API_KEY: k } = process.env;')).toBe(1);
    expect(reads('const k = import.meta.env.API_KEY;')).toBe(1);
    expect(reads("import { API_KEY } from 'astro:env/server';")).toBe(1);
    expect(reads("const name = 'API_KEY';\nconst k = process.env[name];")).toBe(1);
  });

  it('ignores comments, longer names and messages that mention it', () => {
    expect(reads('// API_KEY is read by the entry point')).toBe(0);
    expect(reads("throw new Error('Set API_KEY to run');")).toBe(0);
    expect(reads('const k = process.env.API_KEY_OLD;')).toBe(0);
  });
});

describe('stringsContaining', () => {
  it('looks in string and template literals, not in comments', () => {
    const found = (code: string) => stringsContaining(parse('a.ts', code), 'api.example.test').length;
    expect(found("const u = 'https://api.example.test/v1';")).toBe(1);
    expect(found('const u = `https://api.example.test/${path}`;')).toBe(1);
    expect(found('const u = `${base}/api.example.test`;')).toBe(1);
    expect(found('// calls https://api.example.test')).toBe(0);
  });
});
