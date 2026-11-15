// The docs sync: link rewriting, the page plan against the real repository, and the dist checker.
// These tests need only Node and Vitest, so they run in the root suite without installing docs-site.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brokenLinks, pageMismatch } from './check-links.ts';
import { BASE, GROUPS, REPO_URL } from './site.ts';
import { type LinkContext, type PathKind, plan, plainText, renderPage, REPO_ROOT, rewriteLinks, rewriteTarget, sidebar, splitDocument, sync } from './sync.ts';

const TREE: Readonly<Record<string, PathKind>> = {
  '': 'dir',
  'README.md': 'file',
  LICENSE: 'file',
  gateway: 'dir',
  'gateway/README.md': 'file',
  'gateway/src': 'dir',
  'gateway/src/caps.ts': 'file',
  'gateway/a file.txt': 'file',
  evals: 'dir',
  'evals/README.md': 'file',
  'evals/CASE-STUDY.md': 'file',
  apps: 'dir',
  'apps/caja': 'dir',
  'apps/caja/README.md': 'file',
  'apps/caja/src/dom.ts': 'file',
};
const ctx: LinkContext = {
  pages: new Map([
    ['gateway/README.md', 'gateway'],
    ['evals/README.md', 'evals'],
    ['evals/CASE-STUDY.md', 'evals/case-study'],
    ['apps/caja/README.md', 'apps/caja'],
    ['docs-site/pages/index.md', ''],
  ]),
  kind: (path) => TREE[path],
};
const blob = (path: string) => `${REPO_URL}/blob/main/${path}`;

describe('rewriteTarget', () => {
  it.each([
    // A README or a folder that has a page becomes that page, with the base path.
    ['../evals/README.md', 'gateway/README.md', `${BASE}/evals/`],
    ['../evals/', 'gateway/README.md', `${BASE}/evals/`],
    ['../evals', 'gateway/README.md', `${BASE}/evals/`],
    ['CASE-STUDY.md', 'evals/README.md', `${BASE}/evals/case-study/`],
    ['README.md', 'gateway/README.md', `${BASE}/gateway/`],
    ['./', 'gateway/README.md', `${BASE}/gateway/`],
    // Anchors travel with the link.
    ['../gateway/README.md#install', 'evals/README.md', `${BASE}/gateway/#install`],
    ['CASE-STUDY.md#what-went-wrong', 'evals/README.md', `${BASE}/evals/case-study/#what-went-wrong`],
    ['src/caps.ts#L10-L20', 'gateway/README.md', `${blob('gateway/src/caps.ts')}#L10-L20`],
    // Links that go up directories, from an app and from a hand-written page.
    ['../../gateway/', 'apps/caja/README.md', `${BASE}/gateway/`],
    ['../../gateway/README.md#limits', 'apps/caja/README.md', `${BASE}/gateway/#limits`],
    ['../../gateway/src/caps.ts', 'apps/caja/README.md', blob('gateway/src/caps.ts')],
    ['../../apps/caja/README.md', 'docs-site/pages/index.md', `${BASE}/apps/caja/`],
    ['../../LICENSE', 'docs-site/pages/index.md', blob('LICENSE')],
    // A source file or a folder with no page goes to GitHub on main; the root README has no page.
    ['src/dom.ts', 'apps/caja/README.md', blob('apps/caja/src/dom.ts')],
    ['src/', 'gateway/README.md', `${REPO_URL}/tree/main/gateway/src`],
    ['../README.md#packages', 'gateway/README.md', `${blob('README.md')}#packages`],
    ['../apps/', 'gateway/README.md', `${REPO_URL}/tree/main/apps`],
    ['a%20file.txt', 'gateway/README.md', blob('gateway/a%20file.txt')],
    // Absolute URLs and same-page anchors are left as written.
    ['https://kyndredai.com/templates', 'gateway/README.md', 'https://kyndredai.com/templates'],
    ['mailto:someone@example.test', 'gateway/README.md', 'mailto:someone@example.test'],
    ['#design-decisions', 'gateway/README.md', '#design-decisions'],
  ])('%s in %s becomes %s', (target, from, expected) => {
    expect(rewriteTarget(target, from, ctx)).toBe(expected);
  });

  it.each([
    ['src/missing.ts', 'gateway/README.md'],
    ['../evals/MISSING.md#anchor', 'gateway/README.md'],
    ['../../outside.md', 'gateway/README.md'],
    ['../../../gateway/README.md', 'apps/caja/README.md'],
    ['/gateway/README.md', 'gateway/README.md'],
    ['%E0%A4%A', 'gateway/README.md'],
  ])('%s in %s does not exist', (target, from) => {
    expect(rewriteTarget(target, from, ctx)).toBeNull();
  });
});

