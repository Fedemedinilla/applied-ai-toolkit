/**
 * The fact check of design 4.6, the part code can see: the facts a text states (numbers with their
 * unit, amounts, dates, times, emails, URLs, phones, proper nouns, acronyms, tools and the profile's
 * anchors), the inventory of the original against the CV and the recipient, the rules each edit
 * passes or is reverted by, and the invariant O ⊆ R ⊆ O ∪ C over the whole rewrite.
 *
 * O is the user's original, C the CV plus the recipient plus the profile's extraFacts, R the
 * rewrite. Claims in words ("I led a team") carry no fact this module can read; the line-by-line
 * judge of F5 sees those.
 *
 * Pure: no I/O, no model, no gateway.
 */
import { extractAnchors } from '../../slop-lint/src/lint.ts';
import { asTime, SPECIFIC_PATTERNS } from './specifics.ts';
import type { Edit, FactReport, Flag, Lang } from './types.ts';

export const FACT_KINDS = [
  'number', 'amount', 'date', 'time', 'email', 'url', 'phone', 'proper-noun', 'acronym', 'tool', 'anchor',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** One fact as the text writes it, where it sits, and its normalized key, which is what is compared. */
export interface Fact {
  readonly kind: FactKind;
  readonly text: string;
  readonly key: string;
  readonly start: number;
  readonly end: number;
  /**
   * A capitalized first word of a sentence that nothing else shows to be a name: it may be a name
   * ("Google me pidió") or an ordinary word. Only read with ExtractOptions.openings, and compared
   * as a word in any case, so the same word in lower case anywhere backs it.
   */
  readonly opening?: true;
}

export interface ExtractOptions {
  readonly lang: Lang;
  /** The profile's anchors (RewriteInput.profile.anchors): terms that count as facts. */
  readonly anchors?: readonly string[];
  /**
   * Keys of names read elsewhere (in O, C or the other side of an edit). A sentence's first word
   * with one of these keys is a name there too. The names the text itself states mid-sentence
   * always count.
   */
  readonly knownNames?: ReadonlySet<string>;
  /** Also read an unknown capitalized first word as a possible name (Fact.opening). */
  readonly openings?: boolean;
}

/** What C is made of, kept apart so the inventory can tell a CV fact from one about the recipient. */
export interface FactSources {
  readonly cv: string;
  readonly recipient?: readonly string[];
  readonly extraFacts?: readonly string[];
}

const { TIME, EMAIL, URL_LIKE, NUMBER, PLACEHOLDER_ANY } = SPECIFIC_PATTERNS;

/** Word boundaries that know accented letters, as slop-lint/src/regex.ts defines them. */
const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}\p{M}])`;
const NUM = String.raw`\d+(?:[.,]\d+)*`;
const escape = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');

const CURRENCY: Readonly<Record<string, string>> = {
  'us$': 'USD', 'u$s': 'USD', usd: 'USD', 'dólares': 'USD', dolares: 'USD', dollars: 'USD',
  ars: 'ARS', pesos: 'ARS', eur: 'EUR', '€': 'EUR', euros: 'EUR', $: '$',
};
const AMOUNT_BEFORE = new RegExp(String.raw`(?<![\p{L}\p{N}])(US\$|U\$S|u\$s|USD|ARS|EUR|€|\$)\s?(${NUM})`, 'gu');
const AMOUNT_AFTER = new RegExp(String.raw`(${NUM})\s?(USD|ARS|EUR|€|dólares|dolares|dollars|pesos|euros)${E}`, 'giu');
/** A run of digits with separators long enough to be a phone (9 digits or more, checked below). */
const PHONE = /\+?\d[\d ().-]{7,}\d/gu;

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_EN = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/**
 * Frequent first words of a sentence that are never a name: articles, pronouns, prepositions,
 * conjunctions, adverbs, greetings and the verbs job-search texts open with. A capitalized first
 * word outside these lists, and without a verb or adverb ending, is read as a possible name.
 */
const OPENERS: Readonly<Record<Lang, ReadonlySet<string>>> = {
  es: new Set([
    'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'yo', 'tú', 'vos', 'usted', 'ustedes', 'nosotros', 'nosotras', 'ellos', 'ellas', 'él', 'ella',
    'me', 'te', 'se', 'nos', 'le', 'les', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
    'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'esto', 'eso', 'aquel', 'aquella', 'ante', 'bajo', 'con', 'contra', 'de', 'del',
    'desde', 'durante', 'en', 'entre', 'hacia', 'hasta', 'mediante', 'para', 'por', 'según', 'sin', 'sobre', 'tras', 'al', 'ni', 'pero', 'sino',
    'aunque', 'porque', 'pues', 'que', 'como', 'cuando', 'donde', 'mientras', 'si', 'sí', 'no', 'ya', 'también', 'tampoco', 'además', 'así',
    'entonces', 'luego', 'después', 'antes', 'ahora', 'hoy', 'mañana', 'ayer', 'acá', 'aquí', 'allá', 'allí', 'ahí', 'muy', 'más', 'menos',
    'todo', 'todos', 'toda', 'todas', 'cada', 'otro', 'otra', 'otros', 'otras', 'algo', 'alguien', 'nada', 'nadie', 'mucho', 'muchos', 'mucha',
    'muchas', 'poco', 'pocos', 'poca', 'pocas', 'varios', 'varias', 'algún', 'alguno', 'alguna', 'algunos', 'algunas', 'ningún', 'ninguna',
    'qué', 'cómo', 'cuándo', 'dónde', 'quién', 'quiénes', 'cuál', 'cuáles', 'cuánto', 'cuántos', 'hola', 'gracias', 'saludos', 'abrazo', 'buen',
    'buenas', 'buenos', 'estimado', 'estimada', 'estimados', 'estimadas', 'querido', 'querida', 'perdón', 'disculpá', 'disculpe', 'ok', 'bueno',
    'dale', 'listo', 'che', 'atentamente', 'cordialmente', 'quiero', 'quisiera', 'tengo', 'puedo', 'busco', 'trabajo', 'soy', 'estoy', 'es',
    'son', 'está', 'están', 'hay', 'fue', 'era', 'sé', 'hice', 'hago', 'armo', 'uso', 'llevo', 'ofrezco', 'adjunto', 'escribo', 'envío', 'mando',
    'paso', 'cuento', 'agradezco', 'espero', 'creo', 'pienso', 'necesito', 'vivo', 'sigo', 'tenés', 'podés', 'querés', 'mirá', 'fijate',
    'avisame', 'contame', 'escribime', 'decime', 'recibe', 'tiene', 'puede', 'hace', 'sirve', 'incluye', 'permite',
  ]),
  en: new Set([
    'the', 'a', 'an', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that',
    'these', 'those', 'there', 'here', 'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'when', 'while', 'because', 'as', 'since', 'although',
    'though', 'then', 'also', 'however', 'still', 'now', 'today', 'tomorrow', 'yesterday', 'please', 'thanks', 'thank', 'hi', 'hello', 'hey',
    'dear', 'yes', 'no', 'not', 'in', 'on', 'at', 'by', 'for', 'from', 'to', 'with', 'without', 'of', 'about', 'after', 'before', 'during',
    'over', 'under', 'into', 'through', 'between', 'all', 'any', 'each', 'every', 'some', 'many', 'most', 'more', 'much', 'other', 'another',
    'both', 'few', 'several', 'what', 'who', 'which', 'where', 'why', 'how', 'ok', 'okay', 'well', 'best', 'kind', 'regards', 'sincerely',
    'cheers', 'is', 'are', 'was', 'were', 'am', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should',
    'may', 'might', 'must', 'let', 'one', 'just', 'only', 'even', 'again', 'yours', 'sure', 'happy', 'glad', 'looking', 'attached',
  ]),
};
/** Endings of verbs and adverbs, never of a name: "Armé", "Llegó", "buscando", "Built", "Leading", "Quickly". */
const NOT_A_NAME: Readonly<Record<Lang, RegExp>> = { es: /(?:[éó]|ando|iendo|mente)$/iu, en: /(?:ed|ing|ly)$/iu };
const FIRST_PERSON_EN = new Set(['I', "I'm", "I've", "I'd", "I'll", 'I’m', 'I’ve', 'I’d', 'I’ll']);
/** The first word of a sentence, as slop-lint's words() reads words. */
const FIRST_WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/u;

const monthOf = (name: string): number => {
  const lower = name.toLowerCase();
  const es = MONTHS_ES.indexOf(lower === 'setiembre' ? 'septiembre' : lower);
  return es >= 0 ? es + 1 : MONTHS_EN.findIndex((m) => m.toLowerCase() === lower) + 1;
};
const DATE_ISO = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/gu;
const DATE_NUMERIC = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/gu;
const DATE_ES = new RegExp(
  String.raw`${B}(?:(\d{1,2})\s+de\s+)?(${[...MONTHS_ES, 'setiembre'].join('|')})(?:\s+(?:de|del)\s+(\d{4}))?${E}`,
  'giu',
);
// English month names are read with their capital only: "may" is a verb far more often than a month.
const DATE_EN = new RegExp(
  String.raw`${B}(?:(\d{1,2})(?:st|nd|rd|th)?\s+)?(${MONTHS_EN.join('|')})(?:\s+(\d{1,2})(?:st|nd|rd|th)?)?(?:,?\s+(\d{4}))?(?![\p{L}\p{N}])`,
  'gu',
);
/** "a las 18 hs": the Argentine way to write a time on the hour. */
const HOUR_HS = new RegExp(String.raw`${B}(\d{1,2})\s?hs${E}`, 'giu');

/** Units kept with their number, one key per unit in both languages ("9 hours" and "9 horas" are "9 h"). */
const UNITS: Readonly<Record<string, string>> = {
  '%': '%', s: 's', seg: 's', segundo: 's', segundos: 's', sec: 's', second: 's', seconds: 's', ms: 'ms',
  h: 'h', hora: 'h', horas: 'h', hour: 'h', hours: 'h', hrs: 'h', min: 'min', minuto: 'min', minutos: 'min', minute: 'min', minutes: 'min',
  'día': 'd', 'días': 'd', dia: 'd', dias: 'd', day: 'd', days: 'd', semana: 'wk', semanas: 'wk', week: 'wk', weeks: 'wk',
  mes: 'mo', meses: 'mo', month: 'mo', months: 'mo', 'año': 'y', 'años': 'y', year: 'y', years: 'y',
  km: 'km', kg: 'kg', kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB', x: 'x',
};
const UNIT = new RegExp(String.raw`^\s?(%|(?:${Object.keys(UNITS).filter((u) => u !== '%').sort((a, b) => b.length - a.length).join('|')})${E})`, 'iu');
/**
 * A token with letters and digits, such as n8n, S3 or GPT-4: a name, not a number, unless it is a
 * number and its unit ("6s") or an ordinal ("1st").
 */
const ALNUM = /(?<![\p{L}\p{N}-])(?=[\p{L}\p{N}-]*\p{L})(?=[\p{L}\p{N}-]*\p{N})[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*(?![\p{L}\p{N}-])/gu;

/** The number words slop-lint counts as anchors, as numbers. "una", "one", "half" and "medio" are not anchors there. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100, ciento: 100, mil: 1000, 'millón': 1_000_000,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000, million: 1_000_000,
};

/**
 * A number as one canonical string. Spanish groups thousands with "." and writes decimals with ",",
 * English the other way round; a separator followed by anything but three digits is a decimal in
 * both. "1.200" (es) and "1,200" (en) are "1200"; "4,1" and "4.1" are "4.1".
 */
export function canonicalNumber(raw: string, lang: Lang): string {
  const parts = raw.split(/([.,])/u);
  const groups = parts.filter((_, i) => i % 2 === 0);
  const seps = parts.filter((_, i) => i % 2 === 1);
  let integer = groups.join('');
  let decimals = '';
  if (seps.length > 0) {
    const last = seps.length - 1;
    const lastGroup = groups[groups.length - 1] ?? '';
    const thousandsSep = lang === 'es' ? '.' : ',';
    const mixed = new Set(seps).size > 1;
    const decimal = mixed || lastGroup.length !== 3 || (seps.length === 1 && seps[last] !== thousandsSep);
    if (decimal) {
      integer = groups.slice(0, -1).join('');
      decimals = lastGroup;
    }
  }
  integer = integer.replace(/^0+(?=\d)/u, '');
  decimals = decimals.replace(/0+$/u, '');
  return decimals === '' ? integer : `${integer}.${decimals}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const year = (y: string): number => (y.length === 2 ? 2000 + Number(y) : Number(y));
