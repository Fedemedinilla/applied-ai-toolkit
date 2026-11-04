// The two Claude Code hooks in .claude/hooks/, tested as functions and, for the guard, as the real
// process Claude Code starts: JSON on stdin, exit code 2 to block.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bashTargets, decide, globToRegExp, loadConfig, projectPath } from '../.claude/hooks/guard-protected-paths.ts';
import { editedPath, relatedCommand } from '../.claude/hooks/related-tests.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/u, '');
const GUARD = join(ROOT, '.claude/hooks/guard-protected-paths.ts');
const RELATED = join(ROOT, '.claude/hooks/related-tests.ts');
const config = loadConfig(ROOT);
const edit = (file_path: string, tool_name = 'Edit') => ({ tool_name, tool_input: { file_path } });

function runHook(script: string, input: unknown, env: Record<string, string> = {}) {
  const childEnv: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: ROOT, ...env };
  if (!('DSIM_ALLOW_PROTECTED' in env)) delete childEnv['DSIM_ALLOW_PROTECTED'];
  return spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: childEnv });
}

describe('globToRegExp', () => {
  it.each([
    ['src/**/rules-v*.ts', 'src/tournament/rules-v1.ts', true],
    ['src/**/rules-v*.ts', 'src/rules-v2.ts', true],
    ['src/**/rules-v*.ts', 'src/tournament/rules.ts', false],
    ['test/golden/**', 'test/golden/runs.json', true],
    ['test/golden/**', 'test/golden.test.ts', false],
    ['.claude/**', '.claude/hooks/x.ts', true],
    ['test/purity.test.ts', 'test/purityXtest.ts', false],
  ])('%s against %s is %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe('guard-protected-paths', () => {
  it.each(['src/tournament/rules-v1.ts', 'test/golden/runs.json', 'test/purity.test.ts', '.claude/protected-paths.json', '.claude/hooks/related-tests.ts'])(
    'blocks an edit to %s, relative or absolute',
    (rel) => {
      expect(decide(edit(rel), ROOT, config, {}).block).toBe(true);
      expect(decide(edit(join(ROOT, rel), 'Write'), ROOT, config, {}).block).toBe(true);
    },
  );

  it('allows ordinary source and test files, and paths outside the project', () => {
    for (const rel of ['src/tournament/advance.ts', 'test/advance.test.ts', 'README.md', '/etc/hosts', '../other/file.ts']) {
      expect(decide(edit(rel), ROOT, config, {})).toEqual({ block: false });
    }
  });

  it('blocks a JSON file marked "handwritten": true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsim-guard-'));
    try {
      writeFileSync(join(dir, 'level.json'), JSON.stringify({ handwritten: true, name: 'x' }));
      writeFileSync(join(dir, 'plain.json'), JSON.stringify({ handwritten: 'yes' }));
      expect(decide(edit('level.json'), dir, config, {}).block).toBe(true);
      expect(decide(edit('plain.json'), dir, config, {}).block).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets everything through when the person started the session with DSIM_ALLOW_PROTECTED=1', () => {
    expect(decide(edit('test/golden/runs.json'), ROOT, config, { DSIM_ALLOW_PROTECTED: '1' }).block).toBe(false);
  });

  it('flags shell commands that write to a protected path, and leaves reads alone', () => {
    const bash = (command: string) => bashTargets(command, ROOT, config);
    expect(bash("sed -i 's/1000/1200/' src/tournament/rules-v1.ts")).toEqual(['src/tournament/rules-v1.ts']);
    expect(bash('echo {} > test/golden/runs.json')).toEqual(['test/golden/runs.json']);
    expect(bash('rm -rf .claude')).toEqual(['.claude']);
    expect(bash('git checkout -- test/purity.test.ts')).toEqual(['test/purity.test.ts']);
    expect(bash('cat src/tournament/rules-v1.ts')).toEqual([]);
    expect(bash('npx vitest run test/golden.test.ts')).toEqual([]);
    expect(bash('node batch.ts > out.txt')).toEqual([]);
  });

  it('resolves absolute and ./ paths in shell commands against the project', () => {
    const bash = (command: string) => bashTargets(command, ROOT, config);
    expect(bash(`echo x > ${join(ROOT, 'src/tournament/rules-v1.ts')}`)).toEqual(['src/tournament/rules-v1.ts']);
    expect(bash('echo x >> ./src/tournament/rules-v1.ts')).toEqual(['src/tournament/rules-v1.ts']);
    expect(bash(`sed -i s/a/b/ ${join(ROOT, 'test/purity.test.ts')}`)).toEqual(['test/purity.test.ts']);
    expect(bash(`cd /tmp && echo x > ${join(ROOT, '../elsewhere/rules-v1.ts')}`)).toEqual([]);
  });

  it('does not treat the rest of src/ as protected, or fd duplication as a write', () => {
    const bash = (command: string) => bashTargets(command, ROOT, config);
    expect(bash('npx vitest run src 2>&1 | tail -20')).toEqual([]);
    expect(bash('grep -rn foo src > /tmp/out.txt')).toEqual([]);
    expect(bash('cat src/tournament/rules-v1.ts > /tmp/copy.ts')).toEqual([]);
    expect(bash('echo x > src/fixed.ts')).toEqual([]);
    expect(bash('rm src/fixed.ts')).toEqual([]);
    expect(bash('git checkout src/rng.ts')).toEqual([]);
    expect(bash('echo x > src/tournament/rules-v1.ts')).toEqual(['src/tournament/rules-v1.ts']);
  });

  it('blocks removing or checking out a folder that holds a protected file', () => {
    const bash = (command: string) => bashTargets(command, ROOT, config);
    expect(bash('rm -rf src')).toEqual(['src']);
    expect(bash('mv src/tournament /tmp/t')).toEqual(['src/tournament']);
    expect(bash('git checkout .')).toEqual(['.']);
    expect(bash('rm -rf test/helpers')).toEqual([]);
  });

  it('blocks a shell write to a JSON file marked "handwritten": true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsim-guard-'));
    try {
      writeFileSync(join(dir, 'level.json'), JSON.stringify({ handwritten: true }));
      writeFileSync(join(dir, 'plain.json'), JSON.stringify({}));
      expect(bashTargets(`echo {} > ${join(dir, 'level.json')}`, dir, config)).toEqual(['level.json']);
      expect(bashTargets('sed -i s/a/b/ level.json', dir, config)).toEqual(['level.json']);
      expect(bashTargets('echo {} > plain.json', dir, config)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compares without case when the filesystem ignores it', () => {
    const folded = { ...config, foldCase: true };
    expect(decide(edit('SRC/Tournament/RULES-V1.ts'), ROOT, folded, {}).block).toBe(true);
    expect(bashTargets('echo x > SRC/Tournament/RULES-V1.ts', ROOT, folded)).toEqual(['SRC/Tournament/RULES-V1.ts']);
    expect(decide(edit('SRC/Tournament/RULES-V1.ts'), ROOT, { ...config, foldCase: false }, {}).block).toBe(false);
  });

  it('refuses input that is not a readable tool call', () => {
    for (const input of [null, [], 'Edit', 3, {}, { tool_name: 7 }, { tool_name: 'Bash', tool_input: {} }, { tool_name: 'Edit', tool_input: {} }]) {
      expect(decide(input, ROOT, config, {}).block).toBe(true);
    }
  });

  it('projectPath normalizes and rejects paths outside the root', () => {
    expect(projectPath('/a/b', '/a/b/src/x.ts')).toBe('src/x.ts');
    expect(projectPath('/a/b', 'src/../test/y.ts')).toBe('test/y.ts');
    expect(projectPath('/a/b', '/a/c/x.ts')).toBeNull();
    expect(projectPath('/a/b', '/a/b')).toBeNull();
  });

  it('as a process: exit 2 with the reason on stderr for a protected path, 0 otherwise', () => {
    const blocked = runHook(GUARD, edit('src/tournament/rules-v1.ts'));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/src\/tournament\/rules-v1\.ts is protected/u);
    expect(runHook(GUARD, edit('src/batch.ts')).status).toBe(0);
    expect(runHook(GUARD, { tool_name: 'Bash', tool_input: { command: 'touch test/golden/new.json' } }).status).toBe(2);
    const absolute = `echo x > ${join(ROOT, 'src/tournament/rules-v1.ts')}`;
    expect(runHook(GUARD, { tool_name: 'Bash', tool_input: { command: absolute } }).status).toBe(2);
    expect(runHook(GUARD, { tool_name: 'Bash', tool_input: { command: 'npx vitest run src 2>&1 | tail' } }).status).toBe(0);
    expect(runHook(GUARD, null).status).toBe(2);
    expect(runHook(GUARD, edit('test/golden/runs.json'), { DSIM_ALLOW_PROTECTED: '1' }).status).toBe(0);
  });

  it('as a process: refuses when its input is not JSON, instead of letting the edit through', () => {
    const child = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT } });
    expect(child.status).toBe(2);
    expect(child.stderr).toMatch(/refusing/u);
  });
});

describe('related-tests', () => {
  it('runs vitest related for a TypeScript file under src/ or test/', () => {
    expect(relatedCommand('src/tournament/advance.ts')).toEqual(['npx', 'vitest', 'related', '--run', '--reporter=dot', 'src/tournament/advance.ts']);
    expect(relatedCommand('test/batch.test.ts')).not.toBeNull();
  });

  it('does nothing for other files or paths outside the project', () => {
    for (const rel of ['README.md', 'batch.ts', 'src/notes.md', null]) expect(relatedCommand(rel)).toBeNull();
    expect(editedPath(edit('/elsewhere/src/x.ts'), ROOT)).toBeNull();
    expect(editedPath(edit(join(ROOT, 'src/rng.ts')), ROOT)).toBe('src/rng.ts');
  });

  it('as a process: exits 0 without running anything for a file with no related tests', () => {
    const child = runHook(RELATED, edit('README.md'));
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
  });
});
