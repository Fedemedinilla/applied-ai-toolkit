import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate, formatRatio, guessGrid, LABELED_GENRES, LANGS, loadSets, locate, toMarkdown, validateSet, type LabeledSet } from '../scripts/genre-eval.ts';
import { GUESS_CUTS } from '../src/genres.ts';

// Fictional: the names, the branch and the file are invented for this test.
const TINY: LabeledSet = {
  fictional: 'Fictional texts written for this test.',
  genre: 'email',
  lang: 'en',
  items: [
    {
      id: 'email-en-01',
      kind: 'slop',
      text: 'Hi Dana,\n\nI am writing to express my interest in the analyst role.\nHonestly, the file is ready on the shared drive.\nThe work is pivotal for the Rosario branch.\n\nBest,\nSam',
      sentences: [
        { text: 'Hi Dana,', slop: false, rules: [] },
        // LEX-03 reports it: a true positive.
        { text: 'I am writing to express my interest in the analyst role.', slop: true, rules: ['LEX-03'] },
        // LEX-06 reports "Honestly" in a sentence labelled human: a false positive at level 1.
        { text: 'Honestly, the file is ready on the shared drive.', slop: false, rules: [] },
        // One Tier 2 word is inside the shared budget of 2, so LEX-04 stays quiet: a false negative.
        { text: 'The work is pivotal for the Rosario branch.', slop: true, rules: ['LEX-04'] },
        { text: 'Best,', slop: false, rules: [] },
        { text: 'Sam', slop: false, rules: [] },
      ],
    },
    {
      id: 'email-en-02',
      kind: 'human',
      text: 'Hi Dana,\n\nThe file for March is on the shared drive, 14 tabs.\n\nBest,\nSam',
      sentences: [
        { text: 'Hi Dana,', slop: false, rules: [] },
        { text: 'The file for March is on the shared drive, 14 tabs.', slop: false, rules: [] },
        { text: 'Best,', slop: false, rules: [] },
        { text: 'Sam', slop: false, rules: [] },
      ],
    },
  ],
};

const clone = (): LabeledSet => structuredClone(TINY);

describe('validateSet', () => {
  it('accepts the tiny set', () => {
    expect(validateSet(TINY, 'tiny.json')).toEqual([]);
  });

  it.each([
    ['a missing fiction note', (s: LabeledSet) => void (s.fictional = 'Texts.'), '"fictional" must be a string that starts with "Fictional"'],
    ['an id out of sequence', (s: LabeledSet) => void (s.items[1]!.id = 'email-en-07'), '"id" must be email-en-02'],
    ['an unknown rule id', (s: LabeledSet) => void (s.items[0]!.sentences[1]!.rules = ['LEX-99']), 'unknown rule id LEX-99'],
    ['a rule on a human sentence', (s: LabeledSet) => void (s.items[0]!.sentences[2]!.rules = ['LEX-06']), 'a sentence labelled not slop expects no rule'],
    ['a whole-text rule on a sentence', (s: LabeledSet) => void (s.items[0]!.sentences[1]!.rules = ['ESP-02']), 'ESP-02 judges the whole text'],
    ['a slop sentence in a human item', (s: LabeledSet) => void (s.items[1]!.sentences[1]!.slop = true), 'a human item has no slop sentence'],
    ['a sentence that is not in the text', (s: LabeledSet) => void (s.items[1]!.sentences[1]!.text = 'Another sentence.'), 'the sentences do not cover the text'],
    ['text left unlabelled', (s: LabeledSet) => void s.items[1]!.sentences.pop(), 'the sentences do not cover the text'],
    ['an earlier message outside follow-up', (s: LabeledSet) => void (s.items[1]!.previous = 'Hi.'), '"previous" is a non-empty string, and only in follow-up'],
    ['a variety in English', (s: LabeledSet) => void (s.items[1]!.variety = 'neutral'), '"variety" is rioplatense or neutral, and only in Spanish'],
  ])('reports %s', (_name, spoil, message) => {
    const set = clone();
    spoil(set);
    expect(validateSet(set, 'tiny.json').join('\n')).toContain(message);
  });

  it('reports an unknown key', () => {
    expect(validateSet({ ...TINY, extra: 1 }, 'tiny.json')).toEqual(['tiny.json: unknown key "extra"']);
  });
});

describe('locate', () => {
  it('returns the span of each sentence, and null when text between them is not whitespace', () => {
    expect(locate('A b.\nC d.', [{ text: 'A b.' }, { text: 'C d.' }])).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
    expect(locate('A b. x C d.', [{ text: 'A b.' }, { text: 'C d.' }])).toBeNull();
    expect(locate('A b. C d.', [{ text: 'C d.' }, { text: 'A b.' }])).toBeNull();
  });
});

