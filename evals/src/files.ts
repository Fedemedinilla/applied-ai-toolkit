/** JSONL and output-file helpers shared by the scripts. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * One JSON value per non-blank line. A leading byte order mark (Windows
 * editors write one) is dropped, and an error names the line as counted in
 * the file, blank lines included.
 */
export function readJsonl<T = unknown>(path: string): T[] {
  const out: T[] = [];
  readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .split('\n')
    .forEach((l, i) => {
      if (l.trim() === '') return;
      try {
        out.push(JSON.parse(l) as T);
      } catch {
        throw new Error(`${path}:${i + 1}: not JSON`);
      }
    });
  return out;
}

export const appendJsonl = (path: string, row: unknown) => appendFileSync(path, JSON.stringify(row) + '\n');

/**
 * Refuses an output path that already exists. The runners append row by row
 * so a run cut short keeps what it paid for; appending to last week's file
 * would silently mix two runs of a prompt that has changed since.
 */
export function freshOutput(path: string): string {
  // One exclusive create, not a check then a write: two runs started together
  // on one path cannot both pass.
  try {
    writeFileSync(path, '', { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${path} already exists; pick a new file so two runs never mix`);
    throw e;
  }
  return path;
}