function dateKey(y: number | undefined, m: number, d: number | undefined): string | undefined {
  if (m < 1 || m > 12 || (d !== undefined && (d < 1 || d > 31))) return undefined;
  if (y !== undefined && d !== undefined) return `${y}-${pad(m)}-${pad(d)}`;
  if (y !== undefined) return `${y}-${pad(m)}`;
  if (d !== undefined) return `--${pad(m)}-${pad(d)}`;
  return undefined;
}

/** Word facts are compared by key and, failing that, as the same word in the other text (a name, capitalized). */
const WORD_KINDS: ReadonlySet<FactKind> = new Set(['proper-noun', 'acronym', 'tool', 'anchor']);
/** A changed one of these is a changed number (design 4.6: "12 por 15" always reverts). */
const NUMERIC_KINDS: ReadonlySet<FactKind> = new Set(['number', 'amount', 'date', 'time', 'phone']);

const wordKey = (text: string): string => text.toLocaleLowerCase('und').replace(/['’]s$/u, '').replace(/\s+/gu, ' ');

/** The sentences of a text with their offsets: a break after . ! ? … and a space, or a line break. */
function sentenceSpans(text: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  let start = 0;
  for (const m of text.matchAll(/(?<=[.!?…])\s+|\n+/gu)) {
    out.push({ start, text: text.slice(start, m.index) });
    start = m.index + m[0].length;
  }
  out.push({ start, text: text.slice(start) });
  return out.filter((s) => s.text.trim() !== '');
}

/** Every `[COMPLETAR ...]` marker in the text, as written. None of them is a fact. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_ANY)].map((m) => m[0]);
}

/**
 * The facts a text states, in the order they appear, each one once per occurrence. Placeholders
 * are blanked out first, as specifics() does, so `[COMPLETAR: 15 pedidos]` states nothing. Each pass
 * blanks what it read, so "3/11/2026" is one date and not three numbers.
 */
export function extract(text: string, options: ExtractOptions): Fact[] {
  const { lang } = options;
  const facts: Fact[] = [];
  let rest = text.replace(PLACEHOLDER_ANY, (m) => ' '.repeat(m.length));
  // A placeholder's span is claimed too, so the anchor pass, which reads the original text, skips it.
  const claimed: Array<[number, number]> = [...text.matchAll(PLACEHOLDER_ANY)].map((m) => [m.index, m.index + m[0].length]);
  const take = (kind: FactKind, start: number, raw: string, key: string): void => {
    facts.push({ kind, text: raw, key, start, end: start + raw.length });
    claimed.push([start, start + raw.length]);
    rest = rest.slice(0, start) + ' '.repeat(raw.length) + rest.slice(start + raw.length);
  };
  const pass = (pattern: RegExp, read: (m: RegExpMatchArray) => { kind: FactKind; text: string; key: string } | undefined): void => {
    for (const m of [...rest.matchAll(pattern)]) {
      const found = read(m);
      if (found !== undefined) take(found.kind, m.index ?? 0, found.text, found.key);
    }
  };
  const trimmed = (s: string): string => s.replace(/[.,;:)]+$/u, '');

  pass(URL_LIKE, (m) => ({ kind: 'url', text: trimmed(m[0]), key: trimmed(m[0]).toLowerCase().replace(/\/$/u, '') }));
  pass(EMAIL, (m) => ({ kind: 'email', text: m[0], key: m[0].toLowerCase() }));
  pass(AMOUNT_BEFORE, (m) => ({ kind: 'amount', text: m[0], key: `${CURRENCY[(m[1] ?? '').toLowerCase()] ?? '$'} ${canonicalNumber(m[2] ?? '', lang)}` }));
  pass(AMOUNT_AFTER, (m) => ({ kind: 'amount', text: m[0], key: `${CURRENCY[(m[2] ?? '').toLowerCase()] ?? '$'} ${canonicalNumber(m[1] ?? '', lang)}` }));
  pass(PHONE, (m) => {
    const digits = m[0].replace(/\D/gu, '');
    return digits.length >= 9 ? { kind: 'phone', text: m[0], key: `tel:${m[0].startsWith('+') ? '+' : ''}${digits}` } : undefined;
  });
  pass(DATE_ISO, (m) => {
    const key = dateKey(Number(m[1]), Number(m[2]), Number(m[3]));
    return key === undefined ? undefined : { kind: 'date', text: m[0], key };
  });
  // Numeric dates are day first in Spanish and month first in English, as each is written.
  pass(DATE_NUMERIC, (m) => {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [d, mo] = lang === 'es' ? [a, b] : [b, a];
    const key = dateKey(m[3] === undefined ? undefined : year(m[3]), mo, d);
    return key === undefined ? undefined : { kind: 'date', text: m[0], key };
  });
  pass(DATE_ES, (m) => {
    const key = dateKey(m[3] === undefined ? undefined : Number(m[3]), monthOf(m[2] ?? ''), m[1] === undefined ? undefined : Number(m[1]));
    return key === undefined ? undefined : { kind: 'date', text: m[0], key };
  });
  pass(DATE_EN, (m) => {
    const day = m[1] ?? m[3];
    const key = dateKey(m[4] === undefined ? undefined : Number(m[4]), monthOf(m[2] ?? ''), day === undefined ? undefined : Number(day));
    return key === undefined ? undefined : { kind: 'date', text: m[0], key };
  });
  pass(TIME, (m) => ({ kind: 'time', text: trimmed(m[0]), key: asTime(trimmed(m[0])) }));
  pass(HOUR_HS, (m) => (Number(m[1]) <= 23 ? { kind: 'time', text: m[0], key: `${Number(m[1])}:00` } : undefined));
  pass(ALNUM, (m) => {
    const unit = /^\d+(.*)$/u.exec(m[0]);
    if (unit !== null && (unit[1] === '' || UNIT.test(unit[1] ?? '') || /^(?:st|nd|rd|th|er|do|ro|to|vo|mo|no)$/iu.test(unit[1] ?? ''))) return undefined;
    return { kind: 'tool', text: m[0], key: wordKey(m[0]) };
  });
  const unitAfter = (end: number): { text: string; unit: string } | undefined => {
    const u = UNIT.exec(rest.slice(end));
    return u === null ? undefined : { text: u[0], unit: UNITS[(u[1] ?? '').toLowerCase()] ?? (u[1] ?? '') };
  };
  const numberKey = (n: string, unit: string | undefined): string => (unit === undefined ? n : unit === '%' ? `${n}%` : `${n} ${unit}`);
  pass(NUMBER, (m) => {
    const u = unitAfter((m.index ?? 0) + m[0].length);
    return { kind: 'number', text: m[0] + (u?.text ?? ''), key: numberKey(canonicalNumber(m[0], lang), u?.unit) };
  });

  // Anchors are read per sentence on the original text, as slop-lint reads them (a capital on the
  // first word of a sentence is not a name), and dropped where an earlier pass already read a fact.
  const extras = (options.anchors ?? []).map((t) => t.trim()).filter(Boolean);
  const extraKeys = new Set(extras.map(wordKey));
  const free = (start: number, end: number): boolean => claimed.every(([a, b]) => end <= a || start >= b);
  for (const sentence of sentenceSpans(text)) {
    const masked = rest.slice(sentence.start, sentence.start + sentence.text.length);
    const found = extractAnchors(sentence.text, lang, extras);
    const multi = found.filter((t) => /\s/u.test(t));
    for (const term of multi) {
      const at = masked.indexOf(term);
      if (at >= 0 && free(sentence.start + at, sentence.start + at + term.length)) take('anchor', sentence.start + at, term, wordKey(term));
    }
    let cursor = 0;
    for (const term of found.filter((t) => !/\s/u.test(t))) {
      const re = new RegExp(`${B}${escape(term)}${E}`, 'u');
      const m = re.exec(sentence.text.slice(cursor));
      if (m === null) continue;
      const start = sentence.start + cursor + m.index;
      cursor += m.index + term.length;
      if (/\p{N}/u.test(term) || !free(start, start + term.length)) continue;
      const lower = term.toLowerCase();
      const n = NUMBER_WORDS[lower];
      if (n !== undefined) {
        const u = unitAfter(start + term.length);
        take('number', start, term + (u?.text ?? ''), numberKey(String(n), u?.unit));
      } else if (extraKeys.has(wordKey(term))) take('anchor', start, term, wordKey(term));
      else if (/^\p{Lu}{2,}/u.test(term)) take('acronym', start, term, wordKey(term));
      else if (/^\p{Lu}/u.test(term)) {
        if (!(lang === 'en' && (WEEKDAYS_EN.includes(term) || MONTHS_EN.includes(term)))) take('proper-noun', start, term, wordKey(term));
      } else take('tool', start, term, wordKey(term));
    }
  }

  // slop-lint skips a sentence's first word, since a capital there says nothing. It is a name when
  // the text, O, C or the other side of an edit names it elsewhere, and with `openings`, a possible
  // name when it is not a frequent opener and has no verb or adverb ending.
  const known = new Set(options.knownNames ?? []);
  for (const f of facts) if (WORD_KINDS.has(f.kind) && f.opening === undefined) known.add(f.key);
  for (const sentence of sentenceSpans(text)) {
    const m = FIRST_WORD.exec(sentence.text);
    if (m === null) continue;
    const word = m[0];
    const start = sentence.start + m.index;
    if (!/^\p{Lu}/u.test(word) || /\p{N}/u.test(word) || !free(start, start + word.length)) continue;
    const key = wordKey(word);
    if (known.has(key)) take('proper-noun', start, word, key);
    else if (options.openings === true && isPossibleName(word, lang)) {
      facts.push({ kind: 'proper-noun', text: word, key, start, end: start + word.length, opening: true });
      claimed.push([start, start + word.length]);
    }
  }
  return facts.sort((a, b) => a.start - b.start);
}

function isPossibleName(word: string, lang: Lang): boolean {
  const lower = word.toLocaleLowerCase('und');
  if ([...word].length < 2 || OPENERS[lang].has(lower) || NOT_A_NAME[lang].test(word) || NUMBER_WORDS[lower] !== undefined) return false;
  if (lang === 'en' && (FIRST_PERSON_EN.has(word) || WEEKDAYS_EN.includes(word) || MONTHS_EN.includes(word))) return false;
  if (lang === 'es' && (MONTHS_ES.includes(lower) || lower === 'setiembre')) return false;
  return true;
}

/** The keys of the names, acronyms, tools and anchors the texts state, to read them at a sentence start too. */
function namesOf(texts: readonly string[], options: ExtractOptions): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const f of extract(t, options)) if (WORD_KINDS.has(f.kind) && f.opening === undefined) out.add(f.key);
  return out;
}

