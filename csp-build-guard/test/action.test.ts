import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FOLDER = join(import.meta.dirname, '..');
const ROOT = join(FOLDER, '..');
const ACTION = readFileSync(join(FOLDER, 'action.yml'), 'utf8');
const README = readFileSync(join(FOLDER, 'README.md'), 'utf8');
const LINES = ACTION.split('\n');
const indentOf = (line: string) => line.length - line.trimStart().length;

/** Each run: value of the action, single-line or block, with the line it starts on. */
function runBlocks(): Array<{ line: number; text: string }> {
  const blocks: Array<{ line: number; text: string }> = [];
  LINES.forEach((line, i) => {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (match === null) return;
    const [, , rest = ''] = match;
    if (rest !== '|' && rest !== '>') {
      blocks.push({ line: i + 1, text: rest });
      return;
    }
    const body: string[] = [];
    for (const next of LINES.slice(i + 1)) {
      if (next.trim() !== '' && indentOf(next) <= indentOf(line)) break;
      body.push(next);
    }
    const margin = Math.min(...body.filter((b) => b.trim()).map(indentOf));
    blocks.push({ line: i + 1, text: body.map((b) => b.slice(margin)).join('\n') });
  });
  return blocks;
}

/** The names under a top-level key such as inputs: or outputs:. */
function keysOf(section: string): string[] {
  const start = LINES.indexOf(`${section}:`);
  const keys: string[] = [];
  for (const line of LINES.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) === 0) break;
    const match = /^ {2}([a-z][a-z-]*):\s*$/.exec(line);
    if (match?.[1] !== undefined) keys.push(match[1]);
  }
  return keys;
}

