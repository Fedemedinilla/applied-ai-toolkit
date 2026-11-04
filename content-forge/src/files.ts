/**
 * The catalogue on disk: one JSON file per entity, named after its id, in one folder per entity
 * type. Generated candidates and run reports live under `_candidates/`, which the loader never
 * reads as catalogue.
 *
 *   catalog/
 *     keywords/guard.json  factions/  sets/  cards/  decks/
 *     _candidates/
 *       cards/ember-scout.json      written by generate, moved by promote
 *       reports/<run>.json          one per generate run
 */
import { link, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { emptyRaw, type Problem, type RawCatalog } from './catalog.ts';
import { ENTITIES, ENTITY_NAMES, type EntityName } from './schemas.ts';

export const CANDIDATES = '_candidates';
export const REPORTS = 'reports';

export const entityPath = (dir: string, entity: EntityName, id: string): string => join(dir, ENTITIES[entity].folder, `${id}.json`);
export const candidatePath = (dir: string, entity: EntityName, id: string): string => join(dir, CANDIDATES, ENTITIES[entity].folder, `${id}.json`);
export const reportsDir = (dir: string): string => join(dir, CANDIDATES, REPORTS);

/** What a file holds before validation, as the catalogue reads it. */
export const relativeSource = (entity: EntityName, file: string): string => `${ENTITIES[entity].folder}/${file}`;

/** The `id` of a value that has not been validated yet, or null when it has none. */
export const idOf = (value: unknown): string | null =>
  typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' ? value.id : null;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function listJson(folder: string): Promise<string[] | null> {
  try {
    return (await readdir(folder)).filter((f) => !f.startsWith('.')).sort();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

export interface Loaded {
  readonly raw: RawCatalog;
  /** File-level problems: unreadable JSON, a name that is not the id, a file that is not JSON. */
  readonly problems: readonly Problem[];
}

/** Reads one folder per entity type under `root` (the catalogue, or its `_candidates/`). */
async function loadTree(root: string, prefix: string, only?: EntityName): Promise<Loaded> {
  const raw = emptyRaw();
  const problems: Problem[] = [];
  for (const entity of only ? [only] : ENTITY_NAMES) {
    const folder = join(root, ENTITIES[entity].folder);
    for (const file of (await listJson(folder)) ?? []) {
      const where = `${prefix}${relativeSource(entity, file)}`;
      if (!file.endsWith('.json')) {
        problems.push({ where, path: '', message: 'not a .json file' });
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(await readFile(join(folder, file), 'utf8'));
      } catch {
        problems.push({ where, path: '', message: 'not valid JSON' });
        continue;
      }
      const id = idOf(value);
      if (id !== null && `${id}.json` !== file) problems.push({ where, path: 'id', message: `the file name must be "${id}.json"` });
      raw[entity].push({ source: where, value });
    }
  }
  return { raw, problems };
}

export const loadCatalog = (dir: string): Promise<Loaded> => loadTree(dir, '');

export const loadCandidates = (dir: string, entity?: EntityName): Promise<Loaded> => loadTree(join(dir, CANDIDATES), `${CANDIDATES}/`, entity);

/**
 * A temporary name next to `path`, on the same file system so rename and link work. It starts with
 * a dot, so a file left by a crash is skipped by the loader instead of failing the catalogue, and
 * it carries a random part, so a leftover never blocks a later write with the same pid.
 */
const tempPath = (path: string): string => join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);

async function writeTemp(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return tmp;
}

/** Writes through a temporary file and a rename, so a crash never leaves half a JSON file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = await writeTemp(path, value);
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Writes a file that must not exist yet. The final step is a hard link, which fails with EEXIST
 * if anything appeared at `path` since the caller checked, so this can never overwrite. It needs a
 * file system with hard links.
 */
export async function writeJsonNew(path: string, value: unknown): Promise<void> {
  const tmp = await writeTemp(path, value);
  try {
    await link(tmp, path);
  } finally {
    await unlink(tmp);
  }
}

/**
 * What a file at `path` would mean for an overwrite. A file that cannot be read as JSON counts as
 * handwritten: if the guard cannot tell, it refuses.
 */
export type Occupant = 'none' | 'generated' | 'handwritten' | 'unreadable';

export async function occupant(path: string): Promise<Occupant> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'none';
    return 'unreadable';
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return 'unreadable';
    return 'handwritten' in value && value.handwritten === true ? 'handwritten' : 'generated';
  } catch {
    return 'unreadable';
  }
}

export const remove = (path: string): Promise<void> => rm(path);
