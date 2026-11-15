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

/**
 * The folders an ignore list drops whole: a glob that ends in `/**` drops the folders its prefix
 * matches, and a glob whose last name has no `*` or `?` (`**\/vendor`, `dist/`) drops the folders
 * it names. Any other glob (`src/*`, `**\/*.js`) ignores only the files it matches, even when it
 * also matches a folder's name, so `src/a/deep.ts` stays listed under `src/*`.
 */
function ignoredFolders(ignore: readonly string[]): (path: string) => boolean {
  const folders: string[] = [];
  for (const glob of ignore) {
    const bare = glob.replace(/\/+$/, '');
    if (bare.endsWith('/**')) folders.push(bare.slice(0, -3));
    else if (bare !== '' && !/[*?]/.test(bare.slice(bare.lastIndexOf('/') + 1))) folders.push(bare);
  }
  return globMatcher(folders);
}

/** Whether a file is ignored: a glob matches it, or a folder it lives in is ignored whole. */
function ignoreMatcher(ignore: readonly string[]): { file: (path: string) => boolean; folder: (path: string) => boolean } {
  const matches = globMatcher(ignore);
  const folder = ignoredFolders(ignore);
  const file = (path: string) => {
    if (matches(path)) return true;
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) if (folder(path.slice(0, i))) return true;
    return false;
  };
  return { file, folder };
}

export function diskSource(root: string, ignore: readonly string[] = DEFAULT_IGNORE): FileSource {
  const ignored = ignoreMatcher(ignore);
  let listed: string[] | undefined;
  const walk = (dir: string, out: string[]) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir === '' ? entry.name : posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skipped only when the folder is ignored whole; otherwise each file is matched on its own.
        if (!ignored.folder(path)) walk(path, out);
      } else if (entry.isFile() && isCodeFile(path) && !ignored.file(path)) out.push(path);
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
  const ignored = ignoreMatcher(ignore);
  const listed = Object.keys(files)
    .filter((p) => isCodeFile(p) && !ignored.file(p))
    .sort();
  return {
    list: () => listed,
    read: (path) => (Object.hasOwn(files, path) ? (files[path] ?? null) : null),
    isFile: (path) => Object.hasOwn(files, path),
  };
}
