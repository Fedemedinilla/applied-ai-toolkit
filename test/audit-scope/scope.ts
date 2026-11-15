// The scope of a diff-scoped audit: the files a branch changed, the audit units that own them, and
// the units that import a changed file, found from the real imports of the repository.
//
// A unit is a dependent when one of its files imports a file of another unit and that file, by its
// own imports, reaches a changed file. Imports are read with import-fences' extractor, so comments
// and strings that look like imports are not imports, and the dependents match what the fences see.
// Only relative specifiers are followed: a bare package name (`zod`, a workspace package) is not a
// repository path, and a file read at runtime with readFileSync is not an import.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { join } from 'node:path';
import { moduleRefs, parse } from '../../import-fences/src/index.ts';
import { AREAS, type Area, type AreaKind, unitsOf } from './units.ts';

const CODE = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
const isCode = (path: string) => CODE.some((ext) => path.endsWith(ext));

export interface ImportEdge {
  /** The file that imports, relative to the repository root. */
  readonly importer: string;
  readonly line: number;
  /** As written in the source. */
  readonly specifier: string;
  /** The imported file, relative to the repository root. */
  readonly target: string;
}

export interface Because extends ImportEdge {
  /** The unit the imported file belongs to, already in scope. */
  readonly on: string;
}

export interface ScopedUnit {
  readonly id: string;
  readonly kind: AreaKind;
  readonly reason: 'changed' | 'dependent';
  /** Changed files of the unit, or, for a dependent, its files whose imports caused it. */
  readonly files: readonly string[];
  readonly paths: string;
  readonly context: string;
}

export interface Scope {
  readonly version: 1;
  readonly base: string;
  readonly mergeBase: string;
  readonly head: string;
  readonly branch: string;
  /** Uncommitted or untracked changes are part of `files`. */
  readonly dirty: boolean;
  readonly files: readonly string[];
  /** Changed units first, then dependents, each group in the order of AREAS. */
  readonly units: readonly ScopedUnit[];
  readonly dependents: readonly { readonly unit: string; readonly because: readonly Because[] }[];
  /** Changed files that no unit owns. */
  readonly unmapped: readonly string[];
}

/** The repository-relative imports of the given files. `read` returns null for a file that is gone. */
export function importEdges(files: readonly string[], read: (path: string) => string | null): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const importer of files) {
    if (!isCode(importer)) continue;
    const content = read(importer);
    if (content === null) continue;
    for (const ref of moduleRefs(parse(importer, content))) {
      const specifier = ref.specifier;
      if (specifier === null || !specifier.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(importer), specifier.split('?')[0] ?? ''));
      if (target.startsWith('../') || target === '..') continue;
      edges.push({ importer, line: ref.line, specifier, target });
    }
  }
  return edges;
}

/** Every tracked or untracked (not ignored) file of the repository at `cwd`. */
function repoFiles(cwd: string): string[] {
  return git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
}

/** The import edges of the working tree at `cwd`. */
export function repoEdges(cwd: string): ImportEdge[] {
  return importEdges(repoFiles(cwd), (path) => {
    const full = join(cwd, path);
    return existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : null;
  });
}

export interface ScopeInput {
  readonly base: string;
  readonly mergeBase: string;
  readonly head: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly changed: readonly string[];
  readonly edges: readonly ImportEdge[];
}

export function buildScope(input: ScopeInput, areas: readonly Area[] = AREAS): Scope {
  const files = [...new Set(input.changed)].sort();
  const of = (path: string) => unitsOf(path, areas);
  const changedUnits = new Set(files.flatMap(of));

  // Every file that reaches a changed file through imports, the changed files included.
  const reaching = new Set(files);
  const importersOf = new Map<string, ImportEdge[]>();
  for (const e of input.edges) importersOf.set(e.target, [...(importersOf.get(e.target) ?? []), e]);
  const queue = [...files];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const e of importersOf.get(file) ?? []) {
      if (!reaching.has(e.importer)) {
        reaching.add(e.importer);
        queue.push(e.importer);
      }
    }
  }

  // A crossing into another unit, onto a file that reaches the change, makes the importer's unit a dependent.
  const because = new Map<string, Because[]>();
  for (const e of input.edges) {
    if (!reaching.has(e.target)) continue;
    const from = of(e.importer);
    for (const on of of(e.target)) {
      if (from.includes(on)) continue;
      for (const unit of from) {
        if (changedUnits.has(unit)) continue;
        const list = because.get(unit) ?? [];
        if (!list.some((b) => b.importer === e.importer && b.line === e.line && b.on === on)) list.push({ on, ...e });
        because.set(unit, list);
      }
    }
  }

  const unit = (area: Area, reason: ScopedUnit['reason'], unitFiles: readonly string[]): ScopedUnit => ({
    id: area.id,
    kind: area.kind,
    reason,
    files: [...new Set(unitFiles)].sort(),
    paths: area.paths,
    context: area.context,
  });
  const changed = areas.filter((a) => changedUnits.has(a.id)).map((a) => unit(a, 'changed', files.filter((f) => of(f).includes(a.id))));
  const dependentAreas = areas.filter((a) => because.has(a.id));
  return {
    version: 1,
    base: input.base,
    mergeBase: input.mergeBase,
    head: input.head,
    branch: input.branch,
    dirty: input.dirty,
    files,
    units: [...changed, ...dependentAreas.map((a) => unit(a, 'dependent', (because.get(a.id) ?? []).map((b) => b.importer)))],
    dependents: dependentAreas.map((a) => ({ unit: a.id, because: because.get(a.id) ?? [] })),
    unmapped: files.filter((f) => of(f).length === 0),
  };
}

export class GitError extends Error {}

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new GitError(`git ${args.join(' ')} failed${typeof stderr === 'string' && stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  }
}

const list = (out: string) => out.split('\0').filter(Boolean);

/** The scope of the branch checked out at `cwd` against `base`: base...HEAD plus uncommitted work. */
export function gitScope({ cwd, base }: { readonly cwd: string; readonly base: string }): Scope {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const committed = list(git(root, ['diff', '-z', '--name-only', `${base}...HEAD`]));
  const uncommitted = [...list(git(root, ['diff', '-z', '--name-only', 'HEAD'])), ...list(git(root, ['ls-files', '-z', '--others', '--exclude-standard']))];
  return buildScope({
    base,
    mergeBase,
    head,
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    dirty: uncommitted.length > 0,
    changed: [...committed, ...uncommitted],
    edges: repoEdges(root),
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatText(scope: Scope): string {
  const changed = scope.units.filter((u) => u.reason === 'changed');
  const lines = [
    `Diff-scoped audit: ${plural(scope.files.length, 'file')} changed against ${scope.base} (merge base ${scope.mergeBase.slice(0, 7)}, head ${scope.head.slice(0, 7)}${scope.dirty ? ', with uncommitted changes' : ''}).`,
    `Units: ${changed.length} changed, ${scope.dependents.length} dependent.`,
  ];
  const width = Math.max(0, ...scope.units.map((u) => u.id.length));
  for (const u of changed) lines.push(`  ${u.id.padEnd(width)}  changed    ${plural(u.files.length, 'file')}`);
  for (const d of scope.dependents) {
    const first = d.because[0];
    const more = d.because.length > 1 ? ` (+${d.because.length - 1} more)` : '';
    lines.push(`  ${d.unit.padEnd(width)}  dependent  ${first ? `${first.importer}:${first.line} -> ${first.target}` : ''}${more}`);
  }
  if (scope.unmapped.length) lines.push(`Unmapped: ${scope.unmapped.join(', ')}`);
  return `${lines.join('\n')}\n`;
}
