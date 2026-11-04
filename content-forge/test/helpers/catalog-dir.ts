// Each test gets its own copy of the example catalogue in a temporary folder, so generate and
// promote can write without touching the one in the repository.
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLE = fileURLToPath(new URL('../../catalog/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

export async function copyCatalog(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'content-forge-'));
  await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes('_candidates') });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A model response body from test/fixtures/responses/, as the text the API would return. */
export const response = (name: string): Promise<string> => readFile(join(FIXTURES, 'responses', `${name}.json`), 'utf8');
