/**
 * scripts/session-start.sh run by bash in a temporary project, offline. curl, npm, node and uname
 * are fakes on PATH; tar, sha256sum and grep are the real ones, so the checksum check that runs is
 * the script's own.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../scripts/session-start.sh', import.meta.url);
const WANTED = '99.1.0';
const TARBALL = `node-v${WANTED}-linux-x64.tar.xz`;

let tmp: string;
let project: string;
let fakeBin: string;
let fixtures: string;

const write = (path: string, text: string, mode?: number): void => {
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
};

/** A node that prints a version. The image's node in the fakes, the downloaded one in the tarball. */
const fakeNode = (version: string): string => `#!/bin/sh\n[ "$1" = "--version" ] && echo v${version}\n`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-playbook-session-'));
  project = join(tmp, 'project');
  fakeBin = join(tmp, 'bin');
  fixtures = join(tmp, 'fixtures');
  for (const dir of [join(project, 'scripts'), fakeBin, fixtures]) mkdirSync(dir, { recursive: true });
  copyFileSync(SCRIPT, join(project, 'scripts/session-start.sh'));
  write(join(project, '.node-version'), `${WANTED}\n`);
  write(join(project, 'package-lock.json'), '{"lockfileVersion": 3}\n');

  write(join(fakeBin, 'uname'), '#!/bin/sh\necho x86_64\n', 0o755);
  write(join(fakeBin, 'npm'), `#!/bin/sh\nmkdir -p node_modules\necho "npm $*" >> "${join(tmp, 'npm.log')}"\n`, 0o755);
  // curl -fsSL --retry 3 -o <file> <url>: copies the fixture named after the URL's last segment.
  write(
    join(fakeBin, 'curl'),
    `#!/bin/sh\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --retry) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done\necho "$url" >> "${join(tmp, 'curl.log')}"\ncp "${fixtures}/$(basename "$url")" "$out"\n`,
    0o755,
  );

  // The release: a tarball holding bin/node, and a SHASUMS256.txt that lists it.
  const unpacked = join(tmp, 'release', `node-v${WANTED}-linux-x64`, 'bin');
  mkdirSync(unpacked, { recursive: true });
  write(join(unpacked, 'node'), fakeNode(WANTED), 0o755);
  const tar = spawnSync('tar', ['-cJf', join(fixtures, TARBALL), '-C', join(tmp, 'release'), `node-v${WANTED}-linux-x64`]);
  expect(tar.status).toBe(0);
  const sum = createHash('sha256').update(readFileSync(join(fixtures, TARBALL))).digest('hex');
  write(join(fixtures, 'SHASUMS256.txt'), `${'0'.repeat(64)}  node-v${WANTED}-darwin-arm64.tar.gz\n${sum}  ${TARBALL}\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function run(env: Record<string, string> = {}, script = 'scripts/session-start.sh'): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [join(project, script)], {
    cwd: tmp,
    encoding: 'utf8',
    env: {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HOME: join(tmp, 'home'),
      XDG_CACHE_HOME: join(tmp, 'cache'),
      CLAUDE_CODE_REMOTE: 'true',
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_ENV_FILE: join(tmp, 'session.env'),
      ...env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const npmCalls = (): string[] => read(join(tmp, 'npm.log')).split('\n').filter(Boolean);
const nodeDir = (): string => join(tmp, 'cache', 'node', `v${WANTED}-linux-x64`);

describe('session-start.sh', () => {
  it('does nothing outside a cloud session', () => {
    const result = run({ CLAUDE_CODE_REMOTE: '' });
    expect(result.code).toBe(0);
    expect(existsSync(join(project, '.cache'))).toBe(false);
    expect(npmCalls()).toEqual([]);
  });

  it('uses the Node already on PATH when it is the pinned version, and downloads nothing', () => {
    write(join(fakeBin, 'node'), fakeNode(WANTED), 0o755);
    const result = run();
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain(`Session ready: Node v${WANTED}`);
    expect(read(join(tmp, 'curl.log'))).toBe('');
    const line = `export PATH="${fakeBin}:$PATH"`;
    expect(read(join(tmp, 'session.env'))).toBe(`${line}\n`);
    expect(read(join(project, '.cache/session-env.sh'))).toContain(line);
  });

  it('downloads the pinned Node, checks it against SHASUMS256.txt and puts it first on PATH', () => {
    write(join(fakeBin, 'node'), fakeNode('22.0.0'), 0o755);
    const result = run();
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(read(join(tmp, 'curl.log')).split('\n').filter(Boolean)).toEqual([
      `https://nodejs.org/dist/v${WANTED}/${TARBALL}`,
      `https://nodejs.org/dist/v${WANTED}/SHASUMS256.txt`,
    ]);
    expect(existsSync(join(nodeDir(), 'bin/node'))).toBe(true);
    expect(result.stdout).toContain(`Session ready: Node v${WANTED}`);
    expect(read(join(project, '.cache/session-env.sh'))).toContain(`export PATH="${join(nodeDir(), 'bin')}:$PATH"`);
  });

  it('stops before unpacking when the tarball does not match its checksum', () => {
    write(join(fakeBin, 'node'), fakeNode('22.0.0'), 0o755);
    write(join(fixtures, TARBALL), 'tampered');
    const result = run();
    expect(result.code).not.toBe(0);
    expect(existsSync(nodeDir())).toBe(false);
    expect(existsSync(join(project, '.cache/session-env.sh'))).toBe(false);
    expect(npmCalls()).toEqual([]);
  });

  it('stops when SHASUMS256.txt does not list the tarball', () => {
    write(join(fakeBin, 'node'), fakeNode('22.0.0'), 0o755);
    write(join(fixtures, 'SHASUMS256.txt'), `${'0'.repeat(64)}  node-v${WANTED}-darwin-arm64.tar.gz\n`);
    const result = run();
    expect(result.code).not.toBe(0);
    expect(existsSync(nodeDir())).toBe(false);
    expect(npmCalls()).toEqual([]);
  });

  it('runs npm ci once, again only when the lock file changes, and never duplicates env lines', () => {
    write(join(fakeBin, 'node'), fakeNode(WANTED), 0o755);
    expect(run().code).toBe(0);
    expect(run().code).toBe(0);
    expect(npmCalls()).toEqual(['npm ci --no-audit --no-fund --loglevel=error']);

    write(join(project, 'package-lock.json'), '{"lockfileVersion": 3, "packages": {}}\n');
    expect(run().code).toBe(0);
    expect(npmCalls()).toHaveLength(2);
    expect(read(join(tmp, 'session.env')).split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('works from another path in the project, since the stamp hashes the script by its own path', () => {
    write(join(fakeBin, 'node'), fakeNode(WANTED), 0o755);
    mkdirSync(join(project, 'tools'));
    copyFileSync(SCRIPT, join(project, 'tools/hook.sh'));
    rmSync(join(project, 'scripts'), { recursive: true });
    expect(run({}, 'tools/hook.sh')).toMatchObject({ code: 0, stderr: '' });
    expect(run({}, 'tools/hook.sh').code).toBe(0);
    expect(npmCalls()).toHaveLength(1);
  });

  it('writes the env file for subagents before npm ci, so a failed install leaves Node at hand', () => {
    write(join(fakeBin, 'node'), fakeNode(WANTED), 0o755);
    write(join(fakeBin, 'npm'), '#!/bin/sh\nexit 1\n', 0o755);
    const result = run();
    expect(result.code).not.toBe(0);
    expect(read(join(project, '.cache/session-env.sh'))).toContain(`export PATH="${fakeBin}:$PATH"`);
    expect(existsSync(join(project, 'node_modules/.session-start.sha256'))).toBe(false);
  });
});
