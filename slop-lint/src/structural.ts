import { TUTEO, VOSEO } from './rules.ts';
import { compile } from './regex.ts';
import { isProse, words, type Span } from './text.ts';
import type { Lang } from './types.ts';

/** A raw hit from a structural check, before lint() attaches the rule's metadata. */
export interface StructuralHit {
  ruleId: string;
  start: number;
  end: number;
  detail?: string;
}

export interface StructuralContext {
  text: string;
  lang: Lang;
  sentences: readonly Span[];
  anchorsIn: (sentence: Span) => number;
  /** The sentences EST-10 measures: all of them in plain text, paragraph sentences in Markdown. */
  longSentenceScope: readonly Span[];
}

type Check = (ctx: StructuralContext) => StructuralHit[];

const LONG_SENTENCE: Record<Lang, number> = { en: 35, es: 40 };
const MIN_SENTENCES_FOR_RHYTHM = 8;
const MIN_RHYTHM_CV = 0.25;
const WORDS_PER_ANCHOR = 35;
const WORDS_PER_NOMINALIZATION = 12;
const MIN_WORDS_FOR_NOMINALIZATION = 24;

const NOMINALIZATION: Record<Lang, RegExp> = {
  es: /^\p{L}{2,}(?:ción|ciones|sión|siones|miento|mientos|dad|dades)$/iu,
  en: /^\p{L}{3,}(?:tion|tions|ment|ments|ity|ities|ness|nesses)$/iu,
};

function prose(ctx: StructuralContext): Span[] {
  return ctx.sentences.filter(isProse);
}

function wholeRange(spans: readonly Span[]): { start: number; end: number } {
  return { start: spans[0]?.start ?? 0, end: spans[spans.length - 1]?.end ?? 0 };
}

/** Population coefficient of variation; null when it is undefined. */
export function coefficientOfVariation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function positions(text: string, ch: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(ch); i !== -1; i = text.indexOf(ch, i + 1)) out.push(i);
  return out;
}

