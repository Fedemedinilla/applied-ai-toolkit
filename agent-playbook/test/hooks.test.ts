import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, globToRegExp, projectPath, protectedReason, realTarget } from '../claude/hooks/guard-protected-paths.ts';
import { relatedTestArgs, tail } from '../claude/hooks/related-tests.ts';

const FOLDER = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(FOLDER, 'claude/hooks/guard-protected-paths.ts');
const RELATED = join(FOLDER, 'claude/hooks/related-tests.ts');

describe('globToRegExp', () => {
  it('lets ** cross folders and keeps * inside one name', () => {
    expect(globToRegExp('test/golden/**').test('test/golden/a/b.json')).toBe(true);
    expect(globToRegExp('**/*.snap').test('a/b/c.snap')).toBe(true);
    expect(globToRegExp('**/*.snap').test('c.snap')).toBe(true);
    expect(globToRegExp('db/*.sql').test('db/a/b.sql')).toBe(false);
    expect(globToRegExp('.claude/settings.json').test('.claude/settingsXjson')).toBe(false);
  });
});

describe('projectPath', () => {
  it('returns the path inside the project and null outside it', () => {
    expect(projectPath('/repo', '/repo/test/golden/a.json')).toBe('test/golden/a.json');
    expect(projectPath('/repo', 'src/a.ts')).toBe('src/a.ts');
    expect(projectPath('/repo', '/repo/../other/test/golden/a.json')).toBeNull();
    expect(projectPath('/repo', '/etc/passwd')).toBeNull();
  });
});

describe('protectedReason', () => {
  const config = { paths: ['test/golden/**'], jsonFlag: 'handwritten' };

  it('names the glob or the flag that protects a path', () => {
    expect(protectedReason('test/golden/race.json', config, () => null)).toBe('matches test/golden/**');
    expect(protectedReason('content/hero.json', config, () => ({ handwritten: true }))).toBe('has "handwritten": true');
    expect(protectedReason('content/hero.json', config, () => ({ handwritten: 'yes' }))).toBeNull();
    expect(protectedReason('src/a.ts', config, () => ({ handwritten: true }))).toBeNull();
  });
});

describe('guard-protected-paths, run as Claude Code runs it', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-playbook-guard-'));
    mkdirSync(join(root, '.claude'));
    mkdirSync(join(root, 'content'));
    writeFileSync(join(root, '.claude/protected.json'), readFileSync(join(FOLDER, 'claude/protected.json')));
    writeFileSync(join(root, 'content/intro.json'), '{ "handwritten": true, "text": "..." }');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const hook = (input: unknown, env: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, [GUARD], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: root, ...env },
    });
    return { code: result.status, stderr: result.stderr };
  };
  const edit = (filePath: string) => ({ tool_name: 'Edit', tool_input: { file_path: filePath } });

  it('blocks with exit 2 and tells the agent to ask', () => {
    const result = hook(edit(join(root, 'test/golden/race-42.json')));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^Blocked: test\/golden\/race-42\.json is protected \(matches test\/golden\/\*\*\)\. .*ask the person/);
  });

  it('protects its own config, the settings, the hooks, the agents and the session hook', () => {
    for (const path of [
      '.claude/protected.json',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/hooks/guard-protected-paths.ts',
      '.claude/agents/reviewer.md',
      'scripts/session-start.sh',
    ]) {
      expect(hook(edit(path)).code, path).toBe(2);
    }
  });

  it('refuses a Claude Code settings file outside the project, such as the user-level one', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-playbook-home-'));
    try {
      expect(hook(edit(join(home, '.claude/settings.json'))).code).toBe(2);
      expect(hook(edit(join(home, '.claude/settings.local.json'))).code).toBe(2);
      expect(hook(edit(join(home, 'notes.md')))).toEqual({ code: 0, stderr: '' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolves symbolic links before matching, so a link cannot hide a protected target', () => {
    mkdirSync(join(root, 'test/golden'), { recursive: true });
    writeFileSync(join(root, 'test/golden/race.json'), '{}');
    symlinkSync(join(root, 'test/golden'), join(root, 'g'));
    symlinkSync(join(root, 'test/golden/race.json'), join(root, 'race-link.json'));
    symlinkSync(join(root, 'test/golden/new.json'), join(root, 'dangling.json'));
    expect(hook(edit('g/race.json')).code).toBe(2);
    expect(hook(edit('g/new.json')).code).toBe(2);
    expect(hook(edit('race-link.json')).code).toBe(2);
    expect(hook(edit('dangling.json')).code).toBe(2);
    expect(realTarget(join(root, 'g/a/b.json'))).toBe(join(realTarget(root), 'test/golden/a/b.json'));
  });

  it('blocks when it cannot read the tool call, instead of letting it through', () => {
    const bad = hook('{ not json');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/^Blocked: guard error/);
    expect(hook({ tool_name: 'Edit', tool_input: { file_path: 123 } }).code).toBe(2);
    expect(hook('"a string"').code).toBe(2);
  });

  it('blocks through the settings command when Node cannot run the hook at all', () => {
    const settings = JSON.parse(readFileSync(join(FOLDER, 'claude/settings.json'), 'utf8')) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? '';
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // A Node that cannot strip types fails with exit 1, which Claude Code would treat as "allow".
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "SyntaxError" >&2\nexit 1\n');
    chmodSync(join(bin, 'node'), 0o755);
    const result = spawnSync('sh', ['-c', command], {
      input: JSON.stringify(edit('src/a.ts')),
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: root },
    });
    expect(result.status).toBe(2);
  });

  it('blocks an existing JSON file marked as hand-written, and lets other files through', () => {
    expect(hook(edit('content/intro.json')).code).toBe(2);
    expect(hook(edit('content/other.json'))).toEqual({ code: 0, stderr: '' });
    expect(hook(edit('src/a.ts'))).toEqual({ code: 0, stderr: '' });
  });

  it('reads the notebook path of NotebookEdit', () => {
    expect(hook({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'test/golden/n.ipynb' } }).code).toBe(2);
  });

  it('lets the edit through when the session was started with AGENT_ALLOW_PROTECTED=1', () => {
    expect(hook(edit('test/golden/race-42.json'), { AGENT_ALLOW_PROTECTED: '1' })).toEqual({ code: 0, stderr: '' });
  });

  it('blocks every edit when its config is broken, instead of allowing all', () => {
    writeFileSync(join(root, '.claude/protected.json'), '{ "paths": "test/golden/**" }');
    const result = hook(edit('src/a.ts'));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('protected.json cannot be read');
  });

  it('allows everything when the project has no config', () => {
    rmSync(join(root, '.claude/protected.json'));
    expect(decide(edit('test/golden/a.json'), root, {})).toEqual({ code: 0, message: '' });
  });
});

