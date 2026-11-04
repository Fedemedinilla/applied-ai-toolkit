/** Runs every rule of a config over a file source and returns the violations, sorted by place. */
import { isBuiltin } from 'node:module';
import { posix } from 'node:path';
import type ts from 'typescript';
import type { FencesConfig, RuleConfig } from './config.ts';
import { moduleRefs, namesOf, parse, reexports, stringsContaining, type ModuleRef } from './extract.ts';
import type { FileSource } from './files.ts';
import { globMatcher } from './glob.ts';

export type RuleId =
  | 'forbidden-import'
  | 'unresolved-import'
  | 'single-importer'
  | 'no-reexport'
  | 'single-reader'
  | 'single-string'
  | 'relative-extension'
  | 'dynamic-import'
  | 'stale-allow'
  | 'empty-group';

export interface Violation {
  /** Path relative to the root, or the config label for empty-group and stale-allow on a missing file. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: RuleId;
  readonly reason: string;
  /** The rule's `why` from the config, so whoever breaks a fence reads its reason. */
  readonly why?: string;
}

export interface CheckResult {
  readonly violations: readonly Violation[];
  readonly files: number;
  readonly rules: number;
}

interface Parsed {
  readonly source: ts.SourceFile;
  readonly refs: readonly ModuleRef[];
}

const MODULE_KINDS: ReadonlySet<ModuleRef['kind']> = new Set(['import', 'export', 'dynamic', 'require', 'import-equals', 'import-type']);

/** `pkg` matches `pkg` and `pkg/sub`; a pattern ending in `*` matches by prefix (`node:*`). */
export function matchesSpecifier(specifier: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return specifier.startsWith(pattern.slice(0, -1));
  return specifier === pattern || specifier.startsWith(`${pattern}/`);
}

const isRelative = (specifier: string) => specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
const isPathLike = (specifier: string) => isRelative(specifier) || specifier.startsWith('/');
/** Vite's `?raw`, `?url`, `?worker` and a `#hash` do not change which file is read. */
const withoutQuery = (specifier: string) => specifier.replace(/[?#].*$/, '');

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The repository path a path-like specifier names, or null when it leaves the root. */
function target(from: string, specifier: string): string | null {
  const bare = withoutQuery(specifier);
  const joined = bare.startsWith('/') ? posix.normalize(bare.slice(1)) : posix.join(posix.dirname(from), bare);
  return joined === '..' || joined.startsWith('../') ? null : joined.replace(/\/$/, '');
}

const INLINE_TYPES_NOTE = 'the module still runs; write import type to erase it';

/** The specifier that names `to` from the file `from`: `./x.ts` or `../x.ts`. */
function relativeSpecifier(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(from), to);
  return rel.startsWith('../') ? rel : `./${rel}`;
}

const SOURCE_FOR_OUTPUT: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx'],
};
const BUNDLER_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** How a bundler or tsc would resolve it: the exact file, `.js` written for `.ts`, no extension, or an index. */
function resolveLoosely(path: string, files: FileSource): string | null {
  if (files.isFile(path)) return path;
  const ext = posix.extname(path);
  for (const alternative of SOURCE_FOR_OUTPUT[ext] ?? []) {
    const candidate = path.slice(0, -ext.length) + alternative;
    if (files.isFile(candidate)) return candidate;
  }
  for (const candidate of [...BUNDLER_EXTENSIONS.map((e) => path + e), ...BUNDLER_EXTENSIONS.map((e) => `${path}/index${e}`)]) {
    if (files.isFile(candidate)) return candidate;
  }
  return null;
}

function list(paths: readonly string[]): string {
  return paths.length === 0 ? 'no file' : paths.join(', ');
}

