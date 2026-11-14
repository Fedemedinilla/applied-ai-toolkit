import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/lint.ts';
import { RULES } from '../src/rules.ts';
import { artifactUri, FINGERPRINT_KEY, fingerprint, helpUri, region, sarifLevel, toSarif, type SarifInput } from '../src/sarif.ts';
import type { LintOptions } from '../src/types.ts';
import { sarifLog } from './sarif-schema.ts';

const multibyte = readFileSync(new URL('fixtures/sarif/multibyte.txt', import.meta.url), 'utf8');
const EN: LintOptions = { lang: 'en' };
const input = (uri: string, text: string, options: LintOptions = EN): SarifInput => ({ uri, text, result: lint(text, options) });
const fingerprints = (inputs: SarifInput[]) =>
  toSarif(inputs).runs[0].results.map((r) => ({ ruleId: r.ruleId, fp: r.partialFingerprints[FINGERPRINT_KEY], line: r.locations[0]?.physicalLocation.region.startLine }));

describe('sarifLevel', () => {
  it('maps level 1, and a high or disqualifying severity, to error; level 2 to warning; level 3 to note', () => {
    expect(sarifLevel({ level: 1, severity: 'high' })).toBe('error');
    expect(sarifLevel({ level: 1, severity: 'disqualify' })).toBe('error');
    expect(sarifLevel({ level: 2, severity: 'high' })).toBe('error');
    expect(sarifLevel({ level: 2, severity: 'disqualify' })).toBe('error');
    expect(sarifLevel({ level: 2, severity: 'medium' })).toBe('warning');
    expect(sarifLevel({ level: 2, severity: 'low' })).toBe('warning');
    expect(sarifLevel({ level: 3, severity: 'low' })).toBe('note');
    expect(sarifLevel({ level: 3, severity: 'medium' })).toBe('note');
    expect(sarifLevel({ level: 3, severity: 'high' })).toBe('error');
  });

  it('gives every catalog rule a level, and ESP-02, the level 2 rule with high severity, error', () => {
    const levels = new Set(RULES.map(sarifLevel));
    expect([...levels].sort()).toEqual(['error', 'note', 'warning']);
    expect(sarifLevel(RULES.find((r) => r.id === 'ESP-02') ?? RULES[0]!)).toBe('error');
  });
});

describe('helpUri', () => {
  it('takes the first host and path of a source reference, as https', () => {
    expect(helpUri('Kobak et al. 2025, Science Advances (arxiv.org/pdf/2406.07016); section 12')).toBe('https://arxiv.org/pdf/2406.07016');
    expect(helpUri('RAE, Diccionario panhispánico de dudas, "raya" (rae.es/dpd/raya)')).toBe('https://rae.es/dpd/raya');
    expect(helpUri('see https://example.org/a/b, then more')).toBe('https://example.org/a/b');
  });

  it('gives none for a reference without a host and a path', () => {
    expect(helpUri('erkansaka.net summary of Wikipedia, Signs of AI writing')).toBeUndefined();
    expect(helpUri('Anthropic, prompting guide for Claude Fable 5.1 (density)')).toBeUndefined();
    expect(helpUri('Section 4.3')).toBeUndefined();
  });

  it('gives a parseable https URL for every catalog rule that has one', () => {
    const uris = RULES.map((r) => helpUri(r.source.ref)).filter((u) => u !== undefined);
    expect(uris.length).toBeGreaterThan(0);
    for (const u of uris) expect(new URL(u).protocol).toBe('https:');
  });
});

