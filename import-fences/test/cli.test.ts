import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const CLI = join(import.meta.dirname, '..', 'cli.ts');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'import-fences-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function cli(cwd: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A config written as plain JavaScript, so the fixture does not need this folder's sources. */
const CONFIG = `export default {
  groups: { browser: { include: ['web/**'] }, all: { include: ['**/*'] } },
  rules: [
    { rule: 'forbidden-import', group: 'browser', specifiers: ['node:*'], why: 'browser code has no Node built-ins' },
    { rule: 'relative-extension', group: 'all' },
  ],
};
`;

describe('cli', () => {
  it('prints file:line, the rule and the reason, and exits 1', () => {
    const root = tree({
      'import-fences.config.ts': CONFIG,
      'web/a.ts': "import { b } from './b';\nimport { readFileSync } from 'node:fs';",
      'web/b.ts': '',
    });
    const { code, stdout } = cli(root);
    expect(code).toBe(1);
    expect(stdout.split('\n')).toEqual([
      'web/a.ts:1:1  relative-extension  imports ./b without a file extension; Node does not resolve it (write ./b.ts)',
      'web/a.ts:2:1  forbidden-import  imports node:fs, forbidden in group "browser". Why: browser code has no Node built-ins',
      'import-fences: 2 violations in 3 files, 2 rules',
      '',
    ]);
  });

  it('exits 0 on a clean tree and prints JSON with --json', () => {
    const root = tree({ 'fences.config.ts': CONFIG, 'web/a.ts': "import { b } from './b.ts';", 'web/b.ts': '' });
    expect(cli(root, ['--config', 'fences.config.ts'])).toMatchObject({ code: 0, stdout: 'import-fences: 0 violations in 3 files, 2 rules\n' });
    const json = cli(root, ['--config', 'fences.config.ts', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ violations: [], files: 3, rules: 2 });
  });

  it('exits 2 on bad usage, a missing config or an invalid one', () => {
    const root = tree({ 'import-fences.config.ts': "export default { groups: {}, rules: [{ rule: 'nope', group: 'x' }] };", 'a.ts': '' });
    expect(cli(root, ['--bogus']).code).toBe(2);
    expect(cli(root, ['--config', 'missing.config.ts']).code).toBe(2);
    const invalid = cli(root);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toMatch(/^invalid config:/);
  });
});