/** A text and the keys of its facts, to ask whether it states a fact. */
interface Pool {
  readonly text: string;
  readonly keys: ReadonlySet<string>;
}
const poolOf = (text: string, options: ExtractOptions): Pool => ({ text, keys: new Set(extract(text, options).map((f) => f.key)) });
const sourcesText = (c: FactSources): string => [c.cv, ...(c.recipient ?? []), ...(c.extraFacts ?? [])].join('\n');

/**
 * Whether a pool states a fact: the same key, or the same word in its text. A name or an acronym
 * is backed only by the word capitalized, as a name ("Banco Nación" is not "un banco de la
 * nación"); a tool, an anchor and a possible name at a sentence start, by the word in any case.
 */
function states(pool: Pool, fact: Fact): boolean {
  if (pool.keys.has(fact.key)) return true;
  if (!WORD_KINDS.has(fact.kind)) return false;
  const source = fact.key.split(' ').map(escape).join(String.raw`\s+`);
  const asName = fact.opening === undefined && (fact.kind === 'proper-noun' || fact.kind === 'acronym');
  for (const m of pool.text.matchAll(new RegExp(`${B}${source}${E}`, 'giu'))) {
    if (!asName || /^\p{Lu}/u.test(m[0])) return true;
  }
  return false;
}

