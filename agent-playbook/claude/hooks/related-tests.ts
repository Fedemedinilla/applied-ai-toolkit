#!/usr/bin/env node
/**
 * PostToolUse hook: after an edit to a TypeScript file, runs the Vitest tests that import it
 * (`vitest related`) and tells the agent when they fail. Wire it to Edit|Write|MultiEdit.
 *
 * The edit has already happened, so this hook cannot block it. On a failure it exits 2, which
 * shows stderr to the agent: the failing test arrives in the same turn as the edit that broke it,
 * instead of at the end of a long task. A pass prints nothing, so it costs no context.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** Lines of test output handed to the agent; the tail holds the failure summary. */
const TAIL_LINES = 40;
const TIMEOUT_MS = 120_000;

/** The npx arguments for one edited file, or null when the file has no tests to run. */
export function relatedTestArgs(rel: string): string[] | null {
  if (rel.startsWith('../') || isAbsolute(rel)) return null;
  if (!/\.(ts|tsx|mts)$/.test(rel) || /(^|\/)(node_modules|dist)\//.test(rel)) return null;
  return ['vitest', 'related', rel, '--run', '--passWithNoTests', '--reporter=dot'];
}

export function tail(text: string, lines: number): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

if (import.meta.main) {
  const raw = readFileSync(0, 'utf8');
  const input = (raw.trim() === '' ? {} : JSON.parse(raw)) as { cwd?: string; tool_input?: { file_path?: string } };
  const root = process.env['CLAUDE_PROJECT_DIR'] ?? input.cwd ?? process.cwd();
  const filePath = input.tool_input?.file_path;
  const args = filePath === undefined ? null : relatedTestArgs(relative(root, resolve(root, filePath)).replaceAll('\\', '/'));
  if (args === null) process.exit(0);
  const run = spawnSync('npx', args, { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS });
  if (run.status === 0) process.exit(0);
  const why = run.error !== undefined ? `could not run: ${run.error.message}` : `exit ${String(run.status)}`;
  process.stderr.write(`Related tests failed after editing ${args[2] ?? ''} (${why}):\n${tail(`${run.stdout}${run.stderr}`, TAIL_LINES)}\n`);
  process.exit(2);
}
