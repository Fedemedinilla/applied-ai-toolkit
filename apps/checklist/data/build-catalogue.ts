// Builds public/catalogue.json from the English tables in data/source/.
//
//   node apps/checklist/data/build-catalogue.ts           writes the file
//   node apps/checklist/data/build-catalogue.ts --check   exits 1 when the committed file is stale
//
// The source tables are Markdown with fixed columns, so a reviewer reads them as tables and a diff
// shows one row per change. Every row is validated here: a typo in a priority, a platform or a
// dependency fails the build instead of reaching the app as a check that never applies.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AREAS,
  FEATURES,
  PLATFORM_GROUPS,
  PLATFORMS,
  PRIORITIES,
  type Area,
  type Catalogue,
  type FeatureId,
  type IncidentStep,
  type Item,
  type MatrixRow,
  type Module,
  type NeedId,
  type Phase,
  type PlatformId,
  type PreChangeRow,
  type Priority,
} from '../src/catalogue.ts';

const SOURCE = new URL('./source/', import.meta.url);
const OUTPUT = new URL('../public/catalogue.json', import.meta.url);

/** One source file per module, and the method phase its checks belong to. */
export const MODULE_FILES: readonly { file: string; module: Module; phase: number }[] = [
  { file: 'external.md', module: 'EXT', phase: 1 },
  { file: 'visibility.md', module: 'VIS', phase: 1 },
  { file: 'internal.md', module: 'INT', phase: 2 },
  { file: 'platforms.md', module: 'PLA', phase: 2 },
  { file: 'commerce.md', module: 'COM', phase: 2 },
  { file: 'security.md', module: 'SEG', phase: 4 },
  { file: 'speed.md', module: 'VEL', phase: 4 },
  { file: 'monitoring.md', module: 'OPE', phase: 7 },
];

const ITEM_COLUMNS = ['ID', 'Title', 'Question', 'Where', 'Pass when', 'If it fails', 'Do not touch', 'Priority', 'Area', 'Platforms', 'Needs', 'Access'];

export class SourceError extends Error {}

type Row = Record<string, string>;

/** Splits a Markdown table line on unescaped pipes. Cells are trimmed; the outer pipes are dropped. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out.slice(1, -1);
}

/** Every table in a Markdown text, keyed by the nearest heading above it. */
export function tables(text: string, file: string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  const lines = text.split('\n');
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const h = /^#{1,3} (.+)$/u.exec(line);
    if (h) heading = h[1]?.trim() ?? '';
    if (!line.startsWith('|')) continue;
    const header = cells(line);
    const sep = lines[i + 1] ?? '';
    if (!/^\|(\s*:?-+:?\s*\|)+$/u.test(sep)) throw new SourceError(`${file}:${i + 1}: a table header must be followed by a separator line`);
    const rows: Row[] = [];
    let j = i + 2;
    for (; j < lines.length && (lines[j] ?? '').startsWith('|'); j++) {
      const values = cells(lines[j] ?? '');
      if (values.length !== header.length) {
        throw new SourceError(`${file}:${j + 1}: ${values.length} cells, the header has ${header.length}`);
      }
      rows.push(Object.fromEntries(header.map((name, k) => [name, values[k] ?? ''])));
    }
    if (out.has(heading)) throw new SourceError(`${file}: two tables under "${heading}"`);
    out.set(heading, rows);
    i = j - 1;
  }
  return out;
}

/** The catalogue is English only. A non-ASCII character is most often Spanish text left in. */
function checkText(value: string, where: string): string {
  if (value.length === 0) throw new SourceError(`${where}: empty cell`);
  const bad = /[^\x20-\x7e]/u.exec(value);
  if (bad) throw new SourceError(`${where}: character U+${(bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')} outside printable ASCII`);
  return value;
}

const optional = (value: string, where: string): string | null => (value === '-' ? null : checkText(value, where));
const list = (value: string): string[] => (value === '-' ? [] : value.split(/[\s,]+/u).filter(Boolean));

function oneOf<T extends string>(value: string, allowed: readonly T[], where: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new SourceError(`${where}: "${value}" is not one of ${allowed.join(', ')}`);
  return value as T;
}