describe('rewriteLinks', () => {
  const rewrite = (markdown: string, from = 'gateway/README.md') => rewriteLinks(markdown, from, ctx);

  it('rewrites inline links, links with a code label, titles and several links on a line', () => {
    const { text, broken } = rewrite('See [evals](../evals/) and [`src/caps.ts`](src/caps.ts "the caps"), then [here](#limits).');
    expect(text).toBe(`See [evals](${BASE}/evals/) and [\`src/caps.ts\`](${blob('gateway/src/caps.ts')} "the caps"), then [here](#limits).`);
    expect(broken).toEqual([]);
  });

  it('rewrites reference definitions and image sources', () => {
    expect(rewrite('[caps]: src/caps.ts\n![shot](src/caps.ts)').text).toBe(`[caps]: ${blob('gateway/src/caps.ts')}\n![shot](${blob('gateway/src/caps.ts')})`);
  });

  it('leaves code alone: spans, double-backtick spans and fenced blocks', () => {
    const markdown = [
      'Write `[text](url)` or ``[x](/a`c`)`` and it stays.',
      '```md',
      '[not a link](missing.md)',
      '```',
      '~~~~',
      '```',
      '[still code](missing.md)',
      '~~~~',
      'A lone ` backtick and a [real link](../evals/).',
    ].join('\n');
    const { text, broken } = rewrite(markdown);
    expect(broken).toEqual([]);
    expect(text).toBe(markdown.replace('(../evals/)', `(${BASE}/evals/)`));
  });

  it('reports each link whose file does not exist, and keeps it as written', () => {
    const { text, broken } = rewrite('[a](src/missing.ts) and [b](../nowhere/README.md#x) and [c](src/caps.ts)');
    expect(broken).toEqual(['src/missing.ts', '../nowhere/README.md#x']);
    expect(text).toContain('[a](src/missing.ts)');
  });
});

describe('splitDocument and renderPage', () => {
  it('takes the title from the H1 and the description from the first paragraph, without Markdown', () => {
    const doc = splitDocument('# `safe-markdown`\n\nAn [escape-first](x.md) **renderer**. One file.\n\n## Use\n\nText.\n', 'x/README.md');
    expect(doc).toEqual({ title: 'safe-markdown', description: 'An escape-first renderer. One file.', body: 'An [escape-first](x.md) **renderer**. One file.\n\n## Use\n\nText.\n' });
  });

  it('keeps whole sentences up to the limit, and at least one', () => {
    const long = `${'word '.repeat(50).trim()}.`;
    expect(splitDocument(`# T\n\nShort one. ${long}\n`, 'x').description).toBe('Short one.');
    expect(splitDocument(`# T\n\n${long} Short one.\n`, 'x').description).toBe(long);
  });

  it.each([
    'Read the root README.md first. Then the rest.',
    'Built on Node.js and Astro. It works.',
    'Scripts for the demos on example.test. This is the record.',
    'Costs US$ 1.50 per call. Cheap.',
    'Use a short name, e.g. this one. Then more.',
  ])('keeps a period inside a word as part of its sentence: %s', (paragraph) => {
    const description = splitDocument(`# T\n\n${paragraph}\n`, 'x').description;
    expect(description).toBe(paragraph);
  });

  it('cuts after a whole sentence even when the first one has an inner period', () => {
    const long = `${'word '.repeat(50).trim()}.`;
    expect(splitDocument(`# T\n\nSee README.md now. ${long}\n`, 'x').description).toBe('See README.md now.');
  });

  it('refuses a document with no H1 or no first paragraph', () => {
    expect(() => splitDocument('Text first.\n\n# Late\n', 'x/README.md')).toThrow(/x\/README.md: the first line is not an H1/);
    expect(() => splitDocument('# Title\n\n## Section\n', 'x/README.md')).toThrow(/no paragraph after the H1/);
  });

  it('writes frontmatter with the edit link to the source file', () => {
    const { content } = renderPage('# Gate "way"\n\nIt calls: the API.\n', { source: 'gateway/README.md', slug: 'gateway', label: 'gateway' }, ctx);
    expect(content).toContain('title: "Gate \\"way\\""\ndescription: "It calls: the API."\n');
    expect(content).toContain(`editUrl: "${REPO_URL}/edit/main/gateway/README.md"\n---\n\nIt calls: the API.\n`);
  });
});

