import { describe, expect, it } from 'vitest';
import { ConfigError, customFlags, isCustomId, isIgnored, settingsFor, toRule, validateConfig, type CustomRuleConfig } from '../src/config.ts';
import { globProblem, globToRegExp, matchesAny } from '../src/glob.ts';
import { lint } from '../src/lint.ts';
import { RULES } from '../src/rules.ts';

const HOUSE: CustomRuleConfig = {
  id: 'X-CIRCLE-BACK',
  message: 'House style bans this word.',
  suggestion: 'Say who answers, and by when.',
  lang: 'en',
  level: 1,
  severity: 'high',
  pattern: String.raw`(?<![\p{L}\p{N}])circle back(?![\p{L}\p{N}])`,
};

const problem = (value: unknown): string => {
  try {
    validateConfig(value);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return 'accepted';
};

describe('globs', () => {
  const m = (glob: string, path: string) => matchesAny([glob], path);

  it('keeps * and ? inside one path segment', () => {
    expect(m('*.md', 'a.md')).toBe(true);
    expect(m('*.md', 'docs/a.md')).toBe(false);
    expect(m('docs/*.md', 'docs/a.md')).toBe(true);
    expect(m('docs/*.md', 'docs/es/a.md')).toBe(false);
    expect(m('a?.md', 'ab.md')).toBe(true);
    expect(m('a?.md', 'a/.md')).toBe(false);
  });

  it('lets ** cross folders, and match none when a slash follows', () => {
    expect(m('docs/**', 'docs/a.md')).toBe(true);
    expect(m('docs/**', 'docs/es/deep/a.md')).toBe(true);
    expect(m('docs/**', 'docs')).toBe(false);
    expect(m('docs/es/**', 'docs/esp/a.md')).toBe(false);
    expect(m('**/*.md', 'a.md')).toBe(true);
    expect(m('**/*.md', 'docs/es/a.md')).toBe(true);
    expect(m('docs/**/a.md', 'docs/a.md')).toBe(true);
    expect(m('docs/**/a.md', 'docs/x/y/a.md')).toBe(true);
    expect(m('docs/**/a.md', 'docs/x/ba.md')).toBe(false);
  });

  it('reads every other character as itself', () => {
    expect(m('a.md', 'aXmd')).toBe(false);
    expect(m('notes (old)/[1]+{x}.md', 'notes (old)/[1]+{x}.md')).toBe(true);
    expect(m('README.md', 'docs/README.md')).toBe(false);
    expect(globToRegExp('a|b').test('a')).toBe(false);
  });

  it('reads a hyphen as itself, outside any class', () => {
    expect(m('cover-letters/*.md', 'cover-letters/a.md')).toBe(true);
    expect(m('api-docs/**', 'api-docs/x/y.md')).toBe(true);
    expect(m('a-b.md', 'a_b.md')).toBe(false);
  });

  it('names what is wrong with a pattern it cannot use', () => {
    expect(globProblem('docs/**')).toBeUndefined();
    expect(globProblem('')).toMatch(/empty/u);
    expect(globProblem('/docs/**')).toMatch(/absolute/u);
    expect(globProblem('docs\\es')).toMatch(/backslash/u);
    expect(globProblem('docs/../x')).toMatch(/\.\. segment/u);
    expect(globProblem('!docs/a.md')).toMatch(/negation/u);
    expect(globProblem('./docs/**')).toMatch(/without \.\//u);
    expect(globProblem('docs/')).toMatch(/add \*\*/u);
  });
});

describe('validateConfig', () => {
  it('rejects a pattern that matches the empty string at some position, not only on an empty text', () => {
    for (const pattern of ['(?=synergize)|\\b', '(?=synergize)', '\\b', '$', 'x?(?= )']) {
      expect(problem({ rules: [{ ...HOUSE, pattern }] }), pattern).toMatch(/^rules\[0\]\.pattern: matches the empty string/u);
    }
    expect(problem({ rules: [HOUSE] })).toBe('accepted');
    expect(problem({ rules: [{ ...HOUSE, pattern: 'synergi(?=ze)' }] })).toBe('accepted');
  });

  it('rejects a lookaround that matches empty even when its word is not written out in the source', () => {
    for (const pattern of ['(?=[Ss]ynergy)', '(?=synerg(?:y|ize))', '\\b(?=[Ss]ynergy)', '(?<=[Ss]ynergy)', '(?![\\p{L}])', 'a|(?=[Bb])']) {
      expect(problem({ rules: [{ ...HOUSE, pattern }] }), pattern).toMatch(/^rules\[0\]\.pattern: matches the empty string/u);
    }
    for (const pattern of ['(?<![\\p{L}\\p{N}])[Ss]ynergy(?![\\p{L}\\p{N}])', '\\bsyn(?:ergy|ergize)\\b', '[(?=]x', '\\(?=a\\)', '^a$']) {
      expect(problem({ rules: [{ ...HOUSE, pattern }] }), pattern).toBe('accepted');
    }
  });

  it('rejects an anchor that is only whitespace, at the top level and in an override', () => {
    expect(problem({ anchors: ['dbt', ' '] })).toMatch(/^anchors\[1\]: must hold a character other than whitespace/u);
    expect(problem({ overrides: [{ files: ['a.md'], anchors: ['\t\n'] }] })).toMatch(/^overrides\[0\]\.anchors\[0\]: must hold a character other than whitespace/u);
    expect(problem({ anchors: ['Contoso Agro'] })).toBe('accepted');
  });

  it('rejects __proto__ under ruleSettings as an unknown id, as JSON.parse leaves it an own key', () => {
    for (const value of ['"off"', '{"level":1}', '{"severity":"low"}']) {
      expect(problem(JSON.parse(`{"ruleSettings":{"__proto__":${value}}}`))).toMatch(/^ruleSettings\.__proto__: is not the id of a built-in rule/u);
      expect(problem(JSON.parse(`{"overrides":[{"files":["a.md"],"ruleSettings":{"__proto__":${value}}}]}`))).toMatch(/^overrides\[0\]\.ruleSettings\.__proto__: is not the id/u);
    }
  });

  it('accepts an empty object and returns what it was given', () => {
    expect(validateConfig({})).toEqual({});
    const config = { lang: 'es', anchors: ['dbt'], ruleSettings: { 'LEX-04': 'off' }, rules: [HOUSE] };
    expect(validateConfig(config)).toEqual(config);
  });

  it('puts the key path at the start of every message', () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /^must be an object$/u],
      [{ langs: 'en' }, /^langs: unknown key; the known keys are \$schema, lang, format, /u],
      [{ lang: 'fr' }, /^lang: must be one of "en", "es"$/u],
      [{ format: 'html' }, /^format: must be one of "text", "markdown"$/u],
      [{ anchors: ['dbt', 3] }, /^anchors\[1\]: must be a string$/u],
      [{ ignore: ['ok/**', '/abs'] }, /^ignore\[1\]: is absolute/u],
      [{ ruleSettings: { 'LEX-04': 'on' } }, /^ruleSettings\.LEX-04: must be "off" or an object/u],
      [{ ruleSettings: { 'LEX-04': {} } }, /^ruleSettings\.LEX-04: must set level, severity or both$/u],
      [{ ruleSettings: { 'LEX-04': { level: 4 } } }, /^ruleSettings\.LEX-04\.level: must be one of 1, 2, 3$/u],
      [{ ruleSettings: { 'LEX-04': { severity: 'x' } } }, /^ruleSettings\.LEX-04\.severity: must be one of "disqualify", "high", "medium", "low"$/u],
      [{ ruleSettings: { 'LEX-04': { budget: 1 } } }, /^ruleSettings\.LEX-04\.budget: unknown key/u],
      [{ ruleSettings: { 'LEX-99': 'off' } }, /^ruleSettings\.LEX-99: is not the id of a built-in rule/u],
      [{ rules: [HOUSE, { ...HOUSE, id: 'LEX-03' }] }, /^rules\[1\]\.id: must start with X-/u],
      [{ rules: [{ ...HOUSE, pattern: undefined }] }, /^rules\[0\]\.pattern: must be a string$/u],
      [{ rules: [{ id: 'X-A' }] }, /^rules\[0\]\.message: is required$/u],
      [{ rules: [{ ...HOUSE, flags: 'gy' }] }, /^rules\[0\]\.flags: has the flag y; only g, i, m, s, u are supported$/u],
      [{ rules: [{ ...HOUSE, flags: 'gig' }] }, /^rules\[0\]\.flags: "gig" is not a valid set of flags/u],
      [{ rules: [{ ...HOUSE, pattern: '(circle' }] }, /^rules\[0\]\.pattern: does not compile: Invalid regular expression/u],
      [{ rules: [{ ...HOUSE, pattern: 'a*' }] }, /^rules\[0\]\.pattern: matches the empty string/u],
      [{ rules: [HOUSE, HOUSE] }, /^rules\[1\]\.id: X-CIRCLE-BACK is defined twice$/u],
      [{ overrides: [{ lang: 'es' }] }, /^overrides\[0\]\.files: is required$/u],
      [{ overrides: [{ files: [] }] }, /^overrides\[0\]\.files: must hold at least one pattern$/u],
      [{ overrides: [{ files: ['docs/**'], ruleSettings: { 'X-NOPE': 'off' } }] }, /^overrides\[0\]\.ruleSettings\.X-NOPE: is not the id/u],
      [{ suppressions: { mask: 'no' } }, /^suppressions\.mask: must be true or false$/u],
      [{ suppressions: { unused: 'error' } }, /^suppressions\.unused: unknown key/u],
    ];
    for (const [value, message] of cases) expect(problem(value), JSON.stringify(value)).toMatch(message);
  });

  it('keeps the X- prefix away from the catalog, so a custom rule cannot shadow a built-in one', () => {
    expect(RULES.some((r) => isCustomId(r.id))).toBe(false);
    expect(isCustomId('X-CIRCLE-BACK')).toBe(true);
  });
});

