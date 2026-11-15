// Pins the text and --json output of the CLI byte for byte, so a new output format cannot change
// the existing ones by accident. The golden files were written by the CLI of 51503bf, the commit
// before --sarif and JSON configs, over the trees of sample-tree.ts. A rule change that alters
// these violations on purpose regenerates them: write the tree with writeTree(SAMPLE) or
// writeTree(CLEAN), run `node <repo>/import-fences/cli.ts` and the same with --json inside it, and
// save stdout as test/golden/<name>.text.txt and test/golden/<name>.json.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLEAN, SAMPLE, writeTree } from './sample-tree.ts';

const FOLDER = join(import.meta.dirname, '..');
const golden = (name: string) => readFileSync(join(FOLDER, 'test', 'golden', name), 'utf8');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('existing output formats', () => {
  it.each([
    ['sample', SAMPLE, 1],
    ['clean', CLEAN, 0],
  ] as const)('%s: the same text and JSON output, byte for byte', (name, files, code) => {
    const root = writeTree(files);
    roots.push(root);
    const run = (args: string[]) => spawnSync(process.execPath, [join(FOLDER, 'cli.ts'), ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    const text = run([]);
    expect({ code: text.status, stderr: text.stderr }).toEqual({ code, stderr: '' });
    expect(text.stdout).toBe(golden(`${name}.text.txt`));
    const json = run(['--json']);
    expect({ code: json.status, stderr: json.stderr }).toEqual({ code, stderr: '' });
    expect(json.stdout).toBe(golden(`${name}.json`));
  });

  it('covers every rule id but the two the sample has no code for', () => {
    const rules = new Set((JSON.parse(golden('sample.json')) as { violations: Array<{ rule: string }> }).violations.map((v) => v.rule));
    expect([...rules].sort()).toEqual(['dynamic-import', 'empty-group', 'forbidden-import', 'relative-extension', 'single-importer', 'single-reader', 'stale-allow', 'unresolved-import']);
  });
});
