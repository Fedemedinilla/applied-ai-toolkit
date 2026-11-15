import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLEAN, SAMPLE, writeTree } from './sample-tree.ts';

const FOLDER = join(import.meta.dirname, '..');
const ROOT = join(FOLDER, '..');
const ACTION = readFileSync(join(FOLDER, 'action.yml'), 'utf8');
const README = readFileSync(join(FOLDER, 'README.md'), 'utf8');
const LINES = ACTION.split('\n');
const indentOf = (line: string) => line.length - line.trimStart().length;

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}
function tree(files: Readonly<Record<string, string>>): string {
  const root = writeTree(files);
  temporary.push(root);
  return root;
}

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

  it('pins actions/setup-node to the same 40-hex commit SHA and tag comment as ci.yml, with Node 24', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const PIN = /uses: actions\/setup-node@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/m;
    const expected = PIN.exec(ci);
    expect(expected).not.toBeNull();
    expect(PIN.exec(ACTION)?.slice(1)).toEqual(expected?.slice(1));
    for (const line of LINES.filter((l) => /^\s*(- )?uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    expect(ACTION).toMatch(/uses: actions\/setup-node@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+node-version: 24\n/);
    // The action installs its own deps, so setup-node must not turn on npm caching in the consumer's job.
    expect(ACTION).toMatch(/node-version: 24\n\s+package-manager-cache: false\n/);
  });

  it('runs every step in bash and installs the typescript and zod versions of the root package.json, without scripts', () => {
    expect(LINES.filter((l) => /^\s+shell:/.test(l)).map((l) => l.trim())).toEqual(['shell: bash', 'shell: bash']);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(ACTION).toContain(`TYPESCRIPT_VERSION: ${pkg.devDependencies['typescript']}`);
    expect(ACTION).toContain(`ZOD_VERSION: ${pkg.dependencies['zod']}`);
    const install = runBlocks().find((b) => b.text.includes('npm install'))?.text ?? '';
    expect(install).toContain('--ignore-scripts');
    expect(install).toContain('--no-save');
    expect(install).toContain('"typescript@$TYPESCRIPT_VERSION" "zod@$ZOD_VERSION"');
  });

  it('documents every input and output in the README', () => {
    expect(keysOf('inputs')).toEqual(['config', 'sarif-file', 'fail']);
    expect(keysOf('outputs')).toEqual(['sarif-file', 'exit-code']);
    for (const name of [...keysOf('inputs'), ...keysOf('outputs')]) expect(README).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
    expect(ACTION).toMatch(/^ {2}config:\n {4}description: .*\n {4}required: true$/m);
    expect(ACTION).toMatch(/^ {2}fail:\n {4}description: .*\n {4}required: false\n {4}default: 'true'$/m);
  });

  it('shows in the README a workflow with pinned actions and the two permissions', () => {
    const example = /## Use it in CI[\s\S]*?```yaml\n([\s\S]*?)```/.exec(README)?.[1] ?? '';
    expect(example).toContain('uses: Fedemedinilla/applied-ai-toolkit/import-fences@');
    expect(example).toMatch(/uses: github\/codeql-action\/upload-sarif@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
    expect(example).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
    expect(example).toMatch(/permissions:\n\s+contents: read\n\s+security-events: write\n/);
    expect(example).not.toMatch(/\$\{\{ secrets\./);
    // The pins are the ones the other two actions' READMEs show, which their own tests check.
    const other = readFileSync(join(ROOT, 'csp-build-guard', 'README.md'), 'utf8');
    for (const action of ['actions/checkout', 'github/codeql-action/upload-sarif']) {
      const pin = new RegExp(`uses: ${action}@[0-9a-f]{40} # v[\\d.]+`);
      expect(pin.exec(example)?.[0], action).toBe(pin.exec(other)?.[0]);
    }
  });
});

describe('the run step, executed as GitHub runs it', () => {
  const step = runBlocks().find((b) => b.text.includes('cli.ts'))?.text ?? '';

  function runStep(inputs: { config?: string; sarifFile?: string; fail?: string }, cwd: string) {
    const tmp = temp('import-fences-action-');
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
        INPUT_CONFIG: inputs.config ?? '',
        INPUT_SARIF_FILE: inputs.sarifFile ?? '',
        INPUT_FAIL: inputs.fail ?? 'true',
      },
    });
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, outputs, tmp };
  }
  type Log = { runs: Array<{ tool: { driver: { name: string } }; results: Array<{ ruleId: string; locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }> }> };
  const readLog = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Log;

  it('passes, prints the text report and writes the SARIF log to the runner temp folder by default', () => {
    const { code, stdout, outputs, tmp } = runStep({ config: 'import-fences.config.ts' }, tree(CLEAN));
    expect(code).toBe(0);
    expect(stdout).toBe('import-fences: 0 violations in 4 files, 3 rules\n');
    expect(outputs).toEqual({ 'exit-code': '0', 'sarif-file': join(tmp, 'import-fences.sarif') });
    const log = readLog(join(tmp, 'import-fences.sarif'));
    expect(log.runs[0]?.tool.driver.name).toBe('import-fences');
    expect(log.runs[0]?.results).toEqual([]);
  });

  it('holds this repository\'s own fences, the way the CI job runs it', () => {
    const { code, stdout, outputs } = runStep({ config: 'import-fences/repo.config.ts' }, ROOT);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^import-fences: 0 violations in \d+ files, \d+ rules\n$/);
    expect(readLog(outputs['sarif-file'] ?? '').runs[0]?.results).toEqual([]);
  });

  it('fails on a broken fence by default, and only reports it with fail: false', () => {
    const workspace = tree(SAMPLE);
    const failing = runStep({ config: 'import-fences.config.ts' }, workspace);
    expect(failing.code).toBe(1);
    expect(failing.outputs['exit-code']).toBe('1');
    expect(failing.stdout).toMatch(/^import-fences: 10 violations in 9 files, 5 rules$/m);
    // A sarif-file in a folder that does not exist yet: the step creates the folder.
    const sarif = join(temp('import-fences-action-'), 'reports', 'fences.sarif');
    const reported = runStep({ config: 'import-fences.config.ts', fail: 'false', sarifFile: sarif }, workspace);
    expect(reported.code).toBe(0);
    expect(reported.outputs).toEqual({ 'exit-code': '1', 'sarif-file': sarif });
    const results = readLog(sarif).runs[0]?.results ?? [];
    expect(results).toHaveLength(10);
    // Paths are relative to GITHUB_WORKSPACE, the repository root.
    expect(results[2]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('src/client/app.ts');
  });

  it('always fails on a usage or config error, even with fail: false, and leaves no SARIF file', () => {
    const workspace = tree({ ...CLEAN, 'invalid.config.ts': "export default { groups: {}, rules: [{ rule: 'nope', group: 'x' }] };" });
    const missing = runStep({ config: 'nope.config.ts', fail: 'false' }, workspace);
    expect(missing.code).toBe(2);
    expect(missing.outputs).toEqual({ 'exit-code': '2' });
    expect(existsSync(join(missing.tmp, 'import-fences.sarif'))).toBe(false);
    const invalid = runStep({ config: 'invalid.config.ts', fail: 'false' }, workspace);
    expect(invalid).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
    expect(invalid.stderr).toMatch(/^invalid config:/);
    expect(existsSync(join(invalid.tmp, 'import-fences.sarif'))).toBe(false);
    expect(runStep({ config: 'import-fences.config.ts', fail: 'yes' }, workspace)).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
    expect(runStep({ fail: 'false' }, workspace)).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
    expect(runStep({ config: 'import-fences.config.ts', sarifFile: 'a\nexit-code=0' }, workspace)).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
  });

  it('takes a config whose name starts with -, as a relative path', () => {
    const workspace = tree({ ...CLEAN, '-fences.config.ts': CLEAN['import-fences.config.ts'] });
    const result = runStep({ config: '-fences.config.ts' }, workspace);
    expect(result.stderr).toBe('');
    expect(result).toMatchObject({ code: 0, outputs: { 'exit-code': '0' } });
    expect(result.stdout).toBe('import-fences: 0 violations in 5 files, 3 rules\n');
  });

  it('fails with exit 2 when the SARIF file cannot be written, and never reports a folder as the SARIF file', () => {
    for (const files of [CLEAN, SAMPLE]) {
      const workspace = tree(files);
      const folder = temp('import-fences-sarif-dir-');
      writeFileSync(join(folder, 'old.sarif'), '{}');
      const result = runStep({ config: 'import-fences.config.ts', fail: 'false', sarifFile: folder }, workspace);
      expect(result).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
      expect(result.outputs['sarif-file']).toBeUndefined();
      expect(readFileSync(join(folder, 'old.sarif'), 'utf8')).toBe('{}');
      // A path under a regular file: its folder cannot be created.
      const blocked = join(folder, 'old.sarif', 'fences.sarif');
      expect(runStep({ config: 'import-fences.config.ts', fail: 'false', sarifFile: blocked }, workspace)).toMatchObject({ code: 2, outputs: { 'exit-code': '2' } });
    }
  });

  it('treats inputs as data: shell syntax in an input is never run', () => {
    const marker = join(temp('import-fences-inject-'), 'pwned');
    const result = runStep({ config: `$(touch ${marker}); touch ${marker}`, sarifFile: '', fail: 'false' }, tree(CLEAN));
    expect(result.code).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });
});
