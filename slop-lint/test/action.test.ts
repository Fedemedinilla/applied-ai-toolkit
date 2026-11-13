// Checks action.yml as text (no YAML parser in the repository), then runs its lint script with
// bash the way the runner would: inputs in env, GITHUB_ACTION_PATH and GITHUB_OUTPUT set, a
// temporary folder as the workspace. Offline: setup-node is the only step not run here.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sarifLog } from './sarif-schema.ts';

const actionDir = fileURLToPath(new URL('..', import.meta.url));
const action = readFileSync(join(actionDir, 'action.yml'), 'utf8');
const readme = readFileSync(join(actionDir, 'README.md'), 'utf8');
const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const lines = action.split('\n');
const indent = (line: string) => line.length - line.trimStart().length;

/** The body of every run: key, block scalar or single line, with its indentation removed. */
function runBlocks(): string[] {
  const blocks: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/u.exec(line);
    if (!m) return;
    const keyIndent = (m[1] ?? '').length + (line.trimStart().startsWith('- ') ? 2 : 0);
    if (!/^[|>][+-]?$/u.test(m[2] ?? '')) {
      blocks.push(m[2] ?? '');
      return;
    }
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() !== '' && indent(next) <= keyIndent) break;
      body.push(next);
    }
    const strip = Math.min(...body.filter((l) => l.trim() !== '').map(indent));
    blocks.push(body.map((l) => l.slice(strip)).join('\n'));
  });
  return blocks;
}

/** The keys directly under a top-level mapping such as inputs: or outputs:. */
function keysOf(section: string): string[] {
  const start = lines.indexOf(`${section}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indent(line) === 0) break;
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/u.exec(line);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

describe('action.yml', () => {
  it('has one run script, and no ${{ }} expression in it', () => {
    const blocks = runBlocks();
    expect(blocks).toHaveLength(1);
    for (const block of blocks) {
      expect(block).not.toContain('${{ inputs.');
      expect(block).not.toContain('${{');
      expect(block).toContain('node "$cli"');
      expect(block).toContain('cli="$GITHUB_ACTION_PATH/cli.ts"');
    }
  });

  it('passes every input to the script through env', () => {
    for (const input of keysOf('inputs')) expect(action).toMatch(new RegExp(`^ {8}SLOP_[A-Z_]+: \\$\\{\\{ inputs\\.${input} \\}\\}$`, 'mu'));
  });

  it('pins setup-node by a 40-hex SHA, the same one ci.yml uses', () => {
    const uses = [...action.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gmu)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, comment] of uses) expect(`${ref}${comment}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u);
    const pin = /actions\/setup-node@([0-9a-f]{40})/u;
    expect(pin.exec(action)?.[1]).toBe(pin.exec(ci)?.[1]);
    expect(action).toMatch(/node-version: 24$/mu);
  });

  it('documents every input and output in the README', () => {
    const inputs = keysOf('inputs');
    expect(inputs).toEqual(['files', 'lang', 'format', 'anchors', 'sarif-file', 'fail']);
    const outputs = keysOf('outputs');
    expect(outputs).toEqual(['sarif-file', 'exit-code']);
    const at = readme.indexOf('\n## Use it in CI\n');
    expect(at).toBeGreaterThanOrEqual(0);
    const next = readme.indexOf('\n## ', at + 1);
    const section = readme.slice(at, next === -1 ? undefined : next);
    for (const name of [...inputs, ...outputs]) expect(section).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'mu'));
  });
});

