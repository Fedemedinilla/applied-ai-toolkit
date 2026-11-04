// The schemas and the index validator, on the example catalogue and on broken copies of it.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkCatalog, emptyRaw, formatProblem, type RawCatalog } from '../src/catalog.ts';
import { loadCatalog } from '../src/files.ts';
import { Card, Deck, ENTITIES, ENTITY_NAMES, Faction, Keyword } from '../src/schemas.ts';
import { EXAMPLE } from './helpers/catalog-dir.ts';

const example = await loadCatalog(EXAMPLE);

/** The example catalogue with entries replaced or added, by entity and id. */
function edited(changes: { [entity: string]: Record<string, unknown> }): ReturnType<typeof emptyRaw> {
  const raw = emptyRaw();
  for (const entity of ENTITY_NAMES) {
    const own = changes[entity] ?? {};
    for (const entry of example.raw[entity]) {
      const value = entry.value as { id: string };
      if (!(value.id in own)) raw[entity].push(entry);
    }
    for (const [id, value] of Object.entries(own)) if (value !== null) raw[entity].push({ source: `${entity}/${id}`, value });
  }
  return raw;
}

const problemsOf = (raw: RawCatalog): string[] => {
  const result = checkCatalog(raw);
  return result.ok ? [] : result.problems.map(formatProblem);
};

const value = (entity: (typeof ENTITY_NAMES)[number], id: string): Record<string, unknown> => {
  const found = example.raw[entity].find((e) => (e.value as { id: string }).id === id);
  if (!found) throw new Error(`no ${entity} ${id} in the example`);
  return structuredClone(found.value) as Record<string, unknown>;
};

describe('the example catalogue', () => {
  it('loads with no file problem and validates', () => {
    expect(example.problems).toEqual([]);
    const result = checkCatalog(example.raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ENTITY_NAMES.map((e) => result.index[e].size)).toEqual([5, 3, 2, 13, 2]);
  });

  it('lists every entity type exactly once', () => {
    expect([...ENTITY_NAMES].sort()).toEqual(Object.keys(ENTITIES).sort());
  });
});

describe('schemas', () => {
  const unit = { id: 'test-unit', name: 'Test Unit', set: 'core', faction: null, rarity: 'common', cost: 2, keywords: [], text: '', body: { type: 'unit', power: 1, health: 2 } };

  it('fills nested defaults through prefault', () => {
    expect(Card.parse(unit)).toMatchObject({ limits: { maxCopies: 3, banned: false }, handwritten: false, body: { token: false } });
    expect(Card.parse({ ...unit, limits: { banned: true } }).limits).toEqual({ maxCopies: 3, banned: true });
  });

  it('needs prefault, not default: zod 4 returns a default without parsing it', () => {
    const limits = z.strictObject({ maxCopies: z.int().default(3) });
    // The cast is the lie .default({}) tells: the type promises maxCopies, the value has none.
    const withDefault = z.strictObject({ limits: limits.default({} as z.output<typeof limits>) });
    const withPrefault = z.strictObject({ limits: limits.prefault({}) });
    expect(withDefault.parse({})).toEqual({ limits: {} });
    expect(withPrefault.parse({})).toEqual({ limits: { maxCopies: 3 } });
  });

  it('rejects unknown keys at every level', () => {
    const issues = Card.safeParse({ ...unit, flavor: 'x', body: { ...unit.body, armor: 1 }, limits: { maxCopies: 1, extra: true } }).error?.issues ?? [];
    expect(issues.map((i) => [i.path.join('.'), i.code]).sort()).toEqual([
      ['', 'unrecognized_keys'],
      ['body', 'unrecognized_keys'],
      ['limits', 'unrecognized_keys'],
    ]);
  });

  it('picks the body by its type and rejects fields of another type', () => {
    expect(Card.safeParse({ ...unit, body: { type: 'relic', charges: 2 } }).success).toBe(true);
    expect(Card.safeParse({ ...unit, body: { type: 'relic', power: 1, health: 1 } }).success).toBe(false);
    expect(Card.safeParse({ ...unit, body: { type: 'trap' } }).success).toBe(false);
  });

  it('holds the single-entity invariants as refinements, all reported together', () => {
    const token = { ...unit, rarity: 'rare', cost: 1, body: { type: 'unit', power: 1, health: 1, token: true }, keywords: [{ keyword: 'guard', value: null }, { keyword: 'guard', value: null }] };
    const messages = (Card.safeParse(token).error?.issues ?? []).map((i) => i.message);
    expect(messages).toEqual(['keyword "guard" is listed twice', 'a token is common', 'a token costs 0']);
    expect(Card.safeParse({ ...unit, rarity: 'legendary' }).error?.issues[0]?.message).toBe('a legendary card allows one copy');
    expect(Card.safeParse({ ...unit, body: { type: 'spell', target: 'none', effects: [{ kind: 'damage', amount: 1 }] } }).error?.issues[0]?.message).toBe('damage and heal need a target');
  });

  it('ties a keyword reminder to whether it takes a value', () => {
    const base = { id: 'test-kw', name: 'Test', timing: 'static', takesValue: true, reminder: 'Deal X damage to a unit.' };
    expect(Keyword.safeParse(base).success).toBe(true);
    expect(Keyword.safeParse({ ...base, takesValue: false }).success).toBe(false);
    expect(Keyword.safeParse({ ...base, reminder: 'Deal some damage to a unit.' }).success).toBe(false);
  });

  it('refuses a faction that is its own rival, and ids that are not kebab-case', () => {
    expect(Faction.safeParse({ id: 'mist', name: 'Mist', motto: 'Unseen.', rival: 'mist' }).success).toBe(false);
    expect(Faction.safeParse({ id: 'Mist_Walkers', name: 'Mist', motto: 'Unseen.', rival: null }).success).toBe(false);
  });

  it('counts deck copies and refuses a card listed twice', () => {
    const messages = (Deck.safeParse({ id: 'd', name: 'Dd', faction: 'tide', cards: [{ card: 'flare', copies: 3 }, { card: 'flare', copies: 3 }] }).error?.issues ?? []).map((i) => i.message);
    expect(messages).toEqual(['Too small: expected string to have >=2 characters', 'a deck holds 12 cards and this one holds 6', 'card "flare" is listed twice; raise its copies instead']);
  });
});

