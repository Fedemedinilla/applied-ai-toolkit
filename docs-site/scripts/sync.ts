/**
 * Writes the Starlight content pages from the repository: each folder's README.md, each
 * CASE-STUDY.md, CONTRIBUTING.md, SECURITY.md and the hand-written pages under docs-site/pages/.
 * The pages are generated on every build and never committed, so they cannot drift from the
 * READMEs. Each page gets its title from the H1 and its description from the first paragraph.
 *
 * Relative links are rewritten, because a README is written to be read on GitHub:
 * - a link to a file or folder that has a page here becomes a link to that page;
 * - a link to any other file or folder becomes a GitHub URL on the main branch;
 * - a relative link whose target does not exist fails the sync, with every broken link listed.
 *
 * Run: node docs-site/scripts/sync.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, BRANCH, GROUPS, HAND_WRITTEN, NOT_DOCUMENTED, PROJECT_DOCS, REPO_URL } from './site.ts';

export interface Page {
  /** The Markdown file the page is made from, as a posix path from the repository root. */
  readonly source: string;
  /** Where the page is served under the base; '' is the landing page. */
  readonly slug: string;
  readonly label: string;
  /** The sidebar group; pages without one sit at the top level. */
  readonly group?: string;
}

export type PathKind = 'file' | 'dir' | undefined;

export interface LinkContext {
  /** Source path of every page, mapped to its slug. */
  readonly pages: ReadonlyMap<string, string>;
  /** What a posix path from the repository root is on disk. */
  readonly kind: (path: string) => PathKind;
}

export const pageUrl = (slug: string): string => (slug === '' ? `${BASE}/` : `${BASE}/${slug}/`);

const diskKind = (root: string) => (path: string): PathKind => {
  try {
    const stat = statSync(join(root, path));
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : undefined;
  } catch {
    return undefined;
  }
};

const subfolders = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
    .map((e) => e.name)
    .sort();

/** Every page of the site, in sidebar order. Throws when a folder with a README has no group. */
export function plan(root: string): Page[] {
  const listed = GROUPS.flatMap((g) => g.folders);
  const onDisk = [...subfolders(root).filter((f) => f !== 'apps'), ...subfolders(join(root, 'apps')).map((f) => `apps/${f}`)].filter(
    (f) => existsSync(join(root, f, 'README.md')) && !NOT_DOCUMENTED.includes(f),
  );
  const unlisted = onDisk.filter((f) => !listed.includes(f));
  if (unlisted.length > 0) throw new Error(`no sidebar group in docs-site/scripts/site.ts for: ${unlisted.join(', ')}`);
  const missing = listed.filter((f) => !onDisk.includes(f));
  if (missing.length > 0) throw new Error(`docs-site/scripts/site.ts lists folders with no README.md: ${missing.join(', ')}`);

  const pages: Page[] = HAND_WRITTEN.map((p) => ({ source: `docs-site/pages/${p.file}`, slug: p.slug, label: p.label }));
  for (const group of GROUPS) {
    for (const folder of group.folders) {
      const name = posix.basename(folder);
      pages.push({ source: `${folder}/README.md`, slug: folder, label: name, group: group.label });
      if (existsSync(join(root, folder, 'CASE-STUDY.md'))) {
        pages.push({ source: `${folder}/CASE-STUDY.md`, slug: `${folder}/case-study`, label: `${name} case study`, group: group.label });
      }
    }
  }
  for (const doc of PROJECT_DOCS) pages.push({ source: doc.file, slug: doc.slug, label: doc.label, group: 'Project' });
  return pages;
}

type SidebarItem = { label: string; link: string } | { label: string; items: SidebarItem[] };