/**
 * The numbers of `a` that `b` lacks, counted: "12 y 12" against "12 y 15" lacks one 12. Numbers
 * are facts per occurrence, so a value that stays elsewhere does not hide a changed one.
 */
function surplus(a: readonly Fact[], b: readonly Fact[]): Fact[] {
  const left = new Map<string, number>();
  for (const f of b) left.set(f.key, (left.get(f.key) ?? 0) + 1);
  return a.filter((f) => {
    const n = left.get(f.key) ?? 0;
    if (n > 0) left.set(f.key, n - 1);
    return n === 0;
  });
}

/** What a number counts: its unit, its currency, or its kind. Numbers of one class keep their order. */
const numberClass = (f: Fact): string =>
  f.kind === 'number' ? `n${f.key.replace(/^[\d.]+/u, '')}` : f.kind === 'amount' ? `a${f.key.split(' ')[0] ?? ''}` : f.kind;

/** The numbers of one class that `b` writes in another order than `a`, when both state the same ones. */
function reordered(a: readonly Fact[], b: readonly Fact[]): Fact[] {
  const out: Fact[] = [];
  for (const cls of new Set(a.map(numberClass))) {
    const x = a.filter((f) => numberClass(f) === cls);
    const y = b.filter((f) => numberClass(f) === cls);
    if (x.length === y.length && surplus(x, y).length === 0 && x.some((f, i) => f.key !== y[i]?.key)) out.push(...y);
  }
  return out;
}

