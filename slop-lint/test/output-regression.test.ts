// Pins the text and --json output of the CLI byte for byte, so a new output format cannot
// change the existing ones by accident. The golden files were written by the CLI before --sarif
// existed. A rule change that alters these findings on purpose regenerates them, from slop-lint/:
//   node cli.ts test/fixtures/sarif/multibyte.txt --lang en > test/golden/multibyte.text.txt
//   node cli.ts test/fixtures/sarif/multibyte.txt --lang en --json > test/golden/multibyte.json
//   node cli.ts test/fixtures/sarif/multibyte.txt fixtures/cover-letters/en-after.txt --lang en > test/golden/two-files.text.txt
//   node cli.ts test/fixtures/sarif/multibyte.txt fixtures/cover-letters/en-after.txt --lang en --json > test/golden/two-files.json
// two-files.json was written by the CLI of b6127b9, the commit before --sarif, with the same fixtures.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('..', import.meta.url));
const golden = (name: string) => readFileSync(new URL(`golden/${name}`, import.meta.url), 'utf8');
const run = (args: string[]) => spawnSync(process.execPath, ['cli.ts', ...args], { cwd: dir, encoding: 'utf8' });

describe('existing output formats', () => {
  it('prints the same text output, byte for byte', () => {
    const r = run(['test/fixtures/sarif/multibyte.txt', '--lang', 'en']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(golden('multibyte.text.txt'));
  });

  it('prints the same JSON output, byte for byte', () => {
    const r = run(['test/fixtures/sarif/multibyte.txt', '--lang', 'en', '--json']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(golden('multibyte.json'));
  });

  it('prints the same text output for several files, byte for byte', () => {
    const r = run(['test/fixtures/sarif/multibyte.txt', 'fixtures/cover-letters/en-after.txt', '--lang', 'en']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(golden('two-files.text.txt'));
  });

  it('prints the same JSON output for several files, byte for byte, with no file contents in it', () => {
    const r = run(['test/fixtures/sarif/multibyte.txt', 'fixtures/cover-letters/en-after.txt', '--lang', 'en', '--json']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(golden('two-files.json'));
  });
});