const checks: Record<string, Check> = {
  'ESP-02': (ctx) => {
    const ps = prose(ctx);
    const total = ps.reduce((n, s) => n + words(s.text).length, 0);
    const anchors = ps.reduce((n, s) => n + ctx.anchorsIn(s), 0);
    if (total < WORDS_PER_ANCHOR || anchors * WORDS_PER_ANCHOR >= total) return [];
    return [{ ruleId: 'ESP-02', ...wholeRange(ps), detail: `${anchors} anchors in ${total} words of prose` }];
  },

  'EST-06': (ctx) => {
    const ps = prose(ctx);
    const firstHalf = ps.slice(0, Math.floor(ps.length / 2));
    return firstHalf.flatMap((s) =>
      positions(s.text, '?').map((p) => ({ ruleId: 'EST-06', start: s.start + p, end: s.start + p + 1 })),
    );
  },

  'EST-10': (ctx) =>
    ctx.longSentenceScope.flatMap((s) => {
      const n = words(s.text).length;
      return n > LONG_SENTENCE[ctx.lang] ? [{ ruleId: 'EST-10', start: s.start, end: s.end, detail: `${n} words` }] : [];
    }),

  'EST-11': (ctx) => {
    const ps = prose(ctx);
    if (ps.length < MIN_SENTENCES_FOR_RHYTHM) return [];
    const cv = coefficientOfVariation(ps.map((s) => words(s.text).length));
    if (cv === null || cv >= MIN_RHYTHM_CV) return [];
    return [{ ruleId: 'EST-11', ...wholeRange(ps), detail: `CV ${cv.toFixed(2)} over ${ps.length} sentences` }];
  },

  'FMT-05': (ctx) =>
    [...ctx.text.matchAll(/(?<=[\p{L}\p{N})\]])[ \t]*:[ \t]+(?=\p{Ll})/gu)]
      .slice(2)
      .map((m) => {
        const at = m.index + m[0].indexOf(':');
        return { ruleId: 'FMT-05', start: at, end: at + 1, detail: 'budget 2 per text' };
      }),

  'ORT-01': (ctx) => {
    if (ctx.lang !== 'es') return [];
    return ctx.sentences.flatMap((s) => {
      const hits: StructuralHit[] = [];
      for (const [open, close] of [['¿', '?'], ['¡', '!']] as const) {
        const closes = positions(s.text, close);
        const last = closes[closes.length - 1];
        if (last !== undefined && closes.length > positions(s.text, open).length) {
          hits.push({ ruleId: 'ORT-01', start: s.start + last, end: s.start + last + 1, detail: `missing ${open}` });
        }
      }
      return hits;
    });
  },

  'ORT-04': (ctx) => {
    if (ctx.lang !== 'es') return [];
    const hits: StructuralHit[] = [];
    let asides = 0;
    for (const s of ctx.sentences) {
      const dashes = positions(s.text, '—').filter((p) => !(/\p{L}/u.test(s.text[p - 1] ?? '') && /\p{L}/u.test(s.text[p + 1] ?? '')));
      for (let i = 0; i + 1 < dashes.length; i += 2) {
        asides++;
        const p = dashes[i] ?? 0;
        if (asides > 1) hits.push({ ruleId: 'ORT-04', start: s.start + p, end: s.start + p + 1, detail: 'more than one aside between rayas' });
      }
      const last = dashes[dashes.length - 1];
      if (dashes.length % 2 === 1 && last !== undefined) {
        hits.push({ ruleId: 'ORT-04', start: s.start + last, end: s.start + last + 1, detail: 'aside not closed' });
      }
    }
    return hits;
  },

  'ORT-05': (ctx) => {
    if (ctx.lang !== 'en') return [];
    return positions(ctx.text, '—')
      .slice(1)
      .map((p) => ({ ruleId: 'ORT-05', start: p, end: p + 1, detail: 'budget 1 per text' }));
  },

  'REG-01': (ctx) => {
    if (ctx.lang !== 'es') return [];
    const vos = [...ctx.text.matchAll(compile(VOSEO, 'giu'))];
    const tu = [...ctx.text.matchAll(compile(TUTEO, 'giu'))];
    if (vos.length === 0 || tu.length === 0) return [];
    // Flag the minority register; on a tie, the one that shows up later.
    const firstVos = vos[0]?.index ?? 0;
    const firstTu = tu[0]?.index ?? 0;
    const minority = vos.length < tu.length || (vos.length === tu.length && firstVos > firstTu) ? vos : tu;
    const other = minority === vos ? 'tuteo' : 'voseo';
    return minority.map((m) => ({ ruleId: 'REG-01', start: m.index, end: m.index + m[0].length, detail: `the rest of the text uses ${other}` }));
  },

  'OFI-01': (ctx) => {
    const ws = words(ctx.text);
    if (ws.length < MIN_WORDS_FOR_NOMINALIZATION) return [];
    const count = ws.filter((w) => NOMINALIZATION[ctx.lang].test(w.text)).length;
    if (count * WORDS_PER_NOMINALIZATION <= ws.length) return [];
    return [{ ruleId: 'OFI-01', start: ws[0]?.start ?? 0, end: ws[ws.length - 1]?.end ?? 0, detail: `${count} in ${ws.length} words` }];
  },

  'MED-01': (ctx) => {
    if (ctx.lang !== 'es') return [];
    return words(ctx.text)
      .filter((w) => /^\p{L}{3,}mente$/iu.test(w.text))
      .slice(2)
      .map((w) => ({ ruleId: 'MED-01', start: w.start, end: w.end, detail: 'budget 2 per text' }));
  },
};

export const STRUCTURAL_CHECK_IDS: readonly string[] = Object.keys(checks);

export function runStructural(ruleId: string, ctx: StructuralContext): StructuralHit[] {
  const check = checks[ruleId];
  if (!check) throw new Error(`No structural check for ${ruleId}`);
  return check(ctx);
}
