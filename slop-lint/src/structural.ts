import { TUTEO, VOSEO } from './rules.ts';
import { compile } from './regex.ts';
import { isProse, words, type Span } from './text.ts';
import type { Lang, Variety } from './types.ts';

/** A raw hit from a structural check, before lint() attaches the rule's metadata. */
export interface StructuralHit {
  ruleId: string;
  start: number;
  end: number;
  detail?: string;
  /** Wording for this hit when the rule's catalog message does not fit it. */
  message?: string;
  suggestion?: string;
}

export interface StructuralContext {
  text: string;
  lang: Lang;
  sentences: readonly Span[];
  anchorsIn: (sentence: Span) => number;
  /** The sentences EST-10 measures: all of them in plain text, paragraph sentences in Markdown. */
  longSentenceScope: readonly Span[];
  /** The genre's thresholds and budgets; DEFAULT_THRESHOLDS for a cover letter. */
  thresholds: StructuralThresholds;
  /** The Spanish variety, when the caller gave one. REG-01 reads it. */
  variety?: Variety;
  /** The earlier message, when the caller gave one. */
  previous?: string;
}

/** Every number a structural check applies, so a genre profile can set them. */
export interface StructuralThresholds {
  /** EST-10: words over which a sentence is long, per language. */
  longSentence: Readonly<Record<Lang, number>>;
  /** EST-11: prose sentences needed before the rhythm is measured. */
  minSentencesForRhythm: number;
  /** EST-11: coefficient of variation under which the rhythm is flat. */
  minRhythmCV: number;
  /** ESP-02: words of prose allowed per anchor. */
  wordsPerAnchor: number;
  /** OFI-01: words allowed per nominalization. */
  wordsPerNominalization: number;
  /** OFI-01: words a text needs before nominalizations are counted. */
  minWordsForNominalization: number;
  /** FMT-05: colons before a lowercase word tolerated per text. */
  colonBudget: number;
  /** ORT-04: closed asides between rayas tolerated per text. */
  asideBudget: number;
  /** ORT-05: em dashes tolerated per text. */
  emDashBudget: number;
  /** MED-01: -mente adverbs tolerated per text. */
  menteBudget: number;
  /**
   * ORT-01: true checks an opening mark only when the text uses it somewhere, so a text written
   * without ¿ or ¡ (a chat message, as its author types) is left alone.
   */
  openingMarksFollowText: boolean;
}

type Check = (ctx: StructuralContext) => StructuralHit[];

const LONG_SENTENCE: Record<Lang, number> = { en: 35, es: 40 };
const MIN_SENTENCES_FOR_RHYTHM = 8;
const MIN_RHYTHM_CV = 0.25;
const WORDS_PER_ANCHOR = 35;
const WORDS_PER_NOMINALIZATION = 12;
const MIN_WORDS_FOR_NOMINALIZATION = 24;

/** Today's values, which the cover-letter profile in genres.ts repeats and test/genres.test.ts compares. */
export const DEFAULT_THRESHOLDS: StructuralThresholds = {
  longSentence: LONG_SENTENCE,
  minSentencesForRhythm: MIN_SENTENCES_FOR_RHYTHM,
  minRhythmCV: MIN_RHYTHM_CV,
  wordsPerAnchor: WORDS_PER_ANCHOR,
  wordsPerNominalization: WORDS_PER_NOMINALIZATION,
  minWordsForNominalization: MIN_WORDS_FOR_NOMINALIZATION,
  colonBudget: 2,
  asideBudget: 1,
  emDashBudget: 1,
  menteBudget: 2,
  openingMarksFollowText: false,
};

const NOMINALIZATION: Record<Lang, RegExp> = {
  es: /^\p{L}{2,}(?:ción|ciones|sión|siones|miento|mientos|dad|dades)$/iu,
  en: /^\p{L}{3,}(?:tion|tions|ment|ments|ity|ities|ness|nesses)$/iu,
};

