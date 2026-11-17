// The text the user ends up with, rebuilt in the page from the original and the changes they
// keep. Pure, with no model: a change the user reverts gives back the original's own words at its
// span, so reverting can only remove what the rewrite added, never add a fact. A change the
// checks reverted (status 'reverted') is never placed, whatever the page asks.
//
// Spans are UTF-16 offsets into the original as the rewriter read it (NFC), as
// String.prototype.slice takes them. prose-rewriter places no two applied edits over the same
// text; a result where they overlap, or where an applied change's span does not hold its
// "before", is refused instead of rebuilt by guessing.

import type { ResultChange } from './result.ts';

export type Piece =
  | { readonly kind: 'same'; readonly text: string }
  /** A change the user keeps: `text` is the rewrite's words, `before` the original's. */
  | { readonly kind: 'changed'; readonly id: string; readonly text: string; readonly before: string }
  /** A change the user reverted: `text` is the original's words. */
  | { readonly kind: 'restored'; readonly id: string; readonly text: string };

export type RecomposeProblem = 'out-of-range' | 'before-mismatch' | 'overlap' | 'duplicate-id';

export type Recomposed = { readonly ok: true; readonly text: string; readonly pieces: readonly Piece[] } | { readonly ok: false; readonly reason: RecomposeProblem };

/** The first problem with the changes against this original, or null. */
export function problemOf(original: string, changes: readonly ResultChange[]): RecomposeProblem | null {
  // Only applied changes are placed, so only theirs are checked. A reverted change may be an edit
  // the code could not place: prose-rewriter then spans the sentence the model named (or {0,0})
  // and keeps the model's quote as "before", which that span does not hold by construction.
  const applied = changes.filter((c) => c.status === 'applied');
  for (const c of applied) {
    const { start, end } = c.span;
    if (start > end || end > original.length) return 'out-of-range';
    if (original.slice(start, end) !== c.before) return 'before-mismatch';
  }
  if (new Set(applied.map((c) => c.id)).size !== applied.length) return 'duplicate-id';
  const sorted = [...applied].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (prev !== undefined && next !== undefined && next.span.start < prev.span.end) return 'overlap';
  }
  return null;
}

export function recompose(original: string, changes: readonly ResultChange[], accepted: ReadonlySet<string>): Recomposed {
  const problem = problemOf(original, changes);
  if (problem !== null) return { ok: false, reason: problem };
  // A stable sort keeps two insertions at one offset in the order the rewriter listed them.
  const applied = changes.filter((c) => c.status === 'applied').sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  const pieces: Piece[] = [];
  let at = 0;
  for (const c of applied) {
    if (c.span.start > at) pieces.push({ kind: 'same', text: original.slice(at, c.span.start) });
    pieces.push(accepted.has(c.id) ? { kind: 'changed', id: c.id, text: c.after, before: c.before } : { kind: 'restored', id: c.id, text: c.before });
    at = c.span.end;
  }
  if (at < original.length) pieces.push({ kind: 'same', text: original.slice(at) });
  return { ok: true, text: pieces.map((p) => p.text).join(''), pieces };
}

/** The ids of the changes the rewrite applied: what the page starts with as kept. */
export const appliedIds = (changes: readonly ResultChange[]): Set<string> => new Set(changes.filter((c) => c.status === 'applied').map((c) => c.id));