describe('related-tests', () => {
  it('runs vitest related for a TypeScript file inside the project, and nothing for other files', () => {
    expect(relatedTestArgs('src/race.ts')).toEqual(['vitest', 'related', 'src/race.ts', '--run', '--passWithNoTests', '--reporter=dot']);
    expect(relatedTestArgs('README.md')).toBeNull();
    expect(relatedTestArgs('node_modules/x/index.ts')).toBeNull();
    expect(relatedTestArgs('../other/src/a.ts')).toBeNull();
  });

  it('hands the agent the tail of the output, where the failure summary is', () => {
    expect(tail('a\nb\nc\nd\n', 2)).toBe('c\nd');
  });
});

describe('related-tests, run as Claude Code runs it', () => {
  let root: string;
  let bin: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-playbook-related-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A fake npx that logs its arguments, prints 50 numbered lines and exits with `code`. */
  const fakeNpx = (code: number): void => {
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$*" > "${join(root, 'npx.log')}"\ni=1; while [ $i -le 50 ]; do echo "line $i"; i=$((i+1)); done\nexit ${code}\n`);
    chmodSync(join(bin, 'npx'), 0o755);
  };
  const hook = (filePath: string) => {
    const result = spawnSync(process.execPath, [RELATED], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: root },
    });
    return { code: result.status, stderr: result.stderr };
  };

  it('exits 2 with the tail of the output when the related tests fail', () => {
    fakeNpx(1);
    const result = hook(join(root, 'src/race.ts'));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^Related tests failed after editing src\/race\.ts \(exit 1\)/);
    expect(result.stderr).toContain('line 50');
    expect(result.stderr).toContain('line 11\n');
    expect(result.stderr).not.toContain('line 10\n');
    expect(readFileSync(join(root, 'npx.log'), 'utf8')).toBe('vitest related src/race.ts --run --passWithNoTests --reporter=dot\n');
  });

  it('exits 0 and prints nothing when they pass, and runs nothing for a file without tests', () => {
    fakeNpx(0);
    expect(hook('src/race.ts')).toEqual({ code: 0, stderr: '' });
    rmSync(join(root, 'npx.log'));
    expect(hook('README.md')).toEqual({ code: 0, stderr: '' });
    expect(existsSync(join(root, 'npx.log'))).toBe(false);
  });
});

describe('the .claude folder of the playbook', () => {
  const settings = JSON.parse(readFileSync(join(FOLDER, 'claude/settings.json'), 'utf8')) as {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  };

  it('points every hook command at a file this folder ships', () => {
    const commands = Object.values(settings.hooks).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));
    expect(commands.length).toBe(3);
    for (const command of commands) {
      const target = /"\$CLAUDE_PROJECT_DIR"\/(\S+)/.exec(command)?.[1];
      expect(target, command).toBeDefined();
      // Installed layout: .claude/ comes from claude/, scripts/ from scripts/.
      const shipped = (target ?? '').replace(/^\.claude\//, 'claude/');
      expect(existsSync(join(FOLDER, shipped)), shipped).toBe(true);
    }
  });

  it('guards every tool that writes a file', () => {
    const guard = settings.hooks['PreToolUse']?.find((e) => e.hooks.some((h) => h.command.includes('guard-protected-paths')));
    expect(guard?.matcher?.split('|').sort()).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  });

  it('gives the reviewer agent read-only tools', () => {
    const agent = readFileSync(join(FOLDER, 'claude/agents/reviewer.md'), 'utf8');
    const tools = /^tools:\s*(.+)$/m.exec(agent)?.[1]?.split(',').map((t) => t.trim());
    expect(tools).toEqual(['Read', 'Grep', 'Glob']);
  });
});