describe('evaluate', () => {
  const result = evaluate([TINY]);
  const row = (rule: string) => result.rules.find((r) => r.rule === rule);

  it('counts true positives, false positives and false negatives per rule over sentences', () => {
    // 10 sentences: the rate's denominator is the 9 or 10 that do not name the rule.
    expect(row('LEX-03')).toMatchObject({ level: 1, scope: 'sentence', tp: 1, fp: 0, fn: 0, precision: { num: 1, den: 1 }, recall: { num: 1, den: 1 }, fpRate: { num: 0, den: 9 } });
    expect(row('LEX-04')).toMatchObject({ level: 2, tp: 0, fp: 0, fn: 1, precision: { num: 0, den: 0 }, recall: { num: 0, den: 1 } });
    expect(row('LEX-06')).toMatchObject({ level: 1, tp: 0, fp: 1, fn: 0, fpRate: { num: 1, den: 10 } });
    expect(result.rules.map((r) => r.rule)).toEqual(['LEX-03', 'LEX-04', 'LEX-06']);
  });

  it('measures each level over sentences', () => {
    const level = (l: 1 | 2 | 3 | 'any') => result.levels.find((x) => x.level === l);
    // Level 1 reports two sentences, one of them slop; 8 sentences are human.
    expect(level(1)).toMatchObject({ precision: { num: 1, den: 2 }, recall: { num: 1, den: 1 }, fpRate: { num: 1, den: 8 } });
    expect(level(2)).toMatchObject({ precision: { num: 0, den: 0 }, recall: { num: 0, den: 1 }, fpRate: { num: 0, den: 8 } });
    expect(level('any')).toMatchObject({ precision: { num: 1, den: 2 }, recall: { num: 1, den: 2 }, fpRate: { num: 1, den: 8 } });
  });

  it('lists each false positive and counts level 1 on human texts only', () => {
    expect(result.falsePositives).toEqual([{ genre: 'email', item: 'email-en-01', sentence: 3, rule: 'LEX-06', level: 1, onSlop: false }]);
    // The level 1 false positive is in the slop item, so the human text stays clean.
    expect(result.human).toEqual([{ genre: 'email', humanTexts: 1, textsWithLevel1: 0, level1Findings: 0, rules: [] }]);
  });

  it('counts a whole-text rule per text, against textRules', () => {
    const set = clone();
    const item = set.items[0]!;
    item.textRules = ['ESP-02'];
    const esp = evaluate([set]).rules.find((r) => r.rule === 'ESP-02');
    // ESP-02 does not report this text, so the label is a false negative over the 2 texts.
    expect(esp).toMatchObject({ scope: 'text', tp: 0, fp: 0, fn: 1, fpRate: { num: 0, den: 1 } });
  });

  it('fills the confusion matrix at the current cuts', () => {
    expect(result.guessCases).toBe(2);
    expect(result.confusion.email.email).toEqual({ all: 2, high: 0 });
  });
});

describe('guessGrid', () => {
  it('scores each pair of cuts and marks the current one', () => {
    const cases = [
      { id: 'a', genre: 'whatsapp' as const, text: 'Te paso el tablero 📊\nLo vemos el jueves' },
      { id: 'b', genre: 'email' as const, text: 'Hi Dana,\n\nThe file is in the shared folder.\n\nThanks,\nSam' },
    ];
    const rows = guessGrid(cases, [5, 60], [150]);
    expect(rows.map((r) => [r.cuts.shortWords, r.current, formatRatio(r.accuracy), formatRatio(r.sure)])).toEqual([
      // At 5 words the chat is not short and falls back to cover-letter.
      [5, false, '0.50 (1/2)', '0.00 (0/2)'],
      [60, true, '1.00 (2/2)', '0.50 (1/2)'],
    ]);
    expect(rows[1]?.surePerGenre.whatsapp).toEqual({ num: 1, den: 1 });
    expect(rows[1]?.surePerGenre['cover-letter']).toEqual({ num: 0, den: 0 });
  });
});

describe('toMarkdown', () => {
  it('prints every section, n/a for an empty denominator', () => {
    const md = toMarkdown(evaluate([TINY]));
    for (const heading of ['## The set', '## Level 1 on human texts', '## Per level', '## Per rule', '## False positives, one by one', '## guessGenre']) expect(md).toContain(heading);
    expect(md).toContain('| email | LEX-04 | 2 | sentence | 0 | 0 | 1 | n/a | 0.00 (0/1) | 0.00 (0/9) |');
    expect(md).toContain('| **60** | **150** |');
  });
});

describe('the labelled set', () => {
  const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
  const sets = loadSets(dir);
  const words = (text: string) => text.split(/\s+/u).filter(Boolean).length;
  const hasSubject = (text: string) => /^(?:asunto|subject)\s*:/iu.test(text);
  const of = (genre: string) => sets.filter((s) => s.genre === genre).flatMap((s) => s.items);

  it('has one valid file per genre and language, each with human and slop texts', () => {
    expect(sets.map((s) => `${s.genre}/${s.lang}`)).toEqual(LABELED_GENRES.flatMap((g) => LANGS.map((l) => `${g}/${l}`)));
    for (const set of sets) {
      expect(set.items.length, `${set.genre}/${set.lang}`).toBeGreaterThanOrEqual(10);
      expect(new Set(set.items.map((i) => i.kind)), `${set.genre}/${set.lang}`).toEqual(new Set(['human', 'slop']));
    }
  });

  it("holds texts on both sides of guessGenre's cuts", () => {
    const mails = of('email');
    expect(mails.some((i) => words(i.text) >= GUESS_CUTS.mailWords)).toBe(true);
    expect(mails.some((i) => words(i.text) >= GUESS_CUTS.mailWords * 0.85 && words(i.text) < GUESS_CUTS.mailWords && !hasSubject(i.text))).toBe(true);
    const followUps = of('follow-up');
    // A long follow-up is sure only with a subject line, so the set has long ones with and without it.
    for (const subject of [true, false]) expect(followUps.some((i) => words(i.text) >= GUESS_CUTS.mailWords && hasSubject(i.text) === subject)).toBe(true);
    expect(followUps.filter((i) => i.previous !== undefined && i.sentences.some((s) => s.rules.includes('SEG-03'))).length).toBeGreaterThanOrEqual(2);
    expect(followUps.filter((i) => i.previous !== undefined && i.kind === 'human').length).toBeGreaterThanOrEqual(2);
    const chats = of('whatsapp');
    expect(chats.some((i) => words(i.text) >= GUESS_CUTS.shortWords)).toBe(true);
    expect(chats.some((i) => words(i.text) < GUESS_CUTS.shortWords)).toBe(true);
  });
});
