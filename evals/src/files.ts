/** JSONL and output-file helpers shared by the scripts. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export function readJsonl<T = unknown>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        throw new Error(`${path}:${i + 1}: not JSON`);
      }
    });
}

export const appendJsonl = (path: string, row: unknown) => appendFileSync(path, JSON.stringify(row) + '\n');

/**
 * Refuses an output path that already exists. The runners append row by row
 * so a run cut short keeps what it paid for; appending to last week's file
 * would silently mix two runs of a prompt that has changed since.
 */
export function freshOutput(path: string): string {
  if (existsSync(path)) throw new Error(`${path} already exists; pick a new file so two runs never mix`);
  writeFileSync(path, '');
  return path;
}
