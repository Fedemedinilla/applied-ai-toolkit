import { describe, expect, it } from 'vitest';
import { settingsFor } from '../src/config.ts';
import { lint } from '../src/lint.ts';
import { maskMarkdown } from '../src/markdown.ts';
import { DIRECTIVE_RULES, isDirectiveRuleId } from '../src/suppress.ts';
import { RULES } from '../src/rules.ts';
import type { LintOptions, LintResult } from '../src/types.ts';

const md = (source: string, options: Partial<LintOptions> = {}): LintResult => lint(source, { lang: 'en', format: 'markdown', ...options });
const ids = (r: LintResult) => r.findings.map((f) => f.ruleId);
const suppressedIds = (r: LintResult) => (r.suppressed ?? []).map((f) => f.ruleId);
const problems = (r: LintResult) => (r.directiveProblems ?? []).map((f) => [f.ruleId, f.line, f.detail]);

const BANNED = 'I am passionate about data.';
const PLACEHOLDER = 'I want to join [Company Name] in 2024.';

describe('a directive that names a rule', () => {
  it('moves the findings of that rule, in its range, from findings to suppressed', () => {
    const source = `<!-- slop-lint-disable LEX-03 -->\n${BANNED}\n<!-- slop-lint-enable -->\n\n${BANNED}\n`;
    const result = md(source);
    expect(result.findings.map((f) => [f.ruleId, f.line])).toEqual([['LEX-03', 5]]);
    expect(result.suppressed).toEqual([
      expect.objectContaining({ ruleId: 'LEX-03', level: 1, severity: 'high', line: 2, column: 6, match: 'passionate about', suppressedBy: { line: 1, column: 1 } }),
    ]);
    expect(result.directiveProblems).toBeUndefined();
  });

  it('keeps the suppressed finding out of the verdict and the score', () => {
    const plain = md(BANNED);
    expect(plain).toMatchObject({ passesTier1: false, score: { points: 12 } });
    const result = md(`<!-- slop-lint-disable-next-line LEX-03 -->\n${BANNED}`);
    expect(result).toMatchObject({ findings: [], passesTier1: true, disqualified: false, score: { points: 15 } });
    expect(suppressedIds(result)).toEqual(['LEX-03']);
  });

  it('leaves the other rules in its range alone, unlike the mask', () => {
    const text = 'I am passionate about data \u{1F680} and people.';
    expect(ids(md(text)).sort()).toEqual(['FMT-02', 'LEX-03']);
    const named = md(`<!-- slop-lint-disable-next-line LEX-03 -->\n${text}`);
    expect(ids(named)).toEqual(['FMT-02']);
    expect(suppressedIds(named)).toEqual(['LEX-03']);
    const masked = md(`<!-- slop-lint-disable-next-line -->\n${text}`);
    expect(masked.findings).toEqual([]);
    expect(masked.suppressed).toBeUndefined();
  });

  it('takes several ids, separated by commas or spaces, and a reason after a colon', () => {
    const text = 'I am passionate about data \u{1F680} and people.';
    const result = md(`<!-- slop-lint-disable-next-line LEX-03, FMT-02: quoted from the posting -->\n${text}`);
    expect(result.findings).toEqual([]);
    expect(suppressedIds(result).sort()).toEqual(['FMT-02', 'LEX-03']);
    expect(result.suppressed?.every((f) => f.suppressedBy.reason === 'quoted from the posting')).toBe(true);
    expect(suppressedIds(md(`<!-- slop-lint-disable-next-line LEX-03 FMT-02 -->\n${text}`)).sort()).toEqual(['FMT-02', 'LEX-03']);
  });

  it('works inside a line, and runs to the end of the file without an enable', () => {
    const inline = md(`The posting says <!-- slop-lint-disable LEX-03 -->passionate about<!-- slop-lint-enable --> twice. ${BANNED}`);
    expect(suppressedIds(inline)).toEqual(['LEX-03']);
    expect(ids(inline)).toEqual(['LEX-03']);
    const open = md(`Intro.\n\n<!-- slop-lint-disable LEX-03 -->\n\n${BANNED}\n\n${BANNED}\n`);
    expect(ids(open)).toEqual([]);
    expect(suppressedIds(open)).toEqual(['LEX-03', 'LEX-03']);
  });

  it('closes only the named rule with slop-lint-enable RULE-ID', () => {
    const text = 'I am passionate about data \u{1F680} and people.';
    const result = md(`<!-- slop-lint-disable LEX-03, FMT-02 -->\n${text}\n<!-- slop-lint-enable LEX-03 -->\n\n${text}\n`);
    expect(result.findings.map((f) => [f.ruleId, f.line])).toEqual([['LEX-03', 5]]);
    expect(suppressedIds(result).sort()).toEqual(['FMT-02', 'FMT-02', 'LEX-03']);
  });

  it('does not change what the other findings are: a suppressed hit still spends its budget', () => {
    // LEX-04 words share a budget of two; the third is reported. Suppressing the third leaves the
    // first two unreported, and suppressing the first does not make the third pass.
    const third = md('The pivotal work was robust.\n<!-- slop-lint-disable-next-line LEX-04 -->\nIt was comprehensive.');
    expect(ids(third)).toEqual([]);
    expect(third.suppressed?.map((f) => f.match)).toEqual(['comprehensive']);
    const first = md('<!-- slop-lint-disable-next-line LEX-04 -->\nThe pivotal work was robust.\nIt was comprehensive.');
    expect(first.findings.map((f) => f.match)).toEqual(['comprehensive']);
    expect(problems(first)).toEqual([['SUP-01', 1, 'no LEX-04 finding on the next line']]);
    expect(first.stats.tier2Used).toBe(3);
  });

  it('suppresses a custom rule too', () => {
    const { rules } = settingsFor({ rules: [{ id: 'X-CIRCLE', message: 'm', suggestion: 's', lang: 'en', level: 1, severity: 'high', pattern: 'circle back' }] }, undefined);
    const result = md('<!-- slop-lint-disable-next-line X-CIRCLE -->\nWe will circle back in 2024.', { rules });
    expect(ids(result)).toEqual([]);
    expect(suppressedIds(result)).toEqual(['X-CIRCLE']);
  });

  it('is not a directive inside a code block, and is not read in text mode', () => {
    const fenced = md(`\`\`\`\n<!-- slop-lint-disable LEX-03 -->\n\`\`\`\n${BANNED}`);
    expect(ids(fenced)).toEqual(['LEX-03']);
    expect(fenced.directiveProblems).toBeUndefined();
    const text = lint(`<!-- slop-lint-disable-next-line LEX-03 -->\n${BANNED}`, { lang: 'en' });
    expect(text.findings.map((f) => f.ruleId)).toContain('LEX-03');
    expect(text.suppressed).toBeUndefined();
    expect(text.directiveProblems).toBeUndefined();
  });
});

