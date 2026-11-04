/**
 * promote: moves accepted candidates from `_candidates/` into the catalogue. Every check runs
 * before any file moves, and a single problem moves none. The writes that follow are one file at a
 * time, not a transaction: if a target changes between the check and its write, promote stops and
 * says how many files it had already moved.
 *
 * The candidates were judged against the catalogue of their run. The catalogue may have changed
 * since (a card removed, a set filled up, another promote), and a file in `_candidates/` may have
 * been edited or put there by hand, so the full validator and the range rules for generated
 * content run again here.
 */
import { checkCatalog, emptyRaw, type CatalogIndex, type Problem } from './catalog.ts';
import { ForgeError } from './errors.ts';
import { candidatePath, entityPath, idOf, loadCandidates, loadCatalog, occupant, relativeSource, remove, writeJsonAtomic, writeJsonNew } from './files.ts';
import { checkRules } from './rules.ts';
import { ENTITIES, ENTITY_NAMES, SCHEMAS, type EntityName } from './schemas.ts';

/**
 * Rules promote does not re-apply. Pending ids are the candidates being promoted, and a candidate
 * that claims to be hand-written is reported by promote itself with a clearer message.
 */
const SKIPPED_RULES: ReadonlySet<string> = new Set(['not-pending', 'not-handwritten']);

export interface PromoteOptions {
  readonly dir: string;
  readonly entity: EntityName;
  /** Candidate ids, or 'all' for every pending candidate of the entity type. */
  readonly ids: readonly string[] | 'all';
  /** Allows replacing an existing generated entry. A hand-written one is never replaced. */
  readonly replace?: boolean;
}

export interface PromoteResult {
  readonly moved: readonly string[];
  readonly replaced: readonly string[];
}

export async function promote(options: PromoteOptions): Promise<PromoteResult> {
  const { dir, entity } = options;
  const replace = options.replace ?? false;
  const catalog = await loadCatalog(dir);
  const pending = await loadCandidates(dir, entity);
  const problems: Problem[] = [...catalog.problems, ...pending.problems];

  const byId = new Map(pending.raw[entity].flatMap((e) => {
    const id = idOf(e.value);
    return id === null ? [] : [[id, e] as const];
  }));
  const wanted = options.ids === 'all' ? [...byId.keys()].sort() : [...new Set(options.ids)];
  if (wanted.length === 0) throw new ForgeError('bad_request', `No ${entity} candidates to promote`);

  const selected: { id: string; value: unknown }[] = [];
  const replaced: string[] = [];
  for (const id of wanted) {
    const entry = byId.get(id);
    const where = `${ENTITIES[entity].folder}/${id}.json`;
    if (!entry) {
      problems.push({ where: `_candidates/${where}`, path: '', message: 'no such candidate' });
      continue;
    }
    if (typeof entry.value === 'object' && entry.value !== null && 'handwritten' in entry.value && entry.value.handwritten === true) {
      problems.push({ where: entry.source, path: 'handwritten', message: 'a candidate cannot be hand-written; edit the catalogue directly instead' });
    }
    const target = await occupant(entityPath(dir, entity, id));
    if (target === 'handwritten') problems.push({ where, path: '', message: 'is hand-written, and promote never overwrites it' });
    else if (target === 'unreadable') problems.push({ where, path: '', message: 'cannot be read as JSON, so it is treated as hand-written and kept' });
    else if (target === 'generated' && !replace) problems.push({ where, path: '', message: 'already exists; pass --replace to replace a generated entry' });
    else if (target === 'generated') replaced.push(id);
    selected.push({ id, value: entry.value });
  }

  // The catalogue as it would be after the move: replaced entries out, candidates in.
  const merged = emptyRaw();
  for (const name of ENTITY_NAMES) {
    merged[name].push(...catalog.raw[name].filter((e) => !(name === entity && replaced.some((id) => e.source === relativeSource(entity, `${id}.json`)))));
  }
  merged[entity].push(...selected.map((s) => ({ source: `_candidates/${relativeSource(entity, `${s.id}.json`)}`, value: s.value })));
  const checked = checkCatalog(merged);
  if (!checked.ok) problems.push(...checked.problems);
  problems.push(...rangeRules(entity, selected, checkCatalog(catalog.raw), replaced));
  if (problems.length > 0) throw new ForgeError('refused', 'Nothing was promoted', problems);

  // Written as parsed, so the catalogue file has every default spelled out.
  const parsed = checked.ok ? checked.index[entity] : new Map<string, unknown>();
  const moved: string[] = [];
  for (const { id } of selected) {
    const value = parsed.get(id);
    const path = entityPath(dir, entity, id);
    if (replaced.includes(id)) {
      // Checked again right before the write, in case a person marked it hand-written meanwhile.
      if ((await occupant(path)) !== 'generated') throw new ForgeError('refused', `${relativeSource(entity, `${id}.json`)} changed during promote; ${moved.length} moved before it`);
      await writeJsonAtomic(path, value);
    } else {
      await writeJsonNew(path, value);
    }
    await remove(candidatePath(dir, entity, id));
    moved.push(id);
  }
  return { moved, replaced };
}

/**
 * The range rules for generated content, applied to each candidate that parses, against the
 * catalogue as it is now without the entries being replaced. A catalogue that does not validate is
 * already reported by the full check, so the rules then run against an empty index.
 */
function rangeRules(entity: EntityName, selected: readonly { id: string; value: unknown }[], current: ReturnType<typeof checkCatalog>, replaced: readonly string[]): Problem[] {
  const index = withoutReplaced(current.ok ? current.index : EMPTY_INDEX, entity, replaced);
  const problems: Problem[] = [];
  for (const { id, value } of selected) {
    const parsed = SCHEMAS[entity].safeParse(value);
    if (!parsed.success) continue; // reported by the full check
    for (const failure of checkRules(entity, parsed.data, { index, pending: new Set() })) {
      if (SKIPPED_RULES.has(failure.rule)) continue;
      problems.push({ where: `_candidates/${relativeSource(entity, `${id}.json`)}`, path: '', message: `breaks the rule for generated content "${failure.rule}": ${failure.message}` });
    }
  }
  return problems;
}

const EMPTY_INDEX: CatalogIndex = { keyword: new Map(), faction: new Map(), set: new Map(), card: new Map(), deck: new Map() };

function withoutReplaced(index: CatalogIndex, entity: EntityName, replaced: readonly string[]): CatalogIndex {
  if (replaced.length === 0) return index;
  const drop = <T>(map: ReadonlyMap<string, T>, name: EntityName): ReadonlyMap<string, T> =>
    name === entity ? new Map([...map].filter(([id]) => !replaced.includes(id))) : map;
  return {
    keyword: drop(index.keyword, 'keyword'),
    faction: drop(index.faction, 'faction'),
    set: drop(index.set, 'set'),
    card: drop(index.card, 'card'),
    deck: drop(index.deck, 'deck'),
  };
}