describe('custom rules', () => {
  it('compiles with g and u added, and giu when no flags are given', () => {
    expect(customFlags(undefined)).toBe('giu');
    expect(customFlags('')).toBe('gu');
    expect(customFlags('i')).toBe('igu');
    expect(customFlags('gu')).toBe('gu');
  });

  it('becomes a pattern rule for the languages it names', () => {
    expect(toRule(HOUSE)).toMatchObject({ kind: 'pattern', id: 'X-CIRCLE-BACK', name: 'X-CIRCLE-BACK', patterns: { en: HOUSE.pattern }, flags: 'giu' });
    expect(Object.keys(toRule({ ...HOUSE, lang: 'both' }).patterns)).toEqual(['en', 'es']);
    expect(toRule({ ...HOUSE, name: 'Banned word' }, 'docs/slop-lint.config.json')).toMatchObject({ name: 'Banned word', source: { ref: 'docs/slop-lint.config.json' } });
    expect(toRule(HOUSE).source.ref).toBe('config file');
  });

  it('is reported by lint() like a built-in rule, at its level and severity', () => {
    const { rules } = settingsFor({ rules: [HOUSE] }, undefined);
    const result = lint('We will Circle Back with the two teams in 2023.', { lang: 'en', rules });
    expect(result.findings).toEqual([
      expect.objectContaining({ ruleId: 'X-CIRCLE-BACK', level: 1, severity: 'high', match: 'Circle Back', line: 1, column: 9, message: HOUSE.message, suggestion: HOUSE.suggestion }),
    ]);
    expect(result.passesTier1).toBe(false);
    expect(lint('We will circle back.', { lang: 'es', rules }).findings.map((f) => f.ruleId)).not.toContain('X-CIRCLE-BACK');
  });

  it('follows the level rules: 2 is reported and passes, 3 passes next to an anchor', () => {
    const at = (level: 2 | 3) => settingsFor({ rules: [{ ...HOUSE, level, severity: 'low' }] }, undefined).rules;
    const two = lint('We will circle back in 2023.', { lang: 'en', rules: at(2) });
    expect(two.findings.map((f) => f.ruleId)).toEqual(['X-CIRCLE-BACK']);
    expect(two.passesTier1).toBe(true);
    expect(lint('We will circle back in 2023.', { lang: 'en', rules: at(3) }).findings).toEqual([]);
    expect(lint('We will circle back.', { lang: 'en', rules: at(3) }).stats.tier2Used).toBe(1);
  });
});

