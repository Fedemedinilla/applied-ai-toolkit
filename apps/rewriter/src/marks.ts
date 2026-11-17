// Cuts a text into pieces at every finding boundary, so the page can highlight slop-lint's
// findings even when they overlap or nest. Each piece names, by index, the findings that cover it.
// A finding with no length (a structural check over the whole text) gets no highlight; the page
// still lists it.

export interface Marked {
  readonly text: string;
  /** Indices into the findings array, ascending. */
  readonly marks: readonly number[];
}

export function markSegments(text: string, findings: ReadonlyArray<{ readonly start: number; readonly end: number }>): Marked[] {
  const spans = findings.map((f) => ({ start: Math.max(0, Math.min(f.start, text.length)), end: Math.max(0, Math.min(f.end, text.length)) }));
  const cuts = new Set<number>([0, text.length]);
  for (const s of spans) {
    if (s.end > s.start) {
      cuts.add(s.start);
      cuts.add(s.end);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Marked[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1] ?? 0;
    const to = points[i] ?? 0;
    if (to <= from) continue;
    const marks = spans.flatMap((s, index) => (s.end > s.start && s.start <= from && s.end >= to ? [index] : []));
    const last = out.at(-1);
    // Two neighbours with the same marks become one piece.
    if (last !== undefined && last.marks.join() === marks.join()) out[out.length - 1] = { text: last.text + text.slice(from, to), marks };
    else out.push({ text: text.slice(from, to), marks });
  }
  return out.length === 0 ? [{ text, marks: [] }] : out;
}
