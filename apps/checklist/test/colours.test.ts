// Colour derivation, the counts and their denominator, and the palette measured against WCAG 2.2.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Area, Item, Priority } from '../src/catalogue.ts';
import { COLOUR_EXCEPTIONS, COLOURS, contrast, countLine, deriveColour, luminance, PALETTE, summarise } from '../src/colours.ts';
import { setEvidence, setState, STATES, type State } from '../src/run.ts';
import { appDir, at, loadCatalogue, ok, runWith } from './helpers.ts';

const catalogue = loadCatalogue();
const item = (id: string, area: Area, priority: Priority): Pick<Item, 'id' | 'area' | 'priority'> => ({ id, area, priority });

describe('the colour table', () => {
  // Typed by hand from the method's table, not computed with the code under test.
  const cases: [string, Area, Priority, State | null, string, string | null][] = [
    ['EXT-05', 'security', 'High', 'fail', 'x', 'red'],
    ['EXT-04', 'security', 'Critical', 'fail', 'x', 'red'],
    ['EXT-02', 'security', 'Medium', 'fail', 'x', 'yellow'],
    ['EXT-09', 'security', 'Low', 'fail', 'x', 'yellow'],
    ['EXT-08', 'speed', 'High', 'fail', 'x', 'yellow'],
    ['VEL-02', 'speed', 'High', 'fail', 'x', 'yellow'],
    ['VIS-06', 'visibility', 'High', 'fail', 'x', 'blue'],
    ['VIS-11', 'visibility', 'Low', 'fail', 'x', 'blue'],
    ['EXT-01', 'security', 'High', 'pass_with_note', '', 'yellow'],
    ['VIS-04', 'visibility', 'Medium', 'pass_with_note', '', 'blue'],
    ['EXT-21', 'speed', 'Medium', 'pass_with_note', '', 'blue'],
    ['EXT-07', 'security', 'High', 'pass', 'tls.json', 'green'],
    ['INT-07', 'security', 'Critical', 'fixed', 'restore log', 'green'],
    ['INT-05', 'security', 'Critical', 'risk_accepted', '', 'yellow'],
    ['VIS-12', 'visibility', 'Medium', 'not_verified', '', 'grey'],
    ['EXT-06', 'security', 'High', null, '', 'grey'],
    ['VIS-08', 'visibility', 'Low', 'not_applicable', '', null],
  ];
  it.each(cases)('%s %s %s %s -> %s', (id, area, priority, state, evidence, colour) => {
    expect(deriveColour(item(id, area, priority), state, evidence).colour).toBe(colour);
  });

  it('turns a pass or a fix without evidence grey, and says why', () => {
    for (const state of ['pass', 'fixed'] as const) {
      expect(deriveColour(item('EXT-07', 'security', 'High'), state, '   ')).toEqual({ colour: 'grey', grey: 'no_evidence', note: null });
    }
  });

  it('applies the three written exceptions only to their state, with the reason attached', () => {
    expect(deriveColour(item('VIS-01', 'visibility', 'Critical'), 'fail', '')).toMatchObject({ colour: 'red', note: COLOUR_EXCEPTIONS['VIS-01']?.note });
    expect(deriveColour(item('VIS-18', 'visibility', 'Medium'), 'fail', '').colour).toBe('yellow');
    expect(deriveColour(item('VIS-21', 'visibility', 'Medium'), 'fail', '').colour).toBe('yellow');
    expect(deriveColour(item('VIS-01', 'visibility', 'Critical'), 'pass_with_note', '').colour).toBe('yellow');
    expect(deriveColour(item('VIS-01', 'visibility', 'Critical'), 'pass', 'ok').colour).toBe('green');
  });

  it('labels a risk the owner accepted as their decision', () => {
    expect(deriveColour(item('INT-05', 'security', 'Critical'), 'risk_accepted', '').note).toBe('decided by the owner');
  });

  it('gives every catalogue check a colour for every state', () => {
    for (const i of catalogue.items) for (const s of STATES) expect(() => deriveColour(i, s, 'e')).not.toThrow();
  });
});

describe('the table agrees with site-check on its own example run', () => {
  // site-check derives colours from the same method table in Python. Its example run of a fictional
  // school is published data; every non-hidden colour there must match this derivation, and the
  // priorities of the shared checks must be the same.
  const datos = JSON.parse(readFileSync(new URL('../../../site-check/examples/datos.json', import.meta.url), 'utf8')) as {
    checks: { id: string; estado: string; prioridad: string; color_final: string; evidencia: string[] }[];
  };
  const STATE: Record<string, State> = { APROBADO: 'pass', APROBADO_CON_OBSERVACION: 'pass_with_note', FALLA: 'fail', NO_APLICA: 'not_applicable', NO_VERIFICADO: 'not_verified' };
  const COLOUR: Record<string, string | null> = { rojo: 'red', amarillo: 'yellow', azul: 'blue', verde: 'green', gris: 'grey', oculto: null };
  const PRIORITY: Record<string, Priority> = { Crítica: 'Critical', Alta: 'High', Media: 'Medium', Baja: 'Low' };

  it('has the same colour for each of the 37 checks', () => {
    expect(datos.checks).toHaveLength(37);
    for (const check of datos.checks) {
      const mine = catalogue.items.find((i) => i.id === check.id);
      expect(mine, check.id).toBeDefined();
      if (!mine) continue;
      expect(mine.priority, `${check.id} priority`).toBe(PRIORITY[check.prioridad]);
      const state = STATE[check.estado] ?? null;
      expect(deriveColour(mine, state, check.evidencia.join(' ') || 'evidence').colour, check.id).toBe(COLOUR[check.color_final]);
    }
  });
});