/** The Starlight sidebar for the planned pages. Internal links get the base from Starlight. */
export function sidebar(pages: readonly Page[]): SidebarItem[] {
  const out: SidebarItem[] = [];
  const groups = new Map<string, SidebarItem[]>();
  for (const page of pages) {
    const item = { label: page.label, link: page.slug === '' ? '/' : `/${page.slug}/` };
    if (page.group === undefined) {
      out.push(item);
      continue;
    }
    let items = groups.get(page.group);
    if (items === undefined) {
      items = [];
      groups.set(page.group, items);
      out.push({ label: page.group, items });
    }
    items.push(item);
  }
  groups.get('Project')?.push({ label: 'License', link: `${REPO_URL}/blob/${BRANCH}/LICENSE` });
  return out;
}

/** Splits a line into code spans (kept as written) and the text between them. */
function segments(line: string): Array<{ text: string; code: boolean }> {
  const out: Array<{ text: string; code: boolean }> = [];
  let i = 0;
  let plain = '';
  while (i < line.length) {
    if (line[i] !== '`') {
      plain += line[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (line[i + run] === '`') run += 1;
    // A code span closes at the next run of backticks of the same length.
    let close = -1;
    for (let j = i + run; j < line.length; j += 1) {
      if (line[j] !== '`') continue;
      let length = 0;
      while (line[j + length] === '`') length += 1;
      if (length === run) {
        close = j;
        break;
      }
      j += length - 1;
    }
    if (close === -1) {
      plain += line.slice(i, i + run);
      i += run;
      continue;
    }
    if (plain !== '') out.push({ text: plain, code: false });
    plain = '';
    out.push({ text: line.slice(i, close + run), code: true });
    i = close + run;
  }
  if (plain !== '') out.push({ text: plain, code: false });
  return out;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
/** A closing fence carries no info string: a line such as ```md inside a block is code. */
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
/** The target of an inline link or image, after its label: `](target)` or `](target "title")`. */
const INLINE_TARGET = /\]\(([^()\s]+)(\s+"[^"]*")?\)/g;
/** A reference definition: `[label]: target`. A footnote, `[^label]: text`, is not one. */
const DEFINITION = /^(\s{0,3}\[(?!\^)[^\]]+\]:\s+)(\S+)/;

/**
 * One link target as the docs site needs it, or null when it does not exist. Absolute URLs and
 * same-page anchors are returned as written.
 */
export function rewriteTarget(target: string, from: string, ctx: LinkContext): string | null {
  if (SCHEME.test(target) || target.startsWith('#')) return target;
  // A path from the site root means nothing in a README on GitHub, so it is never right here.
  if (target.startsWith('/')) return null;
  const hashAt = target.indexOf('#');
  const path = hashAt === -1 ? target : target.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : target.slice(hashAt);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(from), decoded)).replace(/\/$/, '');
  if (resolved === '..' || resolved.startsWith('../')) return null;
  const repoPath = resolved === '.' ? '' : resolved;
  const kind = ctx.kind(repoPath);
  if (kind === undefined) return null;
  const slug = kind === 'dir' ? ctx.pages.get(posix.join(repoPath, 'README.md')) : ctx.pages.get(repoPath);
  if (slug !== undefined) return `${pageUrl(slug)}${hash}`;
  const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
  return `${REPO_URL}/${kind === 'dir' ? 'tree' : 'blob'}/${BRANCH}/${encoded}${hash}`;
}

/** Rewrites every relative link outside code. `broken` lists the targets that do not exist. */
export function rewriteLinks(markdown: string, from: string, ctx: LinkContext): { text: string; broken: string[] } {
  const broken: string[] = [];
  const fix = (target: string): string => {
    const next = rewriteTarget(target, from, ctx);
    if (next === null) broken.push(target);
    return next ?? target;
  };
  let fence: string | undefined;
  const lines = markdown.split('\n').map((line) => {
    if (fence !== undefined) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) fence = undefined;
      return line;
    }
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      fence = marker;
      return line;
    }
    const definition = DEFINITION.exec(line);
    if (definition?.[1] !== undefined && definition[2] !== undefined) {
      return `${definition[1]}${fix(definition[2])}${line.slice(definition[0].length)}`;
    }
    return segments(line)
      .map((s) => (s.code ? s.text : s.text.replace(INLINE_TARGET, (_all, target: string, title?: string) => `](${fix(target)}${title ?? ''})`)))
      .join('');
  });
  return { text: lines.join('\n'), broken };
}

