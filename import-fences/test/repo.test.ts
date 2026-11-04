/**
 * The fences of this repository (repo.config.ts), run through the CLI the way CI runs them. A
 * change anywhere in the repository that breaks one fails here with its file and line.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/check.ts';
import { loadConfig, parseConfig } from '../src/config.ts';
import { diskSource, memorySource } from '../src/files.ts';
import { globMatcher } from '../src/glob.ts';
import { APP_USES, folderFences, PUBLIC_SURFACE } from '../repo.config.ts';
import { places } from './helpers.ts';

const FOLDER = join(import.meta.dirname, '..');
const CONFIG = join(FOLDER, 'repo.config.ts');

describe('this repository', () => {
  it('holds every fence in repo.config.ts', () => {
    const result = spawnSync(process.execPath, [join(FOLDER, 'cli.ts'), '--config', CONFIG], { cwd: join(FOLDER, '..'), encoding: 'utf8' });
    expect({ code: result.status, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    expect(result.stdout).toMatch(/^import-fences: 0 violations in \d+ files, \d+ rules\n$/);
  });

  // Witnesses: if a fence stopped seeing the code it guards, these would pass for the wrong reason.
  it('sees the gateway import the SDK, and reports it once the exception is removed', async () => {
    const { config, root } = await loadConfig(CONFIG);
    const withoutException = {
      ...config,
      rules: config.rules.map((r) => (r.rule === 'single-importer' ? { ...r, allow: r.allow.filter((a) => a !== 'gateway/src/client.ts') } : r)),
    };
    const found = check(withoutException, diskSource(root, config.ignore)).violations.filter((v) => v.rule === 'single-importer');
    expect(found.map((v) => `${v.file}:${v.line}`)).toEqual(['gateway/src/client.ts:1']);
  });

  it('gives the groups it relies on real members, and never reads node_modules', async () => {
    const { config, root } = await loadConfig(CONFIG);
    const files = diskSource(root, config.ignore).list();
    const members = (name: string) => {
      const group = config.groups[name];
      if (group === undefined) throw new Error(`no group ${name}`);
      const included = globMatcher(group.include);
      const excluded = globMatcher(group.exclude);
      return files.filter((f) => included(f) && !excluded(f));
    };
    expect(members('browser').length).toBeGreaterThan(0);
    expect(members('source')).toContain('gateway/src/client.ts');
    expect(members('source').some((f) => f.endsWith('.test.ts'))).toBe(false);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });
});

// The folder fences of repo.config.ts on a small tree shaped like this repository, with the real
// PUBLIC_SURFACE and APP_USES: what an app may use of a library, and what stays closed.
describe('folder fences', () => {
  // caja's real entry; the other apps of APP_USES are not part of this small tree.
  const layout = {
    libraries: ['amount-parser', 'gateway', 'slop-lint'],
    apps: ['caja', 'other'],
    surface: PUBLIC_SURFACE,
    uses: { caja: APP_USES['caja'] ?? [] },
  };
  const library = {
    'amount-parser/src/index.ts': "export { parseAmount } from './money.ts';",
    'amount-parser/src/money.ts': 'export const parseAmount = (s: string) => s;',
    'amount-parser/test/corpus-data.ts': 'export const corpus = [];',
    'gateway/src/index.ts': "export { call } from './gateway.ts';",
    'gateway/src/gateway.ts': 'export const call = 1;',
  };
  const allowed = {
    'apps/caja/src/entry.ts': "import { parseAmount } from '../../../amount-parser/src/index.ts';",
    'apps/caja/test/corpus-json.ts': "const raw = new URL('../../../amount-parser/corpus/corpus.json', import.meta.url);",
    'apps/caja/server/model.ts': "import { call } from '../../../gateway/src/index.ts';",
  };
  const fenced = (files: Record<string, string>) => {
    const { groups, rules } = folderFences(layout);
    return check(parseConfig({ groups, rules }), memorySource(files), 'repo.config.ts').violations;
  };

  it('lets an app use a library through its public entry and its published data', () => {
    expect(fenced({ ...library, ...allowed })).toEqual([]);
  });

  it("still forbids a library's internals and test helpers, other apps, and libraries reaching across", () => {
    const v = fenced({
      ...library,
      ...allowed,
      'apps/caja/src/money-view.ts': "import { parseAmount } from '../../../amount-parser/src/money.ts';",
      'apps/caja/test/questions.test.ts': "import { corpus } from '../../../amount-parser/test/corpus-data.ts';",
      'apps/caja/src/call.ts': "import { call } from '../../../gateway/src/gateway.ts';",
      'apps/caja/src/share.ts': "import '../../other/src/main.ts';",
      'apps/other/src/main.ts': "import { parseAmount } from '../../../amount-parser/src/index.ts';",
      'gateway/src/amounts.ts': "import { parseAmount } from '../../amount-parser/src/index.ts';",
      'amount-parser/src/app.ts': "import '../../apps/caja/src/entry.ts';",
    });
    expect(places(v)).toEqual([
      'amount-parser/src/app.ts:1 forbidden-import',
      'apps/caja/src/call.ts:1 forbidden-import',
      'apps/caja/src/money-view.ts:1 forbidden-import',
      'apps/caja/src/share.ts:1 forbidden-import',
      'apps/caja/test/questions.test.ts:1 forbidden-import',
      'apps/other/src/main.ts:1 forbidden-import',
      'gateway/src/amounts.ts:1 forbidden-import',
    ]);
  });

  it('passes an app that names and imports only the public entry, without touching the published data', () => {
    const { groups, rules } = folderFences({ ...layout, uses: { caja: ['amount-parser/src/index.ts'] } });
    const files = { ...library, 'apps/caja/src/entry.ts': allowed['apps/caja/src/entry.ts'] };
    expect(check(parseConfig({ groups, rules }), memorySource(files), 'repo.config.ts').violations).toEqual([]);
  });

  it('reports a published entry an app no longer uses, and refuses an entry the library does not publish', () => {
    expect(places(fenced({ ...library, 'apps/caja/src/entry.ts': allowed['apps/caja/src/entry.ts'] }))).toEqual([
      'repo.config.ts:0 stale-allow',
      'repo.config.ts:0 stale-allow',
    ]);
    expect(() => folderFences({ ...layout, uses: { caja: ['slop-lint/src/index.ts'] } })).toThrow(/which slop-lint does not publish in PUBLIC_SURFACE \(it publishes nothing\)/);
    expect(() => folderFences({ ...layout, uses: { caja: ['gateway/src/gateway.ts'] } })).toThrow(/which gateway does not publish in PUBLIC_SURFACE \(it publishes gateway\/src\/index.ts\)/);
    expect(() => folderFences({ ...layout, uses: { caja: ['amount-parser/src/money.ts'] } })).toThrow(/which amount-parser does not publish/);
    expect(() => folderFences({ ...layout, uses: { caja: ['site/src/index.ts'] } })).toThrow(/which is not in a library folder/);
    expect(() => folderFences({ ...layout, uses: { till: ['amount-parser/src/index.ts'] } })).toThrow(/apps\/till, which does not exist/);
  });

  it('lets a library named in LIBRARY_USES use another library through its public entry, and nothing more', () => {
    const { groups, rules } = folderFences({ ...layout, libraryUses: { 'slop-lint': ['gateway/src/index.ts'] } });
    const v = check(
      parseConfig({ groups, rules }),
      memorySource({
        ...library,
        ...allowed,
        'slop-lint/src/judge.ts': "import { call } from '../../gateway/src/index.ts';",
        'slop-lint/src/inside.ts': "import { call } from '../../gateway/src/gateway.ts';",
        'slop-lint/src/amounts.ts': "import { parseAmount } from '../../amount-parser/src/index.ts';",
      }),
      'repo.config.ts',
    ).violations;
    expect(places(v)).toEqual(['slop-lint/src/amounts.ts:1 forbidden-import', 'slop-lint/src/inside.ts:1 forbidden-import']);
    expect(() => folderFences({ ...layout, libraryUses: { 'slop-lint': ['gateway/src/gateway.ts'] } })).toThrow(/slop-lint\/ uses gateway\/src\/gateway.ts, which gateway does not publish/);
    expect(() => folderFences({ ...layout, libraryUses: { site: ['gateway/src/index.ts'] } })).toThrow(/LIBRARY_USES names site\/, which is not a library folder/);
  });
});
