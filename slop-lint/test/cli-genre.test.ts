// --genre, --variety and --previous. The goldens pin the JSON output of each new genre over its
// fixture; regenerate them on purpose, from slop-lint/:
//   node cli.ts test/fixtures/genres/email-es.txt --lang es --genre email --json > test/golden/genre-email.json
//   node cli.ts test/fixtures/genres/email-list-en.txt --lang en --genre email --json > test/golden/genre-email-list.json
//   node cli.ts test/fixtures/genres/follow-up-en.txt --lang en --genre follow-up --json > test/golden/genre-follow-up.json
//   node cli.ts test/fixtures/genres/whatsapp-es.txt --lang es --genre whatsapp --variety rioplatense --json > test/golden/genre-whatsapp.json
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LintResult } from '../src/types.ts';
import { sarifLog } from './sarif-schema.ts';

const dir = fileURLToPath(new URL('..', import.meta.url));
const golden = (name: string) => readFileSync(new URL(`golden/${name}`, import.meta.url), 'utf8');
const run = (args: string[], options: { input?: string; cwd?: string } = {}) =>
  spawnSync(process.execPath, [join(dir, 'cli.ts'), ...args], { cwd: options.cwd ?? dir, encoding: 'utf8', ...(options.input === undefined ? {} : { input: options.input }) });
const EMAIL = 'test/fixtures/genres/email-es.txt';
const EMAIL_LIST = 'test/fixtures/genres/email-list-en.txt';
const FOLLOW_UP = 'test/fixtures/genres/follow-up-en.txt';
const WHATSAPP = 'test/fixtures/genres/whatsapp-es.txt';