describe('artifactUri', () => {
  it('drops a leading ./ and keeps the path relative', () => {
    expect(artifactUri('./README.md', '/repo')).toBe('README.md');
    expect(artifactUri('././docs/a.md', '/repo')).toBe('docs/a.md');
    expect(artifactUri('docs/./b/../a.md', '/repo')).toBe('docs/a.md');
    expect(artifactUri('../other/a.md', '/repo')).toBe('../other/a.md');
  });

  it('makes an absolute path relative to the working directory', () => {
    expect(artifactUri('/repo/docs/a.md', '/repo')).toBe('docs/a.md');
    expect(artifactUri('/elsewhere/a.md', '/repo/sub')).toBe('../../elsewhere/a.md');
  });

  it('turns Windows separators into forward slashes', () => {
    expect(artifactUri('docs\\guide\\a.md', '/repo')).toBe('docs/guide/a.md');
    expect(artifactUri('.\\docs\\a.md', 'C:\\repo')).toBe('docs/a.md');
    expect(artifactUri('C:\\repo\\docs\\a.md', 'C:\\repo')).toBe('docs/a.md');
    expect(artifactUri('c:\\Repo\\docs\\a.md', 'C:\\repo')).toBe('docs/a.md');
    expect(artifactUri('C:/repo/docs/a.md', 'C:\\repo')).toBe('docs/a.md');
    expect(artifactUri('\\repo\\a.md', 'C:\\repo')).toBe('a.md');
  });

  it('refuses a path it cannot make relative', () => {
    expect(() => artifactUri('D:\\other\\a.md', 'C:\\repo')).toThrow(/drive/u);
    expect(() => artifactUri('C:\\repo\\a.md', '/repo')).toThrow(/Windows path/u);
    expect(() => artifactUri('\\\\server\\share\\a.md', '/repo')).toThrow(/Windows path/u);
    expect(() => artifactUri('/repo', '/repo')).toThrow(/directory/u);
    expect(() => artifactUri('', '/repo')).toThrow(/empty/u);
  });

  it('percent-encodes each segment', () => {
    expect(artifactUri('my docs/cartá #1.md', '/repo')).toBe('my%20docs/cart%C3%A1%20%231.md');
  });
});

describe('region', () => {
  const result = lint(multibyte, EN);
  const lines = multibyte.split('\n');

  it('counts columns in code points where lint() counts UTF-16 code units', () => {
    const writing = result.findings.find((f) => f.match === 'I am writing to express');
    expect(writing).toMatchObject({ line: 3, column: 27 });
    // "Café 🎉 and résumé 👩‍💻: " is 26 UTF-16 code units and 23 code points: three emoji take two units each.
    expect(region(multibyte, writing!)).toEqual({ startLine: 3, startColumn: 24, endLine: 3, endColumn: 47 });
  });

  it('points every finding at its match, counted in code points, with an exclusive end', () => {
    expect(result.findings.length).toBeGreaterThan(5);
    for (const f of result.findings) {
      const r = region(multibyte, f);
      expect(r.endLine).toBe(r.startLine);
      const points = Array.from(lines[r.startLine - 1] ?? '');
      expect(points.slice(r.startColumn - 1, r.endColumn - 1).join('')).toBe(f.match);
    }
  });

  it('keeps UTF-16 and code point columns equal on a line with accents only', () => {
    const text = 'Dear Ms. Núñez, I am passionate about data.';
    const f = lint(text, EN).findings.find((x) => x.match === 'passionate about');
    expect(f).toBeDefined();
    expect(region(text, f!)).toMatchObject({ startLine: 1, startColumn: f!.column });
  });

  it('ends on a later line when the match crosses a line break', () => {
    expect(region('ab\ncd😀ef', { start: 1, end: 7 })).toEqual({ startLine: 1, startColumn: 2, endLine: 2, endColumn: 4 });
  });
});

