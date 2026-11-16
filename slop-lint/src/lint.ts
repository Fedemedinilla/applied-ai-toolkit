import { compile } from './regex.ts';
import { DEFAULT_GENRE, GENRE_PROFILES, resolveRules } from './genres.ts';
import { messageFor } from './messages.ts';
import { RULES } from './rules.ts';
import { blockSentences, maskMarkdown, type MarkdownView } from './markdown.ts';
import { applyDirectives } from './suppress.ts';
import { coefficientOfVariation, runStructural } from './structural.ts';
import { countAnchors, isProse, lineColumn, lineStarts, quotedRanges, splitSentences, words, type Span } from './text.ts';
import type { Finding, Genre, Lang, LintOptions, LintResult, PatternRule, Rule, Severity, StructuralRule } from './types.ts';

interface Hit {
  rule: Rule;
  order: number;
  start: number;
  end: number;
  detail?: string;
  /** Set for a match of the rule's weaker alternatives, which carry their own severity. */
  severity?: Severity;
  /** A structural hit's own wording, which replaces the rule's message and suggestion. */
  message?: string;
  suggestion?: string;
}

/** Whether the rule runs on a text of this language and genre. A rule the genre's profile turns off does not. */
export function appliesTo(rule: Rule, lang: Lang, genre: Genre = DEFAULT_GENRE): boolean {
  return (rule.lang === lang || rule.lang === 'both') && GENRE_PROFILES[genre].rules[rule.id] !== 'off';
}

/**
 * Raw matches of one pattern rule, before anchors, quotes, overlaps and budgets are
 * taken into account. Sentence-start rules are tested against each sentence.
 */
export function rawMatches(
  rule: PatternRule,
  text: string,
  lang: Lang,
  sentences = splitSentences(text),
): Array<{ start: number; end: number; severity?: Severity }> {
  const source = rule.patterns[lang];
  if (source === undefined || !appliesTo(rule, lang)) return [];
  const all = (src: string): Array<{ start: number; end: number; severity?: Severity }> => {
    const re = compile(src, rule.flags);
    if (rule.sentenceStart) {
      return sentences.flatMap((s) => {
        const m = [...s.text.matchAll(re)].find((x) => x.index === 0 && x[0].length > 0);
        return m ? [{ start: s.start, end: s.start + m[0].length }] : [];
      });
    }
    return [...text.matchAll(re)].filter((m) => m[0].length > 0).map((m) => ({ start: m.index, end: m.index + m[0].length }));
  };
  const hits = all(source);
  const closing = rule.closingPatterns?.[lang];
  if (closing !== undefined) {
    const closingFrom = sentences.filter(isProse).slice(-2)[0]?.start ?? Infinity;
    hits.push(...all(closing).filter((m) => m.start >= closingFrom));
  }
  const weaker = rule.weaker;
  const weakerSource = weaker?.patterns[lang];
  if (weaker !== undefined && weakerSource !== undefined) {
    hits.push(...all(weakerSource).map((m) => ({ ...m, severity: weaker.severity })));
  }
  if (hits.length > 0 && (closing !== undefined || weakerSource !== undefined)) hits.sort((x, y) => x.start - y.start);
  return hits;
}

