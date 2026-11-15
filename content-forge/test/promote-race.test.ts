// promote when a target changes between the up-front check and its write. The writers in files.ts
// are wrapped so a test can change the catalogue right before a given write, the way another
// promote or a person editing a file would.
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgeError } from '../src/errors.ts';
import { candidatePath, entityPath } from '../src/files.ts';
import { promote } from '../src/promote.ts';
import { copyCatalog, readJson, writeJson } from './helpers/catalog-dir.ts';

/** Run before and after each write promote makes, with the target path. */
let beforeWrite: (path: string) => Promise<void> = async () => {};
let afterWrite: (path: string) => Promise<void> = async () => {};

vi.mock('../src/files.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/files.ts')>();
  return {
    ...actual,
    writeJsonNew: async (path: string, value: unknown) => {
      await beforeWrite(path);
      await actual.writeJsonNew(path, value);
      await afterWrite(path);
    },
    writeJsonAtomic: async (path: string, value: unknown) => {
      await beforeWrite(path);
      await actual.writeJsonAtomic(path, value);
      await afterWrite(path);
    },
  };
});

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await copyCatalog());
});
afterEach(async () => {
  beforeWrite = async () => {};
  afterWrite = async () => {};
  await cleanup();
});

const card = (id: string, name: string) => ({ id, name, set: 'core', faction: 'grove', rarity: 'common', cost: 2, keywords: [], text: '', body: { type: 'unit', power: 2, health: 3 } });

async function failure(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('a target that changes during promote', () => {
  it('stops at a new file that appeared since the check, names it and says how many were moved', async () => {
    await writeJson(candidatePath(dir, 'card', 'moss-a'), card('moss-a', 'Moss A'));
    await writeJson(candidatePath(dir, 'card', 'moss-b'), card('moss-b', 'Moss B'));
    const other = { ...card('moss-b', 'Moss B'), text: 'written by another promote' };
    beforeWrite = async (path) => {
      if (path === entityPath(dir, 'card', 'moss-b')) await writeJson(path, other);
    };
    const error = await failure(promote({ dir, entity: 'card', ids: 'all' }));
    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ code: 'refused', message: 'cards/moss-b.json appeared during promote; 1 moved before it' });
    expect(await readJson(entityPath(dir, 'card', 'moss-b'))).toEqual(other);
    expect(await readJson(entityPath(dir, 'card', 'moss-a'))).toMatchObject({ id: 'moss-a' });
  });

  it('does not replace a generated target that was marked hand-written since the check', async () => {
    // Two generated entries in the catalogue, both replaced.
    for (const id of ['moss-a', 'moss-b']) {
      await writeJson(entityPath(dir, 'card', id), { ...card(id, id === 'moss-a' ? 'Moss A' : 'Moss B'), handwritten: false });
      await writeJson(candidatePath(dir, 'card', id), { ...card(id, id === 'moss-a' ? 'Moss A' : 'Moss B'), text: 'revised' });
    }
    // Right after the first write, before promote re-checks the second target.
    const target = entityPath(dir, 'card', 'moss-b');
    afterWrite = async (path) => {
      if (path === entityPath(dir, 'card', 'moss-a')) await writeJson(target, { ...card('moss-b', 'Moss B'), handwritten: true });
    };
    const error = await failure(promote({ dir, entity: 'card', ids: 'all', replace: true }));
    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ code: 'refused', message: 'cards/moss-b.json changed during promote; 1 moved before it' });
    expect(await readFile(target, 'utf8')).toContain('"handwritten": true');
    expect(await readJson(target)).not.toMatchObject({ text: 'revised' });
    expect(await readJson(entityPath(dir, 'card', 'moss-a'))).toMatchObject({ text: 'revised' });
  });
});
