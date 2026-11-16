/**
 * The voice profile of design 4.5, measured by code with no model: how the writer addresses the
 * reader, punctuation and accents, emoji, sentence length, greeting and sign-off, contractions and
 * the initial capital. It goes into the prompt as data ("usa voseo; no usa ¿¡"), never as
 * adjectives, and after a rewrite it is a check: the rewrite does not add what the original lacks,
 * except what the genre itself asks for.
 *
 * Pure: no I/O, no model, no gateway.
 */
import type { Genre, Lang } from './types.ts';

/**
 * Word boundaries that know accented letters, as slop-lint/src/regex.ts defines them. JavaScript's
 * \b only knows ASCII, so /podés\b/ would not end where the word does.
 */
const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}\p{M}])`;
const words = (list: readonly string[]): RegExp => new RegExp(`${B}(?:${list.join('|')})${E}`, 'giu');

/**
 * Local copies of slop-lint's VOSEO and TUTEO (slop-lint/src/rules.ts), plus the pronouns. slop-lint
 * exports them from rules.ts only, which is not on the public surface prose-rewriter may import
 * (import-fences/repo.config.ts, LIBRARY_USES), so they are copied here instead of fenced through.
 */
const VOSEO = words([
  'querés', 'podés', 'tenés', 'sabés', 'sos', 'hacés', 'decís', 'venís', 'pensás', 'necesitás',
  'contame', 'escribime', 'mirá', 'fijate', 'avisame', 'decime', 'vos',
]);
const TUTEO = words([
  'quieres', 'puedes', 'tienes', 'sabes', 'eres', 'haces', 'dices', 'vienes', 'piensas', 'necesitas',
  'cuéntame', 'escríbeme', 'fíjate', 'avísame', 'dime', 'tú', 'contigo',
]);
/** Only the pronoun: the third-person verb forms of usted are the same as he or she, so they say nothing. */
const USTED = words(['usted']);
const CHE = words(['che']);
/** Pictographs, without ©, ® and ™, which a business text writes as signs, not as emoji. */
const EMOJI = /(?![©®™])\p{Extended_Pictographic}/gu;
const ACCENT = /[áéíóúü]/giu;
/** n't, 're, 've, 'll, 'm, 'd, and 's only after the words where it is "is" or "us", not a possessive. */
const CONTRACTION = new RegExp(
  `${B}(?:\\p{L}+n['’]t|\\p{L}+['’](?:re|ve|ll|m|d)|(?:it|that|there|here|what|who|where|he|she|let)['’]s)${E}`,
  'giu',
);
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

const GREETING = /^(?:hola|buen(?:os|as)? (?:días|dias|tardes|noches)|buen día|buen dia|estimad[oa]s?|querid[oa]s?|hi|hello|hey|dear|good (?:morning|afternoon|evening))(?![\p{L}])/iu;
const SIGN_OFF =
  /^(?:saludos|un saludo|un abrazo|abrazos?|besos?|gracias|muchas gracias|atentamente|cordialmente|best|regards|best regards|kind regards|warm regards|thanks|thank you|cheers|sincerely)(?![\p{L}])/iu;
/** A greeting or sign-off line is short; a long line that starts with "hola" or "gracias" is body text. */
const FRAME_MAX_WORDS = 4;

export type Treatment = 'voseo' | 'tuteo' | 'usted' | 'mixed' | 'none';

export interface VoiceProfile {
  readonly lang: Lang;
  /** Spanish only; 'none' in English and in a Spanish text that addresses nobody. */
  readonly treatment: Treatment;
  readonly counts: {
    readonly voseo: number;
    readonly tuteo: number;
    readonly usted: number;
    /** ¿ and ¡. */
    readonly invertedMarks: number;
    /** ? and !. */
    readonly closingMarks: number;
    readonly accents: number;
    readonly emoji: number;
    readonly che: number;
    readonly contractions: number;
  };
  /** Sentences of the body: the greeting and sign-off lines are not counted. */
  readonly sentences: number;
  /** Words per body sentence, rounded to one decimal. */
  readonly meanSentenceWords: number;
  /** Population standard deviation of words per body sentence, rounded to one decimal. */
  readonly sentenceWordsSpread: number;
  readonly greeting: boolean;
  readonly signOff: boolean;
  /** The first letter of the text is upper case. */
  readonly initialCapital: boolean;
}

const count = (text: string, re: RegExp): number => [...text.matchAll(re)].length;
const wordCount = (text: string): number => count(text, WORD);
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** A greeting line ("Hola Marta,", "Dear Priya,"): it opens with a greeting and is short. */
export function isGreetingLine(line: string): boolean {
  const trimmed = line.trim();
  return GREETING.test(trimmed) && wordCount(trimmed) <= FRAME_MAX_WORDS;
}

/** A sign-off line ("Saludos,", "Best regards,"): it opens with a sign-off and is short. */
export function isSignOffLine(line: string): boolean {
  const trimmed = line.trim();
  return SIGN_OFF.test(trimmed) && wordCount(trimmed) <= FRAME_MAX_WORDS;
}

/** Of a text's non-blank lines, the one where the sign-off starts: one of the last two, after a greeting. */
export function signOffIndex(lines: readonly string[], afterGreeting: boolean): number {
  // The sign-off is one of the last two lines ("Saludos," then a name), and the rest is the signature.
  let signOffAt = -1;
  for (let i = lines.length - 1; i >= Math.max(lines.length - 2, afterGreeting ? 1 : 0); i--) {
    if (isSignOffLine(lines[i] ?? '')) signOffAt = i;
  }
  return signOffAt;
}

function frame(text: string): { greeting: boolean; signOff: boolean; body: string } {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const first = lines[0]?.trim() ?? '';
  const greetingLine = isGreetingLine(first);
  const greeting = GREETING.test(first);
  const signOffAt = signOffIndex(lines, greetingLine);
  const body = lines.slice(greetingLine ? 1 : 0, signOffAt === -1 ? lines.length : signOffAt).join('\n');
  return { greeting, signOff: signOffAt !== -1, body };
}

/** Sentences end at . ! ? … followed by space or the end, and at every line break. */
function sentenceLengths(body: string): number[] {
  return body
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map(wordCount)
    .filter((n) => n > 0);
}

function treatmentOf(voseo: number, tuteo: number, usted: number): Treatment {
  const used = [voseo > 0 && 'voseo', tuteo > 0 && 'tuteo', usted > 0 && 'usted'].filter((t) => t !== false);
  if (used.length === 0) return 'none';
  if (used.length > 1) return 'mixed';
  return used[0] as Treatment;
}

export function voiceProfile(source: string, lang: Lang): VoiceProfile {
  const text = source.normalize('NFC');
  const es = lang === 'es';
  const voseo = es ? count(text, VOSEO) : 0;
  const tuteo = es ? count(text, TUTEO) : 0;
  const usted = es ? count(text, USTED) : 0;
  const { greeting, signOff, body } = frame(text);
  const lengths = sentenceLengths(body);
  const mean = lengths.length === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.length === 0 ? 0 : lengths.reduce((a, n) => a + (n - mean) ** 2, 0) / lengths.length;
  const firstLetter = /\p{L}/u.exec(text)?.[0];
  return {
    lang,
    treatment: treatmentOf(voseo, tuteo, usted),
    counts: {
      voseo,
      tuteo,
      usted,
      invertedMarks: count(text, /[¿¡]/gu),
      closingMarks: count(text, /[?!]/gu),
      accents: count(text, ACCENT),
      emoji: count(text, EMOJI),
      che: es ? count(text, CHE) : 0,
      contractions: es ? 0 : count(text, CONTRACTION),
    },
    sentences: lengths.length,
    meanSentenceWords: round1(mean),
    sentenceWordsSpread: round1(Math.sqrt(variance)),
    greeting,
    signOff,
    initialCapital: firstLetter !== undefined && firstLetter !== firstLetter.toLowerCase(),
  };
}

/** One decimal, with the decimal comma in Spanish. */
const num = (n: number, lang: Lang): string => (lang === 'es' ? String(n).replace('.', ',') : String(n));

/** The profile as prompt lines in the text's language: what the writer does, with the number beside it. */
export function voicePromptLines(p: VoiceProfile): string[] {
  const c = p.counts;
  if (p.lang === 'es') {
    const treatment: Record<Treatment, string | null> = {
      voseo: 'usa voseo',
      tuteo: 'usa tuteo',
      usted: 'trata de usted',
      mixed: `mezcla tratamientos (voseo ${c.voseo}, tuteo ${c.tuteo}, usted ${c.usted})`,
      none: null,
    };
    return [
      treatment[p.treatment],
      c.invertedMarks > 0 ? `usa ¿¡ (${c.invertedMarks})` : 'no usa ¿¡',
      c.accents > 0 ? `usa tildes (${c.accents})` : 'no usa tildes',
      c.emoji > 0 ? `usa emoji (${c.emoji})` : 'no usa emoji',
      c.che > 0 ? `dice "che" (${c.che})` : 'no dice "che"',
      p.sentences > 0 ? `oraciones de ${num(p.meanSentenceWords, 'es')} palabras en promedio (desvío ${num(p.sentenceWordsSpread, 'es')})` : null,
      p.greeting ? 'abre con saludo' : 'no abre con saludo',
      p.signOff ? 'cierra con despedida' : 'no cierra con despedida',
      p.initialCapital ? 'empieza con mayúscula' : 'empieza en minúscula',
    ].filter((line) => line !== null);
  }
  return [
    c.contractions > 0 ? `uses contractions (${c.contractions})` : 'uses no contractions',
    c.emoji > 0 ? `uses emoji (${c.emoji})` : 'uses no emoji',
    p.sentences > 0 ? `sentences of ${num(p.meanSentenceWords, 'en')} words on average (spread ${num(p.sentenceWordsSpread, 'en')})` : null,
    p.greeting ? 'opens with a greeting' : 'opens with no greeting',
    p.signOff ? 'closes with a sign-off' : 'closes with no sign-off',
    p.initialCapital ? 'starts with a capital letter' : 'starts with a lower-case letter',
  ].filter((line) => line !== null);
}

export type VoiceTrait = 'treatment' | 'inverted-marks' | 'accents' | 'emoji' | 'che' | 'contractions' | 'initial-capital';

export interface VoiceViolation {
  readonly kind: VoiceTrait;
  readonly message: string;
}

/**
 * What a genre asks for even when the writer left it out (design 4.5: "lo que el género exige, por
 * ejemplo mayúscula inicial en un mail en inglés"). A mail, a follow-up and a cover letter follow
 * standard spelling, so an initial capital and Spanish accents may be added there; a WhatsApp
 * keeps the writer's own.
 */
export const GENRE_REQUIRES: Readonly<Record<Genre, readonly VoiceTrait[]>> = {
  'cover-letter': ['initial-capital', 'accents'],
  email: ['initial-capital', 'accents'],
  'follow-up': ['initial-capital', 'accents'],
  whatsapp: [],
};

export interface VoiceContext {
  readonly genre: Genre;
  readonly lang: Lang;
}

/** The traits the rewrite added that the original lacked, minus what the genre requires. */
export function voiceViolations(original: string, rewritten: string, context: VoiceContext): VoiceViolation[] {
  const o = voiceProfile(original, context.lang);
  const r = voiceProfile(rewritten, context.lang);
  const found: VoiceViolation[] = [];
  const added = (kind: VoiceTrait, before: number, after: number, message: string): void => {
    if (before === 0 && after > 0) found.push({ kind, message });
  };
  if (context.lang === 'es') {
    // A new treatment only counts against a text that addressed the reader: "none" has no voice to break.
    if (o.treatment !== 'none') {
      for (const t of ['voseo', 'tuteo', 'usted'] as const) {
        if (o.counts[t] === 0 && r.counts[t] > 0) {
          found.push({ kind: 'treatment', message: `The original uses ${o.treatment}; the rewrite adds ${t}.` });
          break;
        }
      }
    }
    added('inverted-marks', o.counts.invertedMarks, r.counts.invertedMarks, 'The original does not use ¿ or ¡; the rewrite adds them.');
    added('accents', o.counts.accents, r.counts.accents, 'The original is written without accents; the rewrite adds them.');
  }
  added('emoji', o.counts.emoji, r.counts.emoji, 'The original has no emoji; the rewrite adds them.');
  if (context.lang === 'es') added('che', o.counts.che, r.counts.che, 'The original does not say "che"; the rewrite adds it.');
  if (context.lang === 'en') added('contractions', o.counts.contractions, r.counts.contractions, 'The original uses no contractions; the rewrite adds them.');
  if (!o.initialCapital && r.initialCapital) found.push({ kind: 'initial-capital', message: 'The original starts in lower case; the rewrite capitalizes it.' });
  const allowed = GENRE_REQUIRES[context.genre];
  return found.filter((v) => !allowed.includes(v.kind));
}
