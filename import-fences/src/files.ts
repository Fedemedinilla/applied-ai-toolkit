/** Where the checker reads files from: a folder on disk, or an in-memory tree for tests. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isCodeFile } from './extract.ts';
import { globMatcher } from './glob.ts';

export interface FileSource {
  /** Code files under the root that are not ignored, as sorted posix paths relative to the root. */
  list(): readonly string[];
  /** The content of a file, or null if it is not a file. */
  read(path: string): string | null;
  isFile(path: string): boolean;
}

export const DEFAULT_IGNORE: readonly string[] = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/coverage/**'];

export function diskSource(root: string, ignore: readonly string[] = DEFAULT_IGNORE): FileSource {
  const ignored = globMatcher(ignore);
  let listed: string[] | undefined;
  const walk = (dir: string, out: string[]) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir === '' ? entry.name : posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        // A directory is skipped when everything under it is ignored ("**/node_modules/**").
        if (!ignored(`${path}/`) && !ignored(path)) walk(path, out);
      } else if (entry.isFile() && isCodeFile(path) && !ignored(path)) out.push(path);
    }
  };
  return {
    list() {
      if (listed === undefined) {
        listed = [];
        walk('', listed);
        listed.sort();
      }
      return listed;
    },
    read(path) {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && ['ENOENT', 'EISDIR', 'ENOTDIR'].includes(String(error.code))) return null;
        throw error;
      }
    },
    isFile(path) {
      try {
        return statSync(join(root, path)).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** An in-memory tree: keys are posix paths relative to the root. */
export function memorySource(files: Readonly<Record<string, string>>, ignore: readonly string[] = DEFAULT_IGNORE): FileSource {
  const ignored = globMatcher(ignore);
  const listed = Object.keys(files)
    .filter((p) => isCodeFile(p) && !ignored(p))
    .sort();
  return {
    list: () => listed,
    read: (path) => (Object.hasOwn(files, path) ? (files[path] ?? null) : null),
    isFile: (path) => Object.hasOwn(files, path),
  };
}
