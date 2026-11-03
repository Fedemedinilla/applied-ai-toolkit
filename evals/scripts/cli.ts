/** Argument parsing and the API-key gate for the live scripts. */
import Anthropic from '@anthropic-ai/sdk';
import { freshOutput } from '../src/files.ts';

/** Flags that take no value, so the next argument is not swallowed as one. */
const BOOLEAN_FLAGS = new Set(['--dump', '--allow-missing']);

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

export function positional(n: number, usage: string): string[] {
  const args: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
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
