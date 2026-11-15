// Measures the genre profiles on the labelled set: precision, recall and false-positive rate per
// rule and per level, level 1 findings on human texts, and guessGenre's confusion matrix at its
// current cuts and at a few others. Deterministic: no model, no network, no clock.
// Usage: node slop-lint/scripts/genre-eval.ts slop-lint/fixtures > slop-lint/research/genre-eval-report.md
// The fixtures folder is an argument, so this script does not depend on fixtures (import-fences/repo.config.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENRES, GUESS_CUTS, guessGenreWith, resolveRules, SPLIT_PART_IDS, type GuessCuts } from '../src/genres.ts';
import { lint } from '../src/lint.ts';
import { GENRE_RULES, RULES } from '../src/rules.ts';
import { DOCUMENT_SCOPE_IDS } from '../src/structural.ts';
import type { Genre, Lang, Level, Variety } from '../src/types.ts';

export type LabeledGenre = Exclude<Genre, 'cover-letter'>;
export const LABELED_GENRES: readonly LabeledGenre[] = ['email', 'follow-up', 'whatsapp'];
export const LANGS: readonly Lang[] = ['es', 'en'];

export interface LabeledSentence {
  /** The sentence exactly as it appears in the item's text. */
  text: string;
  /** The hand label: would a careful reader call this sentence generated? */
  slop: boolean;
  /**
   * The rules that should report it. Empty for a human sentence, or for slop no rule covers yet.
   * Where two rules match the same words, lint() charges them once (dropCovered in lint.ts), so the
   * label names the rule that is charged: LEX-03 for "passionate about", not ESP-04 as well.
   */
  rules: string[];
}

export interface LabeledItem {
  id: string;
  /** 'human': written to read as a person wrote it, every sentence labelled not slop. 'slop': written to read as generated. */
  kind: 'human' | 'slop';
  text: string;
  variety?: Variety;
  /** The earlier message of a follow-up, for SEG-03. */
  previous?: string;
  /** Whole-text rules (DOCUMENT_SCOPE_IDS) that should report the text: ESP-02 when the text as a whole gives too few concrete facts. */
  textRules?: string[];
  /** Every sentence of the text, in order; together they cover all of it but whitespace. */
  sentences: LabeledSentence[];
}

export interface LabeledSet {
  /** Starts with "Fictional": every name, company, date and figure in the set is invented. */
  fictional: string;
  genre: LabeledGenre;
  lang: Lang;
  items: LabeledItem[];
}

const KNOWN_IDS: ReadonlySet<string> = new Set([...RULES, ...GENRE_RULES].map((r) => r.id).concat(SPLIT_PART_IDS));
const SET_KEYS = ['fictional', 'genre', 'lang', 'items'];
const ITEM_KEYS = ['id', 'kind', 'text', 'variety', 'previous', 'textRules', 'sentences'];
const SENTENCE_KEYS = ['text', 'slop', 'rules'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const unknownKeys = (o: Record<string, unknown>, known: readonly string[]) => Object.keys(o).filter((k) => !known.includes(k));

/** Where each labelled sentence sits in the text, or null when a sentence is not found in order. */
export function locate(text: string, sentences: readonly { text: string }[]): Array<{ start: number; end: number }> | null {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const s of sentences) {
    const at = text.indexOf(s.text, cursor);
    if (at < 0 || text.slice(cursor, at).trim() !== '') return null;
    spans.push({ start: at, end: at + s.text.length });
    cursor = at + s.text.length;
  }
  return text.slice(cursor).trim() === '' ? spans : null;
}