describe('a custom rule next to the catalog', () => {
  it('is charged once per span: a built-in hit of a stricter level on the same text keeps it', () => {
    // "synergy" is already a level 1 phrase of LEX-03, so a level 2 custom rule for it adds nothing.
    const custom = { ...HOUSE, id: 'X-SYNERGY', pattern: 'synergy', level: 2 as const, severity: 'low' as const };
    const { rules } = settingsFor({ rules: [custom] }, undefined);
    expect(lint('We found synergy in 2023.', { lang: 'en', rules }).findings.map((f) => f.ruleId)).toEqual(['LEX-03']);
    const alone = settingsFor({ rules: [custom], ruleSettings: { 'LEX-03': 'off' } }, undefined).rules;
    expect(lint('We found synergy in 2023.', { lang: 'en', rules: alone }).findings.map((f) => f.ruleId)).toEqual(['X-SYNERGY']);
  });
});

describe('settingsFor', () => {
  it('gives the catalog, untouched, for an empty config', () => {
    const settings = settingsFor({}, 'README.md');
    expect(settings.rules).toEqual(RULES);
    expect(settings).toMatchObject({ lang: undefined, format: undefined, anchors: [], off: [] });
    expect(settings.suppressions).toEqual({ allowDisqualify: false, mask: true, failOnProblems: false });
  });

  it('turns a rule off, or changes its level and severity', () => {
    const settings = settingsFor({ ruleSettings: { 'LEX-03': 'off', 'FMT-04': { level: 2, severity: 'low' }, 'EST-10': { severity: 'high' } } }, undefined);
    expect(settings.off).toEqual(['LEX-03']);
    expect(settings.rules.find((r) => r.id === 'LEX-03')).toBeUndefined();
    expect(settings.rules.find((r) => r.id === 'FMT-04')).toMatchObject({ level: 2, severity: 'low' });
    expect(settings.rules.find((r) => r.id === 'EST-10')).toMatchObject({ level: RULES.find((r) => r.id === 'EST-10')?.level, severity: 'high' });
    expect(lint('I am passionate about data.', { lang: 'en', rules: settings.rules }).findings.map((f) => f.ruleId)).not.toContain('LEX-03');
    const placeholder = lint('I want to join [Company Name] in 2024.', { lang: 'en', rules: settings.rules });
    expect(placeholder).toMatchObject({ passesTier1: true, disqualified: false });
    expect(placeholder.findings.map((f) => [f.ruleId, f.level, f.severity])).toContainEqual(['FMT-04', 2, 'low']);
  });

  it('reports every hit of a Tier 2 pool rule raised to level 1, outside the shared budget', () => {
    const settings = settingsFor({ ruleSettings: { 'LEX-04': { level: 1, severity: 'high' } } }, undefined);
    const one = lint('This robust plan works.', { lang: 'en', rules: settings.rules });
    expect(one.passesTier1).toBe(false);
    expect(one.findings.map((f) => [f.ruleId, f.level, f.detail])).toEqual([['LEX-04', 1, undefined]]);
    const three = lint('This robust plan is seamless and pivotal.', { lang: 'en', rules: settings.rules });
    expect(three.findings.filter((f) => f.ruleId === 'LEX-04')).toHaveLength(3);
  });

  it('applies every matching override in order, and none to stdin or a file outside the folder', () => {
    const config = validateConfig({
      lang: 'en',
      anchors: ['dbt'],
      ruleSettings: { 'LEX-04': 'off' },
      overrides: [
        { files: ['docs/**'], format: 'markdown', anchors: ['airflow'] },
        { files: ['docs/es/**'], lang: 'es', ruleSettings: { 'LEX-04': { level: 2 }, 'EST-10': 'off' } },
      ],
    });
    expect(settingsFor(config, 'README.md')).toMatchObject({ lang: 'en', format: undefined, anchors: ['dbt'], off: ['LEX-04'] });
    expect(settingsFor(config, 'docs/guide.md')).toMatchObject({ lang: 'en', format: 'markdown', anchors: ['dbt', 'airflow'], off: ['LEX-04'] });
    expect(settingsFor(config, 'docs/es/guia.md')).toMatchObject({ lang: 'es', format: 'markdown', anchors: ['dbt', 'airflow'], off: ['EST-10'] });
    expect(settingsFor(config, undefined)).toMatchObject({ lang: 'en', format: undefined, anchors: ['dbt'], off: ['LEX-04'] });
  });

  it('ignores the files the ignore globs match, and never stdin', () => {
    const config = validateConfig({ ignore: ['CHANGELOG.md', 'vendor/**'] });
    expect(isIgnored(config, 'CHANGELOG.md')).toBe(true);
    expect(isIgnored(config, 'vendor/a/b.md')).toBe(true);
    expect(isIgnored(config, 'docs/CHANGELOG.md')).toBe(false);
    expect(isIgnored(config, undefined)).toBe(false);
    expect(isIgnored({}, 'a.md')).toBe(false);
  });
});
