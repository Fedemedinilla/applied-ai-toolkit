// The three config files as raw JSON, read fresh on every call so a test can break one copy
// without touching the others. Paths, not URL objects: under jsdom the global URL is jsdom's,
// which node:fs does not accept.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type WriterConfig } from '../src/config-schema.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../config');

export interface RawConfig {
  school: Record<string, unknown>;
  catalog: { roles: Array<Record<string, unknown>>; categories: Array<Record<string, unknown>>; [key: string]: unknown };
  examples: Array<Record<string, unknown>>;
}

export function rawConfig(): RawConfig {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  return { school: read('school.json') as RawConfig['school'], catalog: read('categories.json') as RawConfig['catalog'], examples: read('examples.json') as RawConfig['examples'] };
}

export const realConfig = (): WriterConfig => parseConfig(rawConfig());