describe('sync over a tree', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const tree = (overrides: Readonly<Record<string, string>> = {}): string => {
    root = mkdtempSync(join(tmpdir(), 'docs-sync-'));
    const files: Record<string, string> = { 'CONTRIBUTING.md': '# Contributing\n\nRead [the gateway](gateway/).\n', 'SECURITY.md': '# Security\n\nReport it.\n' };
    for (const folder of GROUPS.flatMap((g) => g.folders)) files[`${folder}/README.md`] = `# ${folder}\n\nA folder.\n`;
    files['docs-site/pages/index.md'] = '# Home\n\nStart at [gateway](../../gateway/README.md).\n';
    files['docs-site/pages/start-here.md'] = '# Start here\n\nTwo paths.\n';
    for (const [path, content] of Object.entries({ ...files, ...overrides })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };

  it('writes one page per source and empties the output first', () => {
    const out = join(tree(), 'out');
    mkdirSync(join(out, 'stale'), { recursive: true });
    writeFileSync(join(out, 'stale/index.md'), 'old');
    const pages = sync(root, out);
    expect(pages.length).toBe(GROUPS.flatMap((g) => g.folders).length + 4);
    expect(readFileSync(join(out, 'index.md'), 'utf8')).toContain(`[gateway](${BASE}/gateway/)`);
    expect(readFileSync(join(out, 'contributing/index.md'), 'utf8')).toContain(`[the gateway](${BASE}/gateway/)`);
    expect(() => readFileSync(join(out, 'stale/index.md'))).toThrow();
  });

  it('fails on a broken relative link, names the file and the link, and writes nothing', () => {
    const out = join(tree({ 'gateway/README.md': '# gateway\n\nSee [caps](src/caps.ts) and [gone](../evals/GONE.md).\n' }), 'out');
    expect(() => sync(root, out)).toThrow(/2 broken relative links:\n {2}gateway\/README.md: src\/caps.ts\n {2}gateway\/README.md: \.\.\/evals\/GONE.md/);
    expect(() => readFileSync(join(out, 'index.md'))).toThrow();
  });

  it('fails when a folder with a README has no sidebar group, and when a listed folder has none', () => {
    tree({ 'new-library/README.md': '# New\n\nText.\n' });
    expect(() => plan(root)).toThrow(/no sidebar group in docs-site\/scripts\/site.ts for: new-library/);
    rmSync(join(root, 'new-library'), { recursive: true });
    rmSync(join(root, 'gateway/README.md'));
    expect(() => plan(root)).toThrow(/lists folders with no README.md: gateway/);
  });

  it('adds a case study page after its folder', () => {
    tree({ 'evals/CASE-STUDY.md': '# Case\n\nA record.\n' });
    const slugs = plan(root).map((p) => p.slug);
    expect(slugs.slice(slugs.indexOf('evals'), slugs.indexOf('evals') + 2)).toEqual(['evals', 'evals/case-study']);
  });
});

