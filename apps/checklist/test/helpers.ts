// Shared test helpers: the committed catalogue, a run with a chosen profile, and a clock.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCatalogue, type Catalogue, type FeatureId, type PlatformId } from '../src/catalogue.ts';
import { newRun, type Run, type Result } from '../src/run.ts';

// Paths, not URL objects: under jsdom the global URL is jsdom's, which node:fs does not accept.
export const here = dirname(fileURLToPath(import.meta.url));
export const appDir = join(here, '..');

export function loadCatalogue(): Catalogue {
  const data: unknown = JSON.parse(readFileSync(join(appDir, 'public/catalogue.json'), 'utf8'));
  if (!isCatalogue(data)) throw new Error('public/catalogue.json is not a catalogue');
  return data;
}

export const T0 = new Date('2026-11-04T13:00:00.000Z');
export const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

export function runWith(catalogue: Catalogue, platform: PlatformId, features: FeatureId[] = [], authorized = false): Run {
  return { ...newRun(catalogue, T0), profile: { platform, features, authorized } };
}

/** Unwraps a Result, failing the test with the refusal when there is one. */
export function ok(result: Result): Run {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.run;
}

export const fixture = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8');