const unique = (facts: readonly Fact[]): Fact[] => {
  const seen = new Set<string>();
  return facts.filter((f) => !seen.has(f.key) && seen.add(f.key) !== undefined);
};

export type FactLabel = 'en-cv' | 'del-destinatario' | 'solo-del-usuario';
export interface LabelledFact extends Fact {
  readonly label: FactLabel;
}

/**
 * Step 1 of 4.6: each fact of the original (once, at its first occurrence) labelled by where C
 * states it. A fact only the user states gets a not-in-cv flag. It is shown, never strengthened or
 * removed (D7).
 */
export function inventory(original: string, sources: FactSources, options: ExtractOptions): { facts: LabelledFact[]; flags: Flag[] } {
  const cv = poolOf([sources.cv, ...(sources.extraFacts ?? [])].join('\n'), options);
  const recipient = poolOf((sources.recipient ?? []).join('\n'), options);
  const facts = unique(extract(original, options)).map((f): LabelledFact => ({
    ...f,
    label: states(cv, f) ? 'en-cv' : states(recipient, f) ? 'del-destinatario' : 'solo-del-usuario',
  }));
  const flags = facts
    .filter((f) => f.label === 'solo-del-usuario')
    .map((f): Flag => ({
      kind: 'not-in-cv',
      span: { start: f.start, end: f.end },
      message: options.lang === 'es' ? `Tu texto dice «${f.text}»; no figura en tu CV.` : `Your text says "${f.text}"; it is not in your CV.`,
    }));
  return { facts, flags };
}

