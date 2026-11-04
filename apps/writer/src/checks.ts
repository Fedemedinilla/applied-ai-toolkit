// Everything under a draft that code can decide: the length of each language, the facts left as
// [COMPLETAR: ...], and the notes that follow from the category's configuration (call to action,
// attachments, photos, graphics, reviewer, sensitivity) or from the text itself (emoji where none
// are allowed, exclamation marks in a sensitive text, words the style guide replaces).
//
// The model is told the length range, but it cannot count characters: it sees tokens, and its
// own estimate of a text's length is a guess. So the range is checked here, after every draft,
// and the number shown to the user is this one.
//
// Pure and browser-safe. Types only from config-schema.ts, so zod is never bundled.

import type { Catalog, Category, Language, School, Sensitivity } from './config-schema.ts';
import { placeholders, PLACEHOLDER } from './protocol.ts';

export type LengthStatus = 'short' | 'ok' | 'long';

export interface LengthCheck {
  readonly lang: Language;
  readonly chars: number;
  readonly min: number;
  readonly max: number;
  readonly status: LengthStatus;
}

export type NoteCode =
  | 'length'
  | 'placeholders'
  | 'missing_en'
  | 'unexpected_en'
  | 'emoji'
  | 'exclamation'
  | 'vocabulary'
  | 'cta'
  | 'attachments'
  | 'photos'
  | 'graphics'
  | 'reviewer'
  | 'sensitivity';

export interface Note {
  readonly code: NoteCode;
  /** warn: something in the text to fix before sending. info: a reminder from the configuration. */
  readonly level: 'warn' | 'info';
  readonly text: string;
}

export interface DraftReport {
  readonly lengths: readonly LengthCheck[];
  readonly placeholders: readonly string[];
  /** Warnings first, then reminders, each in a fixed order. */
  readonly notes: readonly Note[];
}

/**
 * Characters as a reader sees them: Unicode code points of the trimmed text, with the bold markers
 * and list dashes removed and each [COMPLETAR: x] counted as its label x, which is closer to the
 * fact that will replace it than the marker is.
 */
export function lengthOf(text: string): number {
  const visible = text
    .replace(PLACEHOLDER, (_m, label: string | undefined) => (label ?? '').trim())
    .replace(/\*\*/gu, '')
    .replace(/^- /gmu, '')
    .trim();
  return [...visible].length;
}

export function checkLength(lang: Language, text: string, range: Category['length']): LengthCheck {
  const chars = lengthOf(text);
  const status: LengthStatus = chars < range.min ? 'short' : chars > range.max ? 'long' : 'ok';
  return { lang, chars, min: range.min, max: range.max, status };
}

/** High and critical texts carry no emoji, whatever the category allows. */
export const emojiAllowed = (category: Pick<Category, 'emoji' | 'sensitivity'>): boolean =>
  category.sensitivity === 'normal' && category.emoji === 'few';

/** The closing line for a draft: the committee for sensitive texts, the author's role otherwise. */
export function signatureFor(catalog: Pick<Catalog, 'roles' | 'committeeSignature'>, roleId: string, sensitivity: Sensitivity): string {
  if (sensitivity !== 'normal') return catalog.committeeSignature;
  return catalog.roles.find((r) => r.id === roleId)?.signature ?? catalog.committeeSignature;
}

/**
 * Pictographs, minus the four that are text symbols in running prose (©, ®, ‼, ™) and that
 * Extended_Pictographic includes anyway. A lookahead, not a lookbehind: the page is built
 * without lookbehind (csp-build-guard).
 */
export const EMOJI = /(?![\u00A9\u00AE\u203C\u2122])\p{Extended_Pictographic}/u;

/** Lower case with accents removed, so "Excursión" matches "excursion". */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Whole-word, accent- and case-insensitive. No lookbehind: this file can reach a browser bundle,
 * and older Safari rejects the whole script over one.
 */