describe('cross-references', () => {
  it('reports every broken reference of a catalogue in one pass', () => {
    const problems = problemsOf(
      edited({
        card: {
          'reef-sentinel': { ...value('card', 'reef-sentinel'), set: 'nowhere', faction: 'void', keywords: [{ keyword: 'guard', value: 2 }, { keyword: 'echo', value: null }] },
          'tidal-surge': { ...value('card', 'tidal-surge'), body: { type: 'spell', target: 'none', effects: [{ kind: 'summon', card: 'flare', count: 1 }] } },
        },
        deck: { 'ember-starter': { ...value('deck', 'ember-starter'), faction: 'void' } },
      }),
    );
    expect(problems).toEqual([
      'card/reef-sentinel: set: unknown set "nowhere"',
      'card/reef-sentinel: faction: unknown faction "void"',
      'card/reef-sentinel: keywords.0.value: keyword "guard" takes no value',
      'card/reef-sentinel: keywords.1.value: keyword "echo" takes a value',
      'card/tidal-surge: body.effects.0.card: summons "flare", which is not a token unit',
      'card/shell-spawn: body.token: no card summons this token',
      'deck/tide-starter: cards.0.card: "reef-sentinel" belongs to faction "void"',
      'deck/ember-starter: faction: unknown faction "void"',
      'deck/ember-starter: cards.0.card: "cinder-hound" belongs to faction "ember"',
      'deck/ember-starter: cards.1.card: "flare" belongs to faction "ember"',
      'deck/ember-starter: cards.2.card: "forge-heart" belongs to faction "ember"',
      'deck/ember-starter: cards.3.card: "ashen-duelist" belongs to faction "ember"',
    ]);
  });

  it('checks a rivalry from both sides', () => {
    expect(problemsOf(edited({ faction: { ember: { ...value('faction', 'ember'), rival: 'grove' } } }))).toEqual([
      'faction/tide: rival: rival "ember" names "grove" instead of "tide"',
      'faction/ember: rival: rival "grove" names no rival instead of "ember"',
    ]);
  });

  it('checks a summon and its token from both sides', () => {
    // Removing the only card that summons the token leaves the token unreachable.
    const raw = edited({ card: { 'tidal-surge': null }, deck: { 'tide-starter': { ...value('deck', 'tide-starter'), cards: [{ card: 'reef-sentinel', copies: 3 }, { card: 'tidecaller', copies: 3 }, { card: 'undertow', copies: 3 }, { card: 'wandering-tinker', copies: 3 }] } } });
    expect(problemsOf(raw)).toEqual(['card/shell-spawn: body.token: no card summons this token']);
  });

  it('keeps a set within its size, codes and release orders unique', () => {
    const problems = problemsOf(edited({ set: { driftwood: { ...value('set', 'driftwood'), size: 3, code: 'CRS', releaseOrder: 1 } } }));
    expect(problems).toEqual([
      'set/driftwood: code: set "core" already uses code CRS',
      'set/driftwood: releaseOrder: set "core" already has release order 1',
      'set/driftwood: size: holds 4 cards and its size is 3',
    ]);
  });

  it('holds deck limits: copies, tokens and banned cards', () => {
    const problems = problemsOf(
      edited({
        card: { 'wandering-tinker': { ...value('card', 'wandering-tinker'), limits: { maxCopies: 1, banned: true } } },
        deck: { 'tide-starter': { ...value('deck', 'tide-starter'), cards: [{ card: 'reef-sentinel', copies: 3 }, { card: 'tidecaller', copies: 3 }, { card: 'undertow', copies: 3 }, { card: 'shell-spawn', copies: 1 }, { card: 'wandering-tinker', copies: 2 }] } },
      }),
    );
    expect(problems).toEqual([
      'deck/ember-starter: cards.4.card: "wandering-tinker" is banned',
      'deck/ember-starter: cards.4.copies: "wandering-tinker" allows 1 copies',
      'deck/tide-starter: cards.3.card: "shell-spawn" is a token',
      'deck/tide-starter: cards.4.card: "wandering-tinker" is banned',
      'deck/tide-starter: cards.4.copies: "wandering-tinker" allows 1 copies',
    ]);
  });

  it('refuses duplicate ids and names that differ only in case', () => {
    const raw = edited({});
    raw.keyword.push({ source: 'keywords/guard-copy.json', value: { ...value('keyword', 'guard') } });
    raw.keyword.push({ source: 'keywords/swift-two.json', value: { ...value('keyword', 'swift'), id: 'swift-two', name: 'SWIFT' } });
    expect(problemsOf(raw)).toEqual(['keywords/guard-copy.json: id: duplicate keyword id "guard"', 'keywords/swift-two.json: name: keyword "swift" already has the name "SWIFT"']);
  });

  it('reports schema problems with the file and path, and still checks the rest', () => {
    const raw = edited({ card: { flare: { ...value('card', 'flare'), cost: -1 } } });
    const problems = problemsOf(raw);
    expect(problems[0]).toMatch(/^card\/flare: cost: Too small/);
    expect(problems).toContain('deck/ember-starter: cards.1.card: unknown card "flare"');
  });
});
