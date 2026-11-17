/**
 * Genre profiles: what each kind of text changes from the catalog, in one table, so the 52 rules
 * in rules.ts stay as they are and every per-genre choice is reviewed in one place.
 *
 * The cover-letter profile is the catalog with today's thresholds; test/genres.test.ts checks it
 * against the constants in structural.ts and rules.ts so the two cannot drift apart. The other
 * profiles are experimental: no labelled set has measured their false positives yet, so every
 * number they leave at the cover-letter value is still to be measured, not a calibrated choice.
 */
import { messageFor } from './messages.ts';
import { ruleById } from './rules.ts';
import type { StructuralThresholds } from './structural.ts';
import type { Genre, GenreSetting, PatternRule, Rule } from './types.ts';

export interface GenreProfile {
  /** Per rule id. A rule left out keeps its catalog setting. */
  rules: Readonly<Partial<Record<string, GenreSetting>>>;
  /**
   * Catalog rules this genre runs as several rules, by the catalog id. The first part keeps the
   * id; a config setting for that id applies to every part, except a part whose own id the config
   * also sets (SPLIT_PART_IDS).
   */
  splits?: Readonly<Partial<Record<string, readonly Rule[]>>>;
  /** Rules of GENRE_RULES this genre runs, after the catalog's. A config setting for their id applies. */
  adds?: readonly Rule[];
  /** The shared Tier 2 budget per text. */
  tier2Budget: number;
  thresholds: StructuralThresholds;
  /** True until a labelled set measures the profile's false positives. */
  experimental: boolean;
}

export const GENRES: readonly Genre[] = ['cover-letter', 'email', 'follow-up', 'whatsapp'];

export const DEFAULT_GENRE: Genre = 'cover-letter';

const COVER_LETTER: GenreProfile = {
  rules: {},
  tier2Budget: 2,
  thresholds: {
    longSentence: { en: 35, es: 40 },
    minSentencesForRhythm: 8,
    minRhythmCV: 0.25,
    wordsPerAnchor: 35,
    wordsPerNominalization: 12,
    minWordsForNominalization: 24,
    colonBudget: 2,
    asideBudget: 1,
    emDashBudget: 1,
    menteBudget: 2,
    openingMarksFollowText: false,
  },
  experimental: false,
};

/** The rules every new genre turns off: an early question is usually the request, and a gap apology is a letter's. */
const NOT_A_LETTER: Readonly<Record<string, GenreSetting>> = {
  'EST-06': 'off',
  'CAR-03': 'off',
};

const FMT_01 = ruleById('FMT-01');

