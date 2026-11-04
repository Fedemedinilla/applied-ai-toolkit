/**
 * PostToolUse hook: after an edit to a TypeScript file under src/ or test/, runs the tests that
 * import it (`vitest related`). On a failure it exits 2 with the end of the output on stderr, which
 * Claude Code shows to the agent, so a broken test is the next thing the agent reads. Exit 0 would
 * leave the output in the transcript only, where the agent does not see it.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPath } from './guard-protected-paths.ts';

const TAIL_LINES = 60;
const TIMEOUT_MS = 120_000;

/** The command to run for an edited path, or null when the edit has no related tests. */
export function relatedCommand(rel: string | null): string[] | null {
  if (rel === null || !/^(?:src|test)\/.+\.ts$/u.test(rel)) return null;
  return ['npx', 'vitest', 'related', '--run', '--reporter=dot', rel];
}

export function editedPath(input: unknown, root: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
  const target = toolInput['file_path'] ?? toolInput['notebook_path'];
  return typeof target === 'string' ? projectPath(root, target) : null;
}

function main(): void {
  const root = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  const command = relatedCommand(editedPath(input, root));
  if (!command) process.exit(0);
  const [bin, ...args] = command as [string, ...string[]];
  const run = spawnSync(bin, args, { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS, shell: process.platform === 'win32' });
  if (run.status === 0) process.exit(0);
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
  const why = run.error ? `could not run (${run.error.message})` : `failed with exit code ${run.status}`;
  console.error(`Related tests for ${command[command.length - 1]} ${why}:\n${output}`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
