// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { bins, describe as describeHistogram, histogramSvg, tickIndexes } from '../src/histogram.ts';

const HIST = { start: 100, width: 20, counts: [2, 10, 5, 0, 1] };

describe('histogram', () => {
  it('bins carry inclusive integer edges', () => {
    expect(bins(HIST)).toEqual([
      { from: 100, to: 119, count: 2 },
      { from: 120, to: 139, count: 10 },
      { from: 140, to: 159, count: 5 },
      { from: 160, to: 179, count: 0 },
      { from: 180, to: 199, count: 1 },
    ]);
  });

  it('labels at most the requested number of ticks, always from the first bin', () => {
    expect(tickIndexes(5, 6)).toEqual([0, 1, 2, 3, 4]);
    expect(tickIndexes(13, 6)).toEqual([0, 3, 6, 9, 12]);
    expect(tickIndexes(1, 6)).toEqual([0]);
  });

  it('draws one bar per bin, scaled to the tallest, with a text alternative', () => {
    const svg = histogramSvg(document, HIST, 'Final score', 'h1');
    const rects = [...svg.querySelectorAll('.bars rect')];
    expect(rects).toHaveLength(5);
    const heights = rects.map((r) => Number(r.getAttribute('height')));
    expect(Math.max(...heights)).toBe(heights[1]);
    expect(heights[3]).toBe(0);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-labelledby')).toBe('h1-title h1-desc');
    expect(svg.querySelector('#h1-desc')?.textContent).toBe(describeHistogram(HIST, 'Final score'));
    expect(svg.querySelector('#h1-desc')?.textContent).toContain('The tallest bin is 120 to 139, with 10 runs.');
    expect(rects[1]?.querySelector('title')?.textContent).toBe('120 to 139: 10 runs');
    expect(svg.textContent).toContain('final score');
  });

  it('uses no inline style, so it works under a strict style-src policy', () => {
    const svg = histogramSvg(document, HIST, 'x', 'h2');
    expect(svg.querySelectorAll('[style]')).toHaveLength(0);
  });
});
