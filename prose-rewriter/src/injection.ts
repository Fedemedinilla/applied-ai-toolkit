/**
 * The injection guard of design 4.7. The user's text and CV are data, never instructions: stage S0
 * flags the phrases in them that read like an instruction to a model, and the prompt carries each
 * one inside a labelled block (<texto>, <perfil>) that the data cannot close.
 *
 * Heuristic on purpose, and tuned for few false positives on ordinary job-search texts: the real
 * defence is the structured output checked with zod and every edit verified in code. A flag is
 * shown to the user; it never blocks a rewrite by itself.
 *
 * Pure: no I/O, no model, no gateway.
 */
import type { Flag, Lang } from './types.ts';

/** Where the data comes from: the user's text or the profile (the CV). */
export type DataSource = 'texto' | 'perfil';

/** The tags of the data blocks of the prompt. */
export const DATA_TAGS = ['texto', 'perfil'] as const satisfies readonly DataSource[];

/** Patterns are case-insensitive and Unicode-aware; `(?!\p{L})` ends a word that may end in an accent. */
const P = (source: string): RegExp => new RegExp(source, 'giu');
const END = '(?![\\p{L}\\p{N}])';

/**
 * Each pattern needs an instruction verb with an object that only a prompt has ("lo anterior",
 * "previous instructions"), a role marker, or a tag. Bare words such as "ignoro", "instrucciones"
 * or "act as" are left alone: job-search texts use them.
 */
const PATTERNS: readonly RegExp[] = [
  // Spanish: "ignorá lo anterior", "olvidá todas las instrucciones previas", "olvidá todo lo que te dijeron".
  P(`(?<!\\p{L})(?:ignor[aá]|ignoren|ignorad|olvid[aá]|olviden|olvidad|descart[aá]|pas[aá] por alto)\\s+(?:todo\\s+)?(?:lo\\s+anterior|lo\\s+de\\s+arriba|lo\\s+que\\s+te\\s+(?:dijeron|pidieron|indicaron)|(?:todas\\s+)?las\\s+(?:instrucciones|indicaciones|reglas)(?:\\s+(?:anteriores|previas|de\\s+arriba))?)${END}`),
  P(`(?<!\\p{L})a\\s+partir\\s+de\\s+ahora,?\\s+(?:sos|eres|serás|vas\\s+a\\s+ser|actu[aá]|respond[eé]|ten[eé]s\\s+que)${END}`),
  P(`(?<!\\p{L})nuevas\\s+(?:instrucciones|indicaciones|reglas)\\s*:`),
  P(`(?<!\\p{L})(?:prompt|instrucciones|mensaje)\\s+del\\s+sistema${END}`),
  // English: "ignore previous instructions", "disregard all prior rules", "forget everything above".
  P(`\\b(?:ignore|disregard|forget|override)\\s+(?:all\\s+|any\\s+|the\\s+|your\\s+)*(?:previous|prior|above|earlier|preceding|former)\\s+(?:instructions?|prompts?|rules|directions|directives)\\b`),
  P(`\\b(?:ignore|disregard|forget)\\s+(?:everything|all)\\s+(?:above|before|previously|you(?:'ve|\\s+have|\\s+were)\\s+(?:been\\s+)?told)\\b`),
  P(`\\bfrom\\s+now\\s+on,?\\s+you\\s+(?:are|will|must|should|have\\s+to)\\b`),
  P(`\\bnew\\s+(?:instructions|rules)\\s*:`),
  P(`\\bsystem\\s+prompt\\b`),
  P(`\\b(?:reveal|disclose|repeat)\\s+(?:to\\s+me\\s+)?(?:your|the)\\s+(?:instructions|prompt|rules)\\b`),
  // Role tags and role lines of chat formats.
  P(`<\\s*\\/?\\s*(?:system|assistant|user|human|instructions?)\\s*>`),
  P(`<\\|im_(?:start|end)\\|>`),
  P(`\\[\\/?INST\\]`),
  P(`<<\\/?SYS>>`),
  // A role label at the start of a line ("System:", "Assistant:"); multiline, so ^ is a line start.
  new RegExp(`^[ \\t]*(?:system|assistant|human|sistema|asistente)[ \\t]*:`, 'gimu'),
  // A tag of the data blocks themselves: the data trying to close its block or open another.
  P(`<\\s*\\/?\\s*(?:${DATA_TAGS.join('|')})\\s*>`),
];