/** The problems that make a parsed file an invalid labelled set; empty when it is valid. */
export function validateSet(raw: unknown, file: string): string[] {
  const errors: string[] = [];
  const err = (where: string, what: string) => errors.push(`${file}${where}: ${what}`);
  if (!isObject(raw)) return [`${file}: not an object`];
  for (const k of unknownKeys(raw, SET_KEYS)) err('', `unknown key "${k}"`);
  if (typeof raw.fictional !== 'string' || !raw.fictional.startsWith('Fictional')) err('', '"fictional" must be a string that starts with "Fictional"');
  if (!(LABELED_GENRES as readonly unknown[]).includes(raw.genre)) err('', `"genre" must be one of ${LABELED_GENRES.join(', ')}`);
  if (!(LANGS as readonly unknown[]).includes(raw.lang)) err('', '"lang" must be es or en');
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    err('', '"items" must be a non-empty array');
    return errors;
  }
  const ids = new Set<string>();
  raw.items.forEach((item: unknown, i: number) => {
    const at = `[${i}]`;
    if (!isObject(item)) return err(at, 'item is not an object');
    for (const k of unknownKeys(item, ITEM_KEYS)) err(at, `unknown key "${k}"`);
    const id = item.id;
    if (typeof id !== 'string' || id !== `${String(raw.genre)}-${String(raw.lang)}-${String(i + 1).padStart(2, '0')}`) {
      err(at, `"id" must be ${String(raw.genre)}-${String(raw.lang)}-${String(i + 1).padStart(2, '0')}`);
    } else if (ids.has(id)) err(at, `duplicate id ${id}`);
    else ids.add(id);
    if (item.kind !== 'human' && item.kind !== 'slop') err(at, '"kind" must be human or slop');
    if (typeof item.text !== 'string' || item.text.trim() === '') err(at, '"text" must be a non-empty string');
    if (item.variety !== undefined && (raw.lang !== 'es' || (item.variety !== 'rioplatense' && item.variety !== 'neutral'))) err(at, '"variety" is rioplatense or neutral, and only in Spanish');
    if (item.previous !== undefined && (raw.genre !== 'follow-up' || typeof item.previous !== 'string' || item.previous.trim() === '')) err(at, '"previous" is a non-empty string, and only in follow-up');
    if (item.textRules !== undefined && (!isStringArray(item.textRules) || item.textRules.some((r) => !DOCUMENT_SCOPE_IDS.has(r)))) {
      err(at, `"textRules" may only hold ${[...DOCUMENT_SCOPE_IDS].join(', ')}`);
    }
    if (!Array.isArray(item.sentences) || item.sentences.length === 0) return err(at, '"sentences" must be a non-empty array');
    let slopSentences = 0;
    item.sentences.forEach((s: unknown, j: number) => {
      const sat = `${at}.sentences[${j}]`;
      if (!isObject(s)) return err(sat, 'sentence is not an object');
      for (const k of unknownKeys(s, SENTENCE_KEYS)) err(sat, `unknown key "${k}"`);
      if (typeof s.text !== 'string' || s.text === '' || s.text.trim() !== s.text) err(sat, '"text" must be a non-empty string without surrounding whitespace');
      if (typeof s.slop !== 'boolean') err(sat, '"slop" must be true or false');
      if (!isStringArray(s.rules)) return err(sat, '"rules" must be an array of rule ids');
      for (const r of s.rules) {
        if (!KNOWN_IDS.has(r)) err(sat, `unknown rule id ${r}`);
        if (DOCUMENT_SCOPE_IDS.has(r)) err(sat, `${r} judges the whole text: put it in the item's "textRules"`);
      }
      if (new Set(s.rules).size !== s.rules.length) err(sat, 'a rule id is repeated');
      if (s.slop === false && s.rules.length > 0) err(sat, 'a sentence labelled not slop expects no rule');
      if (s.slop === true) slopSentences++;
    });
    const textRules = isStringArray(item.textRules) ? item.textRules : [];
    if (item.kind === 'human' && (slopSentences > 0 || textRules.length > 0)) err(at, 'a human item has no slop sentence and no textRules');
    if (item.kind === 'slop' && slopSentences === 0 && textRules.length === 0) err(at, 'a slop item has at least one slop sentence or a textRules entry');
    if (typeof item.text === 'string' && item.sentences.every((s: unknown) => isObject(s) && typeof s.text === 'string')) {
      if (locate(item.text, item.sentences as { text: string }[]) === null) err(at, 'the sentences do not cover the text in order (only whitespace may fall between them)');
    }
  });
  return errors;
}

interface ItemRun {
  item: LabeledItem;
  /** Per labelled sentence: the sentence-scope rules that reported it, with their level. */
  sentenceHits: Array<Map<string, Level>>;
  /** Whole-text rules that reported the text, with their level. */
  textHits: Map<string, Level>;
}

