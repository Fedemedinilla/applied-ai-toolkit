/** Argument parsing and the API-key gate for the live scripts. */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync } from 'node:fs';
import { freshOutput } from '../src/files.ts';

/** Flags that take no value, so the next argument is not swallowed as one. */
const BOOLEAN_FLAGS = new Set(['--dump', '--allow-missing', '--json', '--markdown', '--multi']);

/** A usage error: one line on stderr and exit code 2, no stack trace. */
export function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

/** `freshOutput`, with an existing file reported as a usage error. */
export function freshOutputOrExit(path: string): string {
  try {
    return freshOutput(path);
  } catch (e) {
    usageError(String((e as Error).message));
  }
}

/**
 * `freshOutputOrExit` for several files: every path is checked before any is
 * created, so a refusal on the last one leaves no half-written set behind
 * that would block the next run.
 */
export function freshOutputsOrExit(paths: readonly string[]): void {
  for (const path of paths) {
    if (existsSync(path)) usageError(`${path} already exists; pick a new file so two runs never mix`);
  }
  for (const path of paths) freshOutputOrExit(path);
}

export function positional(n: number, usage: string): string[] {
  const args: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // flag() reads only "--name value". Refused here, "--name=value" would be
    // skipped as an unknown flag and its default used without a word.
    if (a.startsWith('--') && a.includes('=')) {
      const at = a.indexOf('=');
      usageError(`${a}: write the value as a separate argument (${a.slice(0, at)} ${a.slice(at + 1)})`);
    }
    if (a.startsWith('--')) {
      if (!BOOLEAN_FLAGS.has(a)) i++;
      continue;
    }
    args.push(a);
  }
  if (args.length < n) usageError(usage);
  return args;
}

export function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  return v === undefined || v.startsWith('--') ? fallback : v;
}

export const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/** A numeric flag. An empty or non-numeric value is a usage error, never 0 or NaN. */
export function numberFlag(name: string, fallback: number): number {
  const raw = flag(name, String(fallback));
  const v = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(v)) usageError(`--${name} must be a number, got ${JSON.stringify(raw)}`);
  return v;
}

export function intFlag(name: string, fallback: number): number {
  const v = Number(flag(name, String(fallback)));
  if (!Number.isInteger(v) || v < 1) usageError(`--${name} must be a positive integer`);
  return v;
}

/**
 * The SDK client for a live run, or exit before anything is spent. The key is
 * read from the environment by the SDK and never printed. ANTHROPIC_BASE_URL is
 * honoured on purpose: pointing it at a local stub is how to exercise a script
 * end to end for free.
 */
export function liveClient(options: { timeout: number; maxRetries: number }): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Live runs call the real API and cost money; tests never need a key.');
    process.exit(2);
  }
  return new Anthropic(options);
}
