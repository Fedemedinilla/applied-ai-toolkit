/**
 * The index validator: parses every entity with its schema, then checks every cross-reference and
 * every rule that spans entities. Pure: no file system, no clock. It never stops at the first
 * problem. A catalogue change gets the full list at once, and a generated candidate gets every
 * reason it was rejected, not only the first.
 */
import type { z } from 'zod';
import { SCHEMAS, type EntityName, type EntityTypes } from './schemas.ts';

/** One entity as read from disk or from the model, not yet validated. */
export interface RawEntry {
  /** Where it came from, for messages: "cards/ember-hound.json", "candidate 3". */
  readonly source: string;
  readonly value: unknown;
}

export type RawCatalog = { readonly [E in EntityName]: readonly RawEntry[] };

export type CatalogIndex = { readonly [E in EntityName]: ReadonlyMap<string, EntityTypes[E]> };

export interface Problem {
  /** The file or entity the problem is in: "cards/ember-hound.json" or "card/ember-hound". */
  readonly where: string;
  /** The field, as a dotted zod path, or "" for the whole entity. */
  readonly path: string;
  readonly message: string;
}

export type CatalogResult = { readonly ok: true; readonly index: CatalogIndex } | { readonly ok: false; readonly problems: readonly Problem[] };

export const formatProblem = (p: Problem): string => `${p.where}: ${p.path === '' ? '' : `${p.path}: `}${p.message}`;

export const emptyRaw = (): { [E in EntityName]: RawEntry[] } => ({ keyword: [], faction: [], set: [], card: [], deck: [] });

/** zod issues as problems, every one of them, with the path joined by dots. */
export function issuesToProblems(where: string, issues: readonly z.core.$ZodIssue[]): Problem[] {
  return issues.map((issue) => ({ where, path: issue.path.map(String).join('.'), message: issue.message }));
}

function parseAll<E extends EntityName>(entity: E, entries: readonly RawEntry[], problems: Problem[]): Map<string, EntityTypes[E]> {
  const schema = SCHEMAS[entity];
  const out = new Map<string, EntityTypes[E]>();
  const names = new Map<string, string>();
  for (const entry of entries) {
    const result = schema.safeParse(entry.value);
    if (!result.success) {
      problems.push(...issuesToProblems(entry.source, result.error.issues));
      continue;
    }
    const { id, name } = result.data;
    if (out.has(id)) {
      problems.push({ where: entry.source, path: 'id', message: `duplicate ${entity} id "${id}"` });
      continue;
    }
    // Names are compared folded, so "Ash Wolf" and "ash wolf" cannot both be printed.
    const folded = name.toLocaleLowerCase('en');
    const owner = names.get(folded);
    if (owner !== undefined) problems.push({ where: entry.source, path: 'name', message: `${entity} "${owner}" already has the name "${name}"` });
    names.set(folded, id);
    out.set(id, result.data);
  }
  return out;
}

/** Validates a whole catalogue. The index is returned only when there is no problem at all. */
export function checkCatalog(raw: RawCatalog): CatalogResult {
  const problems: Problem[] = [];
  const index = {
    keyword: parseAll('keyword', raw.keyword, problems),
    faction: parseAll('faction', raw.faction, problems),
    set: parseAll('set', raw.set, problems),
    card: parseAll('card', raw.card, problems),
    deck: parseAll('deck', raw.deck, problems),
  } satisfies CatalogIndex;
  problems.push(...crossReferences(index));
  return problems.length === 0 ? { ok: true, index } : { ok: false, problems };
}

/** Every rule that needs more than one entity. Exported for the tests. */
export function crossReferences(index: CatalogIndex): Problem[] {
  const problems: Problem[] = [];
  const add = (where: string, path: string, message: string): void => {
    problems.push({ where, path, message });
  };
  const need = (entity: EntityName, id: string, where: string, path: string): boolean => {
    if (index[entity].has(id)) return true;
    add(where, path, `unknown ${entity} "${id}"`);
    return false;
  };

  for (const f of index.faction.values()) {
    const where = `faction/${f.id}`;
    if (f.rival === null || !need('faction', f.rival, where, 'rival')) continue;
    // Checked from both sides: a one-sided rivalry is reported on the faction that claims it.
    const back = index.faction.get(f.rival)?.rival ?? null;
    if (back !== f.id) add(where, 'rival', `rival "${f.rival}" names ${back === null ? 'no rival' : `"${back}"`} instead of "${f.id}"`);
  }

  const codes = new Map<string, string>();
  const orders = new Map<number, string>();
  for (const s of index.set.values()) {
    const where = `set/${s.id}`;
    const code = codes.get(s.code);
    if (code !== undefined) add(where, 'code', `set "${code}" already uses code ${s.code}`);
    codes.set(s.code, s.id);
    const order = orders.get(s.releaseOrder);
    if (order !== undefined) add(where, 'releaseOrder', `set "${order}" already has release order ${s.releaseOrder}`);
    orders.set(s.releaseOrder, s.id);
  }

  const perSet = new Map<string, number>();
  const summoned = new Set<string>();
  for (const c of index.card.values()) {
    const where = `card/${c.id}`;
    if (need('set', c.set, where, 'set')) perSet.set(c.set, (perSet.get(c.set) ?? 0) + 1);
    if (c.faction !== null) need('faction', c.faction, where, 'faction');
    c.keywords.forEach((k, i) => {
      const keyword = index.keyword.get(k.keyword);
      if (!keyword) return void add(where, `keywords.${i}.keyword`, `unknown keyword "${k.keyword}"`);
      if (keyword.takesValue && k.value === null) add(where, `keywords.${i}.value`, `keyword "${k.keyword}" takes a value`);
      if (!keyword.takesValue && k.value !== null) add(where, `keywords.${i}.value`, `keyword "${k.keyword}" takes no value`);
    });
    if (c.body.type !== 'spell') continue;
    c.body.effects.forEach((e, i) => {
      if (e.kind !== 'summon') return;
      summoned.add(e.card);
      const path = `body.effects.${i}.card`;
      if (!need('card', e.card, where, path)) return;
      const target = index.card.get(e.card);
      if (target?.body.type !== 'unit' || !target.body.token) add(where, path, `summons "${e.card}", which is not a token unit`);
    });
  }
  // The other direction: a token that no card summons can never enter play.
  for (const c of index.card.values()) {
    if (c.body.type === 'unit' && c.body.token && !summoned.has(c.id)) add(`card/${c.id}`, 'body.token', 'no card summons this token');
  }
  for (const [setId, count] of perSet) {
    const size = index.set.get(setId)?.size ?? 0;
    if (count > size) add(`set/${setId}`, 'size', `holds ${count} cards and its size is ${size}`);
  }

  for (const d of index.deck.values()) {
    const where = `deck/${d.id}`;
    need('faction', d.faction, where, 'faction');
    d.cards.forEach((entry, i) => {
      const path = `cards.${i}`;
      if (!need('card', entry.card, where, `${path}.card`)) return;
      const card = index.card.get(entry.card);
      if (!card) return;
      if (card.faction !== null && card.faction !== d.faction) add(where, `${path}.card`, `"${card.id}" belongs to faction "${card.faction}"`);
      if (card.body.type === 'unit' && card.body.token) add(where, `${path}.card`, `"${card.id}" is a token`);
      if (card.limits.banned) add(where, `${path}.card`, `"${card.id}" is banned`);
      if (entry.copies > card.limits.maxCopies) add(where, `${path}.copies`, `"${card.id}" allows ${card.limits.maxCopies} copies`);
    });
  }
  return problems;
}