function runItem(set: LabeledSet, item: LabeledItem): ItemRun {
  const result = lint(item.text, {
    lang: set.lang,
    genre: set.genre,
    ...(item.variety !== undefined ? { variety: item.variety } : {}),
    ...(item.previous !== undefined ? { previous: item.previous } : {}),
  });
  const spans = locate(item.text, item.sentences);
  if (spans === null) throw new Error(`${item.id}: the sentences do not cover the text`);
  const sentenceHits = item.sentences.map(() => new Map<string, Level>());
  const textHits = new Map<string, Level>();
  for (const f of result.findings) {
    if (DOCUMENT_SCOPE_IDS.has(f.ruleId)) {
      textHits.set(f.ruleId, f.level);
      continue;
    }
    // A finding belongs to the sentence it starts in; one that starts in whitespace, to the next sentence.
    let index = spans.findIndex((s) => f.start < s.end);
    if (index < 0) index = spans.length - 1;
    sentenceHits[index]?.set(f.ruleId, f.level);
  }
  return { item, sentenceHits, textHits };
}

export interface Ratio {
  num: number;
  den: number;
}

export interface RuleRow {
  genre: LabeledGenre;
  rule: string;
  /** The rule's level in this genre; 'off' when the genre's profile does not run it. */
  level: Level | 'off';
  scope: 'sentence' | 'text';
  tp: number;
  fp: number;
  fn: number;
  precision: Ratio;
  recall: Ratio;
  /** False positives over the units (sentences or texts) that do not expect the rule. */
  fpRate: Ratio;
}

export interface LevelRow {
  genre: LabeledGenre;
  level: Level | 'any';
  /** Slop sentences among the sentences reported at this level. */
  precision: Ratio;
  /** Sentences reported at this level among the slop sentences that expect a rule of this level. */
  recall: Ratio;
  /** Human sentences reported at this level over all human sentences. */
  fpRate: Ratio;
}

export interface HumanLevel1Row {
  genre: LabeledGenre;
  humanTexts: number;
  textsWithLevel1: number;
  level1Findings: number;
  rules: string[];
}

export interface FalsePositive {
  genre: LabeledGenre;
  item: string;
  /** 1-based; 0 for a whole-text rule. */
  sentence: number;
  rule: string;
  level: Level;
  /** True when the sentence is labelled slop for another reason. */
  onSlop: boolean;
}

export interface Coverage {
  genre: LabeledGenre;
  lang: Lang;
  items: number;
  human: number;
  slop: number;
  sentences: number;
  slopSentences: number;
  /** Slop sentences whose label names no rule, and how many of them some rule still reported. */
  unnamedSlop: Ratio;
}

export interface GuessCase {
  id: string;
  genre: Genre;
  text: string;
}

export interface GuessRow {
  cuts: GuessCuts;
  current: boolean;
  /** Right genre, any confidence. */
  accuracy: Ratio;
  /** Right genre with high confidence: what `--genre auto` keeps, since a low guess falls back to cover-letter. */
  sure: Ratio;
  /** Per true genre, right with high confidence. */
  surePerGenre: Record<Genre, Ratio>;
}

export interface EvalResult {
  coverage: Coverage[];
  rules: RuleRow[];
  levels: LevelRow[];
  human: HumanLevel1Row[];
  falsePositives: FalsePositive[];
  /** At GUESS_CUTS: matrix[true][guessed] = { all, high }. */
  confusion: Record<Genre, Record<Genre, { all: number; high: number }>>;
  guessCases: number;
  /** How many of guessCases came from extraGuessCases. */
  extraGuessCases: number;
  grid: GuessRow[];
}

const ratio = (num: number, den: number): Ratio => ({ num, den });

function levelsIn(genre: Genre): Map<string, Level> {
  return new Map(resolveRules(RULES, genre).map((r) => [r.id, r.level]));
}

function ruleRows(genre: LabeledGenre, runs: readonly ItemRun[], fps: FalsePositive[]): RuleRow[] {
  const levels = levelsIn(genre);
  const sentences = runs.flatMap((run) => run.item.sentences.map((s, i) => ({ run, s, i, hits: run.sentenceHits[i] ?? new Map<string, Level>() })));
  const ids = new Set<string>();
  for (const { s, hits } of sentences) for (const id of [...s.rules, ...hits.keys()]) ids.add(id);
  for (const run of runs) for (const id of [...(run.item.textRules ?? []), ...run.textHits.keys()]) ids.add(id);
  const rows: RuleRow[] = [];
  for (const rule of [...ids].sort()) {
    const scope = DOCUMENT_SCOPE_IDS.has(rule) ? 'text' : 'sentence';
    const units =
      scope === 'text'
        ? runs.map((run) => ({ expected: (run.item.textRules ?? []).includes(rule), level: run.textHits.get(rule), run, index: 0, onSlop: run.item.kind === 'slop' }))
        : sentences.map(({ run, s, i, hits }) => ({ expected: s.rules.includes(rule), level: hits.get(rule), run, index: i + 1, onSlop: s.slop }));
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const u of units) {
      if (u.level !== undefined && u.expected) tp++;
      else if (u.level !== undefined) {
        fp++;
        fps.push({ genre, item: u.run.item.id, sentence: u.index, rule, level: u.level, onSlop: u.onSlop });
      } else if (u.expected) fn++;
    }
    const negatives = units.filter((u) => !u.expected).length;
    rows.push({ genre, rule, level: levels.get(rule) ?? 'off', scope, tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), fpRate: ratio(fp, negatives) });
  }
  return rows;
}

