// How a check's state becomes one of five colours, the counts with their denominator, and the
// palette with the contrast each value has to meet. Nothing here is picked by eye: the colour comes
// from a fixed table, and test/colours.test.ts measures every palette pair against WCAG 2.2.

import type { Catalogue, Item } from './catalogue.ts';
import { applies, type Baseline, type Run, type State } from './run.ts';

export const COLOURS = ['red', 'yellow', 'blue', 'green', 'grey'] as const;
export type Colour = (typeof COLOURS)[number];

/** Reading order is the order above: urgent first, grey last. The shape carries the meaning without colour. */
export const COLOUR_INFO: Readonly<Record<Colour, { label: string; shape: string; meaning: string; count: (n: number) => string }>> = {
  red: { label: 'Fix now', shape: '▲', meaning: 'A confirmed failure that exposes the site, its data or its mail', count: (n) => `${n} to fix now` },
  yellow: { label: 'Review', shape: '■', meaning: 'A failure worth fixing, or a pass with a weighty note', count: (n) => `${n} to review` },
  blue: {
    label: 'Optional improvement',
    shape: '◆',
    meaning: 'Helps the site look, load or rank better; not a risk',
    count: (n) => `${n} optional ${n === 1 ? 'improvement' : 'improvements'}`,
  },
  green: { label: 'Good', shape: '●', meaning: 'Verified and passed, with evidence', count: (n) => `${n} good` },
  grey: { label: 'Could not check', shape: '○', meaning: 'Not verified: no access, a browser test still to do, a tool that did not answer, or no evidence', count: (n) => `${n} not checked` },
};

export type GreyReason = 'not_marked' | 'not_verified' | 'no_evidence';

export interface Derived {
  /** null: not applicable, which is not shown and not counted. */
  readonly colour: Colour | null;
  readonly grey: GreyReason | null;
  /** The written reason when an exception or an owner decision set the colour. */
  readonly note: string | null;
}

/**
 * Fixed exceptions to the table, each with the reason written next to the colour. A contact path
 * that does not work is yellow, not blue, because the visitor's message is lost; a noindex on the
 * home hides the whole site.
 */
export const COLOUR_EXCEPTIONS: Readonly<Record<string, { readonly state: State; readonly colour: Colour; readonly note: string }>> = {
  'VIS-01': { state: 'fail', colour: 'red', note: 'colour adjusted: the whole site asks not to appear in search results' },
  'VIS-18': { state: 'fail', colour: 'yellow', note: 'colour adjusted: a contact path that does not work; the chat does not open' },
  'VIS-21': { state: 'fail', colour: 'yellow', note: 'colour adjusted: a contact path that does not work; mail to that address bounces' },
};

const highOrCritical = (item: Pick<Item, 'priority'>): boolean => item.priority === 'Critical' || item.priority === 'High';

/**
 * The colour table. `evidence` matters for green only: a green without evidence does not exist, so
 * it is grey until the evidence note says what proves it.
 */
export function deriveColour(item: Pick<Item, 'id' | 'area' | 'priority'>, state: State | null, evidence: string): Derived {
  if (state === null) return { colour: 'grey', grey: 'not_marked', note: null };
  const exception = COLOUR_EXCEPTIONS[item.id];
  if (exception && exception.state === state) return { colour: exception.colour, grey: null, note: exception.note };
  switch (state) {
    case 'pass':
    case 'fixed':
      return evidence.trim() ? { colour: 'green', grey: null, note: null } : { colour: 'grey', grey: 'no_evidence', note: null };
    case 'fail':
      if (item.area === 'visibility') return { colour: 'blue', grey: null, note: null };
      if (item.area === 'speed') return { colour: 'yellow', grey: null, note: null };
      return { colour: highOrCritical(item) ? 'red' : 'yellow', grey: null, note: null };
    case 'pass_with_note':
      return { colour: highOrCritical(item) ? 'yellow' : 'blue', grey: null, note: null };
    case 'risk_accepted':
      return { colour: 'yellow', grey: null, note: 'decided by the owner' };
    case 'not_verified':
      return { colour: 'grey', grey: 'not_verified', note: null };
    case 'not_applicable':
      return { colour: null, grey: null, note: null };
  }
}

