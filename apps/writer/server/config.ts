// Loads and validates the three config files once, when the server starts. A broken file throws
// ConfigInvalid here, before the first request, with one line per problem.

import { readFileSync } from 'node:fs';
import { parseConfig, type WriterConfig } from '../src/config-schema.ts';

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8'));

export function loadConfig(): WriterConfig {
  return parseConfig({ school: read('school.json'), catalog: read('categories.json'), examples: read('examples.json') });
}