function levelRows(genre: LabeledGenre, runs: readonly ItemRun[]): LevelRow[] {
  const levels = levelsIn(genre);
  const sentences = runs.flatMap((run) => run.item.sentences.map((s, i) => ({ s, hits: [...(run.sentenceHits[i] ?? new Map<string, Level>()).values()] })));
  const human = sentences.filter((x) => !x.s.slop).length;
  return ([1, 2, 3, 'any'] as const).map((level) => {
    const at = (l: Level) => level === 'any' || l === level;
    const flagged = sentences.filter((x) => x.hits.some(at));
    const expected = sentences.filter((x) => x.s.slop && x.s.rules.some((r) => levels.has(r) && at(levels.get(r) as Level)));
    return {
      genre,
      level,
      precision: ratio(flagged.filter((x) => x.s.slop).length, flagged.length),
      recall: ratio(expected.filter((x) => x.hits.some(at)).length, expected.length),
      fpRate: ratio(flagged.filter((x) => !x.s.slop).length, human),
    };
  });
}

function humanRow(genre: LabeledGenre, runs: readonly ItemRun[]): HumanLevel1Row {
  const human = runs.filter((r) => r.item.kind === 'human');
  const level1 = human.map((r) => [...r.sentenceHits.flatMap((m) => [...m]), ...r.textHits].filter(([, l]) => l === 1).map(([id]) => id));
  return {
    genre,
    humanTexts: human.length,
    textsWithLevel1: level1.filter((ids) => ids.length > 0).length,
    level1Findings: level1.flat().length,
    rules: [...new Set(level1.flat())].sort(),
  };
}

export function guessGrid(cases: readonly GuessCase[], shorts: readonly number[], mails: readonly number[]): GuessRow[] {
  return shorts.flatMap((shortWords) =>
    mails.map((mailWords) => {
      const cuts = { shortWords, mailWords };
      const guesses = cases.map((c) => ({ c, g: guessGenreWith(c.text, cuts) }));
      const surePerGenre = Object.fromEntries(
        GENRES.map((genre) => {
          const of = guesses.filter((x) => x.c.genre === genre);
          return [genre, ratio(of.filter((x) => x.g.genre === genre && x.g.confidence === 'high').length, of.length)];
        }),
      ) as Record<Genre, Ratio>;
      return {
        cuts,
        current: shortWords === GUESS_CUTS.shortWords && mailWords === GUESS_CUTS.mailWords,
        accuracy: ratio(guesses.filter((x) => x.g.genre === x.c.genre).length, cases.length),
        sure: ratio(guesses.filter((x) => x.g.genre === x.c.genre && x.g.confidence === 'high').length, cases.length),
        surePerGenre,
      };
    }),
  );
}

export const SHORT_CUTS: readonly number[] = [40, 60, 80];
export const MAIL_CUTS: readonly number[] = [100, 150, 200, 250];

