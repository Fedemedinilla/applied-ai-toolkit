/**
 * The build folder as the checks see it: where the static files are, which HTML pages it serves at
 * which URLs, and how a URL in a page maps back to a file.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { matchesAny } from './glob.ts';

export interface Site {
  /** The folder passed with --dir. Every file under it is scanned for secrets. */
  readonly dir: string;
  /** Where the served files are: --dir itself, or its static/ folder for a Vercel Build Output. */
  readonly staticRoot: string;
  /** True when --dir is a Vercel Build Output folder (config.json with a version, and static/). */
  readonly buildOutput: boolean;
  readonly basePath: string;
  /** HTML pages, as paths relative to the static root with forward slashes, sorted. */
  readonly pages: readonly string[];
}

/** Every file under a folder, as forward-slash paths relative to it, sorted. */
export function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((p) => statSync(join(root, p)).isFile())
    .map((p) => p.split(sep).join('/'))
    .sort();
}

/** A --dir that cannot be read as a build folder. The CLI reports it with exit code 2. */
export class InputError extends Error {
  override name = 'InputError';
}

export function openSite(dir: string, basePath: string, exclude: readonly string[]): Site {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new InputError(`--dir ${dir} is not a folder`);
  let buildOutput = false;
  const configJson = join(root, 'config.json');
  if (existsSync(configJson) && existsSync(join(root, 'static'))) {
    try {
      buildOutput = typeof (JSON.parse(readFileSync(configJson, 'utf8')) as { version?: unknown }).version === 'number';
    } catch {
      buildOutput = false;
    }
  }
  const staticRoot = buildOutput ? join(root, 'static') : root;
  const pages = listFiles(staticRoot).filter((p) => p.endsWith('.html') && !matchesAny(p, exclude));
  return { dir: root, staticRoot, buildOutput, basePath: basePath.replace(/\/+$/, ''), pages };
}

/**
 * The URL paths a page can be requested at. "blog/index.html" is "/blog/index.html", "/blog/" and
 * "/blog"; "about.html" is also "/about" (clean URLs). Header rules are matched against all of them.
 */
export function urlPathsForPage(site: Site, page: string): string[] {
  const full = `${site.basePath}/${page}`;
  const paths = [full];
  if (page === 'index.html' || page.endsWith('/index.html')) {
    const folder = full.slice(0, -'index.html'.length);
    paths.push(folder);
    if (folder.length > 1) paths.push(folder.slice(0, -1));
  } else if (page.endsWith('.html')) paths.push(full.slice(0, -'.html'.length));
  return paths;
}

export type Resolved =
  | { readonly kind: 'file'; readonly url: string; readonly file: string }
  | { readonly kind: 'external' | 'missing' | 'bare'; readonly url: string };

/**
 * Maps a script URL found in a page or a module to a file in the static root. `from` is the URL
 * path of the document or module it appears in, for relative URLs. With `specifier`, the URL is a
 * module import specifier, where a name that is not a URL and does not start with "/", "./" or
 * "../" is bare (resolved by an import map, which this guard does not read).
 */
export function resolveUrl(site: Site, from: string, url: string, specifier = false): Resolved {
  if (specifier && !/^(?:[a-z][a-z0-9+.-]*:|\/|\.\.?\/)/i.test(url)) return { kind: 'bare', url };
  const parsed = new URL(url, new URL(from, 'http://site.invalid'));
  if (parsed.origin !== 'http://site.invalid') return { kind: 'external', url };
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return { kind: 'missing', url: parsed.pathname };
  }
  const prefix = `${site.basePath}/`;
  if (!path.startsWith(prefix)) return { kind: 'missing', url: path };
  const relativePath = posix.normalize(path.slice(prefix.length));
  const file = resolve(site.staticRoot, relativePath);
  if (relative(site.staticRoot, file).startsWith('..') || !existsSync(file) || !statSync(file).isFile()) return { kind: 'missing', url: path };
  return { kind: 'file', url: path, file };
}

export const pageUrl = (site: Site, page: string): string => `${site.basePath}/${page}`;