function expandPlatforms(value: string, where: string): PlatformId[] {
  const ids: readonly string[] = PLATFORMS.map((p) => p.id);
  const out = new Set<PlatformId>();
  for (const token of list(value)) {
    const group = PLATFORM_GROUPS[token];
    if (group) group.forEach((p) => out.add(p));
    else out.add(oneOf(token, ids as readonly PlatformId[], where));
  }
  if (out.size === 0) throw new SourceError(`${where}: no platform`);
  // Fixed order, so the JSON does not depend on how the cell was written.
  return PLATFORMS.map((p) => p.id).filter((p) => out.has(p));
}

function column(rows: readonly Row[] | undefined, expected: readonly string[], where: string): readonly Row[] {
  if (!rows) throw new SourceError(`${where}: table missing`);
  const first = rows[0];
  if (!first) throw new SourceError(`${where}: table has no rows`);
  const got = Object.keys(first);
  if (got.join('|') !== expected.join('|')) throw new SourceError(`${where}: columns are ${got.join(', ')}; expected ${expected.join(', ')}`);
  return rows;
}

function readItems(sourceDir: URL): Item[] {
  const items: Item[] = [];
  const seen = new Set<string>();
  const featureIds = FEATURES.map((f) => f.id);
  for (const { file, module, phase } of MODULE_FILES) {
    const all = tables(readFileSync(new URL(file, sourceDir), 'utf8'), file);
    if (all.size !== 1) throw new SourceError(`${file}: expected one table, found ${all.size}`);
    const rows = column([...all.values()][0], ITEM_COLUMNS, file);
    for (const row of rows) {
      const id = row.ID ?? '';
      const at = `${file} ${id || '(no id)'}`;
      if (!new RegExp(`^${module}-\\d{2}$`, 'u').test(id)) throw new SourceError(`${at}: the id must be ${module}-NN`);
      if (seen.has(id)) throw new SourceError(`${at}: duplicate id`);
      seen.add(id);
      items.push({
        id,
        module,
        phase,
        area: oneOf<Area>(row.Area ?? '', AREAS, `${at} Area`),
        title: checkText(row.Title ?? '', `${at} Title`),
        question: checkText(row.Question ?? '', `${at} Question`),
        where: checkText(row.Where ?? '', `${at} Where`),
        pass: checkText(row['Pass when'] ?? '', `${at} Pass when`),
        ifFails: checkText(row['If it fails'] ?? '', `${at} If it fails`),
        doNotTouch: optional(row['Do not touch'] ?? '', `${at} Do not touch`),
        priority: oneOf<Priority>(row.Priority ?? '', PRIORITIES, `${at} Priority`),
        platforms: expandPlatforms(row.Platforms ?? '', `${at} Platforms`),
        needs: list(row.Needs ?? '').map((n) => oneOf<FeatureId>(n, featureIds, `${at} Needs`)),
        access: oneOf(row.Access ?? '', ['passive', 'authorized'] as const, `${at} Access`),
      });
    }
  }
  return items;
}

