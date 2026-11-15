// schema/config.schema.json is for editors; src/config.ts is what the CLI runs. Both are written
// by hand, so this file runs them over one fixture set and fails when they disagree:
//   fixtures/config/valid/            both accept
//   fixtures/config/invalid/          both reject
//   fixtures/config/invalid-meaning/  the schema accepts and the validator rejects, each for a
//                                     reason a JSON Schema cannot state (a regex that does not
//                                     compile, an id that names no rule)
// The schema is read with zod's JSON Schema reader, a dev dependency of the repository, so the
// test needs no network and the package gains no dependency.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, validateConfig, validateShape } from '../src/config.ts';

const schemaFile = fileURLToPath(new URL('../schema/config.schema.json', import.meta.url));
const schemaJson = JSON.parse(readFileSync(schemaFile, 'utf8')) as Record<string, unknown>;
const schema = z.fromJSONSchema(schemaJson as Parameters<typeof z.fromJSONSchema>[0]);

const fixtures = (group: string): Array<[string, unknown]> => {
  const dir = new URL(`fixtures/config/${group}/`, import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown]);
};
const accepts = (check: () => unknown): boolean => {
  try {
    check();
    return true;
  } catch (error) {
    if (error instanceof ConfigError) return false;
    throw error;
  }
};

describe('the config schema and the hand validator', () => {
  it('has fixtures in every group', () => {
    expect(fixtures('valid').length).toBeGreaterThanOrEqual(8);
    expect(fixtures('invalid').length).toBeGreaterThanOrEqual(40);
    expect(fixtures('invalid-meaning').length).toBeGreaterThanOrEqual(6);
  });

  it('has as many fixtures as the README says', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const total = fixtures('valid').length + fixtures('invalid').length + fixtures('invalid-meaning').length;
    const stated = [...readme.matchAll(/over the same (\d+) fixtures/gu)].map((m) => Number(m[1]));
    expect(stated.length).toBeGreaterThan(0);
    expect(stated.every((n) => n === total), `README states ${stated.join(', ')}; there are ${total}`).toBe(true);
  });

  it.each(fixtures('valid'))('both accept valid/%s', (_name, value) => {
    expect(schema.safeParse(value).success).toBe(true);
    expect(accepts(() => validateConfig(value))).toBe(true);
  });

  it.each(fixtures('invalid'))('both reject invalid/%s', (_name, value) => {
    expect(schema.safeParse(value).success).toBe(false);
    expect(accepts(() => validateShape(value))).toBe(false);
  });

  it.each(fixtures('invalid-meaning'))('the schema accepts invalid-meaning/%s and the validator rejects it', (_name, value) => {
    expect(schema.safeParse(value).success).toBe(true);
    expect(accepts(() => validateShape(value))).toBe(true);
    expect(accepts(() => validateConfig(value))).toBe(false);
  });

  it('declares the same top-level keys the validator knows', () => {
    const keys = Object.keys(schemaJson['properties'] as Record<string, unknown>);
    for (const key of keys) {
      const value = key === '$schema' ? 'x' : key === 'lang' ? 'en' : key === 'format' ? 'text' : key === 'ruleSettings' || key === 'suppressions' ? {} : [];
      expect(accepts(() => validateShape({ [key]: value })), key).toBe(true);
    }
    expect(keys).toHaveLength(9);
  });

  it('is a draft 2020-12 schema that closes every object', () => {
    expect(schemaJson['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    const open: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      if (record['type'] === 'object' && record['additionalProperties'] === undefined) open.push(path);
      for (const [key, value] of Object.entries(record)) walk(value, `${path}/${key}`);
    };
    walk(schemaJson, '#');
    expect(open).toEqual([]);
  });
});
