// The original is shown with slop-lint's findings highlighted. Findings may overlap, nest or touch;
// the text is cut at every boundary and each piece lists the findings that cover it.

import { describe, expect, it } from 'vitest';
import { markSegments } from '../src/marks.ts';

const finding = (start: number, end: number, ruleId = 'LEX-01') => ({ start, end, ruleId });

describe('markSegments', () => {
  it('returns the text as one plain piece when there is no finding', () => {
    expect(markSegments('hola', [])).toEqual([{ text: 'hola', marks: [] }]);
  });

  it('cuts around one finding', () => {
    expect(markSegments('ab cd ef', [finding(3, 5)])).toEqual([
      { text: 'ab ', marks: [] },
      { text: 'cd', marks: [0] },
      { text: ' ef', marks: [] },
    ]);
  });

  it('splits overlapping findings at each boundary, naming both where they overlap', () => {
    expect(markSegments('abcdef', [finding(1, 4), finding(2, 6, 'ESP-04')])).toEqual([
      { text: 'a', marks: [] },
      { text: 'b', marks: [0] },
      { text: 'cd', marks: [0, 1] },
      { text: 'ef', marks: [1] },
    ]);
  });

  it('keeps touching findings apart and a nested one inside', () => {
    expect(markSegments('abcd', [finding(0, 2), finding(2, 4), finding(0, 4)]).map((s) => [s.text, s.marks])).toEqual([
      ['ab', [0, 2]],
      ['cd', [1, 2]],
    ]);
  });

  it('leaves out empty findings and clamps spans to the text', () => {
    expect(markSegments('abc', [finding(1, 1), finding(2, 99)])).toEqual([
      { text: 'ab', marks: [] },
      { text: 'c', marks: [1] },
    ]);
  });

  it('never cuts a surrogate pair: offsets are UTF-16, as slop-lint gives them', () => {
    const text = 'Hola 😂 sinergias';
    const start = text.indexOf('sinergias');
    const out = markSegments(text, [finding(start, start + 9)]);
    expect(out.map((s) => s.text).join('')).toBe(text);
    expect(out[1]).toEqual({ text: 'sinergias', marks: [0] });
  });
});
