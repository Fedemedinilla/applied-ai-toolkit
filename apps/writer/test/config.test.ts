// The configuration as data: the shipped files parse, and every rule the schema adds on top of
// zod's shapes rejects a broken copy with a line that names the file, the path and the problem.

import { describe, expect, it } from 'vitest';
import { clientCatalog, ConfigInvalid, parseConfig } from '../src/config-schema.ts';
import { loadConfig } from '../server/config.ts';
import { rawConfig, type RawConfig } from './raw-config.ts';

function problems(edit: (raw: RawConfig) => void): string[] {
  const raw = rawConfig();
  edit(raw);
  try {
    parseConfig(raw);
  } catch (e) {
    if (e instanceof ConfigInvalid) return [...e.problems];
    throw e;
  }
  return [];
}

const category = (raw: RawConfig, id: string): Record<string, unknown> => {
  const found = raw.catalog.categories.find((c) => c['id'] === id);
  if (!found) throw new Error(`no category ${id}`);
  return found;
};

describe('the shipped config', () => {
  it('parses, with four roles, nine categories and four examples', () => {
    const config = loadConfig();
    expect(config.catalog.roles.map((r) => r.id)).toEqual(['direccion', 'coordinacion', 'docente', 'administracion']);
    expect(config.catalog.categories).toHaveLength(9);
    expect(config.examples).toHaveLength(4);
    expect(config.school.fictional).toBe(true);
  });

  it('every role writes at least one category, and every sensitivity level is used', () => {
    const { catalog } = loadConfig();
    for (const role of catalog.roles) expect(catalog.categories.some((c) => c.roles.includes(role.id))).toBe(true);
    expect(new Set(catalog.categories.map((c) => c.sensitivity))).toEqual(new Set(['normal', 'high', 'critical']));
  });

  it('uses only fictional contact details', () => {
    const text = JSON.stringify(rawConfig());
    for (const email of text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu) ?? []) expect(email).toMatch(/\.example$/u);
    expect(text).not.toMatch(/https?:\/\//u);
  });
});

describe('rejected configs', () => {
  it('a category that names a role or a reviewer that does not exist', () => {
    expect(problems((r) => (category(r, 'evento')['roles'] = ['direccion', 'coordinacion', 'preceptoria']))).toEqual([
      'categories.json: categories.1 (evento): unknown role "preceptoria"',
    ]);
    expect(problems((r) => (category(r, 'salud')['reviewer'] = 'legales'))).toEqual(['categories.json: categories.6 (salud): unknown reviewer role "legales"']);
  });

  it('duplicate ids', () => {
    expect(problems((r) => r.catalog.roles.push({ ...r.catalog.roles[0] }))).toContain('categories.json: role id "direccion" is used twice');
    expect(problems((r) => r.catalog.categories.push({ ...r.catalog.categories[0] }))).toContain('categories.json: category id "aviso-general" is used twice');
  });

  it('a length range that is empty or out of bounds', () => {
    expect(problems((r) => (category(r, 'pagos')['length'] = { min: 900, max: 900 }))).toEqual([
      'categories.json: categories.5 (pagos): length.min 900 is not below length.max 900',
    ]);
    expect(problems((r) => (category(r, 'pagos')['length'] = { min: 20, max: 900 }))[0]).toMatch(/^categories\.json: categories\.5\.length\.min: /u);
  });

  it('emoji in a sensitive category, and a call to action without its hint or with a stray one', () => {
    expect(problems((r) => (category(r, 'salud')['emoji'] = 'few'))).toEqual(['categories.json: categories.6 (salud): a high-sensitivity category cannot allow emoji']);
    expect(problems((r) => (category(r, 'evento')['cta'] = { mode: 'required', hint: null }))).toEqual([
      'categories.json: categories.1 (evento): cta.mode "required" needs a hint',
    ]);
    expect(problems((r) => (category(r, 'salud')['cta'] = { mode: 'none', hint: 'un enlace' }))).toEqual([
      'categories.json: categories.6 (salud): cta.hint is set but cta.mode is "none"',
    ]);
  });

  it('unknown keys, a wrong enum and a non-fictional school', () => {
    expect(problems((r) => (category(r, 'logros')['tono'] = 'alegre'))[0]).toMatch(/^categories\.json: categories\.8: Unrecognized key/u);
    expect(problems((r) => (category(r, 'logros')['sensitivity'] = 'baja'))[0]).toMatch(/^categories\.json: categories\.8\.sensitivity: /u);
    expect(problems((r) => (r.school['fictional'] = false))[0]).toMatch(/^school\.json: fictional: /u);
    expect(problems((r) => (r.school['timeZone'] = 'Mars/Olympus'))).toEqual(['school.json: timeZone: an IANA time zone']);
  });

  it('examples that break their own category: length, role, languages', () => {
    expect(problems((r) => (r.examples[0]!['es'] = 'Estimadas familias:\n\nMañana no hay clases.\n\nDirección General'))).toEqual([
      'examples.json: 0 (Salida anticipada el viernes 6 de noviembre): es is 61 characters, outside 200 to 600 for "cambio-horario"',
    ]);
    expect(problems((r) => (r.examples[1]!['role'] = 'administracion'))).toEqual([
      'examples.json: 1 (Salida educativa de 4.º grado al Museo de Ciencias): role "administracion" does not write "salida-educativa"',
    ]);
    expect(problems((r) => delete r.examples[2]!['en'])).toEqual(['examples.json: 2 (Casos de pediculosis en Nivel Inicial): a bilingual category needs an "en" text']);
    expect(problems((r) => (r.examples[1]!['en'] = r.examples[1]!['es']))).toEqual([
      'examples.json: 1 (Salida educativa de 4.º grado al Museo de Ciencias): a Spanish-only category takes no "en" text',
    ]);
  });

  it('reports every problem at once', () => {
    const found = problems((r) => {
      category(r, 'salud')['emoji'] = 'few';
      category(r, 'pagos')['reviewer'] = 'nadie';
    });
    expect(found).toHaveLength(2);
  });
});

describe('the catalog the page gets', () => {
  it('carries names and chip attributes, and none of the prompt text', () => {
    const page = clientCatalog(loadConfig());
    expect(page.schoolName).toBe('Colegio Bilingüe Monte Lirio');
    expect(Object.keys(page.categories[0]!).sort()).toEqual(['id', 'languages', 'length', 'name', 'purpose', 'roles', 'sensitivity']);
    expect(Object.keys(page.roles[0]!).sort()).toEqual(['description', 'id', 'name']);
    const text = JSON.stringify(page);
    expect(text).not.toContain('Cordial y directo');
    expect(text).not.toContain('Estimadas familias');
  });
});
