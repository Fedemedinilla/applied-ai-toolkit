// The run file: the sealed record as indented JSON. Importing it replays the inputs and compares
// both hashes, so a file someone edited, or one saved under rules that later changed, says so.

import { recordOf, sealRun, verifyRun, type State, type Verification } from '../../../deterministic-sim/src/index.ts';

/** Larger than any legal run file (twenty inputs); a bigger file is refused before parsing. */
export const MAX_FILE_BYTES = 64 * 1024;

export interface RunFile {
  readonly fileName: string;
  readonly text: string;
}

/** A seed as a file-name fragment: letters, digits and dashes, at most 24 characters. */
export function slug(seed: string): string {
  const cleaned = seed
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24)
    .toLowerCase();
  return cleaned || 'run';
}

export function exportRun(state: State): RunFile {
  const sealed = sealRun(recordOf(state));
  return {
    fileName: `run-${slug(state.seed)}-${sealed.inputsHash.slice(0, 8)}.json`,
    text: `${JSON.stringify(sealed, null, 2)}\n`,
  };
}

/** The refusal for a file over MAX_FILE_BYTES. */
export function tooLarge(bytes: number): string {
  return `the file is ${bytes} bytes; a run file is at most ${MAX_FILE_BYTES}`;
}

export function importRun(text: string, bytes: number): Verification {
  if (bytes > MAX_FILE_BYTES) return { ok: false, error: tooLarge(bytes) };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the file is not JSON' };
  }
  return verifyRun(value);
}