function sentenceIndexAt(sentences: readonly Span[], offset: number): number {
  let lo = 0;
  let hi = sentences.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sentences[mid];
    if (!s) break;
    if (offset < s.start) hi = mid - 1;
    else if (offset >= s.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Drops a hit when another hit covers its whole span with a stricter or equal level:
 * "passionate" (ESP-04) inside "passionate about" (LEX-03), or "ultimately" (LEX-04)
 * inside "ultimately," (EST-05). On an identical span and level the earlier rule in
 * the catalog wins. Each piece of text is charged once.
 */
function dropCovered(hits: readonly Hit[]): Hit[] {
  return hits.filter(
    (h) =>
      !hits.some((g) => {
        if (g === h || g.start > h.start || g.end < h.end) return false;
        if (g.rule.level !== h.rule.level) return g.rule.level < h.rule.level;
        const longer = g.end - g.start > h.end - h.start;
        return longer || (g.end - g.start === h.end - h.start && g.order < h.order);
      }),
  );
}

const PENALTY: Record<Severity, number> = { disqualify: 15, high: 3, medium: 1.5, low: 0.5 };

function score(findings: readonly Finding[]): number {
  if (findings.some((f) => f.severity === 'disqualify')) return 0;
  if (findings.filter((f) => f.severity === 'high').length >= 3) return 0;
  const penalty = findings.reduce((sum, f) => sum + PENALTY[f.severity], 0);
  return Math.max(0, 15 - penalty);
}

/**
 * Lints plain text, or Markdown with `format: 'markdown'`. Pure: same input, same
 * output, no I/O.
 *
 * Level 1 hits are always reported. Level 2 hits are reported once their rule's
 * budget is spent; Tier 2 words share one budget of two per text with no word
 * repeated. Level 3 words are dropped when their sentence has an anchor and
 * otherwise join the Tier 2 budget.
 *
 * In Markdown mode the rules run on a masked copy of the input (see markdown.ts) with
 * the same length, so every offset, line and column points into the input, and each
 * finding's match is the input's text at those offsets.
 *
 * Markdown mode also reads the inline directives. One that names rule ids moves the findings
 * of those rules to `suppressed` (see suppress.ts). Plain text has no directive syntax: it is
 * the text as it will be sent, so a marker in it would be part of the letter.
 */
export function lint(source: string, options: LintOptions): LintResult {
  if (options.format === 'markdown') {
    const view = maskMarkdown(source, { mask: options.suppressions?.mask ?? true });
    const sentences = blockSentences(view);
    // EST-10 flags a sentence over 35 words (40 in Spanish). As plain text, a Markdown
    // file distorts it two ways. A line that starts in lowercase continues the sentence
    // above it, so a list of lowercase items, a table or a code block reads as one
    // sentence of a hundred words; blockSentences() fixes that for every rule by never
    // letting a sentence cross a block. And a list item is not always prose: in these
    // READMEs a one-sentence item is usually a label and an inventory ("`lint.test.ts`:
    // the shared Tier 2 budget, ..., empty input"), whose length is the length of the
    // list it documents. So EST-10 reads paragraphs, and list items with two or more
    // prose sentences, which are paragraphs written as bullets and where a long sentence
    // costs the reader the same. Headings, quotes and one-sentence items are left out.
    const prose = view.blocks.filter(
      (b) => b.kind === 'paragraph' || (b.kind === 'list' && sentences.filter((s) => s.start >= b.start && s.end <= b.end && isProse(s)).length >= 2),
    );
    const longSentenceScope = sentences.filter((s) => prose.some((b) => s.start >= b.start && s.end <= b.end));
    // Inline code is masked, but a file name, a command or a field name is something a
    // reader can check, which is what an anchor is. Each code span counts as one.
    const codeIn = (s: Span): number => view.code.filter(([a]) => a >= s.start && a < s.end).length;
    return run(source, view.text, sentences, options, { markdown: true, longSentenceScope, extraAnchorsIn: codeIn, view });
  }
  const sentences = splitSentences(source);
  return run(source, source, sentences, options, { markdown: false, longSentenceScope: sentences, extraAnchorsIn: () => 0 });
}

interface Mode {
  markdown: boolean;
  /** The sentences EST-10 measures. */
  longSentenceScope: readonly Span[];
  /** Anchors the masked text no longer shows, per sentence. */
  extraAnchorsIn: (sentence: Span) => number;
  /** The masked document, whose directives are applied to the findings. Absent in text mode. */
  view?: MarkdownView;
}

/** `text` is what the rules read; `source` is the input, which findings quote. Both have the same length. */
function run(source: string, text: string, sentences: Span[], options: LintOptions, mode: Mode): LintResult {
  const { lang } = options;
  const genre = options.genre ?? DEFAULT_GENRE;
  const profile = GENRE_PROFILES[genre];
  const tier2Budget = profile.tier2Budget;
  // The catalog with the genre's profile, unless the caller passes its own list, as the CLI does
  // for a config file; that list already holds the profile (settingsFor applies it) and is used as given.
  const rules = options.rules ?? (genre === DEFAULT_GENRE ? RULES : resolveRules(RULES, genre));
  const patternRules = rules.filter((r): r is PatternRule => r.kind === 'pattern');
  const structuralRules = rules.filter((r): r is StructuralRule => r.kind === 'structural');
  const extraAnchors = options.anchors ?? [];
  const active = (rule: Rule): boolean => !(mode.markdown && rule.plainTextOnly);
  const anchorCache = new Map<number, number>();
  const anchorsIn = (s: Span): number => {
    let n = anchorCache.get(s.start);
    if (n === undefined) {
      n = countAnchors(s.text, lang, extraAnchors) + mode.extraAnchorsIn(s);
      anchorCache.set(s.start, n);
    }
    return n;
  };
  const quotes = quotedRanges(text);
  const inQuotes = (start: number, end: number): boolean => quotes.some(([a, b]) => start >= a && end <= b);

  const hits: Hit[] = [];
  patternRules.forEach((rule, order) => {
    if (!active(rule)) return;
    for (const m of rawMatches(rule, text, lang, sentences)) {
      if (rule.quoteExempt && inQuotes(m.start, m.end)) continue;
      if (rule.anchorExempt || rule.level === 3) {
        const s = sentences[sentenceIndexAt(sentences, m.start)];
        if (s && anchorsIn(s) > 0) continue;
      }
      hits.push({ rule, order, ...m });
    }
  });

  const kept = dropCovered(hits).sort((a, b) => a.start - b.start || a.order - b.order);
  const reported: Hit[] = [];

  // A level 1 rule always fails the run, so a pool rule a config raised to level 1 leaves the budget.
  const pool = kept.filter((h) => h.rule.level !== 1 && (h.rule.level === 3 || (h.rule.kind === 'pattern' && h.rule.tier2Pool)));
  const seen = new Set<string>();
  pool.forEach((h, index) => {
    const key = text.slice(h.start, h.end).toLowerCase().replace(/\s+/gu, ' ');
    const repeated = seen.has(key);
    seen.add(key);
    if (repeated) reported.push({ ...h, detail: `"${key}" repeated; Tier 2 words may not repeat` });
    else if (index >= tier2Budget) reported.push({ ...h, detail: `Tier 2 word ${index + 1}; the budget is ${tier2Budget} per text` });
  });

  const perRule = new Map<string, number>();
  for (const h of kept) {
    if (pool.includes(h)) continue;
    if (h.rule.level === 1) {
      reported.push(h);
      continue;
    }
    const budget = h.rule.kind === 'pattern' ? (h.rule.budget ?? 0) : 0;
    const n = perRule.get(h.rule.id) ?? 0;
    perRule.set(h.rule.id, n + 1);
    if (n >= budget) reported.push(budget > 0 ? { ...h, detail: `budget ${budget} per text` } : h);
  }

  const ctx = {
    text,
    lang,
    sentences,
    anchorsIn,
    longSentenceScope: mode.longSentenceScope,
    thresholds: profile.thresholds,
    ...(options.variety === undefined ? {} : { variety: options.variety }),
    ...(options.previous === undefined ? {} : { previous: options.previous }),
  };
  structuralRules.forEach((rule, i) => {
    if (!appliesTo(rule, lang) || !active(rule)) return;
    for (const s of runStructural(rule.id, ctx)) {
      const hit: Hit = { rule, order: patternRules.length + i, start: s.start, end: s.end };
      if (s.detail !== undefined) hit.detail = s.detail;
      if (s.message !== undefined) hit.message = s.message;
      if (s.suggestion !== undefined) hit.suggestion = s.suggestion;
      reported.push(hit);
    }
  });

  const starts = lineStarts(text);
  const all: Finding[] = reported
    .sort((a, b) => a.start - b.start || a.rule.level - b.rule.level || a.order - b.order)
    .map((h) => {
      const { line, column } = lineColumn(starts, h.start);
      const f: Finding = {
        ruleId: h.rule.id,
        level: h.rule.level,
        severity: h.severity ?? h.rule.severity,
        start: h.start,
        end: h.end,
        line,
        column,
        match: source.slice(h.start, h.end),
        message: h.message ?? messageFor(h.rule, genre),
        suggestion: h.suggestion ?? h.rule.suggestion,
      };
      if (h.detail !== undefined) f.detail = h.detail;
      return f;
    });

  // Directives are applied last, on finished findings: a suppressed hit has already spent its
  // rule's budget and its place in the Tier 2 pool, so suppressing it never changes another finding.
  // Only the rules that ran can be named: a rule of the other language, or a plain-text rule in
  // Markdown, is SUP-03, not an unused SUP-01.
  const view = mode.view;
  const applied =
    view && (view.directives.length > 0 || view.directiveIssues.length > 0)
      ? applyDirectives(all, view.directives, view.directiveIssues, rules.filter((r) => appliesTo(r, lang) && active(r)), { allowDisqualify: options.suppressions?.allowDisqualify ?? false }, source, starts)
      : { kept: all, suppressed: [], problems: [] };
  const findings = applied.kept;

  const prose = sentences.filter(isProse);
  const lengths = prose.map((s) => words(s.text).length);
  return {
    lang,
    findings,
    passesTier1: !findings.some((f) => f.level === 1),
    disqualified: findings.some((f) => f.severity === 'disqualify'),
    score: { points: score(findings), max: 15 },
    stats: {
      words: words(text).length,
      sentences: sentences.length,
      proseSentences: prose.length,
      meanSentenceLength: lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : null,
      sentenceLengthCV: coefficientOfVariation(lengths),
      emDashes: (text.match(/—/gu) ?? []).length,
      anchors: prose.reduce((n, s) => n + anchorsIn(s), 0),
      tier2Used: pool.length,
      tier2Budget,
    },
    ...(applied.suppressed.length > 0 ? { suppressed: applied.suppressed } : {}),
    ...(applied.problems.length > 0 ? { directiveProblems: applied.problems } : {}),
    ...(genre === DEFAULT_GENRE ? {} : { genre }),
    ...(options.variety === undefined ? {} : { variety: options.variety }),
  };
}

export { RULES };
export { GENRES, GENRE_PROFILES, guessGenre, resolveRules, type GenreGuess, type GenreProfile } from './genres.ts';