/** SEG-03: words in a row a follow-up may share with the earlier message (the report's limit for the job posting). */
const COPIED_RUN = 8;

/** WA-03: a line that opens with an emoji (or a keycap number) and goes on after a space. */
const EMOJI_BULLET = /^[ \t]*((?:(?![©®™])\p{Extended_Pictographic}|[0-9#*]\uFE0F?\u20E3)(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*)[ \t]+\S/u;

/** MAIL-01: the thanks formula as a whole sentence. */
const SOLE_THANKS = /^(?:thank you|thanks)(?: (?:so|very) much)? for your time and consideration[.!]$/iu;

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
    const per = ctx.thresholds.wordsPerAnchor;
    if (total < per || anchors * per >= total) return [];
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
      return n > ctx.thresholds.longSentence[ctx.lang] ? [{ ruleId: 'EST-10', start: s.start, end: s.end, detail: `${n} words` }] : [];
    }),

  'EST-11': (ctx) => {
    const ps = prose(ctx);
    if (ps.length < ctx.thresholds.minSentencesForRhythm) return [];
    const cv = coefficientOfVariation(ps.map((s) => words(s.text).length));
    if (cv === null || cv >= ctx.thresholds.minRhythmCV) return [];
    return [{ ruleId: 'EST-11', ...wholeRange(ps), detail: `CV ${cv.toFixed(2)} over ${ps.length} sentences` }];
  },

  'FMT-05': (ctx) => {
    const budget = ctx.thresholds.colonBudget;
    return [...ctx.text.matchAll(/(?<=[\p{L}\p{N})\]])[ \t]*:[ \t]+(?=\p{Ll})/gu)]
      .slice(budget)
      .map((m) => {
        const at = m.index + m[0].indexOf(':');
        return { ruleId: 'FMT-05', start: at, end: at + 1, detail: `budget ${budget} per text` };
      });
  },

  'ORT-01': (ctx) => {
    if (ctx.lang !== 'es') return [];
    const marks = ([['¿', '?'], ['¡', '!']] as const).filter(([open]) => !ctx.thresholds.openingMarksFollowText || ctx.text.includes(open));
    return ctx.sentences.flatMap((s) => {
      const hits: StructuralHit[] = [];
      for (const [open, close] of marks) {
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
    const budget = ctx.thresholds.asideBudget;
    const tooMany = budget === 1 ? 'more than one aside between rayas' : `more than ${budget} asides between rayas`;
    for (const s of ctx.sentences) {
      const dashes = positions(s.text, '—').filter((p) => !(/\p{L}/u.test(s.text[p - 1] ?? '') && /\p{L}/u.test(s.text[p + 1] ?? '')));
      for (let i = 0; i + 1 < dashes.length; i += 2) {
        asides++;
        const p = dashes[i] ?? 0;
        if (asides > budget) hits.push({ ruleId: 'ORT-04', start: s.start + p, end: s.start + p + 1, detail: tooMany });
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
    const budget = ctx.thresholds.emDashBudget;
    return positions(ctx.text, '—')
      .slice(budget)
      .map((p) => ({ ruleId: 'ORT-05', start: p, end: p + 1, detail: `budget ${budget} per text` }));
  },

  'REG-01': (ctx) => {
    if (ctx.lang !== 'es') return [];
    const vos = [...ctx.text.matchAll(compile(VOSEO, 'giu'))];
    const tu = [...ctx.text.matchAll(compile(TUTEO, 'giu'))];
    // With a variety, every form of the other register is wrong, even when it is the only one used.
    if (ctx.variety !== undefined) {
      const wrong = ctx.variety === 'rioplatense' ? tu : vos;
      // The text may use one register only, so the catalog message about a mix would not fit.
      const expected = ctx.variety === 'rioplatense' ? 'voseo' : 'tuteo';
      const forms = ctx.variety === 'rioplatense' ? '"querés... podés"' : '"quieres... puedes"';
      const message = `The variety is ${ctx.variety}, which uses ${expected}.`;
      const suggestion = `Use the ${expected} forms: ${forms}.`;
      return wrong.map((m) => ({ ruleId: 'REG-01', start: m.index, end: m.index + m[0].length, message, suggestion }));
    }
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
    if (ws.length < ctx.thresholds.minWordsForNominalization) return [];
    const count = ws.filter((w) => NOMINALIZATION[ctx.lang].test(w.text)).length;
    if (count * ctx.thresholds.wordsPerNominalization <= ws.length) return [];
    return [{ ruleId: 'OFI-01', start: ws[0]?.start ?? 0, end: ws[ws.length - 1]?.end ?? 0, detail: `${count} in ${ws.length} words` }];
  },

  'MAIL-01': (ctx) => {
    if (ctx.lang !== 'en') return [];
    // The last prose sentence: a sign-off and a name are not prose, so they do not hide it.
    const last = prose(ctx).at(-1);
    if (last === undefined || !SOLE_THANKS.test(last.text)) return [];
    return [{ ruleId: 'MAIL-01', start: last.start, end: last.end }];
  },

  'SEG-03': (ctx) => {
    if (ctx.previous === undefined) return [];
    const n = COPIED_RUN + 1;
    const key = (ws: readonly Span[], i: number): string => ws.slice(i, i + n).map((w) => w.text.toLowerCase()).join(' ');
    const before = words(ctx.previous);
    const seen = new Set<string>();
    for (let i = 0; i + n <= before.length; i++) seen.add(key(before, i));
    const ws = words(ctx.text);
    const hits: StructuralHit[] = [];
    // Windows of n words found in the earlier message; overlapping windows join into one run.
    let i = 0;
    while (i + n <= ws.length) {
      if (!seen.has(key(ws, i))) {
        i++;
        continue;
      }
      let last = i;
      while (last + 1 + n <= ws.length && seen.has(key(ws, last + 1))) last++;
      const count = last - i + n;
      hits.push({ ruleId: 'SEG-03', start: ws[i]?.start ?? 0, end: ws[last + n - 1]?.end ?? 0, detail: `${count} words in a row from the earlier message` });
      i = last + n;
    }
    return hits;
  },

  'WA-03': (ctx) => {
    // The emoji that opens each non-blank line, or null; a blank line does not break a list.
    const markers: Array<{ start: number; end: number } | null> = [];
    let offset = 0;
    for (const line of ctx.text.split('\n')) {
      if (line.trim() !== '') {
        const emoji = EMOJI_BULLET.exec(line)?.[1];
        const start = emoji === undefined ? -1 : offset + line.indexOf(emoji);
        markers.push(emoji === undefined ? null : { start, end: start + emoji.length });
      }
      offset += line.length + 1;
    }
    // A bullet is an item of a list, so it takes two such lines in a row.
    return markers.flatMap((m, i) => (m !== null && (markers[i - 1] || markers[i + 1]) ? [{ ruleId: 'WA-03', ...m }] : []));
  },

  'MED-01': (ctx) => {
    if (ctx.lang !== 'es') return [];
    const budget = ctx.thresholds.menteBudget;
    return words(ctx.text)
      .filter((w) => /^\p{L}{3,}mente$/iu.test(w.text))
      .slice(budget)
      .map((w) => ({ ruleId: 'MED-01', start: w.start, end: w.end, detail: `budget ${budget} per text` }));
  },
};

export const STRUCTURAL_CHECK_IDS: readonly string[] = Object.keys(checks);

/** The checks whose one finding spans the whole prose of the document, so its match is the document. */
export const DOCUMENT_SCOPE_IDS: ReadonlySet<string> = new Set(['ESP-02', 'EST-11', 'OFI-01']);

export function runStructural(ruleId: string, ctx: StructuralContext): StructuralHit[] {
  const check = checks[ruleId];
  if (!check) throw new Error(`No structural check for ${ruleId}`);
  return check(ctx);
}
