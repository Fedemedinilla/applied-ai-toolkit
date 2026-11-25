/**
 * The voice profile of design 4.5, measured by code with no model: how the writer addresses the
 * reader, punctuation and accents, emoji, sentence length, greeting and sign-off, contractions and
 * the initial capital. It goes into the prompt as data ("usa voseo; no usa ¿¡"), never as
 * adjectives, and after a rewrite it is a check: the rewrite does not add what the original lacks,
 * except what the genre itself asks for.
 *
 * Pure: no I/O, no model, no gateway.
 */
import type { Genre, Lang, Variety } from './types.ts';

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
 * The tuteo forms that are also voseo without its accent ("sabes", "haces", "necesitas") are kept
 * apart in AMBIGUOUS: a profile has to read a rioplatense WhatsApp written without tildes.
 */
const VOSEO = words([
  'querés', 'podés', 'tenés', 'sabés', 'sos', 'hacés', 'decís', 'venís', 'pensás', 'necesitás',
  'contame', 'escribime', 'mirá', 'fijate', 'avisame', 'decime', 'vos',
]);
const TUTEO = words([
  'quieres', 'puedes', 'tienes', 'eres', 'dices', 'vienes', 'piensas',
  'cuéntame', 'escríbeme', 'fíjate', 'avísame', 'dime', 'tú', 'contigo',
]);
/**
 * Forms that are tuteo with their accent left out and voseo without it ("sabes" is "sabés"
 * written the way a WhatsApp often is). They count for the treatment the rest of the text shows,
 * and for tuteo only in a text that writes its accents.
 */
const AMBIGUOUS = words(['sabes', 'haces', 'necesitas']);
/**
 * Usted: the pronoun, and the formulas a formal letter uses without it ("Le escribo", "Quedo a su
 * disposición", "consultarle"). The bare third-person verb forms are the same as he or she, so
 * they say nothing.
 */
const USTED = words([
  'usted', 'le escribo', 'le consulto', 'le comento', 'le agradezco', 'le agradecer[ií]a', 'le saludo', 'le saluda', 'le env[ií]o',
  'le adjunto', 'le pido', 'su disposici[oó]n', 'su respuesta', 'su consulta', 'su atenci[oó]n', 'disculpe', 'no dude',
  '(?:consultar|escribir|enviar|comentar|agradecer|contactar|informar|saludar|preguntar|pedir|adjuntar|mandar)le',
]);
const CHE = words(['che']);
/**
 * A character the reader sees as an emoji: one shown as emoji by default, a symbol turned into one
 * by its variation selector, a skin tone or a joiner ("✔️", "👍🏽"), a keycap or a flag. Plain
 * symbols ("✔", "↔", "▪") and ©, ® and ™ are marks, not emoji.
 */
const EMOJI = /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|(?![©®™])\p{Extended_Pictographic}[\uFE0F\u200D\p{Emoji_Modifier}]|(?![©®™])\p{Emoji_Presentation})/u;
const SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });
const emojiCount = (text: string): number => [...SEGMENTER.segment(text)].filter((g) => EMOJI.test(g.segment)).length;
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
  const accents = count(text, ACCENT);
  const sure = { voseo: es ? count(text, VOSEO) : 0, tuteo: es ? count(text, TUTEO) : 0 };
  const ambiguous = es ? count(text, AMBIGUOUS) : 0;
  // An unaccented "sabes" follows the unambiguous forms; alone, it is tuteo only where the writer uses accents.
  const toVoseo = sure.voseo > 0 && sure.tuteo === 0;
  const toTuteo = (sure.tuteo > 0 && sure.voseo === 0) || (sure.voseo === 0 && sure.tuteo === 0 && accents > 0);
  const voseo = sure.voseo + (toVoseo ? ambiguous : 0);
  const tuteo = sure.tuteo + (toTuteo ? ambiguous : 0);
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
      accents,
      emoji: emojiCount(text),
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

export type VoiceTrait = 'treatment' | 'variety' | 'inverted-marks' | 'accents' | 'emoji' | 'che' | 'contractions' | 'initial-capital';

export interface VoiceViolation {
  readonly kind: VoiceTrait;
  readonly message: string;
}

/**
 * What a genre asks for even when the writer left it out (design 4.5: "lo que el género exige, por
 * ejemplo mayúscula inicial en un mail en inglés"). A mail, a follow-up and a cover letter follow
 * standard spelling, so an initial capital, Spanish accents and ¿¡ may be added there; a WhatsApp
 * keeps the writer's own.
 */