export type RevertReason = 'not-found' | 'changed-number' | 'invented' | 'lost' | 'drop-not-elsewhere';
export type EditCheck =
  | { readonly status: 'accepted'; readonly fromCv: Fact[]; readonly dropped: Fact[] }
  | { readonly status: 'reverted'; readonly reason: RevertReason; readonly facts: Fact[]; readonly message: string };

export interface EditContext extends ExtractOptions {
  /** The user's original text. */
  readonly O: string;
  readonly C: FactSources;
  /** The current text's sentences, indexed by Edit.sentenceId. */
  readonly sentences: readonly string[];
}

const listOf = (facts: readonly Fact[]): string => facts.map((f) => f.text).join(', ');

/**
 * Step 2 of 4.6, one edit at a time. The edit is compared inside its sentence, before and after
 * it applies, so a name that moves to the first word of the sentence is not lost. In order:
 * a changed number always reverts; a fact outside O ∪ C reverts (invented); a fact lost without
 * `drop` reverts; a drop stands only if the fact stays in another sentence. A fact taken from C
 * that O lacks is accepted and returned in fromCv.
 */
export function checkEdit(edit: Edit, context: EditContext): EditCheck {
  const sentence = context.sentences[edit.sentenceId];
  const at = sentence === undefined ? -1 : sentence.indexOf(edit.before);
  if (sentence === undefined || at < 0) {
    return { status: 'reverted', reason: 'not-found', facts: [], message: `"${edit.before}" is not in sentence ${edit.sentenceId}.` };
  }
  const after = sentence.slice(0, at) + edit.after + sentence.slice(at + edit.before.length);
  const known = namesOf([context.O, sourcesText(context.C), sentence, after], context);
  const read = { ...context, knownNames: known, openings: true };
  const allBefore = extract(sentence, read);
  const allAfter = extract(after, read);
  const beforeFacts = unique(allBefore);
  const afterFacts = unique(allAfter);
  const beforePool: Pool = { text: sentence, keys: new Set(beforeFacts.map((f) => f.key)) };
  const afterPool: Pool = { text: after, keys: new Set(afterFacts.map((f) => f.key)) };
  // Numbers are compared per occurrence and in order; words, as a set.
  const numbersBefore = allBefore.filter((f) => NUMERIC_KINDS.has(f.kind));
  const numbersAfter = allAfter.filter((f) => NUMERIC_KINDS.has(f.kind));
  const lostNumbers = surplus(numbersBefore, numbersAfter);
  const addedNumbers = surplus(numbersAfter, numbersBefore);
  const lost = [...beforeFacts.filter((f) => !NUMERIC_KINDS.has(f.kind) && !states(afterPool, f)), ...unique(lostNumbers)];
  const added = [...afterFacts.filter((f) => !NUMERIC_KINDS.has(f.kind) && !states(beforePool, f)), ...unique(addedNumbers)];

  if (lostNumbers.length > 0 && addedNumbers.length > 0) {
    return { status: 'reverted', reason: 'changed-number', facts: [...lostNumbers, ...addedNumbers], message: `changed ${listOf(lostNumbers)} to ${listOf(addedNumbers)}` };
  }
  // A number the sentence already states, written once more, stands in for another count ("una clienta" to "dos clientas").
  const repeated = addedNumbers.filter((f) => beforePool.keys.has(f.key));
  if (repeated.length > 0) return { status: 'reverted', reason: 'changed-number', facts: repeated, message: `repeats ${listOf(repeated)} in place of another count` };
  const moved = reordered(numbersBefore, numbersAfter);
  if (moved.length > 0) return { status: 'reverted', reason: 'changed-number', facts: moved, message: `reorders ${listOf(moved)}` };
  const original = poolOf(context.O, context);
  const sources = poolOf(sourcesText(context.C), context);
  const invented = added.filter((f) => !states(original, f) && !states(sources, f));
  if (invented.length > 0) return { status: 'reverted', reason: 'invented', facts: invented, message: `adds ${listOf(invented)}, found in neither the text nor the CV` };
  if (lost.length > 0 && edit.drop !== true) return { status: 'reverted', reason: 'lost', facts: lost, message: `loses ${listOf(lost)} without drop` };
  if (lost.length > 0) {
    const elsewhere = poolOf(context.sentences.filter((_, i) => i !== edit.sentenceId).join('\n'), context);
    const gone = lost.filter((f) => !states(elsewhere, f));
    if (gone.length > 0) return { status: 'reverted', reason: 'drop-not-elsewhere', facts: gone, message: `drops ${listOf(gone)}, which no other sentence states` };
  }
  return { status: 'accepted', fromCv: added.filter((f) => !states(original, f)), dropped: lost };
}

