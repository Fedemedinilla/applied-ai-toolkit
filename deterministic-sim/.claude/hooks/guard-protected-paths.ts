/**
 * PreToolUse hook: refuses an agent's edit to a protected path. Claude Code passes the tool call as
 * JSON on stdin; exit code 2 blocks the call and shows stderr to the agent.
 *
 * Protected: the glob patterns in .claude/protected-paths.json, any JSON file whose top level has
 * `"handwritten": true`, and this folder itself, so the guard cannot be switched off by editing its
 * own config. The override is the environment variable DSIM_ALLOW_PROTECTED=1, which a person sets
 * when starting the session. It is not a file the agent could create with a shell command.
 *
 * Bash commands are checked too, by a heuristic: a write (the target of a redirect, or an argument of
 * tee, sed -i, mv, cp, rm and the like) that resolves to a protected path, relative or absolute, is
 * refused. A determined command can get past a heuristic; this guard is there against mistakes, and
 * review is still needed. Input that is not a tool call the guard can read is refused.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GuardConfig {
  readonly patterns: readonly string[];
  readonly markerKey: string;
  /** Compare paths without case, for the case-insensitive filesystems of macOS and Windows. */
  readonly foldCase: boolean;
}

export type Decision = { readonly block: false } | { readonly block: true; readonly reason: string };

const ALLOW = { block: false } as const;

/** A glob to a regular expression: `**` crosses folders, `*` and `?` stay inside one. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*' && glob.charAt(i + 1) === '*') {
      // "**/" matches zero or more folders; a trailing "**" matches everything below.
      if (glob.charAt(i + 2) === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${out}$`, 'u');
}

/** The path relative to the project, with forward slashes, or null when it is outside the project. */
export function projectPath(root: string, filePath: string): string | null {
  const rel = relative(root, isAbsolute(filePath) ? filePath : resolve(root, filePath)).split('\\').join('/');
  if (rel === '' || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return null;
  return rel;
}

function hasMarker(root: string, rel: string, key: string): boolean {
  if (!rel.endsWith('.json')) return false;
  const full = join(root, rel);
  if (!existsSync(full)) return false;
  try {
    const json: unknown = JSON.parse(readFileSync(full, 'utf8'));
    return typeof json === 'object' && json !== null && (json as Record<string, unknown>)[key] === true;
  } catch {
    return false;
  }
}

// File descriptor duplications ("2>&1", ">&2") write nothing; they are removed before looking for redirects.
const FD_DUP = /\d*>&\d*-?/gu;
// A redirect and the word it writes to: "> f", ">> f", "2> f", "&> f", ">| f".
const REDIRECT = /(?:^|[^<>0-9&])(?:\d+|&)?>>?\|?\s*([^\s;|&()<>]+)/gu;
// Commands whose arguments may be written, moved or deleted. Every word of such a command counts.
const WRITE_COMMAND = /\btee\b|\bsed\s+(?:-[a-zA-Z]*\s+)*-i|\bperl\s+-[a-zA-Z]*i|\b(?:mv|cp|rm|rmdir|truncate|touch|install|ln|chmod|dd|unlink)\b|\bgit\s+(?:checkout|restore|rm|mv|apply|clean|reset)\b|writeFile|\bpython3?\s+-c|\bnode\s+-e/u;
// Commands that remove or replace a whole folder: naming a folder that holds a protected path counts.
const TREE_COMMAND = /\b(?:mv|rm|rmdir)\b|\bgit\s+(?:checkout|restore|rm|mv|clean|reset)\b/u;
const SPLIT = /[\s'"`;|&()<>=]+/u;

/** The fixed folder of a pattern like "test/golden/**": the part before a final "/**" with no glob in it. */
function protectedFolder(pattern: string): string | null {
  if (!pattern.endsWith('/**')) return null;
  const folder = pattern.slice(0, -3);
  return /[*?]/u.test(folder) || folder === '' ? null : folder;
}

/** True when the folder `rel` exists and holds a protected file. Walks at most `budget` entries; past that it answers true. */
function holdsProtected(root: string, rel: string, config: GuardConfig, budget = 5000): boolean {
  const pending = [rel];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop() ?? '';
    const full = dir === '' ? root : join(root, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (++seen > budget) return true;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (isProtected(root, child, config)) return true;
      if (entry.isDirectory()) pending.push(child);
    }
  }
  return false;
}

function fold(path: string, config: GuardConfig): string {
  return config.foldCase ? path.toLowerCase() : path;
}

