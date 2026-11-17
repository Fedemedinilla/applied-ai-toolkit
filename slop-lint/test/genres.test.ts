import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySetting, DEFAULT_GENRE, GENRE_PROFILES, GENRES, GUESS_CUTS, guessGenre, guessGenreWith, resolveRules } from '../src/genres.ts';
import { settingsFor, validateConfig } from '../src/config.ts';
import { appliesTo, lint } from '../src/lint.ts';
import { MESSAGE_VARIANTS, messageFor } from '../src/messages.ts';
import { GENRE_RULES, RULES, ruleById, TIER2_BUDGET } from '../src/rules.ts';
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

describe('Markdown in a mail', () => {
  const text = 'Hola Laura,\n\nTe paso lo que hablamos:\n\n- el tablero de ventas\n- la carga de datos\n\nEl **jueves** lo vemos.\n\nSaludos,\nAna\n';
  const fmt = (genre?: Genre) => lint(text, { lang: 'es', ...(genre === undefined ? {} : { genre }) }).findings.filter((f) => f.ruleId.startsWith('FMT-01')).map((f) => [f.ruleId, f.level, f.severity, f.match]);

  it('lowers a short list to level 2 medium and keeps bold and headings at level 1, in email and follow-up', () => {
    for (const genre of ['email', 'follow-up'] as const) {
      expect(fmt(genre), genre).toEqual([
        ['FMT-01-LIST', 2, 'medium', '- '],
        ['FMT-01-LIST', 2, 'medium', '- '],
        ['FMT-01', 1, 'high', '**jueves**'],
      ]);
      const bold = lint(text, { lang: 'es', genre }).findings.find((f) => f.ruleId === 'FMT-01');
      expect(bold?.message, genre).not.toMatch(/portal/u);
    }
  });

  it('keeps the whole rule at level 1 in a cover letter', () => {
    expect(fmt()).toEqual([
      ['FMT-01', 1, 'high', '- '],
      ['FMT-01', 1, 'high', '- '],
      ['FMT-01', 1, 'high', '**jueves**'],
    ]);
  });

  it('splits the catalog pattern without losing or adding a match', () => {
    const catalog = ruleById('FMT-01');
    const parts = resolveRules(RULES, 'email').filter((r) => r.id.startsWith('FMT-01'));
    expect(parts.map((r) => r.id)).toEqual(['FMT-01', 'FMT-01-LIST']);
    if (catalog.kind !== 'pattern') throw new Error('FMT-01 is a pattern rule');
    for (const lang of ['en', 'es'] as const) {
      expect(parts.map((r) => (r.kind === 'pattern' ? r.patterns[lang] : '')).join('|'), lang).toBe(catalog.patterns[lang]);
    }
  });

  it('lets a config setting for FMT-01 apply to both parts', () => {
    const settings = settingsFor({ ruleSettings: { 'FMT-01': 'off' } }, undefined, 'config file', { genre: 'email' });
    expect(settings.rules.some((r) => r.id.startsWith('FMT-01'))).toBe(false);
    expect(settings.off.filter((id) => id === 'FMT-01')).toEqual(['FMT-01']);
    const raised = settingsFor({ ruleSettings: { 'FMT-01': { level: 1, severity: 'high' } } }, undefined, 'config file', { genre: 'email' });
    expect(raised.rules.filter((r) => r.id.startsWith('FMT-01')).map((r) => [r.id, r.level])).toEqual([['FMT-01', 1], ['FMT-01-LIST', 1]]);
  });

  describe('FMT-01-LIST by name', () => {
    const parts = (config: Parameters<typeof settingsFor>[0], genre: Genre = 'email') => {
      const settings = settingsFor(validateConfig(config), undefined, 'config file', { genre });
      return { rules: settings.rules.filter((r) => r.id.startsWith('FMT-01')).map((r) => [r.id, r.level, r.severity]), off: settings.off.filter((id) => id.startsWith('FMT-01')) };
    };

    it('is accepted under ruleSettings and under an override, and an unknown part is not', () => {
      expect(() => validateConfig({ ruleSettings: { 'FMT-01-LIST': 'off' } })).not.toThrow();
      expect(() => validateConfig({ overrides: [{ files: ['mail/**'], ruleSettings: { 'FMT-01-LIST': { severity: 'low' } } }] })).not.toThrow();
      expect(() => validateConfig({ ruleSettings: { 'FMT-01-BOLD': 'off' } })).toThrow(/^ruleSettings\.FMT-01-BOLD: is not the id of a built-in rule/u);
    });

    it('turns only the list part off, and lists it as off', () => {
      expect(parts({ ruleSettings: { 'FMT-01-LIST': 'off' } })).toEqual({ rules: [['FMT-01', 1, 'high']], off: ['FMT-01-LIST'] });
    });

    it('wins over the FMT-01 setting for the list part, which FMT-01 still sets otherwise', () => {
      expect(parts({ ruleSettings: { 'FMT-01': { severity: 'disqualify' }, 'FMT-01-LIST': { severity: 'low' } } }).rules).toEqual([
        ['FMT-01', 1, 'disqualify'],
        ['FMT-01-LIST', 2, 'low'],
      ]);
      expect(parts({ ruleSettings: { 'FMT-01': 'off', 'FMT-01-LIST': { severity: 'low' } } })).toEqual({ rules: [['FMT-01-LIST', 2, 'low']], off: ['FMT-01'] });
      expect(parts({ ruleSettings: { 'FMT-01': 'off', 'FMT-01-LIST': 'off' } })).toEqual({ rules: [], off: ['FMT-01', 'FMT-01-LIST'] });
    });

    it('lists FMT-01 once as off when the config turns the whole rule off by its catalog id, as before the split', () => {
      expect(parts({ ruleSettings: { 'FMT-01': 'off' } })).toEqual({ rules: [], off: ['FMT-01'] });
      for (const genre of ['email', 'follow-up'] as const) {
        const { off } = settingsFor(validateConfig({ ruleSettings: { 'FMT-01': 'off' } }), undefined, 'config file', { genre });
        expect(off.filter((id) => id.startsWith('FMT-01')), genre).toEqual(['FMT-01']);
      }
    });

    it('keeps a top-level FMT-01-LIST setting when an override sets FMT-01', () => {
      const config = { ruleSettings: { 'FMT-01-LIST': { severity: 'low' as const } }, overrides: [{ files: ['**'], ruleSettings: { 'FMT-01': 'off' as const } }] };
      const settings = settingsFor(validateConfig(config), 'mail.txt', 'config file', { genre: 'email' });
      expect(settings.rules.filter((r) => r.id.startsWith('FMT-01')).map((r) => [r.id, r.severity])).toEqual([['FMT-01-LIST', 'low']]);
    });

    it('changes nothing in a genre that does not split FMT-01', () => {
      expect(parts({ ruleSettings: { 'FMT-01-LIST': 'off' } }, 'cover-letter')).toEqual(parts({}, 'cover-letter'));
      expect(parts({ ruleSettings: { 'FMT-01-LIST': { severity: 'low' } } }, 'whatsapp')).toEqual(parts({}, 'whatsapp'));
    });
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

  it('lowers the grammar rules to low and keeps a voseo and tuteo mix at high without voiding the message', () => {
    const result = lint('Si querés lo vemos. Si puedes, dime.', { lang: 'es', genre: 'whatsapp' });
    const reg = result.findings.filter((f) => f.ruleId === 'REG-01');
    expect(reg.length).toBeGreaterThan(0);
    expect(reg.every((f) => f.severity === 'high')).toBe(true);
    expect(result.disqualified).toBe(false);
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
    // Nothing is mixed in a one-register text, so the finding names the variety instead.
    expect(result.findings[0]).toMatchObject({ message: 'The variety is rioplatense, which uses voseo.', suggestion: 'Use the voseo forms: "querés... podés".' });
    expect('detail' in result.findings[0]!).toBe(false);
    expect(result.variety).toBe('rioplatense');
    expect('genre' in result).toBe(false);
  });

  it('flags every voseo form in a neutral text', () => {
    expect(lint('Si podés, avisame.', { lang: 'es', variety: 'neutral' }).findings.filter((f) => f.ruleId === 'REG-01').map((f) => f.match)).toEqual(['podés', 'avisame']);
    expect(lint('Si podés, avisame.', { lang: 'es', variety: 'neutral' }).findings[0]).toMatchObject({ message: 'The variety is neutral, which uses tuteo.', suggestion: 'Use the tuteo forms: "quieres... puedes".' });
    // Without a variety a mix keeps the catalog message.
    expect(lint('Si querés lo vemos. Si puedes, dime.', { lang: 'es' }).findings.find((f) => f.ruleId === 'REG-01')?.message).toBe(ruleById('REG-01')?.message);
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

  it('does not read a cover letter that says "follow up" as a sure follow-up', () => {
    const after = `${letter('en-after.txt')}\nAt Brightwell I would follow up on every open ticket within a day.\n`;
    expect(guessGenre(after)).toMatchObject({ genre: 'cover-letter', confidence: 'high' });
    const before = `${letter('en-before.txt')}\nI am also used to following up with vendors every week.\n`;
    expect(guessGenre(before).confidence).toBe('low');
    // A long text with no subject line that does point back is still only a low guess.
    const pointsBack = `${letter('en-after.txt')}\nI am following up on my application of 3 March.\n`;
    expect(guessGenre(pointsBack)).toMatchObject({ genre: 'follow-up', confidence: 'low' });
  });

  it.each([
    ['a reference to an earlier message alone', 'As I mentioned in my last note, the file is ready.', 'follow-up', 'low'],
    ['a short mail with a greeting and a sign-off', 'Hi Dana,\n\nThe file is in the shared folder.\n\nThanks,\nSam', 'email', 'low'],
    ['a chat with emoji and closing periods', 'Te paso el tablero 📊.\nLo vemos el jueves.', 'whatsapp', 'low'],
    ['a chat with emoji and open lines', 'Te paso el tablero 📊\nLo vemos el jueves', 'whatsapp', 'high'],
  ] as const)('gives %s the right genre and confidence', (_name, text, genre, confidence) => {
    expect(guessGenre(text)).toMatchObject({ genre, confidence });
  });

  it('cuts at 60 and 150 words unless other cuts are given', () => {
    expect(GUESS_CUTS).toEqual({ shortWords: 60, mailWords: 150 });
    const chat = 'Te paso el tablero 📊\nLo vemos el jueves';
    expect(guessGenreWith(chat, GUESS_CUTS)).toEqual(guessGenre(chat));
    // With a 5-word cut the chat is no longer short, so it falls back to the default genre.
    expect(guessGenreWith(chat, { ...GUESS_CUTS, shortWords: 5 }).genre).toBe(DEFAULT_GENRE);
    const mail = 'Hi Dana,\n\nThe file is in the shared folder.\n\nThanks,\nSam';
    expect(guessGenreWith(mail, { ...GUESS_CUTS, mailWords: 5 }).genre).toBe(DEFAULT_GENRE);
  });

  it('is not called by lint(): without a genre a mail is read as a cover letter', () => {
    expect('genre' in lint(genreFixture('email-es.txt'), { lang: 'es' })).toBe(false);
  });
});

describe('rules only a genre runs', () => {
  const where = (id: string) => GENRES.filter((g) => resolveRules(RULES, g).some((r) => r.id === id));

  it('run in the genres the design gives them and never in a cover letter', () => {
    const expected: Record<string, Genre[]> = { 'MAIL-01': ['email', 'follow-up'], 'MAIL-02': ['email', 'follow-up'], 'MAIL-03': ['email', 'follow-up'], 'MAIL-04': ['email', 'follow-up', 'whatsapp'], 'SEG-03': ['follow-up'], 'WA-03': ['whatsapp'] };
    for (const [id, genres] of Object.entries(expected)) expect(where(id), id).toEqual(genres);
    expect(GENRE_RULES.map((r) => r.id).sort()).toEqual(Object.keys(expected).sort());
  });

  it('can be named by a config, which wins over the genre', () => {
    for (const rule of GENRE_RULES) {
      const genre = where(rule.id)[0] ?? 'email';
      expect(() => validateConfig({ ruleSettings: { [rule.id]: 'off' } }), rule.id).not.toThrow();
      expect(settingsFor({}, undefined, 'config file', { genre }).rules.some((r) => r.id === rule.id), rule.id).toBe(true);
      const off = settingsFor(validateConfig({ ruleSettings: { [rule.id]: 'off' } }), undefined, 'config file', { genre });
      expect(off.rules.some((r) => r.id === rule.id), rule.id).toBe(false);
      expect(off.off, rule.id).toContain(rule.id);
      expect(settingsFor({}, undefined, 'config file', { genre: 'cover-letter' }).rules.some((r) => r.id === rule.id), rule.id).toBe(false);
    }
  });
});

describe('MAIL-01, thanks as the only closing sentence', () => {
  const mail = 'Hi Dana,\n\nI rebuilt the sales dashboard in Power BI in 2024.\n\nThank you for your time and consideration.\n\nBest,\nSam';

  it('fires in email and follow-up as a level 1 finding, and not in a cover letter', () => {
    for (const genre of ['email', 'follow-up'] as const) {
      const result = lint(mail, { lang: 'en', genre });
      const f = result.findings.find((x) => x.ruleId === 'MAIL-01');
      expect(f, genre).toMatchObject({ level: 1, severity: 'high', match: 'Thank you for your time and consideration.' });
      expect(result.passesTier1, genre).toBe(false);
    }
    expect(ids(mail, { lang: 'en' })).not.toContain('MAIL-01');
    expect(ids(mail, { lang: 'en', genre: 'whatsapp' })).not.toContain('MAIL-01');
  });

  it('leaves the formula alone when another sentence closes the text or the sentence goes on', () => {
    const then = 'Hi Dana,\n\nThank you for your time and consideration. I can send the code sample on Monday.\n\nBest,\nSam';
    const longer = 'Hi Dana,\n\nThank you for your time and consideration, and for the notes on the brief.\n\nBest,\nSam';
    expect(ids(then, { lang: 'en', genre: 'email' })).not.toContain('MAIL-01');
    expect(ids(longer, { lang: 'en', genre: 'email' })).not.toContain('MAIL-01');
  });
});

describe('MAIL-01 and the lines after the formula', () => {
  const body = 'Hi Dana,\n\nI rebuilt the sales dashboard in Power BI in 2024.\n\n';
  const match = (text: string) => lint(text, { lang: 'en', genre: 'email' }).findings.filter((f) => f.ruleId === 'MAIL-01').map((f) => f.match);

  it('fires when the sign-off or the signature ends in a period', () => {
    expect(match(`${body}Thank you for your time and consideration.\n\nKind regards, Sam.`)).toEqual(['Thank you for your time and consideration.']);
    expect(match(`${body}Thank you for your time and consideration.\n\nBest,\nSam R. Smith.`)).toEqual(['Thank you for your time and consideration.']);
    expect(match(`${body}Thank you for your time and consideration.\n\nBest regards,\nSam Ruiz\nData analyst, Rosario.`)).toEqual(['Thank you for your time and consideration.']);
  });

  it('fires when the formula is the sign-off line itself, with a comma, an ellipsis or no mark', () => {
    expect(match(`${body}Thank you for your time and consideration,\nSam`)).toEqual(['Thank you for your time and consideration,']);
    expect(match(`${body}Thank you for your time and consideration…\nSam`)).toEqual(['Thank you for your time and consideration…']);
    expect(match(`${body}Thank you for your time and consideration\nSam`)).toEqual(['Thank you for your time and consideration']);
  });

  it('reads a doubled space or a tab between the words as one space', () => {
    expect(match(`${body}Thank you  for your time and consideration.\n\nBest,\nSam`)).toEqual(['Thank you  for your time and consideration.']);
    expect(match(`${body}Thank you for your time\tand consideration.\n\nBest,\nSam`)).toEqual(['Thank you for your time\tand consideration.']);
    for (const subject of ['Asunto: Oportunidad   emocionante', 'Asunto: Oportunidad\temocionante']) {
      expect(ids(`${subject}\n\nHola, Laura:\n\nTe paso el tablero.`, { lang: 'es', genre: 'email' }), subject).toContain('MAIL-03');
    }
  });

  it('still fires with a bare name after the formula, and not when a sentence or a P.S. follows it', () => {
    expect(match(`${body}Thank you for your time and consideration.\n\nSam`)).toEqual(['Thank you for your time and consideration.']);
    expect(match(`${body}Thank you for your time and consideration.\nI can send the code sample on Monday.\n\nBest,\nSam`)).toEqual([]);
    expect(match(`${body}Thank you for your time and consideration.\n\nBest,\nSam\n\nP.S. I attach the code sample here.`)).toEqual([]);
  });
});

describe('MAIL-02, "Estimado/a" with a slash', () => {
  it('fires in email and follow-up, on every spelling of the slash, and not in a cover letter', () => {
    for (const genre of ['email', 'follow-up'] as const) {
      for (const greeting of ['Estimado/a', 'Estimada/o', 'Estimados/as', 'estimado / a']) {
        const f = lint(`${greeting} equipo:\n\nLes paso el tablero de ventas de 2024.`, { lang: 'es', genre }).findings.find((x) => x.ruleId === 'MAIL-02');
        expect(f, `${genre}: ${greeting}`).toMatchObject({ level: 2, severity: 'medium', match: greeting });
      }
    }
    expect(ids('Estimado/a equipo:\n\nLes paso el tablero.', { lang: 'es' })).not.toContain('MAIL-02');
  });

  it('leaves a greeting that names the reader alone', () => {
    expect(ids('Estimada Laura:\n\nTe paso el tablero.', { lang: 'es', genre: 'email' })).not.toContain('MAIL-02');
  });
});

describe('MAIL-03, a generic subject', () => {
  const body = '\n\nHola, Laura:\n\nTe paso el tablero de ventas de 2024.\n\nSaludos,\nAna';

  it('fires on the phrase the report names, on a first line that starts with Asunto: or Subject:', () => {
    for (const genre of ['email', 'follow-up'] as const) {
      for (const subject of ['Asunto: Oportunidad emocionante', 'Subject: Una oportunidad emocionante en Datos Ficticios']) {
        const f = lint(subject + body, { lang: 'es', genre }).findings.find((x) => x.ruleId === 'MAIL-03');
        expect(f, `${genre}: ${subject}`).toMatchObject({ level: 2, severity: 'medium', line: 1 });
        expect(f?.match.toLowerCase()).toBe('oportunidad emocionante');
      }
    }
    expect(ids(`Asunto: Oportunidad emocionante${body}`, { lang: 'es' })).not.toContain('MAIL-03');
  });

  it('reads only the subject line: the phrase in the body, or a subject after the first line, is left alone', () => {
    const inBody = 'Asunto: Analista de datos · Ana Ruiz · Power BI\n\nHola, Laura:\n\nVi una oportunidad emocionante en el aviso.';
    const notFirst = `Hola, Laura:\nAsunto: Oportunidad emocionante${body}`;
    expect(ids(inBody, { lang: 'es', genre: 'email' })).not.toContain('MAIL-03');
    expect(ids(notFirst, { lang: 'es', genre: 'email' })).not.toContain('MAIL-03');
  });
});

describe('SEG-03, a follow-up that copies the earlier message', () => {
  const previous = 'Hi Dana,\n\nI rebuilt the stock dashboard for the Rosario branch and cut the refresh from 40 minutes to 12.\n\nBest,\nSam';
  const copy = 'Hi Dana,\n\nLast week I wrote that I rebuilt the stock dashboard for the Rosario branch and cut the refresh. Could we look at it on Thursday?\n\nBest,\nSam';

  it('reports the run of more than 8 words copied in a row, once, in a follow-up only', () => {
    const result = lint(copy, { lang: 'en', genre: 'follow-up', previous });
    const seg = result.findings.filter((f) => f.ruleId === 'SEG-03');
    expect(seg).toHaveLength(1);
    expect(seg[0]).toMatchObject({ level: 2, severity: 'medium', match: 'I rebuilt the stock dashboard for the Rosario branch and cut the refresh', detail: '13 words in a row from the earlier message' });
    expect(ids(copy, { lang: 'en', genre: 'email', previous })).not.toContain('SEG-03');
    expect(ids(copy, { lang: 'en', previous })).not.toContain('SEG-03');
  });

  it('allows 8 words in a row, ignores case and punctuation, and needs the earlier message', () => {
    const eight = 'Hi Dana,\n\nAbout the stock dashboard for the Rosario branch and its refresh: could we meet on Thursday?\n\nBest,\nSam';
    expect(ids(eight, { lang: 'en', genre: 'follow-up', previous })).not.toContain('SEG-03');
    const shouted = copy.replace('I rebuilt the stock dashboard for the Rosario branch', 'I REBUILT the stock dashboard, for the Rosario branch');
    expect(ids(shouted, { lang: 'en', genre: 'follow-up', previous })).toContain('SEG-03');
    expect(ids(copy, { lang: 'en', genre: 'follow-up' })).not.toContain('SEG-03');
  });

  it('compares only prose: a shared greeting and sign-off are not copied words', () => {
    const before = 'Hi Dana,\n\nThe stock dashboard is live. I can send the sample on Monday.\n\nBest regards,\nSam Ruiz';
    const after = 'Hi Dana,\n\nAny news on the role? Happy to send the sample on Monday.\n\nBest regards,\nSam Ruiz';
    expect(ids(after, { lang: 'en', genre: 'follow-up', previous: before })).not.toContain('SEG-03');
    const antes = 'Hola, Laura:\n\nTe paso el tablero. Te mando el ejemplo el lunes.\n\nUn saludo grande,\nAna Ruiz';
    const despues = 'Hola, Laura:\n\n¿Hay novedades? Sigo con el ejemplo el lunes.\n\nUn saludo grande,\nAna Ruiz';
    expect(ids(despues, { lang: 'es', genre: 'follow-up', previous: antes })).not.toContain('SEG-03');
    // Exactly 8 words of the body copied, then the shared sign-off: within the limit.
    const eightThenSignOff = 'Hi Dana,\n\nLast week I wrote that I cut the refresh from 40 minutes to 12.\n\nBest,\nSam';
    expect(ids(eightThenSignOff, { lang: 'en', genre: 'follow-up', previous })).not.toContain('SEG-03');
    // A copied run starts at the body, not at the greeting the two messages share.
    const fromTheTop = 'Hi Dana,\n\nI rebuilt the stock dashboard for the Rosario branch, as I said. Could we look at it on Thursday?\n\nBest,\nSam';
    const seg = lint(fromTheTop, { lang: 'en', genre: 'follow-up', previous }).findings.filter((f) => f.ruleId === 'SEG-03');
    expect(seg.map((f) => [f.match, f.detail])).toEqual([['I rebuilt the stock dashboard for the Rosario branch', '9 words in a row from the earlier message']]);
  });

  it('treats curly and straight apostrophes, composed and decomposed accents, and a hyphen or a space as the same text', () => {
    const run = (text: string, before: string, lang: Lang) => lint(text, { lang, genre: 'follow-up', previous: before }).findings.filter((f) => f.ruleId === 'SEG-03').map((f) => f.detail);
    const curly = 'Hi Dana,\n\nI don’t think the stock dashboard for the Rosario branch is done.\n\nBest,\nSam';
    expect(run(curly.replace('’', "'"), curly, 'en')).toEqual(['12 words in a row from the earlier message']);
    const nfc = 'Hola, Laura:\n\nYa armé el tablero de ventas de la sucursal Rosario con marzo.\n\nSaludos,\nAna';
    expect(run(nfc, nfc.normalize('NFD'), 'es')).toEqual(['12 words in a row from the earlier message']);
    const hyphen = 'Hi Dana,\n\ni REBUILT the stock-dashboard for the Rosario branch!\n\nBest,\nSam';
    expect(run(hyphen, previous, 'en')).toEqual(['9 words in a row from the earlier message']);
  });

  it('works in Spanish too', () => {
    const anterior = 'Hola, Laura:\n\nTe mandé el tablero de ventas de la sucursal Rosario con los datos de marzo.\n\nSaludos,\nAna';
    const seguimiento = 'Hola, Laura:\n\nTe escribo porque te mandé el tablero de ventas de la sucursal Rosario con los datos. ¿Lo pudiste ver?\n\nSaludos,\nAna';
    expect(ids(seguimiento, { lang: 'es', genre: 'follow-up', previous: anterior })).toContain('SEG-03');
  });
});

describe('WA-03, emoji used as bullets', () => {
  const list = 'Te paso lo que falta\n✅ el tablero de ventas\n✅ la carga de marzo\n📅 lo vemos el jueves';

  it('reports each emoji that opens a line of a list, in whatsapp only', () => {
    const wa = lint(list, { lang: 'es', genre: 'whatsapp' }).findings.filter((f) => f.ruleId === 'WA-03');
    expect(wa.map((f) => [f.match, f.line, f.level, f.severity])).toEqual([
      ['✅', 2, 2, 'medium'],
      ['✅', 3, 2, 'medium'],
      ['📅', 4, 2, 'medium'],
    ]);
    expect(ids(list, { lang: 'es', genre: 'email' })).not.toContain('WA-03');
    expect(ids(list, { lang: 'es' })).not.toContain('WA-03');
  });

  it('counts keycap numbers and skips blank lines between items', () => {
    const numbered = 'Pasos\n1️⃣ bajá el archivo\n\n2️⃣ abrilo en Excel';
    expect(lint(numbered, { lang: 'es', genre: 'whatsapp' }).findings.filter((f) => f.ruleId === 'WA-03').map((f) => f.match)).toEqual(['1️⃣', '2️⃣']);
  });

  it('counts flags as bullets, and leaves two lines that open with different emoji, such as a greeting, alone', () => {
    expect(lint('🇦🇷 el tablero\n🇦🇷 la carga', { lang: 'es', genre: 'whatsapp' }).findings.filter((f) => f.ruleId === 'WA-03').map((f) => f.match)).toEqual(['🇦🇷', '🇦🇷']);
    expect(ids('👋 Hola, Laura\n😊 Te escribo por lo del tablero', { lang: 'es', genre: 'whatsapp' })).not.toContain('WA-03');
  });

  it('leaves one emoji line, an emoji at the end of a line and a dash list alone', () => {
    for (const text of ['✅ Listo el tablero\nLo vemos el jueves', 'Listo el tablero ✅\nLo vemos el jueves 📅', '- el tablero\n- la carga']) {
      expect(ids(text, { lang: 'es', genre: 'whatsapp' }), text).not.toContain('WA-03');
    }
  });
});
