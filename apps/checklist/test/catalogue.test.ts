// The catalogue: the committed JSON is what the build script makes from data/source/, every row is
// valid, and a bad source row stops the build with its file and id.

import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCatalogue, serialise, SourceError, tables } from '../data/build-catalogue.ts';
import { isCatalogue, MODULES } from '../src/catalogue.ts';
import { appDir, loadCatalogue } from './helpers.ts';

const catalogue = loadCatalogue();

describe('the committed catalogue', () => {
  it('is byte for byte what data/build-catalogue.ts writes from the sources', () => {
    expect(readFileSync(join(appDir, 'public/catalogue.json'), 'utf8')).toBe(serialise(buildCatalogue()));
  });

  it('passes the guard the browser runs on it', () => {
    expect(isCatalogue(catalogue)).toBe(true);
    expect(isCatalogue({ ...catalogue, items: [] })).toBe(false);
    expect(isCatalogue({ ...catalogue, items: [{ ...catalogue.items[0], priority: 'Urgent' }] })).toBe(false);
  });

  it('holds 152 checks across the eight modules, with unique ids', () => {
    const count = Object.fromEntries(MODULES.map((m) => [m, catalogue.items.filter((i) => i.module === m).length]));
    expect(count).toEqual({ EXT: 25, VIS: 21, INT: 38, PLA: 7, COM: 10, SEG: 19, VEL: 20, OPE: 12 });
    expect(new Set(catalogue.items.map((i) => i.id)).size).toBe(152);
  });

  it('is English and ASCII only, so no Spanish source text slipped in', () => {
    const text = readFileSync(join(appDir, 'public/catalogue.json'), 'utf8');
    expect(text).toMatch(/^[\x20-\x7e\n]*$/u);
    expect(text).not.toMatch(/\b(sitio|colegio|cliente|chequeo|biblia)\b/iu);
  });

  it('marks as speed exactly the checks the colour table treats as speed: EXT-08, EXT-18 to 21, VEL, COM-08, OPE-08', () => {
    const speed = catalogue.items.filter((i) => i.area === 'speed').map((i) => i.id);
    const expected = ['EXT-08', 'EXT-18', 'EXT-19', 'EXT-20', 'EXT-21', 'COM-08', ...catalogue.items.filter((i) => i.module === 'VEL').map((i) => i.id), 'OPE-08'];
    expect(speed.sort()).toEqual(expected.sort());
    expect(catalogue.items.filter((i) => i.area === 'visibility').every((i) => i.module === 'VIS')).toBe(true);
  });

  it('puts every internal, hardening and monitoring check behind authorization', () => {
    for (const item of catalogue.items) {
      if (['INT', 'SEG', 'VEL', 'OPE'].includes(item.module)) expect(item.access, item.id).toBe('authorized');
      if (['EXT', 'VIS'].includes(item.module)) expect(item.access, item.id).toBe('passive');
    }
  });

  it('has the six pre-change rows, nine matrix rows and six incident phases of the method', () => {
    expect(catalogue.preChange.map((r) => r.id)).toEqual(['backup-restored', 'staging', 'window', 'rollback-plan', 'owner-notice', 'test-inventory']);
    expect(catalogue.postChange).toHaveLength(9);
    expect(catalogue.incident.phases.map((p) => p.name)).toEqual(['Contain', 'Preserve evidence', 'Eradicate in every layer', 'Recover', 'Harden before republishing', 'Verify, republish and report']);
    expect(catalogue.incident.steps.find((s) => s.id === 'rotate-passwords')?.requires).toEqual(['site-isolated', 'admin-lockout', 'second-pass-zero']);
  });
});

describe('the source parser', () => {
  it('reads escaped pipes and keys tables by their heading', () => {
    const t = tables('# A\n\n| X | Y |\n|---|---|\n| a \\| b | c |\n\n## B\n\n| Z |\n|---|\n| d |\n', 'x.md');
    expect(t.get('A')).toEqual([{ X: 'a | b', Y: 'c' }]);
    expect(t.get('B')).toEqual([{ Z: 'd' }]);
  });

  function withEdit(file: string, from: string, to: string): () => unknown {
    return () => {
      const dir = mkdtempSync(join(tmpdir(), 'checklist-src-'));
      try {
        cpSync(join(appDir, 'data/source'), dir, { recursive: true });
        const path = join(dir, file);
        const text = readFileSync(path, 'utf8');
        if (!text.includes(from)) throw new Error(`fixture edit: "${from}" not in ${file}`);
        writeFileSync(path, text.replace(from, to));
        return buildCatalogue(pathToFileURL(`${dir}/`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it('refuses a priority outside the four', () => {
    expect(withEdit('external.md', '| Critical | security | all | - | passive |', '| Urgent | security | all | - | passive |')).toThrow(/EXT-04 Priority: "Urgent"/u);
  });

  it('refuses an unknown platform token', () => {
    expect(withEdit('speed.md', '| High | speed | cms | - | authorized |', '| High | speed | wordpres | - | authorized |')).toThrow(SourceError);
  });

  it('refuses Spanish (non-ASCII) text', () => {
    expect(withEdit('visibility.md', 'Can Google show the site?', '¿Google puede mostrar el sitio?')).toThrow(/U\+00BF outside printable ASCII/u);
  });

  it('refuses a dependency on a later step, so the runbook has no cycle', () => {
    expect(withEdit('procedures.md', '| snapshot | 2 | Full snapshot', '| snapshot-x | 2 | Full snapshot')).toThrow(/requires "snapshot", which is not an earlier step/u);
  });

  it('refuses an id that does not match its file', () => {
    expect(withEdit('commerce.md', '| COM-10 |', '| SEG-99 |')).toThrow(/the id must be COM-NN/u);
  });

  it('refuses a row with a missing cell', () => {
    expect(withEdit('monitoring.md', '| OPE-12 | Monthly forms test |', '| OPE-12 |')).toThrow(/cells, the header has 12/u);
  });
});