interface Hit {
  start: number;
  end: number;
}

/** Every match of every pattern, overlapping hits merged into one, in text order. */
function hits(text: string): Hit[] {
  const all: Hit[] = [];
  for (const pattern of PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      let start = m.index;
      let end = start + m[0].length;
      // A role line is reported as its label, without the indentation before it.
      while (start < end && /[ \t]/.test(text[start] ?? '')) start++;
      while (end > start && /\s/u.test(text[end - 1] ?? '')) end--;
      if (end > start) all.push({ start, end });
    }
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Hit[] = [];
  for (const hit of all) {
    const last = merged.at(-1);
    if (last !== undefined && hit.start < last.end) last.end = Math.max(last.end, hit.end);
    else merged.push({ ...hit });
  }
  return merged;
}

function message(source: DataSource, quote: string, lang: Lang): string {
  if (lang === 'en') {
    const where = source === 'texto' ? 'Your text' : 'Your CV';
    return `${where} has a phrase that reads like an instruction to a model ("${quote}"). It is treated as data and not followed.`;
  }
  const where = source === 'texto' ? 'Tu texto' : 'Tu CV';
  return `${where} tiene una frase que parece una instrucción para un modelo («${quote}»). La trato como dato y no la sigo.`;
}

/**
 * Stage S0 of 4.4: the instruction-like phrases of the user's text or CV, as flags of kind
 * `injection` with their span in `text`. The message is in `lang`, Spanish by default, as the
 * tool's own labels are.
 */
export function injectionFlags(text: string, source: DataSource, lang: Lang = 'es'): Flag[] {
  return hits(text).map(({ start, end }) => ({ kind: 'injection', span: { start, end }, message: message(source, text.slice(start, end), lang) }));
}

/**
 * The start of a data tag, open or closed, with any spacing (`<texto`, `</ perfil`), or the same
 * already written with escaped brackets (`&lt;/texto`, `&amp;lt;/texto`). Escaping the escaped form
 * too is what makes the neutralization reversible.
 */
const TAG_START = new RegExp(`(<|&(?:amp;)*lt;)(?=\\s*\\/?\\s*(?:${DATA_TAGS.join('|')})(?![\\p{L}\\p{N}]))`, 'giu');

function neutralize(text: string): string {
  return text.replace(TAG_START, (lead: string) => (lead === '<' ? '&lt;' : `&amp;${lead.slice(1)}`));
}

function restore(text: string): string {
  return text.replace(TAG_START, (lead: string) => (lead.toLowerCase() === '&lt;' ? '<' : `&${lead.slice('&amp;'.length)}`));
}

/**
 * Puts `text` in a labelled block for the prompt. The `<` of every data tag inside the text (of
 * either block, open or closed, in any case or spacing) is written `&lt;`, so the data cannot
 * close its block or open another one. Nothing else changes: ordinary markup and angle brackets
 * stay as they are. A model that quotes a neutralized tag back quotes `&lt;`; unwrapData() and
 * restoreData() turn it back.
 */
export function wrapData(tag: DataSource, text: string): string {
  return `<${tag}>\n${neutralize(text)}\n</${tag}>`;
}

/** The inverse of the neutralization of wrapData(), for a span quoted from inside a block. */
export function restoreData(quoted: string): string {
  return restore(quoted);
}

/** The data of a block built by wrapData(), as it was. Throws if `wrapped` is not such a block. */
export function unwrapData(tag: DataSource, wrapped: string): string {
  const open = `<${tag}>\n`;
  const close = `\n</${tag}>`;
  if (!wrapped.startsWith(open) || !wrapped.endsWith(close) || wrapped.length < open.length + close.length) {
    throw new Error(`not a <${tag}> block`);
  }
  return restore(wrapped.slice(open.length, wrapped.length - close.length));
}