describe('an unused suppression', () => {
  it('is reported at the directive, once per rule id that matched nothing', () => {
    const result = md(`Intro in 2024.\n\n<!-- slop-lint-disable-next-line LEX-03, FMT-02 -->\n${BANNED}\n`);
    expect(suppressedIds(result)).toEqual(['LEX-03']);
    expect(problems(result)).toEqual([['SUP-01', 3, 'no FMT-02 finding on the next line']]);
    expect(result.directiveProblems?.[0]).toMatchObject({ level: 2, severity: 'low', column: 1, match: '<!-- slop-lint-disable-next-line LEX-03, FMT-02 -->' });
  });

  it('is reported for a region, for a directive on the last line, and for a second directive of the same rule', () => {
    expect(problems(md('<!-- slop-lint-disable LEX-03 -->\nI built it in 2023.\n<!-- slop-lint-enable -->'))).toEqual([['SUP-01', 1, 'no LEX-03 finding in its range']]);
    expect(problems(md('I built it in 2023.\n<!-- slop-lint-disable-next-line LEX-03 -->'))).toEqual([['SUP-01', 2, 'no LEX-03 finding on the next line']]);
    const twice = md(`<!-- slop-lint-disable LEX-03 -->\n<!-- slop-lint-disable LEX-03 -->\n${BANNED}`);
    expect(suppressedIds(twice)).toEqual(['LEX-03']);
    expect(problems(twice)).toEqual([['SUP-01', 2, 'no LEX-03 finding in its range']]);
  });

  it('costs no points and does not change the verdict or the counts', () => {
    const result = md('<!-- slop-lint-disable-next-line LEX-03 -->\nI built it in 2023.');
    expect(result).toMatchObject({ findings: [], passesTier1: true, score: { points: 15 } });
    expect(result.directiveProblems).toHaveLength(1);
  });
});

