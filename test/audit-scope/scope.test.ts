import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScope, formatText, gitScope, importEdges, repoEdges, type Scope } from './scope.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

const files: Record<string, string> = {
  'gateway/src/index.ts': "export { cap } from './caps.ts';\n",
  'gateway/src/caps.ts': 'export const cap = 1;\n',
  'gateway/test/caps.test.ts': "import { cap } from '../src/caps.ts';\n",
  'content-forge/src/forge.ts': "// import '../../slop-lint/src/index.ts' is a comment, not an import\nimport { cap } from '../../gateway/src/index.ts';\nexport const forge = cap;\n",
  'apps/caja/src/main.ts': "import { cap } from '../../../gateway/src/index.ts';\n",
  'apps/writer/src/main.ts': "\nimport { forge } from '../../../content-forge/src/forge.ts';\n",
  'apps/receipt/src/main.ts': "import { x } from '../../../pdf-receipt/src/index.ts';\n",
  'pdf-receipt/src/index.ts': 'export const x = 1;\n',
  'slop-lint/src/index.ts': 'export const lint = 1;\n',
  'README.md': '# Fixture\n',
};
const read = (path: string): string | null => files[path] ?? null;

describe('importEdges', () => {
  it('resolves relative imports to repository paths with the import-fences extractor', () => {
    const edges = importEdges(Object.keys(files), read);
    expect(edges).toContainEqual({ importer: 'content-forge/src/forge.ts', line: 2, specifier: '../../gateway/src/index.ts', target: 'gateway/src/index.ts' });
    expect(edges).toContainEqual({ importer: 'apps/writer/src/main.ts', line: 2, specifier: '../../../content-forge/src/forge.ts', target: 'content-forge/src/forge.ts' });
    // A comment that looks like an import is not one.
    expect(edges.some((e) => e.target.startsWith('slop-lint/'))).toBe(false);
  });

  it('skips package imports, paths outside the repository and query suffixes', () => {
    const edges = importEdges(['a/x.ts'], () => "import 'zod';\nimport '../../outside.ts';\nimport css from './s.css?raw';\n");
    expect(edges).toEqual([{ importer: 'a/x.ts', line: 3, specifier: './s.css?raw', target: 'a/s.css' }]);
  });
});

describe('buildScope', () => {
  const base = { base: 'origin/main', mergeBase: 'b'.repeat(40), head: 'h'.repeat(40), branch: 'work', dirty: false };
  const edges = importEdges(Object.keys(files), read);

  it('adds the units that import a changed file, through the import that reaches it', () => {
    const scope = buildScope({ ...base, changed: ['gateway/src/caps.ts', 'README.md'], edges });
    expect(scope.units.map((u) => [u.id, u.reason])).toEqual([
      ['gateway', 'changed'],
      ['root-docs-truth', 'changed'],
      ['content-forge', 'dependent'],
      ['apps-caja', 'dependent'],
      ['apps-writer', 'dependent'],
    ]);
    expect(scope.units.find((u) => u.id === 'gateway')?.files).toEqual(['gateway/src/caps.ts']);
    const forge = scope.dependents.find((d) => d.unit === 'content-forge');
    expect(forge?.because).toEqual([{ on: 'gateway', importer: 'content-forge/src/forge.ts', line: 2, specifier: '../../gateway/src/index.ts', target: 'gateway/src/index.ts' }]);
    // The writer reaches gateway only through content-forge.
    expect(scope.dependents.find((d) => d.unit === 'apps-writer')?.because.map((b) => b.on)).toEqual(['content-forge']);
    expect(scope.units.find((u) => u.id === 'apps-writer')?.files).toEqual(['apps/writer/src/main.ts']);
    expect(scope.units.find((u) => u.id === 'gateway')?.context).toMatch(/Spend caps/);
  });

  it('adds no dependent for a file nothing imports', () => {
    const scope = buildScope({ ...base, changed: ['gateway/test/caps.test.ts', 'slop-lint/src/index.ts'], edges });
    expect(scope.units.map((u) => u.id)).toEqual(['gateway', 'slop-lint']);
    expect(scope.dependents).toEqual([]);
  });

  it('lists a changed file that no unit owns instead of dropping it', () => {
    const scope = buildScope({ ...base, changed: ['stray.txt'], edges });
    expect(scope.units).toEqual([]);
    expect(scope.unmapped).toEqual(['stray.txt']);
  });

  it('prints a short text summary', () => {
    const text = formatText(buildScope({ ...base, changed: ['gateway/src/caps.ts'], edges }));
    expect(text).toContain('1 file changed against origin/main');
    expect(text).toMatch(/gateway\s+changed\s+1 file/);
    expect(text).toMatch(/apps-writer\s+dependent\s+apps\/writer\/src\/main.ts:2 -> content-forge\/src\/forge.ts/);
  });
});

