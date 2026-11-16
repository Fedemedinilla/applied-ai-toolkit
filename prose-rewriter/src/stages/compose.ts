/**
 * S4 after S3 (design 4.4: S3 edits, then S4 styles). S4 reads the text as the checked S3 edits
 * left it, and its edits quote that text; this module turns each one back into an edit of the
 * original, so placement, S5, S6 and the judge keep working on edits that all quote the original:
 *
 * - a style edit that touches no live edit becomes the same edit on the original;
 * - a style edit that touches live edits (S3's) is merged with them into one edit, from the
 *   original's text under all of them to the text they produce together. The S3 edits it holds
 *   step aside (reverted, "merged into eN"); every check runs on the merged edit, and if it is
 *   refused or reverted the S3 edits come back (restoreMerged);
 * - two style edits whose quotes overlap each other still conflict: the second is refused, as
 *   applyEdits refuses an overlap. Two that only share an S3 edit are merged into the first;
 * - an edit whose text in the original is written more than once in its unit grows a word at a
 *   time until it sits there once (widen), and takes in the other style edits it reaches.
 *
 * Why: the first real-model eval run gave S4 the original text, and its edits on every sentence
 * S3 had edited were refused as overlaps (full 45, no-examples 39, edit-sonnet 44).
 *
 * Pure: no I/O, no model.
 */
import { renderEdits, type AppliedEdit, type Sentence, type TextRange } from '../edits.ts';
import type { Edit } from '../types.ts';
import type { Analysis } from './analyse.ts';
import { liveEdits, type Proposal } from './check.ts';

/**
 * A sentence of the text as the live edits leave it: the original sentences from `id` on that live
 * edits join (only in `reescritura`, where an edit may run past its sentence), with their range in
 * the original and in the current text.
 */
export interface CurrentSentence {
  readonly id: number;
  readonly orig: TextRange;
  readonly cur: TextRange;
  /** current.slice(cur.start, cur.end). */
  readonly text: string;
}

export interface Current {
  readonly text: string;
  readonly live: readonly AppliedEdit[];
  readonly sentences: readonly CurrentSentence[];
}

/** The text the live proposals produce, cut along the original's sentences. */
export function currentText(a: Analysis, units: readonly Sentence[], proposals: readonly Proposal[]): Current {
  const live = liveEdits(a, units, proposals);
  const text = renderEdits(a.text, live);
  const toCur = (p: number): number => p + live.filter((e) => e.span.end <= p).reduce((shift, e) => shift + e.after.length - e.before.length, 0);
  const groups: Array<{ id: number; start: number; end: number }> = [];
  for (const s of a.sentences) {
    const last = groups.at(-1);
    if (last !== undefined && live.some((e) => e.span.start < s.start && e.span.end > s.start)) {
      last.end = Math.max(last.end, s.end);
      continue;
    }
    groups.push({ id: s.id, start: s.start, end: s.end });
  }
  const sentences = groups.map((g) => {
    const end = Math.max(g.end, ...live.filter((e) => e.span.start >= g.start && e.span.start < g.end).map((e) => e.span.end));
    const cur = { start: toCur(g.start), end: toCur(end) };
    return { id: g.id, orig: { start: g.start, end }, cur, text: text.slice(cur.start, cur.end) };
  });
  return { text, live, sentences };
}

const intersects = (a: TextRange, b: TextRange): boolean => a.start < b.end && b.start < a.end;
const shiftOf = (e: AppliedEdit): number => e.after.length - e.before.length;

/** Where a quote starting at `qs` of the current text starts in the original, widened over the live edit it starts in. */
function startOf(live: readonly AppliedEdit[], qs: number): { orig: number; cur: number } {
  const inside = live.find((e) => e.newSpan.start <= qs && qs < e.newSpan.end);
  if (inside !== undefined) return { orig: inside.span.start, cur: inside.newSpan.start };
  return { orig: qs - live.filter((e) => e.newSpan.end <= qs).reduce((s, e) => s + shiftOf(e), 0), cur: qs };
}

/** Where a quote ending at `qe` of the current text ends in the original, widened over the live edit it ends in. */
function endOf(live: readonly AppliedEdit[], qe: number): { orig: number; cur: number } {
  const inside = live.find((e) => e.newSpan.start < qe && qe <= e.newSpan.end);
  if (inside !== undefined) return { orig: inside.span.end, cur: inside.newSpan.end };
  return { orig: qe - live.filter((e) => e.newSpan.end < qe).reduce((s, e) => s + shiftOf(e), 0), cur: qe };
}

