// The CLI with a config file, in temporary folders: discovery, precedence, ignore, overrides,
// custom rules in every output format, inline suppression in every output format, --list-rules.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LintResult } from '../src/types.ts';
import { sarifLog } from './sarif-schema.ts';

const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));

/** A folder with a .git marker, so discovery never looks above it, and the given files. */
const project = (files: Record<string, string | object>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-lint-config-'));
  mkdirSync(join(dir, '.git'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
};
const run = (cwd: string, args: string[], input?: string) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', ...(input === undefined ? {} : { input }) });

const BANNED = 'I am passionate about data.\n';
const CLEAN = 'I built the export in Python in 2023.\n';
const CIRCLE = { id: 'X-CIRCLE-BACK', name: 'Meeting filler', message: 'House style bans this phrase.', suggestion: 'Say who answers, and by when.', lang: 'en', level: 1, severity: 'high', pattern: 'circle back' };

describe('finding the config file', () => {
  it('reads slop-lint.config.json from the working directory, so --lang is not needed', () => {
    const dir = project({ 'slop-lint.config.json': { lang: 'en' }, 'letter.txt': BANNED });
    const r = run(dir, ['letter.txt']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/letter\.txt:1:6 +L1 high +LEX-03/u);
  });

  it('finds it in a parent folder, and globs stay relative to its folder', () => {
    const dir = project({ 'slop-lint.config.json': { lang: 'en', ignore: ['docs/skip.txt'] }, 'docs/skip.txt': BANNED, 'docs/keep.txt': CLEAN });
    const r = run(join(dir, 'docs'), ['skip.txt', 'keep.txt']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('keep.txt: 0 findings (L1 0, L2 0, L3 0); slop score 15/15; passes tier 1\n');
  });

  it('takes ignore and override globs with a hyphen in a folder name', () => {
    const dir = project({
      'slop-lint.config.json': { lang: 'en', ignore: ['cover-letters/*.md'], overrides: [{ files: ['my-docs/*.md'], ruleSettings: { 'LEX-03': 'off', 'ESP-04': 'off' } }] },
      'cover-letters/a.md': BANNED,
      'my-docs/b.md': BANNED,
    });
    const ignored = run(dir, ['cover-letters/a.md']);
    expect(ignored.stderr).toMatch(/every input file is ignored/u);
    expect(ignored.status).toBe(0);
    const overridden = run(dir, ['my-docs/b.md']);
    expect(overridden.stderr).toBe('');
    expect(overridden.status).toBe(0);
  });

  it('stops at the folder that holds .git', () => {
    const dir = project({ 'slop-lint.config.json': { lang: 'en' }, 'inner/.git/HEAD': '', 'inner/letter.txt': BANNED });
    const r = run(join(dir, 'inner'), ['letter.txt']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^--lang must be en or es\n/u);
  });

  it('takes --config, and ignores every config with --no-config', () => {
    const dir = project({ 'slop-lint.config.json': { lang: 'es' }, 'other/team.json': { lang: 'en', ruleSettings: { 'LEX-03': 'off', 'ESP-04': 'off' } }, 'letter.txt': BANNED });
    expect(run(dir, ['letter.txt', '--config', 'other/team.json']).status).toBe(0);
    expect(run(dir, ['letter.txt', '--config=other/team.json']).status).toBe(0);
    const none = run(dir, ['letter.txt', '--no-config']);
    expect(none.status).toBe(2);
    expect(none.stderr).toMatch(/^--lang must be en or es\n/u);
    expect(run(dir, ['letter.txt', '--no-config', '--lang', 'en']).status).toBe(1);
  });

  it('prints the same bytes with --no-config, with an empty config, and with none', () => {
    const letter = 'I am passionate about data \u{1F680}. The pivotal work was robust and comprehensive.\n';
    const bare = project({ 'letter.txt': letter, 'README.md': `# Notes\n\n${letter}` });
    const empty = project({ 'slop-lint.config.json': {}, 'letter.txt': letter, 'README.md': `# Notes\n\n${letter}` });
    for (const mode of [[], ['--json'], ['--sarif']]) {
      const args = ['letter.txt', 'README.md', '--lang', 'en', ...mode];
      const expected = run(bare, args);
      expect(expected.status).toBe(1);
      expect(run(empty, args).stdout).toBe(expected.stdout);
      expect(run(empty, [...args, '--no-config']).stdout).toBe(expected.stdout);
    }
  });
});

describe('a config file that cannot be used', () => {
  const bad = (config: string | object, args: string[] = ['letter.txt']) => {
    const dir = project({ 'slop-lint.config.json': config, 'letter.txt': BANNED });
    return run(dir, args);
  };

  it('is a usage error, exit 2, with the file and the key path, and nothing on stdout', () => {
    const cases: Array<[string | object, RegExp]> = [
      [{ langs: 'en' }, /^slop-lint\.config\.json: langs: unknown key; the known keys are /u],
      [{ lang: 'fr' }, /^slop-lint\.config\.json: lang: must be one of "en", "es"\n$/u],
      [{ ruleSettings: { 'LEX-99': 'off' } }, /^slop-lint\.config\.json: ruleSettings\.LEX-99: is not the id/u],
      [{ rules: [{ ...CIRCLE, pattern: '(circle' }] }, /^slop-lint\.config\.json: rules\[0\]\.pattern: does not compile: /u],
      [{ rules: [{ ...CIRCLE, id: 'LEX-03' }] }, /^slop-lint\.config\.json: rules\[0\]\.id: must start with X-/u],
      [{ overrides: [{ files: ['docs/**'], lang: 3 }] }, /^slop-lint\.config\.json: overrides\[0\]\.lang: must be one of/u],
      ['{ "lang": ', /^slop-lint\.config\.json: not valid JSON: /u],
    ];
    for (const [config, message] of cases) {
      const r = bad(config, ['letter.txt', '--lang', 'en']);
      expect(r.status, JSON.stringify(config)).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(message);
    }
  });

  it('is a usage error when --config names a missing file, has no value, or meets --no-config', () => {
    const dir = project({ 'letter.txt': BANNED });
    expect(run(dir, ['letter.txt', '--lang', 'en', '--config', 'nope.json']).stderr).toMatch(/^cannot read the config file nope\.json: /u);
    expect(run(dir, ['letter.txt', '--lang', 'en', '--config', 'nope.json']).status).toBe(2);
    expect(run(dir, ['letter.txt', '--lang', 'en', '--config']).stderr).toMatch(/^--config needs a file\n/u);
    expect(run(dir, ['letter.txt', '--lang', 'en', '--config', 'a.json', '--no-config']).stderr).toMatch(/cannot be used together/u);
  });
});

describe('precedence', () => {
  it('lets --lang, --format and --anchors win over the config', () => {
    const dir = project({
      'slop-lint.config.json': { lang: 'es', format: 'markdown', anchors: ['airflow'] },
      'es.txt': 'Uso airflow con el equipo. Me gusta el equipo.\n',
      'doc.txt': '# Notes\n\n- First item.\n- Second item.\n',
    });
    expect(run(dir, ['es.txt']).stdout).toMatch(/^0 findings/u);
    expect(run(dir, ['es.txt', '--anchors', 'dbt']).stdout).toMatch(/LEX-07/u);
    expect(run(dir, ['doc.txt', '--lang', 'en']).stdout).not.toMatch(/FMT-01/u);
    expect(run(dir, ['doc.txt', '--lang', 'en', '--format', 'text']).stdout).toMatch(/FMT-01/u);
    expect((JSON.parse(run(dir, ['es.txt', '--json']).stdout) as LintResult).lang).toBe('es');
    expect((JSON.parse(run(dir, ['es.txt', '--json', '--lang', 'en']).stdout) as LintResult).lang).toBe('en');
  });

  it('applies overrides per file: another language for docs/es', () => {
    const dir = project({
      'slop-lint.config.json': { lang: 'en', overrides: [{ files: ['docs/es/**'], lang: 'es' }] },
      'docs/guide.md': CLEAN,
      'docs/es/guia.md': 'Armé el reporte en Python en 2023.\n',
    });
    const r = run(dir, ['docs/guide.md', 'docs/es/guia.md', '--json']);
    const report = JSON.parse(r.stdout) as Array<{ file: string; result: LintResult }>;
    expect(report.map((x) => [x.file, x.result.lang])).toEqual([
      ['docs/guide.md', 'en'],
      ['docs/es/guia.md', 'es'],
    ]);
    const forced = JSON.parse(run(dir, ['docs/es/guia.md', '--json', '--lang', 'en']).stdout) as LintResult;
    expect(forced.lang).toBe('en');
  });

  it('says which file has no language when the config sets one only for some', () => {
    const dir = project({ 'slop-lint.config.json': { overrides: [{ files: ['docs/**'], lang: 'en' }] }, 'docs/a.md': CLEAN, 'b.md': CLEAN });
    expect(run(dir, ['docs/a.md']).status).toBe(0);
    const r = run(dir, ['docs/a.md', 'b.md']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^--lang must be en or es; slop-lint\.config\.json sets no lang for b\.md\n/u);
  });
});

describe('ignore', () => {
  it('skips a matching file even when it is named, and never stdin', () => {
    const dir = project({ 'slop-lint.config.json': { lang: 'en', ignore: ['vendor/**', 'CHANGELOG.md'] }, 'vendor/a/x.md': BANNED, 'CHANGELOG.md': BANNED, 'README.md': CLEAN });
    const r = run(dir, ['vendor/a/x.md', 'CHANGELOG.md', 'README.md', '-'], BANNED);
    expect(r.status).toBe(1);
    expect(r.stdout.split('\n').filter((l) => / findings \(/u.test(l)).map((l) => l.split(':')[0])).toEqual(['README.md', '-']);
  });

  it('exits 0 with a note on stderr when every file is ignored', () => {
    const dir = project({ 'slop-lint.config.json': { lang: 'en', ignore: ['**/*.md'] }, 'a.md': BANNED });
    const r = run(dir, ['a.md']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('slop-lint: every input file is ignored by slop-lint.config.json\n');
    expect(run(dir, ['a.md', '--json']).stdout).toBe('[]\n');
  });
});

describe('rule settings and custom rules', () => {
  const config = {
    lang: 'en',
    ruleSettings: { 'LEX-03': { level: 2, severity: 'low' }, 'ESP-04': 'off' },
    rules: [CIRCLE],
    overrides: [{ files: ['drafts/**'], ruleSettings: { 'X-CIRCLE-BACK': 'off' } }],
  };
  const LETTER = 'I am passionate about data. We will circle back in 2024.\n';

  it('reports a custom rule in the text output like a built-in one, and fails on its level 1', () => {
    const dir = project({ 'slop-lint.config.json': config, 'letter.txt': LETTER, 'drafts/letter.txt': LETTER });
    const r = run(dir, ['letter.txt']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      'letter.txt:1:6   L2 low        LEX-03    Banned cover-letter phrase.\n' +
        '    "passionate about" -> Replace it with a fact from the CV: a project, a tool, a number, a year.\n' +
        'letter.txt:1:37  L1 high       X-CIRCLE-BACK House style bans this phrase.\n' +
        '    "circle back" -> Say who answers, and by when.\n' +
        '2 findings (L1 1, L2 1, L3 0); slop score 11.5/15; fails tier 1\n',
    );
    const draft = run(dir, ['drafts/letter.txt']);
    expect(draft.status).toBe(0);
    expect(draft.stdout).not.toMatch(/X-CIRCLE-BACK/u);
  });

  it('reports it in --json and in --sarif, with a rule descriptor', () => {
    const dir = project({ 'slop-lint.config.json': config, 'letter.txt': LETTER });
    const result = JSON.parse(run(dir, ['letter.txt', '--json']).stdout) as LintResult;
    expect(result.findings.map((f) => [f.ruleId, f.level, f.severity])).toEqual([
      ['LEX-03', 2, 'low'],
      ['X-CIRCLE-BACK', 1, 'high'],
    ]);
    const log = sarifLog.parse(JSON.parse(run(dir, ['letter.txt', '--sarif']).stdout));
    const [sarifRun] = log.runs;
    expect(sarifRun?.tool.driver.rules.map((r) => [r.id, r.shortDescription.text, r.defaultConfiguration.level])).toEqual([
      ['LEX-03', 'Tier 1 phrases (English)', 'warning'],
      ['X-CIRCLE-BACK', 'Meeting filler', 'error'],
    ]);
    expect(sarifRun?.results.map((r) => [r.ruleId, r.level])).toEqual([
      ['LEX-03', 'warning'],
      ['X-CIRCLE-BACK', 'error'],
    ]);
  });
});

describe('inline suppression in the output', () => {
  const DOC = [
    '# Notes',
    '',
    '<!-- slop-lint-disable-next-line LEX-03: quoted from the posting -->',
    'I am passionate about data.',
    '',
    '<!-- slop-lint-disable-next-line FMT-02 -->',
    'I built the export in Python in 2023.',
    '',
  ].join('\n');

  it('counts the suppressed findings in the summary and lists the unused directive', () => {
    const dir = project({ 'notes.md': DOC });
    const r = run(dir, ['notes.md', '--lang', 'en']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      'notes.md:6:1  L2 low        SUP-01    This suppression matches no finding. (no FMT-02 finding on the next line)\n' +
        '    "<!-- slop-lint-disable-next-line FMT-02 -->" -> Delete the directive, or the rule id that matches nothing.\n' +
        '0 findings (L1 0, L2 0, L3 0); slop score 15/15; passes tier 1; 1 suppressed; 1 directive problem\n',
    );
  });

  it('lists them in --json, outside findings', () => {
    const dir = project({ 'notes.md': DOC });
    const result = JSON.parse(run(dir, ['notes.md', '--lang', 'en', '--json']).stdout) as LintResult;
    expect(result.findings).toEqual([]);
    expect(result.suppressed).toEqual([expect.objectContaining({ ruleId: 'LEX-03', line: 4, suppressedBy: { line: 3, column: 1, reason: 'quoted from the posting' } })]);
    expect(result.directiveProblems?.map((f) => [f.ruleId, f.line])).toEqual([['SUP-01', 6]]);
  });

  it('lists them in --sarif: the suppressed result with suppressions inSource, the unused one as a warning', () => {
    const dir = project({ 'notes.md': DOC });
    const raw = JSON.parse(run(dir, ['notes.md', '--lang', 'en', '--sarif']).stdout) as { runs: Array<{ results: Array<Record<string, unknown>> }> };
    const log = sarifLog.parse(raw);
    expect(log.runs[0]?.tool.driver.rules.map((r) => r.id)).toEqual(['LEX-03', 'SUP-01']);
    expect(raw.runs[0]?.results.map((r) => [r['ruleId'], r['level'], r['suppressions']])).toEqual([
      ['LEX-03', 'error', [{ kind: 'inSource', justification: 'quoted from the posting' }]],
      ['SUP-01', 'warning', undefined],
    ]);
  });

  it('keeps the fingerprint of a finding when it becomes suppressed', () => {
    const dir = project({ 'a.md': 'I am passionate about data.\n', 'b/a.md': '<!-- slop-lint-disable-next-line LEX-03 -->\nI am passionate about data.\n' });
    const fp = (cwd: string) => {
      const raw = JSON.parse(run(cwd, ['a.md', '--lang', 'en', '--sarif']).stdout) as { runs: Array<{ results: Array<{ ruleId: string; partialFingerprints: Record<string, string> }> }> };
      return raw.runs[0]?.results.find((r) => r.ruleId === 'LEX-03')?.partialFingerprints;
    };
    expect(fp(join(dir, 'b'))).toEqual(fp(dir));
  });

  it('refuses to suppress a disqualify rule unless the config allows it, and fails on problems when asked', () => {
    const doc = '<!-- slop-lint-disable-next-line FMT-04 -->\nI want to join [Company Name] in 2024.\n';
    const strict = project({ 'slop-lint.config.json': { lang: 'en' }, 'a.md': doc });
    const refused = run(strict, ['a.md']);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/FMT-04[\s\S]*SUP-02[\s\S]*disqualified; 1 directive problem\n$/u);
    const allowed = project({ 'slop-lint.config.json': { lang: 'en', suppressions: { allowDisqualify: true } }, 'a.md': doc });
    expect(run(allowed, ['a.md']).stdout).toBe('0 findings (L1 0, L2 0, L3 0); slop score 15/15; passes tier 1; 1 suppressed\n');
    const unused = '<!-- slop-lint-disable-next-line LEX-03 -->\nI built it in 2023.\n';
    expect(run(project({ 'slop-lint.config.json': { lang: 'en' }, 'a.md': unused }), ['a.md']).status).toBe(0);
    expect(run(project({ 'slop-lint.config.json': { lang: 'en', suppressions: { failOnProblems: true } }, 'a.md': unused }), ['a.md']).status).toBe(1);
  });

  it('refuses the mask when the config turns it off', () => {
    const doc = '<!-- slop-lint-disable-next-line -->\nI am passionate about data.\n';
    expect(run(project({ 'slop-lint.config.json': { lang: 'en' }, 'a.md': doc }), ['a.md']).status).toBe(0);
    const r = run(project({ 'slop-lint.config.json': { lang: 'en', suppressions: { mask: false } }, 'a.md': doc }), ['a.md']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/SUP-02/u);
  });
});

describe('--list-rules', () => {
  const config = { lang: 'en', ruleSettings: { 'LEX-04': 'off', 'EST-10': { level: 1 } }, rules: [CIRCLE], overrides: [{ files: ['drafts/**'], ruleSettings: { 'X-CIRCLE-BACK': 'off' } }] };
  interface Listing {
    config: string | null;
    rules: Array<{ id: string; name: string; lang: string; level: number; severity: string; kind: string; source: string; default?: { level: number; severity: string } }>;
    off: string[];
  }

  it('lists the whole catalog without a config, needing no file and no --lang', () => {
    const dir = project({});
    const r = run(dir, ['--list-rules', '--json']);
    expect(r.status).toBe(0);
    const listing = JSON.parse(r.stdout) as Listing;
    expect(listing.config).toBeNull();
    expect(listing.off).toEqual([]);
    expect(listing.rules).toHaveLength(52);
    expect(listing.rules.every((x) => x.source === 'built-in' && x.default === undefined)).toBe(true);
    expect(listing.rules[0]).toEqual({ id: 'LEX-01', name: expect.any(String), lang: expect.any(String), level: expect.any(Number), severity: expect.any(String), kind: 'pattern', source: 'built-in' });
    const text = run(dir, ['--list-rules']).stdout;
    expect(text).toMatch(/^id +level +severity +lang +kind +source +name\n/u);
    expect(text).toMatch(/\n52 rules: 52 built-in, 0 from the config; 0 off\nno config file\n$/u);
  });

  it('shows what the config changes: off, a new level, a custom rule', () => {
    const dir = project({ 'slop-lint.config.json': config });
    const listing = JSON.parse(run(dir, ['--list-rules', '--json']).stdout) as Listing;
    expect(listing.config).toBe('slop-lint.config.json');
    expect(listing.off).toEqual(['LEX-04']);
    expect(listing.rules.find((x) => x.id === 'LEX-04')).toBeUndefined();
    expect(listing.rules.find((x) => x.id === 'EST-10')).toMatchObject({ level: 1, source: 'built-in', default: { level: 2 } });
    expect(listing.rules.at(-1)).toEqual({ id: 'X-CIRCLE-BACK', name: 'Meeting filler', lang: 'en', level: 1, severity: 'high', kind: 'pattern', source: 'config' });
    const text = run(dir, ['--list-rules']).stdout;
    expect(text).toMatch(/\nX-CIRCLE-BACK +1 +high +en +pattern +config +Meeting filler\n/u);
    expect(text).toMatch(/\nEST-10 .*\(default: level 2, \w+\)\n/u);
    expect(text).toMatch(/\n52 rules: 51 built-in, 1 from the config; 1 off \(LEX-04\)\nconfig: slop-lint\.config\.json\n$/u);
  });

  it('applies the overrides of the one file it is given', () => {
    const dir = project({ 'slop-lint.config.json': config });
    const listing = JSON.parse(run(dir, ['--list-rules', '--json', 'drafts/a.txt']).stdout) as Listing;
    expect(listing.off).toEqual(['LEX-04', 'X-CIRCLE-BACK']);
    expect(run(dir, ['--list-rules', 'a.txt', 'b.txt']).status).toBe(2);
    expect(run(dir, ['--list-rules', '--sarif']).status).toBe(2);
  });
});