export function itemColour(item: Item, run: Run): Derived {
  const mark = run.marks[item.id];
  return deriveColour(item, mark?.state ?? null, mark?.evidence ?? '');
}

// ---------------------------------------------------------------------------------------------
// Counts

export interface Summary {
  /** Checks in scope (the phase filter) that apply to the profile. */
  readonly inProfile: number;
  /** Of those, marked not applicable: they leave the denominator. */
  readonly notApplicable: number;
  /** The denominator: inProfile minus notApplicable. */
  readonly applicable: number;
  readonly colours: Readonly<Record<Colour, number>>;
  /** Part of grey: never marked. */
  readonly unmarked: number;
  /** Part of grey: passed or fixed, but with no evidence note. */
  readonly noEvidence: number;
  /** Passed or fixed with evidence: the template's "checks passed, N of M applicable". */
  readonly passed: number;
}

/** Counts for the checks in `phase` (all phases with null), from the run's marks or from a recorded "before". */
export function summarise(catalogue: Catalogue, run: Run, phase: number | null = null, before?: Baseline): Summary {
  const colours: Record<Colour, number> = { red: 0, yellow: 0, blue: 0, green: 0, grey: 0 };
  let inProfile = 0;
  let notApplicable = 0;
  let unmarked = 0;
  let noEvidence = 0;
  for (const item of catalogue.items) {
    if (phase !== null && item.phase !== phase) continue;
    if (!applies(item, run.profile)) continue;
    inProfile++;
    const mark = run.marks[item.id];
    const state = before ? (before.states[item.id] ?? null) : (mark?.state ?? null);
    const d = deriveColour(item, state, before ? (before.evidence[item.id] ?? '') : (mark?.evidence ?? ''));
    if (d.colour === null) {
      notApplicable++;
      continue;
    }
    colours[d.colour]++;
    if (d.grey === 'not_marked') unmarked++;
    if (d.grey === 'no_evidence') noEvidence++;
  }
  return { inProfile, notApplicable, applicable: inProfile - notApplicable, colours, unmarked, noEvidence, passed: colours.green };
}

/** "4 to fix now, of 38 applicable": a count never goes out without its denominator. */
export const countLine = (colour: Colour, summary: Summary): string => `${COLOUR_INFO[colour].count(summary.colours[colour])}, of ${summary.applicable} applicable`;

// ---------------------------------------------------------------------------------------------
// Palette. One value per colour and theme, used for the shape, the label and the bar. Each one has
// to reach 4.5:1 against the page and the card background of its theme, so the same token can carry
// text (WCAG 1.4.3) and a meaningful shape (1.4.11, 3:1) without a second, brighter variant.

export interface Theme {
  readonly page: string;
  readonly card: string;
  readonly text: string;
  /** Secondary text, on page and card. */
  readonly muted: string;
  /** Primary button background, and its label. */
  readonly accent: string;
  readonly accentText: string;
  readonly colours: Readonly<Record<Colour, string>>;
}

export const PALETTE: Readonly<Record<'light' | 'dark', Theme>> = {
  light: {
    page: '#ffffff',
    card: '#ffffff',
    text: '#111111',
    muted: '#4a4a4a',
    accent: '#c8ff2e',
    accentText: '#0a0a0a',
    colours: { red: '#cc0000', yellow: '#c33300', blue: '#0d47a1', green: '#008800', grey: '#707070' },
  },
  dark: {
    page: '#151312',
    card: '#1c1917',
    text: '#f0ede8',
    muted: '#cfc9c2',
    accent: '#c8ff2e',
    accentText: '#0a0a0a',
    colours: { red: '#ff3333', yellow: '#ffaa33', blue: '#90caf9', green: '#00cc66', grey: '#9e9e9e' },
  },
};

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.2 relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => channel(parseInt(x ?? '0', 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG 2.2 contrast ratio, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
