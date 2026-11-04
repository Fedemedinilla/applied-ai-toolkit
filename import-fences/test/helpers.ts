import { check, type Violation } from '../src/check.ts';
import { parseConfig, type FencesConfigInput } from '../src/config.ts';
import { memorySource } from '../src/files.ts';

/** Runs a config over an in-memory tree and returns `file:line rule` plus the reason. */
export function run(files: Record<string, string>, config: Omit<FencesConfigInput, 'root'>): Violation[] {
  return [...check(parseConfig(config), memorySource(files), 'fences.config.ts').violations];
}

/** The short form most assertions compare: `file:line rule`. */
export function places(violations: readonly Violation[]): string[] {
  return violations.map((v) => `${v.file}:${v.line} ${v.rule}`);
}