/** Runs every item of every set; `extraGuessCases` (the cover letters) only enter guessGenre's matrix. */
export function evaluate(sets: readonly LabeledSet[], extraGuessCases: readonly GuessCase[] = []): EvalResult {
  const result: EvalResult = { coverage: [], rules: [], levels: [], human: [], falsePositives: [], confusion: emptyMatrix(), guessCases: 0, extraGuessCases: extraGuessCases.length, grid: [] };
  const runsByGenre = new Map<LabeledGenre, ItemRun[]>();
  for (const set of sets) {
    const runs = set.items.map((item) => runItem(set, item));
    runsByGenre.set(set.genre, [...(runsByGenre.get(set.genre) ?? []), ...runs]);
    const all = set.items.flatMap((i) => i.sentences);
    const unnamed = runs.flatMap((r) => r.item.sentences.map((s, i) => ({ s, hit: (r.sentenceHits[i]?.size ?? 0) > 0 }))).filter((x) => x.s.slop && x.s.rules.length === 0);
    result.coverage.push({
      genre: set.genre,
      lang: set.lang,
      items: set.items.length,
      human: set.items.filter((i) => i.kind === 'human').length,
      slop: set.items.filter((i) => i.kind === 'slop').length,
      sentences: all.length,
      slopSentences: all.filter((s) => s.slop).length,
      unnamedSlop: ratio(unnamed.filter((x) => x.hit).length, unnamed.length),
    });
  }
  for (const genre of LABELED_GENRES) {
    const runs = runsByGenre.get(genre);
    if (runs === undefined) continue;
    result.rules.push(...ruleRows(genre, runs, result.falsePositives));
    result.levels.push(...levelRows(genre, runs));
    result.human.push(humanRow(genre, runs));
  }
  const cases: GuessCase[] = [...sets.flatMap((s) => s.items.map((i) => ({ id: i.id, genre: s.genre as Genre, text: i.text }))), ...extraGuessCases];
  for (const c of cases) {
    const g = guessGenreWith(c.text, GUESS_CUTS);
    const cell = result.confusion[c.genre][g.genre];
    cell.all++;
    if (g.confidence === 'high') cell.high++;
  }
  result.guessCases = cases.length;
  result.grid = guessGrid(cases, SHORT_CUTS, MAIL_CUTS);
  return result;
}

function emptyMatrix(): EvalResult['confusion'] {
  return Object.fromEntries(GENRES.map((t) => [t, Object.fromEntries(GENRES.map((g) => [g, { all: 0, high: 0 }]))])) as EvalResult['confusion'];
}

export function formatRatio(r: Ratio): string {
  return r.den === 0 ? 'n/a' : `${(r.num / r.den).toFixed(2)} (${r.num}/${r.den})`;
}

const table = (head: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
];