describe('the action script', () => {
  const [script] = runBlocks();
  const scriptFile = join(mkdtempSync(join(tmpdir(), 'slop-lint-action-')), 'lint.sh');
  writeFileSync(scriptFile, script ?? '');

  const workspace = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'slop-lint-ws-'));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };
  const CLEAN = '# Notes\n\nI built the export in Python in 2023.\n';
  const BANNED = 'I am passionate about data.\n';

  const runAction = (cwd: string, inputs: Record<string, string>) => {
    const output = join(cwd, '.github-output');
    writeFileSync(output, '');
    const env: NodeJS.ProcessEnv = {
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
      GITHUB_ACTION_PATH: actionDir,
      GITHUB_OUTPUT: output,
      SLOP_FILES: '',
      SLOP_LANG: 'en',
      SLOP_FORMAT: '',
      SLOP_ANCHORS: '',
      SLOP_SARIF_FILE: '',
      SLOP_FAIL: 'true',
      ...inputs,
    };
    const r = spawnSync('bash', [scriptFile], { cwd, env, encoding: 'utf8' });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
  };

  it('expands ** globs and space or newline separated patterns', () => {
    const ws = workspace({ 'README.md': CLEAN, 'docs/a.md': CLEAN, 'docs/deep/b.md': CLEAN, 'notes.txt': 'I built it in 2023.\n' });
    const r = runAction(ws, { SLOP_FILES: 'README.md  **/*.md\nnotes.txt' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^README\.md: 0 findings/mu);
    expect(r.stdout).toMatch(/^docs\/deep\/b\.md: 0 findings/mu);
    expect(r.stdout).toMatch(/^notes\.txt: /mu);
    expect(r.outputs).toEqual({ 'exit-code': '0', 'sarif-file': '' });
  });

  it('fails on a level 1 finding, and not with fail: false', () => {
    const ws = workspace({ 'letter.txt': BANNED });
    expect(runAction(ws, { SLOP_FILES: 'letter.txt' })).toMatchObject({ status: 1, outputs: { 'exit-code': '1' } });
    expect(runAction(ws, { SLOP_FILES: 'letter.txt', SLOP_FAIL: 'false' })).toMatchObject({ status: 0, outputs: { 'exit-code': '1' } });
  });

  it('always fails with exit 2 on a usage or read error, even with fail: false', () => {
    const ws = workspace({ 'letter.txt': BANNED });
    const nothing = runAction(ws, { SLOP_FILES: 'docs/**/*.md', SLOP_FAIL: 'false' });
    expect(nothing.status).toBe(2);
    expect(nothing.stderr).toBe('slop-lint: no file matches docs/**/*.md\n');
    expect(runAction(ws, { SLOP_FILES: 'missing.txt', SLOP_FAIL: 'false' }).stderr).toMatch(/no file matches missing\.txt/u);
    expect(runAction(ws, { SLOP_FILES: '   ', SLOP_FAIL: 'false' }).stderr).toMatch(/files is empty/u);
    const lang = runAction(ws, { SLOP_FILES: 'letter.txt', SLOP_LANG: 'fr', SLOP_FAIL: 'false' });
    expect(lang).toMatchObject({ status: 2, outputs: { 'exit-code': '2' } });
    expect(runAction(ws, { SLOP_FILES: 'letter.txt', SLOP_FAIL: 'yes' }).status).toBe(2);
    expect(runAction(ws, { SLOP_FILES: 'letter.txt', SLOP_FORMAT: '--sarif', SLOP_FAIL: 'false' }).status).toBe(2);
  });

  it('treats every input as data, never as shell code', () => {
    const ws = workspace({ 'letter.txt': BANNED });
    const pwned = join(ws, 'pwned');
    for (const value of ['$(touch pwned)', '`touch pwned`', 'letter.txt;touch pwned', "'; touch pwned; '"]) {
      const files = runAction(ws, { SLOP_FILES: value, SLOP_FAIL: 'false' });
      expect(files.status).toBe(2);
      const anchors = runAction(ws, { SLOP_FILES: 'letter.txt', SLOP_ANCHORS: value, SLOP_FAIL: 'false' });
      expect(anchors.status).toBe(0);
      const lang = runAction(ws, { SLOP_FILES: 'letter.txt', SLOP_LANG: value });
      expect(lang.status).toBe(2);
    }
    expect(existsSync(pwned)).toBe(false);
  });

  it('reads a file whose name starts with - as a file', () => {
    const ws = workspace({ '-letter.txt': BANNED });
    const r = runAction(ws, { SLOP_FILES: '-letter.txt' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^\.\/-letter\.txt:1:/mu);
  });

  it('also writes SARIF to sarif-file, with uris relative to the workspace', () => {
    const ws = workspace({ 'docs/letter.txt': BANNED, 'README.md': CLEAN });
    const r = runAction(ws, { SLOP_FILES: '**/*.txt README.md', SLOP_SARIF_FILE: 'out/sarif/slop-lint.sarif', SLOP_FAIL: 'false' });
    expect(r.status).toBe(0);
    expect(r.outputs).toEqual({ 'exit-code': '1', 'sarif-file': 'out/sarif/slop-lint.sarif' });
    const log = sarifLog.parse(JSON.parse(readFileSync(join(ws, 'out/sarif/slop-lint.sarif'), 'utf8')));
    expect(log.runs[0]?.results.map((x) => x.locations[0]?.physicalLocation.artifactLocation.uri)).toContain('docs/letter.txt');
    expect(r.stdout).toMatch(/docs\/letter\.txt:1:/u);
  });

  it('fails with exit 2 when the SARIF file cannot be written, even with fail: false', () => {
    // A redirect into a folder fails with status 1, the same code as a level 1 finding.
    const ws = workspace({ 'letter.txt': BANNED, 'out/keep.txt': '' });
    const r = runAction(ws, { SLOP_FILES: 'letter.txt', SLOP_SARIF_FILE: 'out', SLOP_FAIL: 'false' });
    expect(r.status).toBe(2);
    expect(r.outputs).toEqual({ 'exit-code': '2', 'sarif-file': '' });
    expect(r.stderr).toMatch(/could not write SARIF to out/u);
  });

  it('refuses a sarif-file with a line break, which could forge another output', () => {
    const ws = workspace({ 'letter.txt': BANNED });
    const r = runAction(ws, { SLOP_FILES: 'letter.txt', SLOP_SARIF_FILE: 'a.sarif\nexit-code=0', SLOP_FAIL: 'false' });
    expect(r.status).toBe(2);
    expect(r.outputs).toEqual({});
  });
});
