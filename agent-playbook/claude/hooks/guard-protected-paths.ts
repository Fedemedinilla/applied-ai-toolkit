#!/usr/bin/env node
/**
 * PreToolUse hook: refuses a file edit on a protected path unless the person who started the
 * session allowed it. Wire it to Edit|Write|MultiEdit|NotebookEdit (see ../settings.json).
 *
 * Protected paths are the files whose value is that nobody changed them to make a test pass:
 * golden outputs, hand-written content, versioned rule sets, applied migrations. The list lives in
 * .claude/protected.json, next to this hook:
 *
 *   { "paths": ["tests/golden/**", "db/migrations/**"], "jsonFlag": "handwritten" }
 *
 * `jsonFlag` also protects any existing JSON file whose top level has that key set to true.
 *
 * The override is the AGENT_ALLOW_PROTECTED variable of the Claude Code process, set by the person
 * when they start the session for a change that needs it. A marker file in the repository would be
 * one shell command away from the agent. The settings files that could set the variable for hooks
 * are protected paths, and settings files outside the project are refused too.
 *
 * Paths are matched as written and after resolving symbolic links, so a link cannot hide a
 * protected target. Exit code 2 blocks the tool call and shows stderr to the agent. Any other
 * non-zero exit lets the call through, so every error in this file ends in exit 2, and the settings
 * command adds `|| exit 2` for the case where Node cannot run the file at all.
 */
import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface ProtectedConfig {
  readonly paths: readonly string[];
  readonly jsonFlag?: string;
}

/** `**` crosses folders, `*` stays inside one name. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i);
    if (c === '*' && glob.charAt(i + 1) === '*') {
      const slash = glob.charAt(i + 2) === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** The path relative to the project, or null when the edit is outside it. */
export function projectPath(root: string, filePath: string): string | null {
  const rel = relative(root, resolve(root, filePath)).replaceAll('\\', '/');
  return rel === '' || rel.startsWith('../') || rel === '..' || isAbsolute(rel) ? null : rel;
}

/**
 * The path with every symbolic link resolved, including a dangling one, for a file that may not
 * exist yet: the nearest existing ancestor is resolved and the missing names are appended.
 */
export function realTarget(path: string): string {
  let current = resolve(path);
  let rest: string[] = [];
  for (let links = 0; links <= 40; ) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      let link: string | null;
      try {
        link = readlinkSync(current);
      } catch {
        link = null;
      }
      if (link !== null) {
        links += 1;
        current = resolve(dirname(current), link);
        continue;
      }
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest = [basename(current), ...rest];
      current = parent;
    }
  }
  throw new Error(`too many symbolic links in ${path}`);
}

/** Settings files Claude Code reads hooks and their environment from, wherever they are. */
const SETTINGS_FILE = /(^|\/)\.claude\/settings(\.local)?\.json$/;

/** Why the path is protected, or null when it is not. */
export function protectedReason(rel: string, config: ProtectedConfig, readJson: (rel: string) => unknown): string | null {
  const glob = config.paths.find((g) => globToRegExp(g).test(rel));
  if (glob !== undefined) return `matches ${glob}`;
  if (config.jsonFlag !== undefined && rel.endsWith('.json')) {
    const json = readJson(rel);
    if (typeof json === 'object' && json !== null && (json as Record<string, unknown>)[config.jsonFlag] === true) {
      return `has "${config.jsonFlag}": true`;
    }
  }
  return null;
}

function parseConfig(raw: unknown): ProtectedConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('protected.json must be an object');
  const { paths, jsonFlag } = raw as { paths?: unknown; jsonFlag?: unknown };
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new Error('protected.json: "paths" must be a list of globs');
  if (jsonFlag !== undefined && typeof jsonFlag !== 'string') throw new Error('protected.json: "jsonFlag" must be a string');
  return jsonFlag === undefined ? { paths } : { paths, jsonFlag };
}

export interface HookInput {
  readonly cwd?: unknown;
  readonly tool_input?: { readonly file_path?: unknown; readonly notebook_path?: unknown };
}

/** The edited path, undefined for a tool call without one. Throws on a path that is not a string. */
export function targetOf(input: HookInput): string | undefined {
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (target !== undefined && typeof target !== 'string') throw new Error('the file path is not a string');
  return target;
}

/** Exit code and message for one hook call. Throws on input it cannot read; the caller blocks. */
export function decide(input: HookInput, root: string, env: NodeJS.ProcessEnv): { code: 0 | 2; message: string } {
  const target = targetOf(input);
  if (target === undefined) return { code: 0, message: '' };
  const configFile = resolve(root, '.claude/protected.json');
  // No config means nothing is protected; a broken config blocks, so a typo cannot open every path.
  if (!existsSync(configFile)) return { code: 0, message: '' };
  const absolute = resolve(root, target);
  const real = realTarget(absolute);
  const candidates = [projectPath(root, absolute), projectPath(realTarget(root), real)].filter((p): p is string => p !== null);
  if (candidates.length === 0) {
    if (!SETTINGS_FILE.test(real.replaceAll('\\', '/')) && !SETTINGS_FILE.test(absolute.replaceAll('\\', '/'))) return { code: 0, message: '' };
    return {
      code: 2,
      message: `Blocked: ${absolute} is a Claude Code settings file outside the project, which could switch the hooks off. Stop and ask the person.`,
    };
  }
  let config: ProtectedConfig;
  try {
    config = parseConfig(JSON.parse(readFileSync(configFile, 'utf8')));
  } catch (error) {
    return { code: 2, message: `Blocked: .claude/protected.json cannot be read (${(error as Error).message}).` };
  }
  const readJson = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
    } catch {
      return null; // a new file or one that is not JSON carries no flag
    }
  };
  let rel = '';
  let reason: string | null = null;
  for (const candidate of candidates) {
    reason = protectedReason(candidate, config, readJson);
    rel = candidate;
    if (reason !== null) break;
  }
  if (reason === null) return { code: 0, message: '' };
  if (env['AGENT_ALLOW_PROTECTED'] === '1') return { code: 0, message: '' };
  return {
    code: 2,
    message:
      `Blocked: ${rel} is protected (${reason}). Do not work around this. ` +
      'Stop and ask the person for approval; they can restart the session with AGENT_ALLOW_PROTECTED=1 for this change.',
  };
}

/** The whole hook: stdin text in, exit code and stderr out. An error of any kind blocks. */
export function run(raw: string, env: NodeJS.ProcessEnv, cwd: string): { code: 0 | 2; message: string } {
  try {
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('the hook input is not a JSON object');
    const input = parsed as HookInput;
    const root = env['CLAUDE_PROJECT_DIR'] ?? (typeof input.cwd === 'string' ? input.cwd : cwd);
    return decide(input, root, env);
  } catch (error) {
    return { code: 2, message: `Blocked: guard error (${error instanceof Error ? error.message : String(error)}). Stop and ask the person.` };
  }
}

if (import.meta.main) {
  let result: { code: 0 | 2; message: string };
  try {
    result = run(readFileSync(0, 'utf8'), process.env, process.cwd());
  } catch (error) {
    result = { code: 2, message: `Blocked: guard error (${String(error)}).` };
  }
  if (result.message !== '') process.stderr.write(`${result.message}\n`);
  process.exit(result.code);
}
