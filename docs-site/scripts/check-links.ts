/**
 * Checks the built site, as the last step of the build:
 * - the pages in dist/ are exactly the planned pages plus Starlight's 404 page;
 * - every internal href and src in every page points at a file in dist/, under the base path;
 * - every fragment of an internal link is the id of an element on the target page.
 * A link from the site root that is outside the base would leave the docs and land on the demos'
 * part of the Pages site, so it is reported as well. External URLs are not fetched.
 *
 * Run: node docs-site/scripts/check-links.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE } from './site.ts';
import { plan, REPO_ROOT } from './sync.ts';

const SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
/** An opening tag. Text content escapes its <, so a quoted href inside a code sample is not one. */
const TAG = /<[a-zA-Z][^<>]*>/g;
const ATTRIBUTE = /\s(?:href|src)="([^"]*)"/g;

const decodeEntities = (value: string): string =>
  value.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Every .html file under dir, as posix paths relative to it, sorted. */
export function htmlFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...htmlFiles(dir, path));
    else if (entry.name.endsWith('.html')) out.push(path);
  }
  return out.sort();
}

/** The file in dist that a URL path under the base is served from, or null when there is none. */
function served(dist: string, urlPath: string): string | null {
  if (urlPath !== BASE && !urlPath.startsWith(`${BASE}/`)) return null;
  const relative = decodeURIComponent(urlPath.slice(BASE.length + 1));
  const candidates = relative === '' || relative.endsWith('/') ? [`${relative}index.html`] : [relative, `${relative}/index.html`];
  for (const candidate of candidates) {
    const file = join(dist, candidate);
    if (existsSync(file) && statSync(file).isFile()) return candidate;
  }
  return null;
}

/** One line per broken link: the page, the link as written and what is wrong with it. */
export function brokenLinks(dist: string): string[] {
  const problems: string[] = [];
  const html = new Map(htmlFiles(dist).map((file) => [file, readFileSync(join(dist, file), 'utf8')]));
  const hasId = (file: string, id: string): boolean => {
    const page = html.get(file);
    return page === undefined || page.includes(`id="${id}"`);
  };
  for (const [file, page] of html) {
    const pagePath = `${BASE}/${file.replace(/(^|\/)index\.html$/, '$1')}`;
    const links = [...page.matchAll(TAG)].flatMap((tag) => [...tag[0].matchAll(ATTRIBUTE)].map((m) => decodeEntities(m[1] ?? '')));
    for (const link of links) {
      if (link === '' || SCHEME.test(link)) continue;
      const hashAt = link.indexOf('#');
      const path = (hashAt === -1 ? link : link.slice(0, hashAt)).replace(/\?.*$/, '');
      const fragment = hashAt === -1 ? '' : decodeURIComponent(link.slice(hashAt + 1));
      const target = path === '' ? pagePath : path.startsWith('/') ? posix.normalize(path) : posix.normalize(posix.join(posix.dirname(`${pagePath}x`), path));
      const targetFile = served(dist, target);
      if (targetFile === null) {
        problems.push(`${file}: ${link} (${target.startsWith(`${BASE}/`) || target === BASE ? 'no such file in the build' : `outside the base ${BASE}/`})`);
      } else if (fragment !== '' && !hasId(targetFile, fragment)) {
        problems.push(`${file}: ${link} (no element with id "${fragment}" in ${targetFile})`);
      }
    }
  }
  return problems;
}

/** The planned pages that were not built, and the built pages that were not planned. */
export function pageMismatch(dist: string, slugs: readonly string[]): string[] {
  const expected = new Set([...slugs.map((slug) => (slug === '' ? 'index.html' : `${slug}/index.html`)), '404.html']);
  const built = new Set(htmlFiles(dist));
  return [
    ...[...expected].filter((file) => !built.has(file)).map((file) => `${file}: planned but not built`),
    ...[...built].filter((file) => !expected.has(file)).map((file) => `${file}: built but not planned`),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  const pages = plan(REPO_ROOT);
  const problems = [...pageMismatch(dist, pages.map((p) => p.slug)), ...brokenLinks(dist)];
  if (problems.length > 0) {
    console.error(`check-links: ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${dist}\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`check-links: ${pages.length} pages from the repository plus 404.html, every internal link and anchor resolves under ${BASE}/`);
}
