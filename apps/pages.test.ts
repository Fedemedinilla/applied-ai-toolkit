// The GitHub Pages site: the landing page, the list of published apps, and the "Live demo" links in
// the READMEs all name the same apps, and the assembly copies exactly those builds.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assemblePages, landingLinks, PAGES_APPS, PAGES_URL } from './pages.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const landing = read('./index.html');

describe('the landing page', () => {
  it('links every published app once, in the order of PAGES_APPS', () => {
    expect(landingLinks(landing)).toEqual([...PAGES_APPS]);
  });

  it('has a language, a strict policy, and no inline script or style', () => {
    expect(landing).toMatch(/<html lang="en">/);
    expect(landing).toContain(`content="default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'"`);
    expect(landing).not.toMatch(/<script|<style|style="/);
  });

  it('has a dark scheme and a visible focus ring', () => {
    const css = read('./index.css');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/:focus-visible \{\s*outline: 3px solid/);
  });
});

describe('the demo links', () => {
  it.each(PAGES_APPS)('apps/%s/README.md links its demo, and so does the root README', (app) => {
    const url = `${PAGES_URL}${app}/`;
    expect(read(`./${app}/README.md`)).toContain(`Live demo: <${url}>`);
    expect(read('../README.md')).toContain(url);
  });

  it.each(PAGES_APPS)('apps/%s builds with relative URLs, so it works under the Pages subpath', (app) => {
    expect(read(`./${app}/vite.config.ts`)).toMatch(/base: '\.\/'/);
  });
});

describe('assemblePages', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const tree = (apps: readonly string[]) => {
    root = mkdtempSync(join(tmpdir(), 'pages-'));
    mkdirSync(join(root, 'apps'));
    writeFileSync(join(root, 'apps/index.html'), landing);
    writeFileSync(join(root, 'apps/index.css'), 'body {}');
    for (const app of apps) {
      mkdirSync(join(root, 'dist/apps', app, 'assets'), { recursive: true });
      writeFileSync(join(root, 'dist/apps', app, 'index.html'), `<title>${app}</title>`);
      writeFileSync(join(root, 'dist/apps', app, 'assets/a.js'), '');
    }
    return pathToFileURL(`${root}/`);
  };

  it('copies the landing page and each published build, and nothing else', () => {
    const out = assemblePages(tree([...PAGES_APPS, 'chat-widget']));
    expect(readdirSync(out).sort()).toEqual([...PAGES_APPS, 'index.css', 'index.html'].sort());
    expect(readFileSync(join(out, 'replay-lab/index.html'), 'utf8')).toBe('<title>replay-lab</title>');
    expect(readdirSync(join(out, 'caja/assets'))).toEqual(['a.js']);
  });

  it('refuses to assemble when a published build is missing', () => {
    expect(() => assemblePages(tree(PAGES_APPS.filter((a) => a !== 'checklist')))).toThrow(/dist\/apps\/checklist\/index.html is missing/);
  });
});