export function toMarkdown(r: EvalResult): string {
  const lines: string[] = [
    '# Genre profiles on the labelled set',
    '',
    'Generated by `npm run genre:eval` (`node slop-lint/scripts/genre-eval.ts slop-lint/fixtures`) from `slop-lint/fixtures/{email,follow-up,whatsapp}/{es,en}.json`. Do not edit it by hand: change the set or the profiles and run the script again. `slop-lint/test/genre-eval.test.ts` fails when this file is out of date.',
    '',
    'The texts are fictional and were written for this set, with every sentence labelled by hand. The numbers describe this set only. They are a first reading for choosing the false-positive threshold that takes a profile out of experimental (design decision D3); the profiles and thresholds are unchanged.',
    '',
    'The same hand wrote the texts and knows the catalog, so the slop texts lean on phrases the rules list and the recall here is likely higher than on drafts from a model. A review of a sample by Federico (D3) is still pending.',
    '',
    '## How to read it',
    '',
    '- A finding counts for the sentence it starts in. ESP-02, EST-11 and OFI-01 judge the whole text, so they count per text against the labels in `textRules`.',
    '- Per rule, the unit is a sentence, or a text for the three rules above. A true positive is a unit the rule reports and whose label names it. A false positive is one it reports and whose label does not name it. A false negative is one whose label names the rule and that the rule does not report. The false-positive rate divides the false positives by the units whose label does not name the rule.',
    '- Per level, precision is the share of reported sentences labelled slop. Recall is the share of slop sentences that name a rule of that level and are reported at it. The false-positive rate is the share of human sentences reported at it.',
    '- A ratio reads as value (count/denominator); n/a means the denominator is 0.',
    '',
    '## The set',
    '',
    ...table(
      ['genre', 'lang', 'texts', 'human', 'slop', 'sentences', 'slop sentences', 'slop with no rule named, reported anyway'],
      r.coverage.map((c) => [c.genre, c.lang, c.items, c.human, c.slop, c.sentences, c.slopSentences, formatRatio(c.unnamedSlop)]),
    ),
    '',
    '## Level 1 on human texts',
    '',
    'The criterion for whatsapp to leave experimental is zero here (design 3.6).',
    '',
    ...table(
      ['genre', 'human texts', 'texts with a level 1 finding', 'level 1 findings', 'rules'],
      r.human.map((h) => [h.genre, h.humanTexts, h.textsWithLevel1, h.level1Findings, h.rules.join(', ') || 'none']),
    ),
    '',
    '## Per level',
    '',
    ...table(
      ['genre', 'level', 'precision', 'recall', 'false-positive rate'],
      r.levels.map((l) => [l.genre, String(l.level), formatRatio(l.precision), formatRatio(l.recall), formatRatio(l.fpRate)]),
    ),
    '',
    '## Per rule',
    '',
    'Only the rules that fired or that a label names, per genre.',
    '',
    ...table(
      ['genre', 'rule', 'level', 'scope', 'TP', 'FP', 'FN', 'precision', 'recall', 'false-positive rate'],
      r.rules.map((x) => [x.genre, x.rule, String(x.level), x.scope, x.tp, x.fp, x.fn, formatRatio(x.precision), formatRatio(x.recall), formatRatio(x.fpRate)]),
    ),
    '',
    '## False positives, one by one',
    '',
    'Sentence 0 is the whole text. "on slop" says the sentence is labelled slop for another rule or for no rule yet.',
    '',
    ...(r.falsePositives.length === 0
      ? ['None.']
      : table(
          ['genre', 'text', 'sentence', 'rule', 'level', 'on slop'],
          r.falsePositives.map((f) => [f.genre, f.item, f.sentence, f.rule, f.level, f.onSlop ? 'yes' : 'no']),
        )),
    '',
    '## guessGenre',
    '',
    `${r.guessCases} texts, the labelled set and ${r.extraGuessCases} fictional cover letters from \`slop-lint/fixtures/cover-letters/\`. Rows are the true genre, columns the guess at the current cuts (${GUESS_CUTS.shortWords} and ${GUESS_CUTS.mailWords} words); each cell gives every guess, and in parentheses the high-confidence ones.`,
    '',
    ...table(
      ['true \\ guessed', ...GENRES],
      GENRES.map((t) => [t, ...GENRES.map((g) => `${r.confusion[t][g].all} (${r.confusion[t][g].high})`)]),
    ),
    '',
    '"sure" counts a right guess with high confidence. With `--genre auto` a low guess falls back to cover-letter, so a right but low guess is lost. The short cut decides when a text can be a chat. The mail cut decides when a greeting and a sign-off make a mail, and when a follow-up without a subject line is still a sure guess.',
    '',
    ...table(
      ['short cut', 'mail cut', 'accuracy', 'sure', ...GENRES.map((g) => `sure ${g}`)],
      r.grid.map((g) => [
        g.current ? `**${g.cuts.shortWords}**` : g.cuts.shortWords,
        g.current ? `**${g.cuts.mailWords}**` : g.cuts.mailWords,
        formatRatio(g.accuracy),
        formatRatio(g.sure),
        ...GENRES.map((genre) => formatRatio(g.surePerGenre[genre])),
      ]),
    ),
    '',
    'The current cuts are in bold.',
    '',
  ];
  return lines.join('\n');
}

/** The six labelled files, parsed and validated; throws with every problem when one is invalid. */
export function loadSets(dir: string): LabeledSet[] {
  const errors: string[] = [];
  const sets: LabeledSet[] = [];
  for (const genre of LABELED_GENRES) {
    for (const lang of LANGS) {
      const file = `${genre}/${lang}.json`;
      const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const problems = validateSet(raw, file);
      if (isObject(raw) && (raw.genre !== genre || raw.lang !== lang)) problems.push(`${file}: genre and lang must match the path`);
      errors.push(...problems);
      if (problems.length === 0) sets.push(raw as LabeledSet);
    }
  }
  if (errors.length > 0) throw new Error(`Invalid labelled set:\n${errors.join('\n')}`);
  return sets;
}

/** The fictional cover letters, as cover-letter cases for guessGenre. */
export function loadCoverLetters(dir: string): GuessCase[] {
  const letters = join(dir, 'cover-letters');
  return readdirSync(letters)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => ({ id: `cover-letter/${f}`, genre: 'cover-letter' as const, text: readFileSync(join(letters, f), 'utf8') }));
}

/** The report for the fixtures folder `dir`: the labelled sets under it and its cover-letters/. */
export function report(dir: string): string {
  return toMarkdown(evaluate(loadSets(dir), loadCoverLetters(dir)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (dir === undefined) {
    process.stderr.write('Usage: node slop-lint/scripts/genre-eval.ts <fixtures folder>\n');
    process.exit(2);
  }
  process.stdout.write(report(dir));
}