export interface InvariantResult {
  readonly holds: boolean;
  /** Facts of O that R does not state and that no accepted drop covers; numbers per occurrence. */
  readonly missing: Fact[];
  /** Facts of R that neither O nor C states; a number R repeats more often than O, too. */
  readonly extra: Fact[];
  /** Numbers of one class (unit, currency or kind) that R states in another order than O. Only present when there are some. */
  readonly reordered?: Fact[];
}

/**
 * Step 4 of 4.6: O ⊆ R (except the accepted drops, by key) and R ⊆ O ∪ C, with the differences.
 * Numbers count per occurrence, and those of one class keep their order ("de 4,1 s a 1,6 s").
 */
export function factInvariant(
  original: string,
  rewritten: string,
  sources: FactSources,
  acceptedDrops: readonly string[],
  options: ExtractOptions,
): InvariantResult {
  const O = poolOf(original, options);
  const R = poolOf(rewritten, options);
  const C = poolOf(sourcesText(sources), options);
  const read = { ...options, knownNames: namesOf([original, rewritten, C.text], options), openings: true };
  const inO = extract(original, read);
  const inR = extract(rewritten, read);
  const isNumber = (f: Fact): boolean => NUMERIC_KINDS.has(f.kind);
  const numbersO = inO.filter(isNumber);
  const numbersR = inR.filter(isNumber);
  const missing = [
    ...unique(inO).filter((f) => !isNumber(f) && !states(R, f)),
    ...surplus(numbersO, numbersR),
  ].filter((f) => !acceptedDrops.includes(f.key)).sort((a, b) => a.start - b.start);
  const extra = [
    ...unique(inR).filter((f) => !isNumber(f) && !states(O, f) && !states(C, f)),
    ...surplus(numbersR, numbersO).filter((f) => O.keys.has(f.key) || !states(C, f)),
  ].sort((a, b) => a.start - b.start);
  const moved = reordered(numbersO, numbersR);
  return { holds: missing.length === 0 && extra.length === 0 && moved.length === 0, missing, extra, ...(moved.length > 0 ? { reordered: moved } : {}) };
}

/**
 * The FactReport of the contract, by key. kept and dropped split the facts of O by whether R
 * states them; fromCv and added split the facts R states and O does not, by whether C states them,
 * so added holds only what nothing backs; notInCv is the inventory's solo-del-usuario; placeholders
 * are the markers left in R.
 */
export function factReport(original: string, rewritten: string, sources: FactSources, options: ExtractOptions): FactReport {
  const O = poolOf(original, options);
  const R = poolOf(rewritten, options);
  const C = poolOf(sourcesText(sources), options);
  const inO = unique(extract(original, options));
  const newInR = unique(extract(rewritten, options)).filter((f) => !states(O, f));
  const key = (f: Fact) => f.key;
  return {
    kept: inO.filter((f) => states(R, f)).map(key),
    dropped: inO.filter((f) => !states(R, f)).map(key),
    added: newInR.filter((f) => !states(C, f)).map(key),
    fromCv: newInR.filter((f) => states(C, f)).map(key),
    notInCv: inventory(original, sources, options).facts.filter((f) => f.label === 'solo-del-usuario').map(key),
    placeholders: placeholders(rewritten),
  };
}