describe('toSarif', () => {
  it('builds a log that the code scanning subset accepts', () => {
    const log = toSarif([input('a.txt', multibyte)]);
    expect(() => sarifLog.parse(log)).not.toThrow();
    const run = log.runs[0];
    expect(run.results.length).toBe(lint(multibyte, EN).findings.length);
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(['LEX-03', 'LEX-04', 'FMT-02']);
  });

  it('lists only the rules that have a finding, in catalog order, and an empty run for clean input', () => {
    const empty = toSarif([input('clean.txt', 'I built the billing export in Python in 2023.')]);
    expect(empty.runs[0].tool.driver.rules).toEqual([]);
    expect(empty.runs[0].results).toEqual([]);
    expect(() => sarifLog.parse(empty)).not.toThrow();
    expect(toSarif([]).runs[0].results).toEqual([]);
  });

  it('includes the matched text and the suggestion in each message', () => {
    const r = toSarif([input('a.txt', multibyte)]).runs[0].results.find((x) => x.ruleId === 'LEX-04');
    expect(r?.message.text).toBe(
      'Excess style vocabulary. Tolerated twice per text, never the same word twice. (Tier 2 word 3; the budget is 2 per text) Found "seamless". Suggestion: Use the plain verb or the fact.',
    );
  });

  it('covers several files in one run, with the rules shared', () => {
    const es = 'Me apasiona el equipo. Sinergia y sinergia.';
    const log = toSarif([input('a.txt', multibyte), input('b/c.txt', es, { lang: 'es' })]);
    expect(() => sarifLog.parse(log)).not.toThrow();
    const uris = new Set(log.runs[0].results.map((r) => r.locations[0]?.physicalLocation.artifactLocation.uri));
    expect([...uris]).toEqual(['a.txt', 'b/c.txt']);
  });

  it('is deterministic', () => {
    const a = JSON.stringify(toSarif([input('a.txt', multibyte)]));
    const b = JSON.stringify(toSarif([input('a.txt', multibyte)]));
    expect(a).toBe(b);
  });
});

describe('fingerprints', () => {
  it('stay the same when lines move', () => {
    const before = fingerprints([input('a.txt', multibyte)]);
    const after = fingerprints([input('a.txt', `\n\n\n${multibyte.replace('\n\n', '\n\n\n\n')}`)]);
    expect(after.map(({ ruleId, fp }) => ({ ruleId, fp }))).toEqual(before.map(({ ruleId, fp }) => ({ ruleId, fp })));
    expect(after.map((x) => x.line)).toEqual(before.map((x) => (x.line ?? 0) + 5));
  });

  it('tell apart repeated matches by occurrence, and files by uri', () => {
    const text = 'I am passionate about data. I am passionate about maps.';
    const one = fingerprints([input('a.txt', text)]).filter((x) => x.ruleId === 'LEX-03');
    expect(one).toHaveLength(2);
    expect(one[0]?.fp).not.toBe(one[1]?.fp);
    expect(one[0]?.fp).toBe(fingerprint('LEX-03', 'a.txt', 'passionate about', 0));
    expect(one[1]?.fp).toBe(fingerprint('LEX-03', 'a.txt', 'passionate about', 1));
    const other = fingerprints([input('b.txt', text)]).filter((x) => x.ruleId === 'LEX-03');
    expect(other[0]?.fp).not.toBe(one[0]?.fp);
  });

  it('count occurrences in each file from 0, so one file does not move the fingerprints of the next', () => {
    const text = 'I am passionate about data. I am passionate about maps.';
    const lex = (inputs: SarifInput[]) => fingerprints(inputs).filter((x) => x.ruleId === 'LEX-03').map((x) => x.fp);
    const alone = lex([input('b.txt', text)]);
    expect(lex([input('a.txt', text), input('b.txt', text)])).toEqual([...lex([input('a.txt', text)]), ...alone]);
    expect(alone).toEqual([fingerprint('LEX-03', 'b.txt', 'passionate about', 0), fingerprint('LEX-03', 'b.txt', 'passionate about', 1)]);
  });

  it('do not depend on the column either', () => {
    const a = fingerprints([input('a.txt', 'I am passionate about data.')]);
    const b = fingerprints([input('a.txt', 'Today, I am passionate about data.')]).filter((x) => x.ruleId === 'LEX-03');
    expect(b.map((x) => x.fp)).toEqual(a.filter((x) => x.ruleId === 'LEX-03').map((x) => x.fp));
  });
});