export function check(config: FencesConfig, files: FileSource, configLabel = 'import-fences config'): CheckResult {
  const all = files.list();
  const parsed = new Map<string, Parsed>();
  const get = (path: string): Parsed | null => {
    const cached = parsed.get(path);
    if (cached !== undefined) return cached;
    const content = files.read(path);
    if (content === null) return null;
    const source = parse(path, content);
    const entry = { source, refs: moduleRefs(source) };
    parsed.set(path, entry);
    return entry;
  };

  const members = new Map<string, readonly string[]>();
  for (const [name, group] of Object.entries(config.groups)) {
    const included = globMatcher(group.include);
    const excluded = globMatcher(group.exclude);
    members.set(
      name,
      all.filter((p) => included(p) && !excluded(p)),
    );
  }

  const violations: Violation[] = [];
  for (const [name, group] of Object.entries(config.groups)) {
    if (!group.allowEmpty && members.get(name)?.length === 0) {
      violations.push({
        file: configLabel,
        line: 0,
        column: 0,
        rule: 'empty-group',
        reason: `group "${name}" matches no file, so its rules check nothing (include: ${group.include.join(', ')})`,
      });
    }
  }

  for (const rule of config.rules) {
    const inGroup = members.get(rule.group) ?? [];
    const report = (v: Omit<Violation, 'why'>) => violations.push(rule.why === undefined ? v : { ...v, why: rule.why });
    switch (rule.rule) {
      case 'forbidden-import':
        forbiddenImport(rule, inGroup, files, get, report, configLabel);
        break;
      case 'single-importer':
        singleImporter(rule, inGroup, get, report, configLabel);
        break;
      case 'single-reader':
      case 'single-string':
        singleMention(rule, inGroup, get, report, configLabel);
        break;
      case 'relative-extension':
        relativeExtension(inGroup, files, get, report);
        break;
      case 'dynamic-import':
        dynamicImport(inGroup, get, report);
        break;
    }
  }

  // One line per place and rule: a file reached from many entries reports its import once.
  const seen = new Set<string>();
  const unique = violations.filter((v) => {
    const key = `${v.file}:${v.line}:${v.column}:${v.rule}:${v.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return { violations: unique, files: all.length, rules: config.rules.length };
}

type Report = (violation: Omit<Violation, 'why'>) => void;
type Get = (path: string) => Parsed | null;
type RuleOf<K extends RuleConfig['rule']> = Extract<RuleConfig, { rule: K }>;

const DYNAMIC_REASON: Readonly<Record<ModuleRef['kind'], string>> = {
  dynamic: 'import() with a computed argument: a bundler turns it into a glob and bundles every file that matches',
  require: 'require() with a computed argument: what it loads cannot be checked',
  url: 'new URL() with a computed path and import.meta.url: a bundler emits every file that matches',
  glob: 'import.meta.glob() bundles every file that matches its pattern, and the fences cannot follow it',
  import: 'import with a computed specifier',
  export: 'export with a computed specifier',
  'import-equals': 'import = require() with a computed argument',
  'import-type': 'import() type with a computed argument',
};

function forbiddenImport(
  rule: RuleOf<'forbidden-import'>,
  entries: readonly string[],
  files: FileSource,
  get: Get,
  report: Report,
  configLabel: string,
): void {
  const inPaths = globMatcher(rule.paths);
  const excepted = globMatcher(rule.except);
  /** Paths the group reached that only `except` let through, for the stale check at the end. */
  const exceptedSeen = new Set<string>();
  const forbiddenPath = (path: string): boolean => {
    if (!inPaths(path)) return false;
    if (!excepted(path)) return true;
    exceptedSeen.add(path);
    return false;
  };
  const external = (s: string) => rule.external.some((p) => matchesSpecifier(s, p));
  const installed = (from: string, name: string) => {
    for (let dir = posix.dirname(from); ; dir = posix.dirname(dir)) {
      if (files.isFile(posix.join(dir === '.' ? '' : dir, 'node_modules', name, 'package.json'))) return true;
      if (dir === '.' || dir === '') return false;
    }
  };
  const via = (chain: readonly string[]) => (chain.length > 1 ? `, reached from ${chain.slice(0, -1).join(' -> ')}` : '');
  const typeNote = (ref: ModuleRef) =>
    ref.typeOnly ? ' (type-only; this rule forbids types too)' : ref.inlineTypesOnly ? ` (${INLINE_TYPES_NOTE})` : '';

  for (const entry of entries) {
    if (inPaths(entry) && !excepted(entry)) {
      report({ file: entry, line: 1, column: 1, rule: 'forbidden-import', reason: `is in group "${rule.group}" but lives in a forbidden path` });
    }
  }

  // Breadth first from every entry at once, so each file is read once and keeps its shortest chain.
  const chains = new Map<string, readonly string[]>(entries.map((e) => [e, [e]]));
  const queue = [...entries];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const chain = chains.get(current) ?? [current];
    const file = get(current);
    if (file === null) continue;
    for (const ref of file.refs) {
      if (ref.typeOnly && rule.typeOnly === 'allow') continue;
      const at = { file: current, line: ref.line, column: ref.column };
      if (ref.specifier === null) {
        // Without a walk the rule only promises to check literal imports; dynamic-import covers the rest.
        if (rule.transitive) {
          report({ ...at, rule: 'unresolved-import', reason: `${DYNAMIC_REASON[ref.kind]}; the walk for group "${rule.group}" cannot follow it${via(chain)}` });
        }
        continue;
      }
      const specifier = ref.specifier;
      if (ref.kind === 'url') {
        // An asset or a folder, not a module: checked against the forbidden paths, followed only if it is code.
        const path = isPathLike(specifier) ? target(current, specifier) : null;
        if (path !== null && forbiddenPath(path)) {
          report({ ...at, rule: 'forbidden-import', reason: `points new URL() at ${path}, a path forbidden in group "${rule.group}"${via(chain)}` });
        } else if (path !== null && rule.transitive && files.isFile(path) && !chains.has(path)) {
          chains.set(path, [...chain, path]);
          queue.push(path);
        }
        continue;
      }
      if (!isPathLike(specifier)) {
        if (rule.specifiers.some((p) => matchesSpecifier(specifier, p))) {
          report({ ...at, rule: 'forbidden-import', reason: `imports ${specifier}, forbidden in group "${rule.group}"${typeNote(ref)}${via(chain)}` });
        } else if (!isBuiltin(specifier) && !external(specifier) && !installed(current, packageName(specifier))) {
          report({ ...at, rule: 'unresolved-import', reason: `imports ${specifier}, which is not a built-in or an installed package; declare it in "external" if it is a virtual module${via(chain)}` });
        }
        continue;
      }
      const path = target(current, specifier);
      const resolved = path === null ? null : resolveLoosely(path, files);
      if (resolved === null) {
        report({ ...at, rule: 'unresolved-import', reason: `imports ${specifier}, which names no file in the repository${via(chain)}` });
      } else if (forbiddenPath(resolved)) {
        report({ ...at, rule: 'forbidden-import', reason: `imports ${resolved}, a path forbidden in group "${rule.group}"${typeNote(ref)}${via(chain)}` });
      } else if (rule.transitive && !chains.has(resolved)) {
        chains.set(resolved, [...chain, resolved]);
        queue.push(resolved);
      }
    }
  }

  // An exception nobody uses would let a file start crossing there later without review.
  for (const pattern of rule.except) {
    const matcher = globMatcher([pattern]);
    if (![...exceptedSeen].some((p) => matcher(p))) {
      report({ file: configLabel, line: 0, column: 0, rule: 'stale-allow', reason: `except entry ${pattern} matches nothing that group "${rule.group}" imports; remove it` });
    }
  }
}

function singleImporter(rule: RuleOf<'single-importer'>, inGroup: readonly string[], get: Get, report: Report, configLabel: string): void {
  const allowed = globMatcher(rule.allow);
  const isTarget = (s: string) => matchesSpecifier(s, rule.package);
  const allowedSeen = new Set<string>();
  for (const path of inGroup) {
    const file = get(path);
    if (file === null) continue;
    for (const ref of file.refs) {
      if (ref.specifier === null || !isTarget(ref.specifier)) continue;
      if (ref.typeOnly && rule.typeOnly === 'allow') continue;
      if (allowed(path)) {
        allowedSeen.add(path);
        continue;
      }
      const what = ref.typeOnly ? 'types from' : ref.inlineTypesOnly ? 'only inline types from' : 'values from';
      const note = ref.inlineTypesOnly ? ` (${INLINE_TYPES_NOTE})` : '';
      report({ file: path, line: ref.line, column: ref.column, rule: 'single-importer', reason: `imports ${what} ${ref.specifier}; only ${list(rule.allow)} may${note}` });
    }
    for (const leak of reexports(file.source, isTarget)) {
      report({ file: path, line: leak.line, column: leak.column, rule: 'no-reexport', reason: `re-exports a value of ${rule.package} (${leak.text}), which opens a second way in` });
    }
  }
  staleAllow(rule.allow, inGroup, allowedSeen, `imports ${rule.package}${rule.typeOnly === 'allow' ? ' values' : ''}`, rule.group, report, configLabel);
}

function singleMention(rule: RuleOf<'single-reader'> | RuleOf<'single-string'>, inGroup: readonly string[], get: Get, report: Report, configLabel: string): void {
  const allowed = globMatcher(rule.allow);
  const allowedSeen = new Set<string>();
  for (const path of inGroup) {
    const file = get(path);
    if (file === null) continue;
    const found = rule.rule === 'single-reader' ? namesOf(file.source, rule.variable) : stringsContaining(file.source, rule.text);
    if (found.length > 0 && allowed(path)) {
      allowedSeen.add(path);
      continue;
    }
    for (const place of found) {
      const reason =
        rule.rule === 'single-reader'
          ? `reads ${rule.variable} (${place.text}); only ${list(rule.allow)} may`
          : `contains "${rule.text}" in ${place.text}; only ${list(rule.allow)} may`;
      report({ file: path, line: place.line, column: place.column, rule: rule.rule, reason });
    }
  }
  const what = rule.rule === 'single-reader' ? `reads ${rule.variable}` : `contains "${rule.text}"`;
  staleAllow(rule.allow, inGroup, allowedSeen, what, rule.group, report, configLabel);
}

/**
 * An exception that no longer matches code is reported: it would let that file start importing
 * again without review, and a stale list reads as documentation of who does it.
 */
function staleAllow(
  allow: readonly string[],
  inGroup: readonly string[],
  seen: ReadonlySet<string>,
  what: string,
  group: string,
  report: Report,
  configLabel: string,
): void {
  for (const pattern of allow) {
    const matcher = globMatcher([pattern]);
    const matching = inGroup.filter((p) => matcher(p));
    if (matching.length === 0) {
      report({ file: configLabel, line: 0, column: 0, rule: 'stale-allow', reason: `allow entry ${pattern} matches no file of group "${group}"` });
    } else if (!matching.some((p) => seen.has(p))) {
      report({ file: configLabel, line: 0, column: 0, rule: 'stale-allow', reason: `allow entry ${pattern} matches no file that ${what}; remove it` });
    }
  }
}

function relativeExtension(inGroup: readonly string[], files: FileSource, get: Get, report: Report): void {
  for (const path of inGroup) {
    const file = get(path);
    if (file === null) continue;
    for (const ref of file.refs) {
      if (ref.specifier === null || !MODULE_KINDS.has(ref.kind) || !isRelative(ref.specifier)) continue;
      const at = { file: path, line: ref.line, column: ref.column, rule: 'relative-extension' as const };
      const named = target(path, ref.specifier);
      if (named === null) {
        report({ ...at, reason: `imports ${ref.specifier}, which leaves the repository root` });
        continue;
      }
      const loose = resolveLoosely(named, files);
      if (posix.extname(posix.basename(named)) === '' || ref.specifier.endsWith('/') || /(?:^|\/)\.\.?$/.test(ref.specifier)) {
        const hint = loose === null ? '' : ` (write ${relativeSpecifier(path, loose)})`;
        report({ ...at, reason: `imports ${ref.specifier} without a file extension; Node does not resolve it${hint}` });
      } else if (!files.isFile(named)) {
        const hint = loose === null ? 'no such file' : `only a bundler maps it to ${loose}`;
        report({ ...at, reason: `imports ${ref.specifier}, which is not a file: ${hint}` });
      }
    }
  }
}

function dynamicImport(inGroup: readonly string[], get: Get, report: Report): void {
  for (const path of inGroup) {
    const file = get(path);
    if (file === null) continue;
    for (const ref of file.refs) {
      if (ref.specifier !== null || ref.kind === 'import-type') continue;
      report({ file: path, line: ref.line, column: ref.column, rule: 'dynamic-import', reason: DYNAMIC_REASON[ref.kind] });
    }
  }
}