describe('counts with their denominator', () => {
  it('says "4 to fix now, of 38 applicable"', () => {
    const summary = { inProfile: 39, notApplicable: 1, applicable: 38, colours: { red: 4, yellow: 7, blue: 11, green: 8, grey: 8 }, unmarked: 0, noEvidence: 0, passed: 8 };
    expect(countLine('red', summary)).toBe('4 to fix now, of 38 applicable');
    expect(countLine('blue', summary)).toBe('11 optional improvements, of 38 applicable');
    expect(countLine('grey', summary)).toBe('8 not checked, of 38 applicable');
    expect(countLine('blue', { ...summary, colours: { ...summary.colours, blue: 1 } })).toBe('1 optional improvement, of 38 applicable');
  });

  it('counts an unmarked check as grey, never as good, and drops not applicable from the denominator', () => {
    let run = runWith(catalogue, 'wordpress');
    const external = summarise(catalogue, run, 1);
    // Passive WordPress profile, phase 1: every EXT and VIS check except the four that need a feature.
    expect(external).toMatchObject({ inProfile: 42, applicable: 42, unmarked: 42 });
    expect(external.colours).toEqual({ red: 0, yellow: 0, blue: 0, green: 0, grey: 42 });

    run = ok(setState(catalogue, run, 'EXT-04', 'fail', at(1)));
    run = ok(setState(catalogue, run, 'EXT-07', 'pass', at(2)));
    run = ok(setState(catalogue, run, 'EXT-17', 'pass', at(3)));
    run = ok(setEvidence(catalogue, run, 'EXT-17', 'four redirects in curl output', at(4)));
    const s = summarise(catalogue, run, 1);
    expect(s).toMatchObject({ inProfile: 42, notApplicable: 0, applicable: 42, noEvidence: 1, passed: 1 });
    // EXT-07 passed with no evidence note: grey, not good.
    expect(s.colours).toEqual({ red: 1, yellow: 0, blue: 0, green: 1, grey: 40 });

    expect(setState(catalogue, run, 'VIS-08', 'not_applicable', at(5))).toEqual({ ok: false, reason: 'not_in_profile' });
    run = ok(setState(catalogue, run, 'VIS-06', 'not_applicable', at(6)));
    const after = summarise(catalogue, run, 1);
    expect(after.applicable).toBe(41);
    expect(COLOURS.reduce((n, c) => n + after.colours[c], 0)).toBe(after.applicable);
  });

  it('adds the checks a profile enables to the denominator', () => {
    const plain = summarise(catalogue, runWith(catalogue, 'wordpress'));
    const full = summarise(catalogue, runWith(catalogue, 'wordpress', ['own-mail', 'forms', 'bilingual', 'hosting-panel'], true));
    const hosted = summarise(catalogue, runWith(catalogue, 'hosted', [], true));
    expect(plain.applicable).toBe(42);
    expect(full.applicable).toBeGreaterThan(plain.applicable);
    expect(hosted.applicable).toBeLessThan(full.applicable);
  });
});

describe('the palette', () => {
  it('computes WCAG contrast correctly on known pairs', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(luminance('#ffffff')).toBe(1);
  });

  for (const [theme, t] of Object.entries(PALETTE)) {
    it(`${theme}: every state colour, the muted text and the body text reach 4.5:1 on the page and on a card`, () => {
      for (const [name, value] of [...Object.entries(t.colours), ['muted', t.muted], ['text', t.text]] as const) {
        expect(contrast(value, t.page), `${theme} ${name} on page`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(value, t.card), `${theme} ${name} on card`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(t.accentText, t.accent), `${theme} button label`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('is the palette styles.css uses, in both themes', () => {
    const css = readFileSync(join(appDir, 'src/styles.css'), 'utf8');
    const block = (name: string): Record<string, string> => {
      const m = new RegExp(`/\\* palette:${name} \\*/([\\s\\S]*?)/\\* end palette \\*/`, 'u').exec(css);
      if (!m) throw new Error(`palette:${name} block missing`);
      return Object.fromEntries([...(m[1] ?? '').matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/gu)].map((x) => [x[1], x[2]]));
    };
    for (const theme of ['light', 'dark'] as const) {
      const t = PALETTE[theme];
      expect(block(theme)).toEqual({
        page: t.page,
        card: t.card,
        text: t.text,
        'st-red': t.colours.red,
        'st-yellow': t.colours.yellow,
        'st-blue': t.colours.blue,
        'st-green': t.colours.green,
        'st-grey': t.colours.grey,
        muted: t.muted,
        accent: t.accent,
        'accent-text': t.accentText,
      });
    }
  });
});
