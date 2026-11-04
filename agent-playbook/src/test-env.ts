/**
 * The environment a test suite sees, kept apart from the environment of the session that runs it.
 *
 * A coding agent's session carries its own credentials and settings: the agent's API key, a base
 * URL for a proxy, a database token. A test that reads process.env would see them, and an SDK
 * client built without an explicit key would pick them up on its own. The Anthropic SDK reads
 * ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS and ANTHROPIC_LOG even when it is given an API key.
 *
 * The policy: variables with an isolated prefix reach the tests only when a committed test file
 * (placeholders) or an ignored local file (deliberate overrides) sets them. A few names under an
 * isolated prefix configure a local tool and grant no access; those are kept by name, each with
 * its reason in the caller's policy. Everything else in the session environment passes through.
 *
 * Call applyTestEnv from the Vitest config, before any project or worker starts, so every worker
 * inherits the cleaned environment. envLeaks returns names only, never values, so a failing test
 * prints nothing secret.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export interface IsolationPolicy {
  /** Prefixes of the variables that reach tests only from the test files. */
  readonly prefixes: readonly string[];
  /** Names under those prefixes that configure a tool and grant no access. */
  readonly keep: ReadonlySet<string>;
  /** Committed, with a placeholder for every variable the app declares. */
  readonly file: string;
  /** Optional and ignored by git: what it sets is overridden on purpose. */
  readonly localFile: string;
}

export const DEFAULT_POLICY: IsolationPolicy = {
  prefixes: ['ANTHROPIC_', 'CLAUDE_'],
  keep: new Set(),
  file: '.env.test',
  localFile: '.env.test.local',
};

export function isIsolated(name: string, policy: IsolationPolicy): boolean {
  return policy.prefixes.some((prefix) => name.startsWith(prefix)) && !policy.keep.has(name);
}

function readFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (value !== undefined) values[name] = value;
  }
  return values;
}

/** The variables of the test file, with what the local file overrides. Throws without the test file. */
export function readTestEnv(root: string, policy: IsolationPolicy = DEFAULT_POLICY): Record<string, string> {
  const base = join(root, policy.file);
  // Failing here is the point: without the file, the suite would run on the session's values.
  if (!existsSync(base)) throw new Error(`Missing ${base}: without it the tests would see the session's variables.`);
  const local = join(root, policy.localFile);
  return { ...readFile(base), ...(existsSync(local) ? readFile(local) : {}) };
}

/** Leaves env as the tests must see it: test values on top, isolated session values removed. */
export function applyTestEnv(root: string, policy: IsolationPolicy = DEFAULT_POLICY, env: NodeJS.ProcessEnv = process.env): void {
  const fromFiles = readTestEnv(root, policy);
  for (const name of Object.keys(env)) {
    if (isIsolated(name, policy) && !Object.hasOwn(fromFiles, name)) delete env[name];
  }
  Object.assign(env, fromFiles);
}

/**
 * How env differs from what applyTestEnv leaves: names from the test files with another value, and
 * isolated names that came from the session. Names only. Empty when the environment is clean.
 */
export function envLeaks(root: string, policy: IsolationPolicy = DEFAULT_POLICY, env: NodeJS.ProcessEnv = process.env): string[] {
  const fromFiles = readTestEnv(root, policy);
  const changed = Object.entries(fromFiles)
    .filter(([name, value]) => env[name] !== value)
    .map(([name]) => `${name}: does not hold the test file's value`);
  const fromSession = Object.keys(env)
    .filter((name) => isIsolated(name, policy) && !Object.hasOwn(fromFiles, name))
    .map((name) => `${name}: comes from the session environment`);
  return [...changed, ...fromSession].sort();
}

/**
 * The app's own variables that fall under an isolated prefix. The app's key needs a name of its
 * own (APP_ANTHROPIC_KEY, not the SDK's default name): under the default name the agent's key and
 * the app's key are the same variable, and whichever is set wins without anyone noticing.
 */
export function crossingNames(appVariables: Iterable<string>, policy: IsolationPolicy = DEFAULT_POLICY): string[] {
  return [...appVariables].filter((name) => policy.prefixes.some((prefix) => name.startsWith(prefix))).sort();
}