export function isProtected(root: string, rel: string, config: GuardConfig): boolean {
  const path = fold(rel, config);
  return (
    config.patterns.some((p) => globToRegExp(fold(p, config)).test(path)) ||
    config.patterns.some((p) => {
      const folder = protectedFolder(p);
      return folder !== null && fold(folder, config) === path;
    }) ||
    hasMarker(root, rel, config.markerKey)
  );
}

/** A word of a shell command as a path inside the project ("" for the root), or null when it is outside. */
function shellWordPath(root: string, word: string): string | null {
  if (word.startsWith('-') || word.startsWith('$') || word.startsWith('~')) return null;
  const full = isAbsolute(word) ? word : resolve(root, word);
  const rel = relative(root, full).split('\\').join('/');
  if (rel === '') return '';
  return projectPath(root, full);
}

/**
 * Protected paths a shell command writes, by heuristic. A redirect counts only for the word it writes
 * to, so `cat rules-v1.ts > /tmp/x` and `vitest run src 2>&1` pass. Every word of a writing command
 * (sed -i, mv, cp, rm and similar) counts, after it is resolved against the project root, so absolute
 * and ./ forms match too. For commands that remove or replace a folder (rm, mv, git checkout and the
 * like), a folder that holds a protected file counts as well.
 */
export function bashTargets(command: string, root: string, config: GuardConfig): string[] {
  const text = command.replace(FD_DUP, ' ');
  const candidates: string[] = [];
  for (const match of text.matchAll(REDIRECT)) if (match[1] !== undefined) candidates.push(match[1]);
  const writes = WRITE_COMMAND.test(text);
  if (writes) candidates.push(...text.split(SPLIT).filter(Boolean));
  const tree = TREE_COMMAND.test(text);
  const named = new Set<string>();
  for (const word of candidates) {
    const rel = shellWordPath(root, word);
    if (rel === null) continue;
    if (rel !== '' && isProtected(root, rel, config)) {
      named.add(rel);
      continue;
    }
    if (tree && holdsProtected(root, rel, config)) named.add(rel === '' ? '.' : rel);
  }
  return [...named];
}

function refuse(reason: string): Decision {
  return { block: true, reason };
}

export function decide(input: unknown, root: string, config: GuardConfig, env: Readonly<Record<string, string | undefined>>): Decision {
  if (env['DSIM_ALLOW_PROTECTED'] === '1') return ALLOW;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuse('the hook input is not a JSON object');
  const call = input as { tool_name?: unknown; tool_input?: unknown };
  if (typeof call.tool_name !== 'string') return refuse('the hook input has no tool_name');
  const toolInput = (typeof call.tool_input === 'object' && call.tool_input !== null ? call.tool_input : {}) as Record<string, unknown>;
  if (call.tool_name === 'Bash') {
    const command = toolInput['command'];
    if (typeof command !== 'string') return refuse('the Bash call has no command');
    const targets = bashTargets(command, root, config);
    if (targets.length === 0) return ALLOW;
    return refuse(`this command writes to protected paths (${targets.join(', ')})`);
  }
  const target = toolInput['file_path'] ?? toolInput['notebook_path'] ?? toolInput['path'];
  if (typeof target !== 'string') return refuse(`the ${call.tool_name} call names no file`);
  const rel = projectPath(root, target);
  if (rel === null) return ALLOW;
  if (!isProtected(root, rel, config)) return ALLOW;
  return refuse(`${rel} is protected`);
}

export function loadConfig(root: string): GuardConfig {
  const raw: unknown = JSON.parse(readFileSync(join(root, '.claude/protected-paths.json'), 'utf8'));
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const patterns = record['patterns'];
  const markerKey = record['markerKey'];
  if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string') || typeof markerKey !== 'string') {
    throw new Error('.claude/protected-paths.json needs "patterns" (strings) and "markerKey" (a string)');
  }
  return { patterns, markerKey, foldCase: process.platform === 'darwin' || process.platform === 'win32' };
}

function main(): void {
  const root = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  let input: unknown;
  let config: GuardConfig;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    config = loadConfig(root);
  } catch (error) {
    // A guard that cannot read its input or its config refuses, rather than letting every edit through.
    console.error(`guard-protected-paths: ${error instanceof Error ? error.message : 'unreadable input'}; refusing the edit`);
    process.exit(2);
  }
  const decision = decide(input, root, config, process.env);
  if (decision.block) {
    console.error(
      `Blocked: ${decision.reason}. Published rulesets, golden runs, the purity test and .claude/ change only with a person's approval. ` +
        'Explain the change and ask; the person restarts the session with DSIM_ALLOW_PROTECTED=1 if they agree.',
    );
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
