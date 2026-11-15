import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { check } from '../src/check.ts';
import { parseConfig } from '../src/config.ts';
import { diskSource, memorySource } from '../src/files.ts';

const TREE: Readonly<Record<string, string>> = {
  'src/top.ts': '',
  'src/a/deep.ts': '',
  'lib/b.js': '',
  'lib/three.js/index.ts': '',
  'vendor/x.ts': '',
  'pkg/vendor/y.ts': '',
  'dist/out.js': '',
  'node_modules/p/index.js': '',
};

const root = mkdtempSync(join(tmpdir(), 'import-fences-files-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const [path, content] of Object.entries(TREE)) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

describe('diskSource and memorySource', () => {
  it('list the same files for the same ignore list', () => {
    const cases: readonly (readonly string[])[] = [
      ['src/*'],
      ['**/*.js'],
      ['**/vendor'],
      ['dist/'],
      ['{dist,node_modules}'],
      ['**/node_modules/**', 'src/a/**'],
      [],
    ];
    for (const ignore of cases) {
      expect(diskSource(root, ignore).list(), JSON.stringify(ignore)).toEqual(memorySource(TREE, ignore).list());
    }
  });

  it('keep files that an ignore glob does not match, even when it matches their folder name', () => {
    expect(diskSource(root, ['src/*']).list()).toContain('src/a/deep.ts');
    expect(diskSource(root, ['**/*.js']).list()).toContain('lib/three.js/index.ts');
    expect(diskSource(root, ['**/*.js']).list()).not.toContain('lib/b.js');
  });

  it('drop a folder named without a wildcard, written with or without a trailing slash or /**', () => {
    for (const ignore of [['**/vendor'], ['**/vendor/'], ['**/vendor/**']]) {
      const listed = diskSource(root, ignore).list();
      expect(listed, JSON.stringify(ignore)).not.toContain('vendor/x.ts');
      expect(listed, JSON.stringify(ignore)).not.toContain('pkg/vendor/y.ts');
    }
  });
});

describe('packages installed above the root', () => {
  it('count as installed, as Node resolves them in a workspace with hoisted node_modules', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'import-fences-hoisted-'));
    try {
      const files: Record<string, string> = {
        'node_modules/hoisted-pkg/package.json': '{"name":"hoisted-pkg"}',
        'pkg/src/client/a.ts': "import { x } from 'hoisted-pkg';\nimport { y } from 'missing-pkg';",
      };
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(workspace, path)), { recursive: true });
        writeFileSync(join(workspace, path), content);
      }
      const config = parseConfig({
        groups: { client: { include: ['src/client/**'] } },
        rules: [{ rule: 'forbidden-import', group: 'client', specifiers: ['node:*'], paths: ['src/server/**'] }],
      });
      const found = check(config, diskSource(join(workspace, 'pkg'))).violations.map((v) => `${v.file}:${v.line} ${v.rule}`);
      expect(found).toEqual(['src/client/a.ts:2 unresolved-import']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