/** Markdown inline syntax removed, for a title or a description. */
export const plainText = (markdown: string): string =>
  markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?:)[^>]+)>/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const DESCRIPTION_LIMIT = 200;

/**
 * The first sentences of a paragraph that fit the limit; always at least one. A sentence ends
 * only at punctuation followed by whitespace, so README.md, Node.js or 1.50 stay whole, and the
 * result is always a prefix of the paragraph.
 */
function shorten(paragraph: string): string {
  let out = '';
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    const next = out === '' ? sentence : `${out} ${sentence}`;
    if (out !== '' && next.length > DESCRIPTION_LIMIT) break;
    out = next;
  }
  return out.trim();
}

/**
 * The H1, the first paragraph after it, and the document without the H1. A leading byte order
 * mark and CRLF line endings (a Windows checkout with core.autocrlf) are normalized first.
 */
export function splitDocument(markdown: string, source: string): { title: string; description: string; body: string } {
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((line) => line.trim() !== '');
  const title = /^# (.+)$/.exec(lines[at] ?? '')?.[1];
  if (title === undefined) throw new Error(`${source}: the first line is not an H1, so the page has no title`);
  const rest = lines.slice(at + 1);
  const start = rest.findIndex((line) => line.trim() !== '');
  const paragraph: string[] = [];
  for (const line of start === -1 ? [] : rest.slice(start)) {
    if (line.trim() === '' || /^(#|```|~~~|\s*[-*] |\|)/.test(line)) break;
    paragraph.push(line);
  }
  if (paragraph.length === 0) throw new Error(`${source}: no paragraph after the H1, so the page has no description`);
  return { title: plainText(title), description: shorten(plainText(paragraph.join(' '))), body: rest.join('\n').replace(/^\n+/, '') };
}

/** The content file for one page: frontmatter and the body with its links rewritten. */
export function renderPage(markdown: string, page: Page, ctx: LinkContext): { content: string; broken: string[] } {
  const { title, description, body } = splitDocument(markdown, page.source);
  const { text, broken } = rewriteLinks(body, page.source, ctx);
  // JSON strings are valid YAML double-quoted scalars.
  const frontmatter = [
    '---',
    `# Generated by docs-site/scripts/sync.ts from ${page.source}. Edit that file, not this one.`,
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `editUrl: ${JSON.stringify(`${REPO_URL}/edit/${BRANCH}/${page.source}`)}`,
    '---',
    '',
  ].join('\n');
  return { content: `${frontmatter}\n${text}`, broken };
}

/** Writes every page under outDir, emptied first. Throws when any relative link is broken. */
export function sync(root: string, outDir: string): Page[] {
  const pages = plan(root);
  const ctx: LinkContext = { pages: new Map(pages.map((p) => [p.source, p.slug])), kind: diskKind(root) };
  const broken: string[] = [];
  const rendered = pages.map((page) => {
    const result = renderPage(readFileSync(join(root, page.source), 'utf8'), page, ctx);
    broken.push(...result.broken.map((target) => `${page.source}: ${target}`));
    return { page, content: result.content };
  });
  if (broken.length > 0) {
    throw new Error(`${broken.length} broken relative link${broken.length === 1 ? '' : 's'}:\n  ${broken.join('\n  ')}`);
  }
  rmSync(outDir, { recursive: true, force: true });
  for (const { page, content } of rendered) {
    const file = join(outDir, page.slug, 'index.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return pages;
}

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const CONTENT_DIR = fileURLToPath(new URL('../src/content/docs', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const pages = sync(REPO_ROOT, CONTENT_DIR);
    console.log(`sync: ${pages.length} pages written to ${CONTENT_DIR}`);
  } catch (error) {
    console.error(`sync: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