describe('--genre', () => {
  it('prints the same JSON as the golden of each new genre', () => {
    expect(run([EMAIL, '--lang', 'es', '--genre', 'email', '--json']).stdout).toBe(golden('genre-email.json'));
    expect(run([EMAIL_LIST, '--lang', 'en', '--genre', 'email', '--json']).stdout).toBe(golden('genre-email-list.json'));
    expect(run([FOLLOW_UP, '--lang', 'en', '--genre', 'follow-up', '--json']).stdout).toBe(golden('genre-follow-up.json'));
    expect(run([WHATSAPP, '--lang', 'es', '--genre', 'whatsapp', '--variety', 'rioplatense', '--json']).stdout).toBe(golden('genre-whatsapp.json'));
  });

  it('says on stderr that a new profile is experimental, and says nothing for a cover letter', () => {
    const r = run([WHATSAPP, '--lang', 'es', '--genre=whatsapp']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("slop-lint: the whatsapp profile is experimental; no labelled set has measured its false positives yet\n");
    expect(run([WHATSAPP, '--lang', 'es', '--genre', 'cover-letter']).stderr).toBe('');
    expect(run([WHATSAPP, '--lang', 'es']).stderr).toBe('');
  });

  it('gives the cover-letter output when the genre is cover-letter', () => {
    expect(run([EMAIL, '--lang', 'es', '--genre', 'cover-letter', '--json']).stdout).toBe(run([EMAIL, '--lang', 'es', '--json']).stdout);
  });

  it('guesses with auto, and falls back to cover-letter with a note when unsure', () => {
    const sure = run([FOLLOW_UP, '--lang', 'en', '--genre', 'auto', '--json']);
    expect((JSON.parse(sure.stdout) as LintResult).genre).toBe('follow-up');
    const unsure = run(['-', '--lang', 'en', '--genre', 'auto', '--json'], { input: 'Thanks.' });
    expect('genre' in (JSON.parse(unsure.stdout) as LintResult)).toBe(false);
    expect(unsure.stderr).toMatch(/^slop-lint: -: unsure of the genre \(.+\); linting it as cover-letter\n$/u);
  });

  it('rejects an unknown genre or variety, and a flag with no value', () => {
    for (const args of [['--genre', 'sms'], ['--variety', 'argentina'], ['--genre'], ['--previous']]) {
      const r = run([EMAIL, '--lang', 'es', ...args]);
      expect(r.status, args.join(' ')).toBe(2);
    }
    expect(run(['--list-rules', '--genre', 'auto']).status).toBe(2);
  });

  it('lists the rules as the genre leaves them', () => {
    const r = run(['--list-rules', '--json', '--genre', 'whatsapp', '--no-config']);
    const listed = JSON.parse(r.stdout) as { rules: Array<{ id: string; severity: string; default?: unknown }>; off: string[] };
    expect(listed.off).toContain('FMT-02');
    expect(listed.rules.find((x) => x.id === 'REG-01')).toMatchObject({ severity: 'disqualify', default: { level: 1, severity: 'high' } });
  });

  it('names the genre in the SARIF run, and describes the rules with the profile', () => {
    const r = run([EMAIL, '--lang', 'es', '--genre', 'email', '--sarif']);
    const log = JSON.parse(r.stdout) as { runs: Array<{ properties?: unknown; tool: { driver: { rules: Array<{ id: string; properties: { severity: string } }> } } }> };
    expect(sarifLog.safeParse(log).success).toBe(true);
    expect(log.runs[0]?.properties).toEqual({ genres: { 'test/fixtures/genres/email-es.txt': 'email' } });
    expect(log.runs[0]?.tool.driver.rules.find((x) => x.id === 'EST-09')?.properties.severity).toBe('low');
    expect('properties' in (JSON.parse(run([EMAIL, '--lang', 'es', '--sarif']).stdout) as { runs: object[] }).runs[0]!).toBe(false);
  });
});

describe('--variety and --previous', () => {
  it('flags every form of the other register', () => {
    const r = run(['-', '--lang', 'es', '--variety', 'rioplatense', '--json'], { input: 'Si puedes, dime cuándo.' });
    const result = JSON.parse(r.stdout) as LintResult;
    expect(result.variety).toBe('rioplatense');
    expect(result.findings.filter((f) => f.ruleId === 'REG-01').map((f) => f.match)).toEqual(['puedes', 'dime']);
  });

  it('reads the earlier message and fails on one it cannot read', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'slop-previous-'));
    writeFileSync(join(tmp, 'previous.txt'), 'Hi Dana, I built a dashboard for the Rosario branch.');
    expect(run([join(dir, FOLLOW_UP), '--lang', 'en', '--genre', 'follow-up', '--previous', 'previous.txt'], { cwd: tmp }).status).toBe(0);
    const missing = run([join(dir, FOLLOW_UP), '--lang', 'en', '--genre', 'follow-up', '--previous', 'none.txt'], { cwd: tmp });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/^cannot read none\.txt/u);
  });
});

describe('genre in the config file', () => {
  it('applies the config genre, lets the flag win, and lets the config win over the genre on a rule', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'slop-genre-'));
    writeFileSync(join(tmp, 'chat.txt'), readFileSync(join(dir, WHATSAPP), 'utf8'));
    writeFileSync(join(tmp, 'slop-lint.config.json'), JSON.stringify({ lang: 'es', genre: 'whatsapp' }));
    const byConfig = JSON.parse(run(['chat.txt', '--json'], { cwd: tmp }).stdout) as LintResult;
    expect(byConfig).toMatchObject({ genre: 'whatsapp', findings: [] });
    const byFlag = JSON.parse(run(['chat.txt', '--json', '--genre', 'email'], { cwd: tmp }).stdout) as LintResult;
    expect(byFlag.genre).toBe('email');
    expect(byFlag.findings.map((f) => [f.ruleId, f.message])).toEqual([['FMT-02', 'Emoji in a professional message.']]);
    writeFileSync(join(tmp, 'slop-lint.config.json'), JSON.stringify({ lang: 'es', genre: 'whatsapp', ruleSettings: { 'FMT-02': { level: 2, severity: 'low' } } }));
    const configWins = JSON.parse(run(['chat.txt', '--json'], { cwd: tmp }).stdout) as LintResult;
    expect(configWins.findings.map((f) => [f.ruleId, f.level, f.severity])).toEqual([['FMT-02', 2, 'low']]);
  });
});
