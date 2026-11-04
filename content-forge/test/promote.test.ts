// promote: all or nothing, never over a hand-written file, and checked against the catalogue as it
// is at promote time.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCatalog, formatProblem } from '../src/catalog.ts';
import { ForgeError } from '../src/errors.ts';
import { candidatePath, entityPath, loadCatalog, writeJsonNew } from '../src/files.ts';
import { promote } from '../src/promote.ts';
import { copyCatalog, readJson, writeJson } from './helpers/catalog-dir.ts';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await copyCatalog());
});
afterEach(async () => {
  await cleanup();
});

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id
    .split('-')
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' '),
  set: 'core',
  faction: 'grove',
  rarity: 'common',
  cost: 2,
  keywords: [],
  text: '',
  body: { type: 'unit', power: 2, health: 3 },
  ...extra,
});

async function refusal(run: Promise<unknown>): Promise<string[]> {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ForgeError);
  return error instanceof ForgeError ? error.problems.map(formatProblem) : [];
}

const fileText = (path: string): Promise<string> => readFile(path, 'utf8');

describe('promote', () => {
  it('moves the selected candidates into the catalogue with their defaults, and the catalogue stays valid', async () => {
    await writeJson(candidatePath(dir, 'card', 'moss-crawler'), card('moss-crawler'));
    await writeJson(candidatePath(dir, 'card', 'bark-sprite'), card('bark-sprite'));
    const result = await promote({ dir, entity: 'card', ids: 'all' });
    expect(result).toEqual({ moved: ['bark-sprite', 'moss-crawler'], replaced: [] });
    expect(await readdir(join(dir, '_candidates', 'cards'))).toEqual([]);
    expect(await readJson(entityPath(dir, 'card', 'moss-crawler'))).toMatchObject({ handwritten: false, limits: { maxCopies: 3, banned: false } });
    expect(checkCatalog((await loadCatalog(dir)).raw).ok).toBe(true);
  });

  it('moves only the ids it is given', async () => {
    await writeJson(candidatePath(dir, 'card', 'moss-crawler'), card('moss-crawler'));
    await writeJson(candidatePath(dir, 'card', 'bark-sprite'), card('bark-sprite'));
    expect((await promote({ dir, entity: 'card', ids: ['bark-sprite'] })).moved).toEqual(['bark-sprite']);
    expect(await readdir(join(dir, '_candidates', 'cards'))).toEqual(['moss-crawler.json']);
  });

  it('never overwrites a hand-written entry, even with --replace, and then moves nothing at all', async () => {
    const before = await fileText(entityPath(dir, 'card', 'flare'));
    await writeJson(candidatePath(dir, 'card', 'flare'), card('flare', { name: 'Flare Again' }));
    await writeJson(candidatePath(dir, 'card', 'moss-crawler'), card('moss-crawler'));
    expect(await refusal(promote({ dir, entity: 'card', ids: 'all', replace: true }))).toEqual([
      'cards/flare.json: is hand-written, and promote never overwrites it',
      // The merged index has two cards with the id "flare" as well.
      '_candidates/cards/flare.json: id: duplicate card id "flare"',
    ]);
    expect(await fileText(entityPath(dir, 'card', 'flare'))).toBe(before);
    expect(await readdir(join(dir, '_candidates', 'cards'))).toEqual(['flare.json', 'moss-crawler.json']);
  });

  it('replaces a generated entry only with --replace', async () => {
    const candidate = card('quick-study', { name: 'Quick Study', faction: null, cost: 1, body: { type: 'spell', target: 'none', effects: [{ kind: 'draw', count: 1 }] }, text: 'Draw a card. Then draw a card.' });
    await writeJson(candidatePath(dir, 'card', 'quick-study'), candidate);
    expect(await refusal(promote({ dir, entity: 'card', ids: ['quick-study'] }))).toEqual(['cards/quick-study.json: already exists; pass --replace to replace a generated entry', '_candidates/cards/quick-study.json: id: duplicate card id "quick-study"']);
    expect(await promote({ dir, entity: 'card', ids: ['quick-study'], replace: true })).toEqual({ moved: ['quick-study'], replaced: ['quick-study'] });
    expect(await readJson(entityPath(dir, 'card', 'quick-study'))).toMatchObject({ text: 'Draw a card. Then draw a card.' });
  });

  it('treats a target it cannot read as hand-written', async () => {
    await writeFile(entityPath(dir, 'card', 'quick-study'), '{ "id": "quick-study", ');
    await writeJson(candidatePath(dir, 'card', 'quick-study'), card('quick-study'));
    const problems = await refusal(promote({ dir, entity: 'card', ids: ['quick-study'], replace: true }));
    expect(problems).toContain('cards/quick-study.json: cannot be read as JSON, so it is treated as hand-written and kept');
  });

  it('refuses a candidate that claims to be hand-written, and an id with no candidate', async () => {
    await writeJson(candidatePath(dir, 'card', 'moss-crawler'), card('moss-crawler', { handwritten: true }));
    expect(await refusal(promote({ dir, entity: 'card', ids: ['moss-crawler', 'ghost'] }))).toEqual([
      '_candidates/cards/moss-crawler.json: handwritten: a candidate cannot be hand-written; edit the catalogue directly instead',
      '_candidates/cards/ghost.json: no such candidate',
    ]);
  });

  it('checks against the catalogue as it is now, not as it was when the candidate was generated', async () => {
    await writeJson(candidatePath(dir, 'card', 'moss-crawler'), card('moss-crawler', { set: 'driftwood' }));
    // Since the run, someone shrank the set to the cards it already holds.
    const set = (await readJson(entityPath(dir, 'set', 'driftwood'))) as Record<string, unknown>;
    await writeJson(entityPath(dir, 'set', 'driftwood'), { ...set, size: 4 });
    expect(await refusal(promote({ dir, entity: 'card', ids: 'all' }))).toEqual(['set/driftwood: size: holds 5 cards and its size is 4']);
  });

  it('re-applies the range rules for generated content to a candidate edited after the run', async () => {
    // A legendary far off the cost curve: valid as catalogue content, never as generated content.
    await writeJson(candidatePath(dir, 'card', 'moss-crawler'), card('moss-crawler', { rarity: 'legendary', limits: { maxCopies: 1 }, body: { type: 'unit', power: 12, health: 3 } }));
    expect(await refusal(promote({ dir, entity: 'card', ids: ['moss-crawler'] }))).toEqual([
      '_candidates/cards/moss-crawler.json: breaks the rule for generated content "no-legendary": is legendary',
      '_candidates/cards/moss-crawler.json: breaks the rule for generated content "cost-curve": spends 15 and its budget at cost 2 is 5',
    ]);
    expect(await readdir(join(dir, '_candidates', 'cards'))).toEqual(['moss-crawler.json']);
  });

  it('checks a set candidate\'s release order against the catalogue without the set it replaces', async () => {
    const driftwood = (await readJson(entityPath(dir, 'set', 'driftwood'))) as Record<string, unknown>;
    // driftwood is the last set; a generated replacement keeps its release order.
    await writeJson(entityPath(dir, 'set', 'driftwood'), { ...driftwood, handwritten: false });
    await writeJson(candidatePath(dir, 'set', 'driftwood'), { ...driftwood, handwritten: false, name: 'Driftwood Revised' });
    expect(await promote({ dir, entity: 'set', ids: ['driftwood'], replace: true })).toEqual({ moved: ['driftwood'], replaced: ['driftwood'] });
  });

  it('says when there is nothing to promote', async () => {
    await expect(promote({ dir, entity: 'deck', ids: 'all' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('writeJsonNew', () => {
  it('fails instead of overwriting a file that appeared after the check', async () => {
    const path = entityPath(dir, 'card', 'flare');
    const before = await fileText(path);
    await expect(writeJsonNew(path, { id: 'flare' })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fileText(path)).toBe(before);
    expect((await readdir(join(dir, 'cards'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('uses a dot-prefixed temporary name, so a file left by a crash does not break the catalogue', async () => {
    await writeFile(join(dir, 'cards', '.moss-crawler.json.4242.left-by-a-crash.tmp'), '{ "id": "moss');
    const loaded = await loadCatalog(dir);
    expect(loaded.problems).toEqual([]);
    expect(checkCatalog(loaded.raw).ok).toBe(true);
    await writeJsonNew(entityPath(dir, 'card', 'moss-crawler'), card('moss-crawler'));
    expect(await readJson(entityPath(dir, 'card', 'moss-crawler'))).toMatchObject({ id: 'moss-crawler' });
  });
});
