import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySetting, DEFAULT_GENRE, GENRE_PROFILES, GENRES, guessGenre, resolveRules } from '../src/genres.ts';
import { appliesTo, lint } from '../src/lint.ts';
import { MESSAGE_VARIANTS, messageFor } from '../src/messages.ts';
import { RULES, ruleById, TIER2_BUDGET } from '../src/rules.ts';
import { DEFAULT_THRESHOLDS, runStructural, type StructuralContext } from '../src/structural.ts';
import { splitSentences } from '../src/text.ts';
import type { Genre, Lang, LintOptions } from '../src/types.ts';

const genreFixture = (name: string) => readFileSync(new URL(`fixtures/genres/${name}`, import.meta.url), 'utf8');
const letter = (name: string) => readFileSync(new URL(`../fixtures/cover-letters/${name}`, import.meta.url), 'utf8');
const ids = (text: string, options: LintOptions) => lint(text, options).findings.map((f) => f.ruleId);
const rulesSource = readFileSync(new URL('../src/rules.ts', import.meta.url), 'utf8');

const NEW_GENRES: readonly Genre[] = ['email', 'follow-up', 'whatsapp'];

describe('the cover-letter profile', () => {
  it('holds the structural constants of today, the Tier 2 budget and no rule change', () => {
    const profile = GENRE_PROFILES['cover-letter'];
    expect(profile.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(profile.tier2Budget).toBe(TIER2_BUDGET);
    expect(profile.rules).toEqual({});
    expect(profile.experimental).toBe(false);
    expect(DEFAULT_GENRE).toBe('cover-letter');
  });

  it('states the constants the catalog documents: the budgets in the structural rules match the thresholds', () => {
    expect(ruleById('FMT-05').kind === 'structural' && ruleById('FMT-05')).toMatchObject({ threshold: expect.stringContaining('2') });
    expect(rulesSource).toContain('export const TIER2_BUDGET = 2;');
    expect(DEFAULT_THRESHOLDS).toMatchObject({ colonBudget: 2, asideBudget: 1, emDashBudget: 1, menteBudget: 2 });
  });

  it('gives the same result as no genre, on every section 15 letter and both formats', () => {
    const files: Array<[string, Lang]> = [
      ['en-before.txt', 'en'],
      ['en-after.txt', 'en'],
      ['es-neutral-before.txt', 'es'],
      ['es-neutral-after.txt', 'es'],
      ['es-rioplatense-before.txt', 'es'],
      ['es-rioplatense-after.txt', 'es'],
    ];
    for (const [name, lang] of files) {
      for (const format of ['text', 'markdown'] as const) {
        const text = letter(name);
        expect(lint(text, { lang, format, genre: 'cover-letter' }), name).toEqual(lint(text, { lang, format }));
      }
    }
  });

  it('resolves to the very same rule objects', () => {
    const resolved = resolveRules(RULES, 'cover-letter');
    expect(resolved.length).toBe(RULES.length);
    resolved.forEach((r, i) => expect(r).toBe(RULES[i]));
  });

  it('leaves genre and variety out of the result', () => {
    const result = lint('Plain text.', { lang: 'en', genre: 'cover-letter' });
    expect('genre' in result).toBe(false);
    expect('variety' in result).toBe(false);
  });
});

describe('the genre profiles', () => {
  it('cover every genre, and each new one is experimental', () => {
    expect(Object.keys(GENRE_PROFILES).sort()).toEqual([...GENRES].sort());
    for (const g of NEW_GENRES) expect(GENRE_PROFILES[g].experimental, g).toBe(true);
  });

  it('name only rules that exist', () => {
    const known = new Set(RULES.map((r) => r.id));
    for (const g of GENRES) for (const id of Object.keys(GENRE_PROFILES[g].rules)) expect(known.has(id), `${g}: ${id}`).toBe(true);
  });

  it('turn off the rules the table turns off in every new genre', () => {
    for (const g of NEW_GENRES) {
      for (const id of ['EST-06', 'CAR-03']) {
        expect(resolveRules(RULES, g).some((r) => r.id === id), `${g}: ${id}`).toBe(false);
        expect(appliesTo(ruleById(id), 'en', g)).toBe(false);
      }
    }
    expect(appliesTo(ruleById('EST-06'), 'en')).toBe(true);
  });

  it('apply a level, a severity and a pattern budget to a clone', () => {
    const rule = ruleById('LEX-04');
    const before = { level: rule.level, severity: rule.severity };
    const changed = applySetting(rule, { level: 1, severity: 'high', budget: 3 });
    expect(changed).toMatchObject({ id: 'LEX-04', level: 1, severity: 'high', budget: 3 });
    expect({ level: rule.level, severity: rule.severity }).toEqual(before);
    expect(applySetting(rule, 'off')).toBeUndefined();
    expect(applySetting(rule, undefined)).toBe(rule);
    // A structural rule has no pattern budget: its budget lives in the thresholds.
    expect(applySetting(ruleById('MED-01'), { budget: 5 })).not.toHaveProperty('budget');
  });

  it('report the genre in the result and the profile Tier 2 budget in the stats', () => {
    for (const g of NEW_GENRES) {
      const result = lint('Plain text.', { lang: 'en', genre: g });
      expect(result.genre).toBe(g);
      expect(result.stats.tier2Budget).toBe(GENRE_PROFILES[g].tier2Budget);
    }
  });
});

describe('structural thresholds come from the context', () => {
  const ctx = (text: string, lang: Lang, thresholds = DEFAULT_THRESHOLDS): StructuralContext => ({
    text,
    lang,
    sentences: splitSentences(text),
    anchorsIn: () => 0,
    longSentenceScope: splitSentences(text),
    thresholds,
  });

  it('reads each budget the checks used to write inline', () => {
    const mente = 'Trabajé rápidamente, eficientemente y constantemente.';
    expect(runStructural('MED-01', ctx(mente, 'es'))).toHaveLength(1);
    expect(runStructural('MED-01', ctx(mente, 'es', { ...DEFAULT_THRESHOLDS, menteBudget: 3 }))).toHaveLength(0);
    const dashes = 'One — two — three — four.';
    expect(runStructural('ORT-05', ctx(dashes, 'en'))).toHaveLength(2);
    expect(runStructural('ORT-05', ctx(dashes, 'en', { ...DEFAULT_THRESHOLDS, emDashBudget: 2 }))[0]?.detail).toBe('budget 2 per text');
    const colons = 'Uno: dos. Tres: cuatro. Cinco: seis.';
    expect(runStructural('FMT-05', ctx(colons, 'es'))).toHaveLength(1);
    expect(runStructural('FMT-05', ctx(colons, 'es', { ...DEFAULT_THRESHOLDS, colonBudget: 3 }))).toHaveLength(0);
    const asides = 'Hice —con ayuda— el cierre y —sin apuro— el reporte.';
    expect(runStructural('ORT-04', ctx(asides, 'es'))[0]?.detail).toBe('more than one aside between rayas');
    expect(runStructural('ORT-04', ctx(asides, 'es', { ...DEFAULT_THRESHOLDS, asideBudget: 2 }))).toHaveLength(0);
    const long = 'Uno dos tres cuatro cinco seis.';
    expect(runStructural('EST-10', ctx(long, 'es', { ...DEFAULT_THRESHOLDS, longSentence: { en: 5, es: 5 } }))).toHaveLength(1);
  });
});

describe('messages per genre', () => {
  it('keeps the catalog text byte for byte in a cover letter', () => {
    for (const rule of RULES) expect(messageFor(rule, 'cover-letter')).toBe(rule.message);
  });

  it('has a variant for every catalog message that speaks of a letter or a candidate', () => {
    const lettered = RULES.filter((r) => /\bletter\b|cover-letter|candidate/iu.test(r.message)).map((r) => r.id);
    expect(lettered.sort()).toEqual(['ESP-01', 'FMT-02', 'FMT-04', 'LEX-03', 'LEX-06', 'ORT-04', 'RET-01']);
    for (const id of lettered) expect(MESSAGE_VARIANTS[id]?.message, id).toBeDefined();
  });

  it('has a deviation variant where the deviation ties the rule to a letter, and every variant is free of the words', () => {
    // The other deviations that match cite the report's section 15 sample letter, or say
    // "letters" for characters; they describe where a pattern came from, in any genre.
    const tied = RULES.filter((r) => /middle of a letter\b|per cover letter/iu.test(r.deviation ?? '') && r.id !== 'EST-05').map((r) => r.id);
    expect(tied.sort()).toEqual(['EST-04', 'ORT-05']);
    for (const id of tied) expect(MESSAGE_VARIANTS[id]?.deviation, id).toBeDefined();
    for (const [id, v] of Object.entries(MESSAGE_VARIANTS)) expect(`${v.message ?? ''}`, id).not.toMatch(/\bletter\b|candidate/iu);
  });

  it('shows the variant in a finding outside a cover letter, and keeps a caller message', () => {
    expect(lint('Excited 🚀 to apply.', { lang: 'en', genre: 'email' }).findings[0]?.message).toBe('Emoji in a professional message.');
    const custom = { ...ruleById('FMT-02'), message: 'My own message.' };
    expect(lint('Excited 🚀 to apply.', { lang: 'en', genre: 'email', rules: [custom] }).findings[0]?.message).toBe('My own message.');
  });
});

describe('email', () => {
  const text = genreFixture('email-es.txt');

  it('drops the early-question rule and lowers process narration to low', () => {
    expect(ids(text, { lang: 'es' })).toEqual(['EST-06', 'EST-09']);
    const result = lint(text, { lang: 'es', genre: 'email' });
    expect(result.findings.map((f) => [f.ruleId, f.severity])).toEqual([['EST-09', 'low']]);
    expect(result.score.points).toBe(14.5);
  });
});

describe('follow-up', () => {
  const text = genreFixture('follow-up-en.txt');

  it('turns process narration off: quoting the earlier message is the point', () => {
    expect(ids(text, { lang: 'en' })).toEqual(['EST-09']);
    expect(ids(text, { lang: 'en', genre: 'follow-up' })).toEqual([]);
  });

  it('turns the flat-rhythm check off', () => {
    const flat = Array.from({ length: 9 }, (_, i) => `I sent the report on day ${i + 1} as planned.`).join(' ');
    expect(ids(flat, { lang: 'en', anchors: ['report'] })).toContain('EST-11');
    expect(ids(flat, { lang: 'en', anchors: ['report'], genre: 'follow-up' })).not.toContain('EST-11');
  });

  it('accepts the earlier message without changing the findings yet', () => {
    expect(lint(text, { lang: 'en', genre: 'follow-up', previous: 'Hi Dana, I built a dashboard.' })).toEqual(lint(text, { lang: 'en', genre: 'follow-up' }));
  });
});

describe('whatsapp', () => {
  const text = genreFixture('whatsapp-es.txt');

  it('does not report the emoji a chat uses', () => {
    expect(ids(text, { lang: 'es' })).toEqual(['FMT-02']);
    const result = lint(text, { lang: 'es', genre: 'whatsapp' });
    expect(result.findings).toEqual([]);
    expect(result.passesTier1).toBe(true);
  });

  it('follows the text on opening marks: none used, none asked for; some used, all checked', () => {
    const bare = 'Hola, como va? Te paso el link.';
    expect(ids(bare, { lang: 'es' })).toContain('ORT-01');
    expect(ids(bare, { lang: 'es', genre: 'whatsapp' })).not.toContain('ORT-01');
    const mixed = '¿Lo vemos el jueves? Y el viernes, te sirve?';
    expect(ids(mixed, { lang: 'es', genre: 'whatsapp' })).toContain('ORT-01');
  });

  it('lowers the grammar rules to low and raises a voseo and tuteo mix to disqualify', () => {
    const result = lint('Si querés lo vemos. Si puedes, dime.', { lang: 'es', genre: 'whatsapp' });
    const reg = result.findings.filter((f) => f.ruleId === 'REG-01');
    expect(reg.length).toBeGreaterThan(0);
    expect(reg.every((f) => f.severity === 'disqualify')).toBe(true);
    expect(result.disqualified).toBe(true);
    expect(resolveRules(RULES, 'whatsapp').find((r) => r.id === 'SIN-05')?.severity).toBe('low');
  });

  it('turns off the rules that ask a chat for anchors', () => {
    const resolved = new Set(resolveRules(RULES, 'whatsapp').map((r) => r.id));
    for (const id of ['LEX-07', 'LEX-08', 'OFI-01', 'ESP-02', 'EST-05', 'RET-01', 'FMT-01', 'FMT-02', 'ORT-02', 'EST-11']) expect(resolved.has(id), id).toBe(false);
  });
});

describe('a caller rule list with a genre', () => {
  it('is used as given: the genre brings thresholds and messages, not rule changes', () => {
    const text = genreFixture('whatsapp-es.txt');
    expect(ids(text, { lang: 'es', genre: 'whatsapp', rules: RULES })).toEqual(['FMT-02']);
  });
});

describe('variety', () => {
  it('flags every tuteo form in a rioplatense text, even with no voseo in it', () => {
    const text = 'Si puedes, dime cuándo.';
    expect(ids(text, { lang: 'es' })).not.toContain('REG-01');
    const result = lint(text, { lang: 'es', variety: 'rioplatense' });
    expect(result.findings.filter((f) => f.ruleId === 'REG-01').map((f) => f.match)).toEqual(['puedes', 'dime']);
    expect(result.findings[0]?.detail).toBe('the variety is rioplatense, which uses voseo');
    expect(result.variety).toBe('rioplatense');
    expect('genre' in result).toBe(false);
  });

  it('flags every voseo form in a neutral text', () => {
    expect(lint('Si podés, avisame.', { lang: 'es', variety: 'neutral' }).findings.filter((f) => f.ruleId === 'REG-01').map((f) => f.match)).toEqual(['podés', 'avisame']);
  });

  it('leaves English alone', () => {
    expect(ids('I can send it on Monday.', { lang: 'en', variety: 'rioplatense' })).toEqual([]);
  });
});

describe('guessGenre', () => {
  it('reads each fixture as its genre', () => {
    expect(guessGenre(genreFixture('email-es.txt'))).toMatchObject({ genre: 'email', confidence: 'high' });
    expect(guessGenre(genreFixture('follow-up-en.txt'))).toMatchObject({ genre: 'follow-up', confidence: 'high' });
    expect(guessGenre(genreFixture('whatsapp-es.txt'))).toMatchObject({ genre: 'whatsapp', confidence: 'high' });
    expect(guessGenre(letter('en-after.txt')).genre).toBe('cover-letter');
  });

  it('says low when the signals are thin, and lists what it saw', () => {
    const guess = guessGenre('Thanks.');
    expect(guess.confidence).toBe('low');
    expect(guess.signals.length).toBeGreaterThan(0);
  });

  it('is not called by lint(): without a genre a mail is read as a cover letter', () => {
    expect('genre' in lint(genreFixture('email-es.txt'), { lang: 'es' })).toBe(false);
  });
});