/** The rules of GENRE_RULES that email and follow-up run. */
const MAIL_RULES: readonly Rule[] = ['MAIL-01', 'MAIL-02', 'MAIL-03', 'MAIL-04'].map(ruleById);
const MARKUP = String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}[ \t]`;
const LIST_ITEM = String.raw`^[ \t]*(?:[-*•]|\d+[.)])[ \t]+`;

/**
 * A mail can hold a short list, so in email and follow-up FMT-01 keeps bold and headings at
 * level 1 and its list items become FMT-01-LIST at level 2. The two patterns joined are the
 * catalog's, which test/genres.test.ts checks.
 */
const FMT_01_IN_A_MAIL: readonly Rule[] =
  FMT_01.kind === 'pattern'
    ? [
        { ...FMT_01, patterns: { en: MARKUP, es: MARKUP }, examples: [{ lang: 'en', fire: 'I use **Python** daily.', pass: 'I use Python daily.' }] },
        {
          ...FMT_01,
          id: 'FMT-01-LIST',
          name: 'List in a plain-text mail',
          level: 2,
          severity: 'medium',
          patterns: { en: LIST_ITEM, es: LIST_ITEM },
          message: 'List in a plain-text mail. A short one reads fine; a long one reads as a report.',
          suggestion: 'Keep it to a few items, or write them as a sentence.',
          examples: [{ lang: 'es', fire: '- Power BI\n- SQL', pass: 'Power BI y SQL.' }],
        },
      ]
    : [FMT_01];

export const GENRE_PROFILES: Readonly<Record<Genre, GenreProfile>> = {
  'cover-letter': COVER_LETTER,
  email: {
    rules: { ...NOT_A_LETTER, 'EST-09': { severity: 'low' } },
    splits: { 'FMT-01': FMT_01_IN_A_MAIL },
    adds: MAIL_RULES,
    tier2Budget: COVER_LETTER.tier2Budget,
    thresholds: COVER_LETTER.thresholds,
    experimental: true,
  },
  'follow-up': {
    // Quoting the earlier message is what a follow-up is for, so process narration is off.
    rules: { ...NOT_A_LETTER, 'EST-09': 'off', 'EST-11': 'off' },
    splits: { 'FMT-01': FMT_01_IN_A_MAIL },
    adds: [...MAIL_RULES, ruleById('SEG-03')],
    tier2Budget: COVER_LETTER.tier2Budget,
    thresholds: COVER_LETTER.thresholds,
    experimental: true,
  },
  whatsapp: {
    rules: {
      ...NOT_A_LETTER,
      // A chat has almost no anchors, so the rules that ask for them are off.
      'LEX-07': 'off',
      'LEX-08': 'off',
      'OFI-01': 'off',
      'ESP-02': 'off',
      'EST-05': 'off',
      'RET-01': 'off',
      'EST-09': { severity: 'low' },
      'EST-11': 'off',
      // FMT-01 and FMT-02 are off as findings; WA-03 reports emoji used as bullets; WA-01 (`**` and `#`) is not implemented yet.
      'FMT-01': 'off',
      'FMT-02': 'off',
      'ORT-02': 'off',
      'SIN-05': { severity: 'low' },
      'SIN-06': { severity: 'low' },
      'SIN-07': { severity: 'low' },
      'SIN-08': { severity: 'low' },
      'SIN-11': { severity: 'low' },
      'SIN-EN-06': { severity: 'low' },
      // REG-01 keeps its default severity, high: a voseo and tuteo mix is flagged without voiding the message.
    },
    // A mail's stock formula is further out of place in a chat.
    adds: [ruleById('MAIL-04'), ruleById('WA-03')],
    tier2Budget: COVER_LETTER.tier2Budget,
    thresholds: { ...COVER_LETTER.thresholds, openingMarksFollowText: true },
    experimental: true,
  },
};

/**
 * The ids of the parts a genre adds when it splits a catalog rule, such as FMT-01-LIST. A config
 * may name them under ruleSettings; in a genre that does not split the rule they change nothing.
 */
export const SPLIT_PART_IDS: readonly string[] = [
  ...new Set(Object.values(GENRE_PROFILES).flatMap((p) => Object.entries(p.splits ?? {}).flatMap(([id, parts]) => (parts ?? []).map((r) => r.id).filter((partId) => partId !== id)))),
];

export function isGenre(value: unknown): value is Genre {
  return typeof value === 'string' && (GENRES as readonly string[]).includes(value);
}

/** One rule with a genre setting applied; undefined when the setting turns it off. Exported for tests. */
export function applySetting(rule: Rule, setting: GenreSetting | undefined): Rule | undefined {
  if (setting === 'off') return undefined;
  if (setting === undefined) return rule;
  const changed = { ...rule, level: setting.level ?? rule.level, severity: setting.severity ?? rule.severity };
  if (changed.kind !== 'pattern') return changed;
  const weaker = changed.weaker && setting.severity !== undefined ? { weaker: { ...changed.weaker, severity: setting.severity } } : {};
  return { ...changed, ...weaker, ...(setting.budget === undefined ? {} : { budget: setting.budget }) };
}

/** The rules a catalog rule runs as in this genre: itself, or its parts when the profile splits it. */
export function splitRule(rule: Rule, genre: Genre = DEFAULT_GENRE): readonly Rule[] {
  return GENRE_PROFILES[genre].splits?.[rule.id] ?? [rule];
}

/** The rules a genre runs on top of the catalog, from GENRE_RULES. None for a cover letter. */
export function addedRules(genre: Genre = DEFAULT_GENRE): readonly Rule[] {
  return GENRE_PROFILES[genre].adds ?? [];
}

/**
 * The rules with a genre's profile applied: the ones set to "off" dropped, the others cloned with
 * the profile's level, severity, budget and message, and the genre's own rules (addedRules) after
 * them unless the list already holds their id. Structural budgets are not set here; they travel in
 * the profile's thresholds. A rule the profile does not name is returned as it is, so
 * 'cover-letter' returns the same rule objects.
 */