/** Every place `needle` starts in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) out.push(at);
  return out;
}

interface Cluster {
  readonly head: Proposal;
  readonly sentence: CurrentSentence;
  orig: TextRange;
  cur: TextRange;
  /** The style edits' quotes in the current text, with their replacements. */
  readonly quotes: Array<TextRange & { after: string; id: string; drop: boolean }>;
}

/**
 * Turns the fresh style proposals, which quote `current`, into edits of the original (see the
 * header). Refused ones are marked 'refused'; merged S3 proposals are marked 'reverted' with
 * `mergedInto`. Call before place().
 */
export function composeStyle(a: Analysis, units: readonly Sentence[], proposals: readonly Proposal[], current: Current, fresh: readonly Proposal[]): void {
  const clusters: Cluster[] = [];
  const refuse = (p: Proposal, message: string): void => {
    p.status = 'refused';
    p.reason = message;
    p.before = p.edit.before.normalize('NFC');
    p.after = p.edit.after.normalize('NFC');
  };
  for (const p of fresh) {
    if (p.status !== 'live') continue;
    const sentence = current.sentences.find((s) => s.id === p.edit.sentenceId);
    const before = p.edit.before.normalize('NFC');
    const places = sentence === undefined ? [] : occurrences(sentence.text, before);
    if (sentence === undefined || places.length === 0) {
      refuse(p, `"${p.edit.before}" is not in sentence ${p.edit.sentenceId}`);
      continue;
    }
    if (places.length > 1) {
      refuse(p, `"${p.edit.before}" appears ${places.length} times in sentence ${p.edit.sentenceId}`);
      continue;
    }
    const quote = { start: sentence.cur.start + (places[0] as number), end: sentence.cur.start + (places[0] as number) + before.length };
    const conflict = clusters.find((c) => c.quotes.some((q) => intersects(q, quote)));
    if (conflict !== undefined) {
      const other = conflict.quotes.find((q) => intersects(q, quote));
      refuse(p, `the edit overlaps ${other?.id ?? conflict.head.id}, accepted before it`);
      continue;
    }
    const s = startOf(current.live, quote.start);
    const e = endOf(current.live, quote.end);
    const entry = { ...quote, after: p.edit.after.normalize('NFC'), id: p.id, drop: p.edit.drop === true };
    const joined = clusters.filter((c) => c.sentence === sentence && c.cur.start < e.cur && s.cur < c.cur.end);
    const [first, ...rest] = joined;
    if (first === undefined) {
      clusters.push({ head: p, sentence, orig: { start: s.orig, end: e.orig }, cur: { start: s.cur, end: e.cur }, quotes: [entry] });
      continue;
    }
    for (const c of [...rest]) {
      first.quotes.push(...c.quotes);
      clusters.splice(clusters.indexOf(c), 1);
    }
    first.quotes.push(entry);
    first.orig = { start: Math.min(s.orig, ...joined.map((c) => c.orig.start)), end: Math.max(e.orig, ...joined.map((c) => c.orig.end)) };
    first.cur = { start: Math.min(s.cur, ...joined.map((c) => c.cur.start)), end: Math.max(e.cur, ...joined.map((c) => c.cur.end)) };
  }

  // The quote of the original must sit once in its unit, where code places it. A cluster whose
  // quote does not grows a word at a time, and takes in the clusters it reaches.
  const ready: Cluster[] = [];
  for (const c of [...clusters]) {
    if (!clusters.includes(c)) continue;
    const unit = units.find((u) => u.id === c.sentence.id);
    if (unit === undefined) {
      refuse(c.head, `there is no sentence ${c.sentence.id}`);
      continue;
    }
    widen(a, current, clusters, c, unit.text);
    ready.push(c);
  }

  for (const c of ready.filter((r) => clusters.includes(r))) {
    const merged = current.live.filter((e) => c.orig.start <= e.span.start && e.span.end <= c.orig.end);
    const shifted = merged.map((m) => ({ ...m, span: { start: m.span.start - c.orig.start, end: m.span.end - c.orig.start } }));
    if (renderEdits(a.text.slice(c.orig.start, c.orig.end), shifted) !== current.text.slice(c.cur.start, c.cur.end)) {
      throw new Error(`style edit ${c.head.id}: its range of the original does not map onto the current text`);
    }
    let after = current.text.slice(c.cur.start, c.cur.end);
    for (const q of [...c.quotes].sort((x, y) => y.start - x.start)) after = after.slice(0, q.start - c.cur.start) + q.after + after.slice(q.end - c.cur.start);
    const held = merged.map((m) => proposals.find((q) => q.id === m.id)).filter((q): q is Proposal => q !== undefined);
    const ruleId = c.head.edit.ruleId ?? held.find((q) => q.edit.ruleId !== undefined)?.edit.ruleId;
    const drop = c.quotes.some((q) => q.drop) || held.some((q) => q.edit.drop === true);
    const edit: Edit = {
      sentenceId: c.sentence.id,
      before: a.text.slice(c.orig.start, c.orig.end),
      after,
      reason: c.head.edit.reason,
      ...(ruleId === undefined ? {} : { ruleId }),
      ...(c.head.edit.principleId === undefined ? {} : { principleId: c.head.edit.principleId }),
      ...(drop ? { drop: true } : {}),
    };
    c.head.edit = edit;
    for (const q of held) {
      q.status = 'reverted';
      q.reason = `merged into ${c.head.id}`;
      q.mergedInto = c.head.id;
    }
    for (const q of c.quotes.slice(1)) {
      const member = fresh.find((f) => f.id === q.id);
      if (member === undefined || member === c.head) continue;
      member.status = 'reverted';
      member.reason = `merged into ${c.head.id}`;
      member.mergedInto = c.head.id;
    }
  }
}

