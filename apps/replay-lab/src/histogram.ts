// The batch histogram as SVG: one bar per bin, a baseline, the tallest count on the y axis and a
// few bin edges on the x axis. Bars use currentColor, so light and dark themes come from CSS.

import type { Histogram } from '../../../deterministic-sim/src/index.ts';
import { s } from './dom.ts';

export const WIDTH = 400;
export const HEIGHT = 240;
const PAD = { top: 16, right: 12, bottom: 40, left: 44 };

export interface Bin {
  readonly from: number;
  /** Inclusive upper edge; the scores are integers. */
  readonly to: number;
  readonly count: number;
}

export function bins(histogram: Histogram): Bin[] {
  return histogram.counts.map((count, i) => {
    const from = histogram.start + i * histogram.width;
    return { from, to: from + histogram.width - 1, count };
  });
}

/** At most `max` evenly spaced bin indexes to label, always including the first. */
export function tickIndexes(binCount: number, max: number): number[] {
  const step = Math.max(1, Math.ceil(binCount / max));
  const out: number[] = [];
  for (let i = 0; i < binCount; i += step) out.push(i);
  return out;
}

export function describe(histogram: Histogram, label: string): string {
  const all = bins(histogram);
  const [first, ...rest] = all;
  if (!first) return `${label}: no runs.`;
  const total = all.reduce((sum, b) => sum + b.count, 0);
  const top = rest.reduce((best, b) => (b.count > best.count ? b : best), first);
  return `${label}: ${total.toLocaleString('en-US')} runs in ${all.length} bins of ${histogram.width}. The tallest bin is ${top.from} to ${top.to}, with ${top.count.toLocaleString('en-US')} runs.`;
}

export function histogramSvg(doc: Document, histogram: Histogram, label: string, id: string): SVGElement {
  const all = bins(histogram);
  const peak = Math.max(1, ...all.map((b) => b.count));
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const barW = plotW / Math.max(1, all.length);
  const baseY = PAD.top + plotH;

  const svg = s(doc, 'svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, class: 'histogram', role: 'img', 'aria-labelledby': `${id}-title ${id}-desc` });
  svg.append(s(doc, 'title', { id: `${id}-title` }, label), s(doc, 'desc', { id: `${id}-desc` }, describe(histogram, label)));

  const bars = s(doc, 'g', { class: 'bars' });
  all.forEach((b, i) => {
    const barH = (b.count / peak) * plotH;
    const rect = s(doc, 'rect', {
      x: (PAD.left + i * barW + 1).toFixed(2),
      y: (baseY - barH).toFixed(2),
      width: Math.max(1, barW - 2).toFixed(2),
      height: barH.toFixed(2),
    });
    rect.append(s(doc, 'title', {}, `${b.from} to ${b.to}: ${b.count} runs`));
    bars.append(rect);
  });
  svg.append(bars);

  const axes = s(doc, 'g', { class: 'axes' });
  axes.append(
    s(doc, 'line', { x1: PAD.left, y1: baseY, x2: WIDTH - PAD.right, y2: baseY }),
    s(doc, 'line', { x1: PAD.left, y1: PAD.top, x2: PAD.left, y2: baseY }),
    s(doc, 'text', { x: PAD.left - 6, y: PAD.top + 4, 'text-anchor': 'end' }, String(peak)),
    s(doc, 'text', { x: PAD.left - 6, y: baseY, 'text-anchor': 'end' }, '0'),
    s(doc, 'text', { x: PAD.left + plotW / 2, y: HEIGHT - 4, 'text-anchor': 'middle', class: 'axis-label' }, 'final score'),
  );
  for (const i of tickIndexes(all.length, 6)) {
    const b = all[i];
    if (!b) continue;
    axes.append(s(doc, 'text', { x: (PAD.left + i * barW).toFixed(2), y: baseY + 16, 'text-anchor': 'middle' }, String(b.from)));
  }
  svg.append(axes);
  return svg;
}