export const GENRE_REQUIRES: Readonly<Record<Genre, readonly VoiceTrait[]>> = {
  'cover-letter': ['initial-capital', 'accents', 'inverted-marks'],
  email: ['initial-capital', 'accents', 'inverted-marks'],
  'follow-up': ['initial-capital', 'accents', 'inverted-marks'],
  whatsapp: [],
};

export interface VoiceContext {
  readonly genre: Genre;
  readonly lang: Lang;
  /** The Spanish variety the input names. A rioplatense text that addressed no one may start using voseo. */
  readonly variety?: Variety;
}

/**
 * Marks of Spain's Spanish that a rioplatense or neutral American text does not use: vosotros and
 * os, the vosotros verb endings -áis and -éis (voseo ends in -ás, -és and -ís, never in these), sois
 * and vais, and a few words with an everyday American equivalent. "vale" stays out: "¿cuánto vale?"
 * is everyday rioplatense.
 */
const SPAIN = [
  /(?<!\p{L})vosotr[oa]s(?!\p{L})/giu,
  /(?<!\p{L})[Oo]s(?!\p{L})/gu,
  /(?<!\p{L})\p{L}{2,}(?:áis|éis)(?!\p{L})/giu,
  /(?<!\p{L})(?:sois|vais)(?!\p{L})/giu,
  /(?<!\p{L})(?:ordenador(?:es)?|guay|chaval(?:es)?|curro|currar|mola(?:n)?|coger|cojo|coges|coge|cogemos|cogí)(?!\p{L})/giu,
];

/** How many marks of Spain's Spanish a text has (SPAIN). */
export function spainMarks(text: string): number {
  const t = text.normalize('NFC');
  return SPAIN.reduce((n, re) => n + [...t.matchAll(re)].length, 0);
}

/**
 * What the rewrite changed of the writer's voice that must not change. Decision of 25/11/2026
 * (Federico): only the treatment and the variety are kept. A treatment the original does not use
 * (tú in a voseo text, an usted it did not use) and Spain's Spanish in a text that did not use it
 * are flagged; emoji, ¿¡, accents, "che", capitals and contractions follow the channel's guide.
 */
export function voiceViolations(original: string, rewritten: string, context: VoiceContext): VoiceViolation[] {
  if (context.lang !== 'es') return [];
  const o = voiceProfile(original, context.lang);
  const r = voiceProfile(rewritten, context.lang);
  const found: VoiceViolation[] = [];
  // A treatment the original does not use is added voice, also in a text that addressed no one.
  for (const t of ['voseo', 'tuteo', 'usted'] as const) {
    // Speaking to the reader is what a message to them does; in rioplatense that is voseo.
    if (t === 'voseo' && o.treatment === 'none' && context.variety === 'rioplatense') continue;
    if (o.counts[t] === 0 && r.counts[t] > 0) {
      const before = o.treatment === 'none' ? 'The original addresses no one directly' : `The original uses ${o.treatment}`;
      found.push({ kind: 'treatment', message: `${before}; the rewrite adds ${t}.` });
      break;
    }
  }
  if (spainMarks(original) === 0 && spainMarks(rewritten) > 0) found.push({ kind: 'variety', message: "The original does not write Spain's Spanish; the rewrite adds vosotros, its verbs or its words." });
  return found;
}

const SPAIN_LINE = 'Nada de vosotros, os, verbos en -áis o -éis ni palabras de España (ordenador, coger).';

/**
 * What the prompt asks the model to keep of the writer's voice (decision of 25/11/2026): the
 * treatment and the variety, nothing else. The lines are data, in the language of the text.
 */
export function voiceKeepLines(p: VoiceProfile, variety: Variety | undefined): string[] {
  if (p.lang !== 'es') return ['English: no treatment or variety to keep.'];
  const c = p.counts;
  const treatment: Record<Treatment, string> = {
    voseo: 'tratamiento: voseo. No lo cambies a tú ni a usted.',
    tuteo: 'tratamiento: tuteo. No lo cambies a vos ni a usted.',
    usted: 'tratamiento: usted. No lo cambies a tú ni a vos.',
    mixed: `tratamiento: mezcla (voseo ${c.voseo}, tuteo ${c.tuteo}, usted ${c.usted}). No sumes uno que no esté.`,
    none: variety === 'rioplatense' ? 'tratamiento: ninguno. Si le hablás al lector, usá voseo; nunca tú ni usted.' : 'tratamiento: ninguno. No agregues tú, vos ni usted.',
  };
  const name = variety === undefined ? 'no indicada' : variety === 'rioplatense' ? 'rioplatense' : 'neutra';
  return [treatment[p.treatment], `variedad: ${name}. ${SPAIN_LINE}`];
}