/**
 * Grows `c` over the original a word at a time, left then right, until its text sits once in
 * `unit` (at most to its whole sentence), never ending inside a live edit. Each other cluster of
 * the sentence it then reaches is merged into it, so it is not refused as an overlap.
 *
 * Why: widening straight to the whole sentence refused the other style edits of that sentence as
 * overlaps, and a keep[] phrase no edit touched, as soon as a short quote ("the proposal for")
 * was written twice in the unit.
 */
function widen(a: Analysis, current: Current, clusters: Cluster[], c: Cluster, unit: string): void {
  const bounds = c.sentence.orig;
  const once = (): boolean => occurrences(unit, a.text.slice(c.orig.start, c.orig.end)).length === 1;
  const live = current.live;
  // An insertion at a boundary falls inside the range, as renderEdits applies it there.
  const toCur = (p: number, side: 'start' | 'end'): number =>
    p + live.filter((e) => e.span.end < p || (e.span.end === p && (side === 'end' || e.span.start < p))).reduce((shift, e) => shift + shiftOf(e), 0);
  const word = /\S/u;
  while (!once() && (c.orig.start > bounds.start || c.orig.end < bounds.end)) {
    let start = c.orig.start;
    while (start > bounds.start && !word.test(a.text[start - 1] ?? '')) start--;
    while (start > bounds.start && word.test(a.text[start - 1] ?? '')) start--;
    start = live.find((e) => e.span.start < start && start < e.span.end)?.span.start ?? start;
    if (start < c.orig.start) c.orig = { start, end: c.orig.end };
    else {
      let end = c.orig.end;
      while (end < bounds.end && !word.test(a.text[end] ?? '')) end++;
      while (end < bounds.end && word.test(a.text[end] ?? '')) end++;
      end = live.find((e) => e.span.start < end && end < e.span.end)?.span.end ?? end;
      c.orig = { start: c.orig.start, end };
    }
    c.cur = { start: toCur(c.orig.start, 'start'), end: toCur(c.orig.end, 'end') };
  }
  if (!once()) {
    c.orig = c.sentence.orig;
    c.cur = c.sentence.cur;
  }
  for (let other = reached(); other !== undefined; other = reached()) {
    c.quotes.push(...other.quotes);
    c.orig = { start: Math.min(c.orig.start, other.orig.start), end: Math.max(c.orig.end, other.orig.end) };
    c.cur = { start: Math.min(c.cur.start, other.cur.start), end: Math.max(c.cur.end, other.cur.end) };
    clusters.splice(clusters.indexOf(other), 1);
  }
  function reached(): Cluster | undefined {
    return clusters.find((o) => o !== c && o.sentence === c.sentence && intersects(o.cur, c.cur));
  }
}

/**
 * The proposals merged into a composed edit that is no longer live, back to live: the caller
 * places and checks them again. Returns them.
 */
export function restoreMerged(proposals: readonly Proposal[], composed: readonly Proposal[]): Proposal[] {
  const gone = new Set(composed.filter((p) => p.status !== 'live').map((p) => p.id));
  const back = proposals.filter((p) => p.mergedInto !== undefined && gone.has(p.mergedInto) && p.stage === 'edit');
  for (const p of back) {
    p.status = 'live';
    delete p.reason;
    delete p.mergedInto;
  }
  return back;
}
