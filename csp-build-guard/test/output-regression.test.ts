// Pins the text and --json output of the CLI byte for byte, so a new output format cannot change
// the existing ones by accident. sarif.test.ts compares the CLI with the report functions it calls,
// which only catches the CLI's wiring: an edit to formatReport or to the report shape changes both
// sides. These golden files were written by the CLI of b6127b9, the commit before --sarif. The JSON
// report holds absolute paths, so the repository root is written as <root>. A check that changes
// these findings on purpose regenerates them, from the repository root, for each case below:
//   FIXTURE_SECRET=fixture-secret-value-0001 node csp-build-guard/cli.ts --dir csp-build-guard/fixtures/<name>/<dir> \
//     --config csp-build-guard/fixtures/<name>/csp-guard.config.json [--json] > csp-build-guard/test/golden/<name>.(text.txt|json)
// and replaces the root path in the JSON files with <root>.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FOLDER = join(import.meta.dirname, '..');
const ROOT = join(FOLDER, '..');
const golden = (name: string) => readFileSync(join(FOLDER, 'test', 'golden', name), 'utf8');
const run = (args: string[]) =>
  spawnSync(process.execPath, [join(FOLDER, 'cli.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', FIXTURE_SECRET: 'fixture-secret-value-0001' },
  });

describe('existing output formats', () => {
  // meta skips one check and meta-misplaced three, so the SKIP lines are pinned too.
  it.each([
    ['pass', 'site', 0],
    ['meta', 'site', 0],
    ['meta-misplaced', 'site', 1],
    ['stale-hash', 'site', 1],
    ['policy-drift', 'site', 1],
    ['vercel-output', 'output', 1],
  ])('%s: the same text and JSON output, byte for byte', (name, dir, code) => {
    const args = ['--dir', `csp-build-guard/fixtures/${name}/${dir}`, '--config', `csp-build-guard/fixtures/${name}/csp-guard.config.json`];
    const text = run(args);
    expect(text.status).toBe(code);
    expect(text.stdout).toBe(golden(`${name}.text.txt`));
    const json = run([...args, '--json']);
    expect(json.status).toBe(code);
    expect(json.stdout.replaceAll(ROOT, '<root>')).toBe(golden(`${name}.json`));
  });
});