describe('a refused suppression', () => {
  it('does not suppress a disqualify rule, and says so at the directive', () => {
    const result = md(`<!-- slop-lint-disable-next-line FMT-04 -->\n${PLACEHOLDER}`);
    expect(ids(result)).toEqual(['FMT-04']);
    expect(result).toMatchObject({ disqualified: true, passesTier1: false, score: { points: 0 } });
    expect(result.suppressed).toBeUndefined();
    expect(problems(result)).toEqual([['SUP-02', 1, expect.stringMatching(/^FMT-04 has the severity disqualify/u)]]);
  });

  it('suppresses it when the options allow it', () => {
    const result = md(`<!-- slop-lint-disable-next-line FMT-04 -->\n${PLACEHOLDER}`, { suppressions: { allowDisqualify: true } });
    expect(result).toMatchObject({ findings: [], disqualified: false, passesTier1: true, score: { points: 15 } });
    expect(suppressedIds(result)).toEqual(['FMT-04']);
    expect(result.directiveProblems).toBeUndefined();
  });

  it('follows the severity the config gives the rule, not the catalog', () => {
    const lowered = settingsFor({ ruleSettings: { 'FMT-04': { severity: 'high' } } }, undefined).rules;
    expect(suppressedIds(md(`<!-- slop-lint-disable-next-line FMT-04 -->\n${PLACEHOLDER}`, { rules: lowered }))).toEqual(['FMT-04']);
    const raised = settingsFor({ ruleSettings: { 'LEX-03': { severity: 'disqualify' } } }, undefined).rules;
    const result = md(`<!-- slop-lint-disable-next-line LEX-03 -->\n${BANNED}`, { rules: raised });
    expect(ids(result)).toEqual(['LEX-03']);
    expect(problems(result).map((p) => p[0])).toEqual(['SUP-02']);
  });

  it('refuses the mask, the directive without a rule id, when the options turn it off', () => {
    const source = `<!-- slop-lint-disable -->\n${BANNED}\n<!-- slop-lint-enable -->\n\n<!-- slop-lint-disable-next-line -->\n${PLACEHOLDER}\n`;
    expect(md(source).findings).toEqual([]);
    expect(md(source).directiveProblems).toBeUndefined();
    const strict = md(source, { suppressions: { mask: false } });
    expect(ids(strict)).toEqual(['LEX-03', 'FMT-04']);
    expect(problems(strict)).toEqual([
      ['SUP-02', 1, expect.stringMatching(/^slop-lint-disable without a rule id hides its text from every rule/u)],
      ['SUP-02', 5, expect.stringMatching(/^slop-lint-disable-next-line without a rule id/u)],
    ]);
  });
});

describe('an invalid directive', () => {
  it('is reported and not applied', () => {
    const cases: Array<[string, RegExp]> = [
      ['<!-- slop-lint-disable-next-line lex-03 -->', /^"lex-03" is not a rule id$/u],
      ['<!-- slop-lint-disable-next-line LEX-03 because -->', /^"because" is not a rule id$/u],
      ['<!-- slop-lint-disable-next-line : quoted -->', /has a reason and no rule id$/u],
      ['<!-- slop-lint-disable-next-line LEX-99 -->', /^LEX-99 is not a rule that applies to this file/u],
    ];
    for (const [directive, detail] of cases) {
      const result = md(`${directive}\n${BANNED}`);
      expect(ids(result), directive).toEqual(['LEX-03']);
      expect(problems(result), directive).toEqual([['SUP-03', 1, expect.stringMatching(detail)]]);
    }
  });

  it('reports a rule that cannot run on this file: another language, or plain text only in Markdown', () => {
    const other = md(`<!-- slop-lint-disable-next-line LEX-01 -->\nThe team shipped the report in May.`);
    expect(problems(other)).toEqual([['SUP-03', 1, expect.stringMatching(/^LEX-01 is not a rule that applies to this file/u)]]);
    const plain = md(`<!-- slop-lint-disable-next-line FMT-01 -->\nI use **Python** daily.`);
    expect(problems(plain)).toEqual([['SUP-03', 1, expect.stringMatching(/^FMT-01 is not a rule that applies to this file/u)]]);
  });

  it('reports a rule the config turned off, and an enable with nothing to close', () => {
    const { rules } = settingsFor({ ruleSettings: { 'LEX-03': 'off' } }, undefined);
    const off = md(`<!-- slop-lint-disable-next-line LEX-03 -->\n${BANNED}`, { rules });
    expect(ids(off)).not.toContain('LEX-03');
    expect(problems(off).map((p) => p[0])).toEqual(['SUP-03']);
    expect(problems(md(`${BANNED}\n<!-- slop-lint-enable LEX-03 -->`))).toEqual([['SUP-03', 2, 'no slop-lint-disable of LEX-03 is open here']]);
  });

  it('leaves an ordinary comment, and a bare enable with nothing open, alone', () => {
    const result = md(`<!-- slop-lint-disabled -->\n<!-- note: slop-lint-disable LEX-03 -->\n<!-- slop-lint-enable -->\n${BANNED}`);
    expect(ids(result)).toEqual(['LEX-03']);
    expect(result.directiveProblems).toBeUndefined();
  });
});

describe('the directive rules', () => {
  it('have ids no catalog or custom rule can take', () => {
    expect(DIRECTIVE_RULES.map((r) => r.id)).toEqual(['SUP-01', 'SUP-02', 'SUP-03']);
    expect(RULES.some((r) => isDirectiveRuleId(r.id))).toBe(false);
    expect(RULES.some((r) => r.id.startsWith('SUP-'))).toBe(false);
  });

  it('keeps the result of a document without rule-id directives exactly as it was', () => {
    const source = `# Notes\n\nThe list includes <!-- slop-lint-disable -->passionate about<!-- slop-lint-enable --> and more.\n`;
    expect(Object.keys(md(source))).toEqual(['lang', 'findings', 'passesTier1', 'disqualified', 'score', 'stats']);
    expect(maskMarkdown(source).directives).toEqual([{ kind: 'enable', ids: [], start: 69, end: 94 }]);
  });
});