describe('repoEdges on this repository', () => {
  it('finds every app and library that imports the gateway entry', () => {
    const scope = buildScope({ base: 'x', mergeBase: 'x', head: 'x', branch: 'x', dirty: false, changed: ['gateway/src/index.ts'], edges: repoEdges(ROOT) });
    const dependents = scope.dependents.map((d) => d.unit);
    // The users of gateway/src/index.ts named in import-fences/repo.config.ts (APP_USES, LIBRARY_USES).
    for (const unit of ['apps-caja', 'apps-chat-widget', 'apps-salon-assistant', 'apps-writer', 'content-forge']) expect(dependents).toContain(unit);
    expect(dependents).not.toContain('apps-receipt');
  });
});

describe('gitScope and the CLI on a temporary repository', () => {
  let repo = '';
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'audit-scope-'));
    git('init', '-q', '-b', 'main');
    for (const [path, content] of Object.entries(files)) write(path, content);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('branch', 'base');
    git('switch', '-q', '-c', 'work');
    write('gateway/src/caps.ts', 'export const cap = 2;\n');
    git('commit', '-qam', 'change caps');
    // The base moves on after the branch point; its own changes are not this branch's.
    git('switch', '-q', 'base');
    write('slop-lint/src/index.ts', 'export const lint = 2;\n');
    git('commit', '-qam', 'base moves');
    git('switch', '-q', 'work');
    // Uncommitted: a change to a tracked file and a new untracked file.
    write('README.md', '# Fixture, edited\n');
    write('pdf-receipt/src/new.ts', 'export const y = 1;\n');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('lists the branch changes since the merge base plus uncommitted and untracked files', () => {
    const scope: Scope = gitScope({ cwd: repo, base: 'base' });
    expect(scope.files).toEqual(['README.md', 'gateway/src/caps.ts', 'pdf-receipt/src/new.ts']);
    expect(scope.units.map((u) => u.id)).toEqual(['gateway', 'pdf-receipt', 'root-docs-truth', 'content-forge', 'apps-caja', 'apps-writer']);
    expect(scope.branch).toBe('work');
    expect(scope.dirty).toBe(true);
    expect(scope.head).toBe(git('rev-parse', 'HEAD').trim());
    expect(scope.mergeBase).toBe(git('merge-base', 'base', 'HEAD').trim());
  });

  it('prints JSON with --json and writes it with --out', () => {
    const run = spawnSync(process.execPath, [CLI, '--base', 'base', '--json'], { cwd: repo, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as Scope).units.map((u) => u.id)).toContain('apps-writer');
    const out = join(repo, 'scope.json');
    const written = spawnSync(process.execPath, [CLI, '--base', 'base', '--out', out], { cwd: repo, encoding: 'utf8' });
    expect(written.status).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as Scope).files).toContain('gateway/src/caps.ts');
    expect(written.stdout).toContain('dependent');
  });

  it('exits 2 with a message for a base that does not exist or an unknown option', () => {
    const missing = spawnSync(process.execPath, [CLI, '--base', 'no-such-ref'], { cwd: repo, encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('no-such-ref');
    const unknown = spawnSync(process.execPath, [CLI, '--nope'], { cwd: repo, encoding: 'utf8' });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('--nope');
  });
});