export function resolveRules(rules: readonly Rule[], genre: Genre = DEFAULT_GENRE): Rule[] {
  const profile = GENRE_PROFILES[genre];
  const ids = new Set(rules.map((r) => r.id));
  return [...rules, ...addedRules(genre).filter((r) => !ids.has(r.id))].flatMap((rule) =>
    splitRule(rule, genre).flatMap((part) => {
      const applied = applySetting(part, profile.rules[part.id] ?? profile.rules[rule.id]);
      if (applied === undefined) return [];
      const message = messageFor(applied, genre);
      return [message === applied.message ? applied : { ...applied, message }];
    }),
  );
}

export interface GenreGuess {
  genre: Genre;
  confidence: 'high' | 'low';
  /** The signals seen, in the order they were checked. */
  signals: string[];
}

const SUBJECT = /^(?:asunto|subject)\s*:/imu;
// Only phrases that point back to a message: a bare "follow up" is something a cover letter promises too.
const PREVIOUS = /\b(?:te escribí el|le escribí el|te escribí la semana|I wrote to you on|following up on (?:my|our)|as I mentioned in my (?:last|previous)|retomo (?:el|mi) (?:mail|mensaje))|^(?:asunto|subject)\s*:\s*(?:re|rv)\s*:/imu;
const GREETING = /^(?:hola|estimad[oa]s?|buen(?:os|as) (?:días|tardes|noches)|dear|hi|hello)\b[^\n]{0,40}[,:]?\s*$/imu;
const SIGN_OFF = /^(?:saludos(?: cordiales)?|un saludo|atentamente|gracias|best(?: regards)?|regards|kind regards|thanks|cheers),?\s*$/imu;
const EMOJI = /(?![©®™])\p{Extended_Pictographic}/u;

/**
 * A guess at the genre, from the subject line, a reference to an earlier message, the greeting
 * and sign-off of a mail, the length, emoji and lines that end without a period. lint() never
 * calls it: a wrong guess would turn rules off without a word, so the genre stays explicit and
 * this is for `--genre auto` and for tools that show the guess and ask.
 */
export function guessGenre(text: string): GenreGuess {
  return guessGenreWith(text, GUESS_CUTS);
}

/** The word counts guessGenre cuts at. Not calibrated: scripts/genre-eval.ts measures them on the labelled set. */
export interface GuessCuts {
  /** Under this many words a text can be a chat message. */
  shortWords: number;
  /** Under this many words a text with a greeting and a sign-off reads as a mail, not a letter. */
  mailWords: number;
}

export const GUESS_CUTS: Readonly<GuessCuts> = { shortWords: 60, mailWords: 150 };

/** guessGenre with other cuts, so scripts/genre-eval.ts can compare them. Not part of the package entry. */
export function guessGenreWith(text: string, cuts: Readonly<GuessCuts>): GenreGuess {
  const signals: string[] = [];
  const wordCount = text.split(/\s+/u).filter(Boolean).length;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const subject = SUBJECT.test(text);
  if (subject) signals.push('subject line');
  const previous = PREVIOUS.test(text);
  if (previous) signals.push('reference to an earlier message');
  const greeting = GREETING.test(text);
  if (greeting) signals.push('greeting');
  const signOff = SIGN_OFF.test(text);
  if (signOff) signals.push('mail sign-off');
  const emoji = EMOJI.test(text);
  if (emoji) signals.push('emoji');
  const unpunctuated = lines.filter((l) => !/[.!?:…]$/u.test(l)).length;
  const chatLines = lines.length > 0 && unpunctuated * 2 > lines.length;
  if (chatLines) signals.push('lines without a closing period');
  const short = wordCount < cuts.shortWords;
  if (short) signals.push(`${wordCount} words`);

  // A letter can mention an earlier application too, so a long text needs a subject line to be sure.
  if (previous) return { genre: 'follow-up', confidence: subject || ((greeting || signOff) && wordCount < cuts.mailWords) ? 'high' : 'low', signals };
  if (subject) return { genre: 'email', confidence: 'high', signals };
  if (short && (emoji || chatLines) && !signOff) return { genre: 'whatsapp', confidence: emoji && chatLines ? 'high' : 'low', signals };
  // A cover letter has a greeting and a sign-off too; it is longer than most mails.
  if (greeting && signOff && wordCount < cuts.mailWords) return { genre: 'email', confidence: 'low', signals };
  return { genre: DEFAULT_GENRE, confidence: wordCount >= cuts.mailWords && !emoji ? 'high' : 'low', signals };
}