describe('action.yml', () => {
  it('has run: blocks with no ${{ }} expression, so no input reaches the shell as code', () => {
    const blocks = runBlocks();
    expect(blocks.length).toBe(2);
    for (const block of blocks) expect(block.text, `run: at line ${block.line}`).not.toContain('${{');
  });

  it('passes each input only as an env: value, one input per variable', () => {
    const uses = LINES.map((line, i) => ({ line, i })).filter(({ line }) => line.includes('${{ inputs.'));
    expect(uses.length).toBeGreaterThan(0);
    for (const { line, i } of uses) {
      expect(line).toMatch(/^\s+INPUT_[A-Z_]+: \$\{\{ inputs\.[a-z-]+ \}\}$/);
      const parent = LINES.slice(0, i).reverse().find((l) => l.trim() !== '' && indentOf(l) < indentOf(line));
      expect(parent?.trim()).toBe('env:');
    }
    expect(uses.map(({ line }) => /inputs\.([a-z-]+)/.exec(line)?.[1]).sort()).toEqual(keysOf('inputs').sort());
  });

  it('pins actions/setup-node to the same 40-hex commit SHA and tag comment as ci.yml', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const PIN = /uses: actions\/setup-node@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/m;
    const expected = PIN.exec(ci);
    expect(expected).not.toBeNull();
    expect(PIN.exec(ACTION)?.slice(1)).toEqual(expected?.slice(1));
    for (const line of LINES.filter((l) => /^\s*(- )?uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it('runs every step in bash and installs the zod version of the root package.json', () => {
    expect(LINES.filter((l) => /^\s+shell:/.test(l)).map((l) => l.trim())).toEqual(['shell: bash', 'shell: bash']);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(ACTION).toContain(`ZOD_VERSION: ${pkg.dependencies.zod}`);
  });

  it('documents every input and output in the README', () => {
    expect(keysOf('inputs')).toEqual(['dir', 'config', 'sarif-file', 'fail']);
    expect(keysOf('outputs')).toEqual(['sarif-file', 'exit-code']);
    for (const name of [...keysOf('inputs'), ...keysOf('outputs')]) expect(README).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
  });

  it('shows in the README a workflow with pinned actions and the two permissions', () => {
    const example = /## Use it in CI[\s\S]*?```yaml\n([\s\S]*?)```/.exec(README)?.[1] ?? '';
    expect(example).toContain('uses: Fedemedinilla/applied-ai-toolkit/csp-build-guard@');
    expect(example).toMatch(/uses: github\/codeql-action\/upload-sarif@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
    expect(example).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
    expect(example).toMatch(/permissions:\n\s+contents: read\n\s+security-events: write\n/);
    expect(example).not.toMatch(/\$\{\{ secrets\./);
  });
});

describe('the run step, executed as GitHub runs it', () => {
  const step = runBlocks().find((b) => b.text.includes('cli.ts'))?.text ?? '';

  function runStep(
    inputs: { dir?: string; config?: string; sarifFile?: string; fail?: string },
    env: Record<string, string> = { FIXTURE_SECRET: 'fixture-secret-value-0001' },
    cwd = ROOT,
  ) {
    const tmp = mkdtempSync(join(tmpdir(), 'csp-guard-action-'));
    const script = join(tmp, 'step.sh');
    const output = join(tmp, 'output');
    writeFileSync(script, step);
    writeFileSync(output, '');
    // GitHub runs a bash step as `bash --noprofile --norc -eo pipefail {0}`.
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_ACTION_PATH: FOLDER,
        GITHUB_WORKSPACE: cwd,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: tmp,
        INPUT_DIR: inputs.dir ?? '',
        INPUT_CONFIG: inputs.config ?? '',
        INPUT_SARIF_FILE: inputs.sarifFile ?? '',
        INPUT_FAIL: inputs.fail ?? 'true',
        ...env,
      },
    });
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, outputs, tmp };
  }
  const fixture = (name: string) => ({ dir: `csp-build-guard/fixtures/${name}/site`, config: `csp-build-guard/fixtures/${name}/csp-guard.config.json` });

  it('passes, prints the text report and writes the SARIF log to the runner temp folder by default', () => {
    const { code, stdout, outputs, tmp } = runStep(fixture('pass'));
    expect(code).toBe(0);
    expect(stdout).toMatch(/^OK: 6 checks passed, 0 skipped$/m);
    expect(outputs).toEqual({ 'exit-code': '0', 'sarif-file': join(tmp, 'csp-build-guard.sarif') });
    const log = JSON.parse(readFileSync(join(tmp, 'csp-build-guard.sarif'), 'utf8')) as { runs: Array<{ results: unknown[] }> };
    expect(log.runs[0]?.results).toEqual([]);
  });

  it('fails on a failing check by default, and only reports it with fail: false', () => {
    const failing = runStep(fixture('lookbehind'));
    expect(failing.code).toBe(1);
    expect(failing.outputs['exit-code']).toBe('1');
    // A sarif-file in a folder that does not exist yet: the step creates the folder.
    const sarif = join(mkdtempSync(join(tmpdir(), 'csp-guard-action-')), 'reports', 'csp.sarif');
    const reported = runStep({ ...fixture('lookbehind'), fail: 'false', sarifFile: sarif });
    expect(reported.code).toBe(0);
    expect(reported.outputs).toEqual({ 'exit-code': '1', 'sarif-file': sarif });
    const log = JSON.parse(readFileSync(sarif, 'utf8')) as { runs: Array<{ results: Array<{ locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }> }> };
    // Paths are relative to GITHUB_WORKSPACE, the repository root.
    expect(log.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('csp-build-guard/fixtures/lookbehind/site/_astro/app.js');
  });

  it('always fails on a usage or config error, even with fail: false, and leaves no SARIF file', () => {
    const missing = runStep({ dir: 'csp-build-guard/fixtures/nope', config: fixture('pass').config, fail: 'false' });
    expect(missing.code).toBe(2);
    expect(missing.outputs).toEqual({ 'exit-code': '2' });
    expect(existsSync(join(missing.tmp, 'csp-build-guard.sarif'))).toBe(false);
    expect(runStep({ ...fixture('pass'), fail: 'yes' })).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
    expect(runStep({ config: fixture('pass').config })).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
    expect(runStep({ ...fixture('pass'), sarifFile: 'a\nexit-code=0' })).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
  });

  it('takes a dir and a config whose names start with -, as relative paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'csp-guard-dash-'));
    cpSync(join(FOLDER, 'fixtures', 'pass'), join(workspace, '-build'), { recursive: true });
    const result = runStep({ dir: '-build/site', config: '-build/csp-guard.config.json' }, undefined, workspace);
    expect(result.stderr).toBe('');
    expect(result).toMatchObject({ code: 0, outputs: { 'exit-code': '0' } });
    expect(result.stdout).toMatch(/^OK: 6 checks passed, 0 skipped$/m);
  });

  it('fails with exit 2 when the SARIF file cannot be written, and never reports a folder as the SARIF file', () => {
    for (const name of ['pass', 'lookbehind']) {
      const folder = mkdtempSync(join(tmpdir(), 'csp-guard-sarif-dir-'));
      writeFileSync(join(folder, 'old.sarif'), '{}');
      const result = runStep({ ...fixture(name), fail: 'false', sarifFile: folder });
      expect(result, name).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
      expect(result.outputs['sarif-file'], name).toBeUndefined();
      expect(readFileSync(join(folder, 'old.sarif'), 'utf8')).toBe('{}');
      // A path under a regular file: its folder cannot be created.
      const blocked = join(folder, 'old.sarif', 'csp.sarif');
      expect(runStep({ ...fixture(name), fail: 'false', sarifFile: blocked }), name).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
    }
  });

  it('treats inputs as data: shell syntax in an input is never run', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'csp-guard-inject-'));
    const marker = join(tmp, 'pwned');
    const result = runStep({ dir: `$(touch ${marker})`, config: `x; touch ${marker}`, fail: 'false' });
    expect(result.code).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });
});