describe('the real repository', () => {
  const pages = plan(REPO_ROOT);

  it('plans a page for every README, the case study, the two project docs and the two hand-written pages', () => {
    expect(pages.map((p) => p.slug)).toContain('evals/case-study');
    expect(pages.length).toBe(GROUPS.flatMap((g) => g.folders).length + 5);
    expect(new Set(pages.map((p) => p.slug)).size).toBe(pages.length);
  });

  it('has no broken relative link in any source', () => {
    // A temporary output keeps the test from touching src/content.
    const out = mkdtempSync(join(tmpdir(), 'docs-real-'));
    try {
      expect(sync(REPO_ROOT, join(out, 'docs')).length).toBe(pages.length);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('gives every page a description that is the start of its first paragraph', () => {
    for (const page of pages) {
      const markdown = readFileSync(join(REPO_ROOT, page.source), 'utf8');
      const { description, body } = splitDocument(markdown, page.source);
      const first = plainText(body.split(/\n\s*\n/)[0] ?? '');
      expect(first.startsWith(description), `${page.source}: ${description}`).toBe(true);
    }
  });

  it('groups the sidebar like the root README, with Project last and the license on GitHub', () => {
    const items = sidebar(pages);
    expect(items.map((i) => i.label)).toEqual(['Overview', 'Start here', ...GROUPS.map((g) => g.label), 'Project']);
    const project = items.at(-1);
    expect(project !== undefined && 'items' in project ? project.items : []).toEqual([
      { label: 'Contributing', link: '/contributing/' },
      { label: 'Security', link: '/security/' },
      { label: 'License', link: `${REPO_URL}/blob/main/LICENSE` },
    ]);
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    for (const group of GROUPS.filter((g) => g.label !== 'Apps')) expect(readme).toContain(`### ${group.label}\n`);
  });
});

describe('the dist checker', () => {
  let dist = '';
  afterEach(() => {
    if (dist) rmSync(dist, { recursive: true, force: true });
  });
  const build = (files: Readonly<Record<string, string>>): string => {
    dist = mkdtempSync(join(tmpdir(), 'docs-dist-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dist, path)), { recursive: true });
      writeFileSync(join(dist, path), content);
    }
    return dist;
  };

  it('accepts links under the base that resolve, with anchors, and ignores external URLs and code samples', () => {
    build({
      'index.html': `<a href="${BASE}/gateway/#install">x</a><a href="gateway/">y</a><a href="#top">z</a><h1 id="top">T</h1><link href="${BASE}/_astro/a.css?v=1"><a href="https://example.test/">e</a><code>&lt;a href="/a&lt;code class="x"&gt;</code>`,
      'gateway/index.html': `<h2 id="install">Install</h2><a href="../">home</a><a href="${BASE}/">home</a><img src="${BASE}/favicon.svg">`,
      '_astro/a.css': '',
      'favicon.svg': '',
    });
    expect(brokenLinks(dist)).toEqual([]);
  });

  it('reports a missing page, a missing anchor and a link outside the base', () => {
    build({
      'index.html': `<a href="${BASE}/gone/">x</a><a href="${BASE}/gateway/#nope">y</a><a href="/gateway/">z</a><a href="/applied-ai-toolkit/caja/">demo</a>`,
      'gateway/index.html': '<h2 id="install">Install</h2>',
    });
    expect(brokenLinks(dist)).toEqual([
      `index.html: ${BASE}/gone/ (no such file in the build)`,
      `index.html: ${BASE}/gateway/#nope (no element with id "nope" in gateway/index.html)`,
      `index.html: /gateway/ (outside the base ${BASE}/)`,
      `index.html: /applied-ai-toolkit/caja/ (outside the base ${BASE}/)`,
    ]);
  });

  it('compares the built pages with the planned ones', () => {
    build({ 'index.html': '', '404.html': '', 'extra/index.html': '' });
    expect(pageMismatch(dist, ['', 'gateway'])).toEqual(['gateway/index.html: planned but not built', 'extra/index.html: built but not planned']);
  });
});