export function containsWord(text: string, word: string): boolean {
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(fold(word))}(?:$|[^\\p{L}\\p{N}])`, 'u');
  return pattern.test(fold(text));
}

const LANGUAGE_NAME: Record<Language, string> = { es: 'español', en: 'inglés' };

const formatInt = (n: number): string => new Intl.NumberFormat('es', { useGrouping: true }).format(n);

export interface ReportInput {
  readonly category: Category;
  readonly catalog: Pick<Catalog, 'roles' | 'committeeSignature'>;
  readonly school: Pick<School, 'vocabulary'>;
  readonly es: string;
  readonly en: string | null;
}

export function draftReport({ category, catalog, school, es, en }: ReportInput): DraftReport {
  const bilingual = category.languages.length === 2;
  const texts: Array<[Language, string]> = [['es', es]];
  if (en !== null) texts.push(['en', en]);
  const lengths = texts.map(([lang, text]) => checkLength(lang, text, category.length));
  const all = texts.map(([, t]) => t).join('\n');
  const missing = placeholders(all);

  const warn: Note[] = [];
  const info: Note[] = [];

  for (const l of lengths) {
    if (l.status === 'ok') continue;
    const range = `entre ${formatInt(l.min)} y ${formatInt(l.max)}`;
    warn.push({
      code: 'length',
      level: 'warn',
      text: `El texto en ${LANGUAGE_NAME[l.lang]} tiene ${formatInt(l.chars)} caracteres; esta categoría pide ${range}.`,
    });
  }
  if (missing.length > 0) {
    const labels = missing.map((m) => (m === '' ? 'un dato sin nombre' : m)).join('; ');
    warn.push({
      code: 'placeholders',
      level: 'warn',
      text: `${missing.length === 1 ? 'Falta 1 dato' : `Faltan ${missing.length} datos`} antes de enviar: ${labels}.`,
    });
  }
  if (bilingual && en === null) warn.push({ code: 'missing_en', level: 'warn', text: 'Esta categoría se envía en español y en inglés, y falta la versión en inglés.' });
  if (!bilingual && en !== null) warn.push({ code: 'unexpected_en', level: 'warn', text: 'Esta categoría se envía solo en español; la versión en inglés no se usa.' });
  if (!emojiAllowed(category) && EMOJI.test(all)) {
    warn.push({ code: 'emoji', level: 'warn', text: 'El texto tiene emojis y esta categoría no los usa.' });
  }
  if (category.sensitivity !== 'normal' && /[!¡]/u.test(all)) {
    warn.push({ code: 'exclamation', level: 'warn', text: 'El texto tiene signos de exclamación; en una comunicación sensible no van.' });
  }
  for (const entry of school.vocabulary) {
    const found = entry.avoid.filter((w) => containsWord(all, w));
    if (found.length > 0) {
      warn.push({ code: 'vocabulary', level: 'warn', text: `Aparece ${found.map((w) => `«${w}»`).join(', ')}; la guía de estilo usa «${entry.use}».` });
    }
  }

  if (category.cta.mode === 'required') info.push({ code: 'cta', level: 'info', text: `Agregar ${category.cta.hint ?? 'el enlace de la acción'} antes de enviar.` });
  if (category.cta.mode === 'optional') info.push({ code: 'cta', level: 'info', text: `Si hace falta una acción, agregar ${category.cta.hint ?? 'el enlace'}.` });
  if (category.attachments === 'usually') info.push({ code: 'attachments', level: 'info', text: 'Este tipo de comunicado suele ir con documentos adjuntos: revisar que estén.' });
  if (category.attachments === 'sometimes') info.push({ code: 'attachments', level: 'info', text: 'Si hay documentos, adjuntarlos al envío.' });
  if (category.photos === 'usually') info.push({ code: 'photos', level: 'info', text: 'Este tipo de comunicado suele ir con fotos o un video.' });
  if (category.photos === 'sometimes') info.push({ code: 'photos', level: 'info', text: 'Si hay fotos, se pueden sumar al envío.' });
  if (category.graphics) info.push({ code: 'graphics', level: 'info', text: 'Este tipo de comunicado suele llevar una pieza gráfica: pedirla con tiempo.' });
  if (category.reviewer !== null) {
    const name = catalog.roles.find((r) => r.id === category.reviewer)?.name ?? category.reviewer;
    info.push({ code: 'reviewer', level: 'info', text: `Antes de enviar, pedir una revisión a: ${name}.` });
  }
  if (category.sensitivity === 'high') info.push({ code: 'sensitivity', level: 'info', text: `Sensibilidad alta: firma ${catalog.committeeSignature}. Releer el tono antes de enviar.` });
  if (category.sensitivity === 'critical') {
    info.push({ code: 'sensitivity', level: 'info', text: `Sensibilidad crítica: firma ${catalog.committeeSignature} y el texto necesita una segunda lectura antes del envío.` });
  }

  return { lengths, placeholders: missing, notes: [...warn, ...info] };
}
