import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sarifLog, type ParsedSarif } from './sarif-schema.ts';

// Run from slop-lint/, so relative paths and their uris are predictable.
const dir = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = 'test/fixtures/sarif/multibyte.txt';
const PASSING = 'fixtures/cover-letters/en-after.txt';
const run = (args: string[], input?: string) =>
  spawnSync(process.execPath, ['cli.ts', ...args], { cwd: dir, encoding: 'utf8', ...(input === undefined ? {} : { input }) });
const parse = (stdout: string): ParsedSarif => sarifLog.parse(JSON.parse(stdout));
const uris = (log: ParsedSarif) => [...new Set(log.runs[0]?.results.map((r) => r.locations[0]?.physicalLocation.artifactLocation.uri))];

describe('cli --sarif', () => {
  it('prints one valid log and keeps the exit code of the lint', () => {
    const r = run([FIXTURE, '--lang', 'en', '--sarif']);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('');
    const log = parse(r.stdout);
    expect(uris(log)).toEqual([FIXTURE]);
    expect(log.runs[0]?.results.some((x) => x.ruleId === 'LEX-03' && x.level === 'error')).toBe(true);
    expect(r.stdout.endsWith('}\n')).toBe(true);
  });

  it('exits 0 when no level 1 rule fires', () => {
    const r = run([PASSING, '--lang', 'en', '--sarif']);
    expect(r.status).toBe(0);
    expect(parse(r.stdout).runs[0]?.results.every((x) => x.level !== 'error' || x.ruleId === 'ESP-02')).toBe(true);
  });

  it('prints the same bytes on every run', () => {
    const a = run([FIXTURE, PASSING, '--lang', 'en', '--sarif']).stdout;
    expect(run([FIXTURE, PASSING, '--lang', 'en', '--sarif']).stdout).toBe(a);
  });

  it('converts columns to code points on the multibyte fixture', () => {
    const results = parse(run([FIXTURE, '--lang', 'en', '--sarif']).stdout).runs[0]?.results ?? [];
    const writing = results.find((x) => x.message.text.includes('"I am writing to express"'));
    expect(writing?.locations[0]?.physicalLocation.region).toEqual({ startLine: 3, startColumn: 24, endLine: 3, endColumn: 47 });
    const emoji = results.filter((x) => x.ruleId === 'FMT-02').map((x) => x.locations[0]?.physicalLocation.region.startColumn);
    expect(emoji).toEqual([6, 19, 21]);
  });

  it('covers several files in one run, and exits 1 if any fails', () => {
    const r = run([PASSING, FIXTURE, '--lang', 'en', '--sarif']);
    expect(r.status).toBe(1);
    const log = parse(r.stdout);
    expect(log.runs).toHaveLength(1);
    expect(uris(log)).toEqual([PASSING, FIXTURE]);
  });

  it('writes the uri relative, with forward slashes and no leading ./', () => {
    expect(uris(parse(run([`./${FIXTURE}`, '--lang', 'en', '--sarif']).stdout))).toEqual([FIXTURE]);
    expect(uris(parse(run([join(dir, FIXTURE), '--lang', 'en', '--sarif']).stdout))).toEqual([FIXTURE]);
    const tmp = mkdtempSync(join(tmpdir(), 'slop-lint-sarif-'));
    const outside = join(tmp, 'letter.txt');
    writeFileSync(outside, 'I am passionate about data.');
    const [uri] = uris(parse(run([outside, '--lang', 'en', '--sarif']).stdout));
    expect(uri).toMatch(/^(\.\.\/)+.*letter\.txt$/u);
  });

  it('names stdin "stdin", or what --sarif-uri says', () => {
    const letter = 'I am passionate about data.';
    expect(uris(parse(run(['-', '--lang', 'en', '--sarif'], letter).stdout))).toEqual(['stdin']);
    expect(uris(parse(run(['-', '--lang', 'en', '--sarif', '--sarif-uri', 'docs\\letter.txt'], letter).stdout))).toEqual(['docs/letter.txt']);
    expect(uris(parse(run(['-', PASSING, '--lang', 'en', '--sarif', '--sarif-uri=./letters/a.txt'], letter).stdout))).toEqual(['letters/a.txt', PASSING]);
  });

  it('is a usage error, exit 2 with nothing on stdout, to combine it with --json', () => {
    for (const args of [
      [FIXTURE, '--lang', 'en', '--json', '--sarif'],
      [FIXTURE, '--lang', 'en', '--sarif', '--json'],
    ]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/--json and --sarif cannot be used together/u);
    }
  });

  it('exits 2 on a misused --sarif-uri, an unreadable file or a path it cannot name', () => {
    const cases: Array<[string[], RegExp]> = [
      [['-', '--lang', 'en', '--sarif-uri', 'a.txt'], /needs --sarif/u],
      [[FIXTURE, '--lang', 'en', '--sarif', '--sarif-uri', 'a.txt'], /no input is -/u],
      [['-', '--lang', 'en', '--sarif', '--sarif-uri='], /needs a value/u],
      [['-', '--lang', 'en', '--sarif', '--sarif-uri'], /needs a value/u],
      [['does-not-exist.txt', '--lang', 'en', '--sarif'], /cannot read/u],
      [['C:\\repo\\a.txt', '--lang', 'en', '--sarif'], /Windows path/u],
    ];
    for (const [args, message] of cases) {
      const r = run(args, 'Text.');
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(message);
    }
  });
});