function readProcedures(sourceDir: URL): Omit<Catalogue, 'format' | 'version' | 'id' | 'items'> {
  const file = 'procedures.md';
  const all = tables(readFileSync(new URL(file, sourceDir), 'utf8'), file);
  const int = (v: string, where: string): number => {
    if (!/^\d+$/u.test(v)) throw new SourceError(`${where}: "${v}" is not a whole number`);
    return Number(v);
  };

  const phases: Phase[] = column(all.get('Phases'), ['Phase', 'Name', 'Produces'], `${file} Phases`).map((r, i) => ({
    number: int(r.Phase ?? '', `${file} Phases row ${i + 1}`),
    name: checkText(r.Name ?? '', `${file} Phases row ${i + 1}`),
    produces: checkText(r.Produces ?? '', `${file} Phases row ${i + 1}`),
  }));

  const ids = (rows: readonly { id: string }[], where: string): void => {
    const seen = new Set<string>();
    for (const { id } of rows) {
      if (!/^[a-z][a-z0-9-]*$/u.test(id)) throw new SourceError(`${where}: "${id}" is not a kebab-case id`);
      if (seen.has(id)) throw new SourceError(`${where}: duplicate id ${id}`);
      seen.add(id);
    }
  };

  const preChange: PreChangeRow[] = column(all.get('Pre-change list'), ['ID', 'Item'], `${file} Pre-change list`).map((r) => ({
    id: r.ID ?? '',
    text: checkText(r.Item ?? '', `${file} pre-change ${r.ID ?? ''}`),
  }));
  ids(preChange, `${file} Pre-change list`);

  const needIds: readonly NeedId[] = [...FEATURES.map((f) => f.id), 'store'];
  const postChange: MatrixRow[] = column(all.get('Post-change matrix'), ['ID', 'What', 'How', 'Pass when', 'Needs'], `${file} Post-change matrix`).map((r) => {
    const at = `${file} matrix ${r.ID ?? ''}`;
    return {
      id: r.ID ?? '',
      what: checkText(r.What ?? '', at),
      how: checkText(r.How ?? '', at),
      pass: checkText(r['Pass when'] ?? '', at),
      needs: list(r.Needs ?? '').map((n) => oneOf<NeedId>(n, needIds, `${at} Needs`)),
    };
  });
  ids(postChange, `${file} Post-change matrix`);

  const incidentPhases = column(all.get('Incident phases'), ['Phase', 'Name'], `${file} Incident phases`).map((r, i) => ({
    number: int(r.Phase ?? '', `${file} Incident phases row ${i + 1}`),
    name: checkText(r.Name ?? '', `${file} Incident phases row ${i + 1}`),
  }));
  const phaseNumbers = new Set(incidentPhases.map((p) => p.number));

  const steps: IncidentStep[] = [];
  const stepPhase = new Map<string, number>();
  for (const r of column(all.get('Incident steps'), ['ID', 'Phase', 'Step', 'Requires'], `${file} Incident steps`)) {
    const id = r.ID ?? '';
    const at = `${file} step ${id}`;
    const phase = int(r.Phase ?? '', at);
    if (!phaseNumbers.has(phase)) throw new SourceError(`${at}: phase ${phase} is not an incident phase`);
    const requires = list(r.Requires ?? '');
    for (const dep of requires) {
      // Only earlier rows may be required: the table order is then a valid order, and no cycle can exist.
      const depPhase = stepPhase.get(dep);
      if (depPhase === undefined) throw new SourceError(`${at}: requires "${dep}", which is not an earlier step`);
      if (depPhase > phase) throw new SourceError(`${at}: requires "${dep}" from a later phase`);
    }
    steps.push({ id, phase, text: checkText(r.Step ?? '', at), requires });
    stepPhase.set(id, phase);
  }
  ids(steps, `${file} Incident steps`);

  return { phases, preChange, postChange, incident: { phases: incidentPhases, steps } };
}

export function buildCatalogue(sourceDir: URL = SOURCE): Catalogue {
  const items = readItems(sourceDir);
  const procedures = readProcedures(sourceDir);
  for (const item of items) {
    if (!procedures.phases.some((p) => p.number === item.phase)) throw new SourceError(`${item.id}: phase ${item.phase} is not in the Phases table`);
  }
  const body = { phases: procedures.phases, items, preChange: procedures.preChange, postChange: procedures.postChange, incident: procedures.incident };
  const id = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { format: 'site-checklist-catalogue', version: 1, id, ...body };
}

export const serialise = (catalogue: Catalogue): string => `${JSON.stringify(catalogue, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fresh = serialise(buildCatalogue());
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
      // A missing file is stale too.
    }
    if (current !== fresh) {
      console.error('apps/checklist/public/catalogue.json is stale: run node apps/checklist/data/build-catalogue.ts');
      process.exit(1);
    }
    console.log('catalogue.json is current');
  } else {
    writeFileSync(OUTPUT, fresh);
    const c = JSON.parse(fresh) as Catalogue;
    console.log(`wrote catalogue.json: ${c.items.length} checks, ${c.incident.steps.length} incident steps, id ${c.id}`);
  }
}
