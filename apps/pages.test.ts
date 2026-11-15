// The GitHub Pages site: the landing page, the list of published apps, and the "Live demo" links in
// the READMEs all name the same apps, and the assembly copies exactly those builds.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assemblePages, DOCS_FOLDER, landingLinks, PAGES_APPS, PAGES_URL } from './pages.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const landing = read('./index.html');

describe('the landing page', () => {
  it('links every published app once, in the order of PAGES_APPS', () => {
    expect(landingLinks(landing)).toEqual([...PAGES_APPS]);
  });

  it.each([
    ['an attribute before href', '<a class="demo-link" href="./writer/">Writer</a>', 'writer'],
    ['single quotes', "<a href='./push-lab/'>Push</a>", 'push-lab'],
    ['no trailing slash', '<a href="./chat-widget">Chat</a>', 'chat-widget'],
    ['no leading ./', '<a href="writer/">Writer</a>', 'writer'],
    ['a file inside the folder', '<a href="./writer/index.html">Writer</a>', 'writer'],
    ['a digit in the folder name', '<a href="./app2/">App</a>', 'app2'],
    ['spaces around =', '<a href = "./salon-assistant/">Salon</a>', 'salon-assistant'],
  ])('sees a link to an app folder written with %s', (_, link, folder) => {
    expect(landingLinks(`<a href="./caja/">Caja</a>${link}`)).toEqual(['caja', folder]);
  });

  it('ignores links that leave the site, fragments, data-href and the docs folder', () => {
    const html = '<a href="#demos">Skip</a><a href="https://github.com/x">GitHub</a><a href="mailto:a@example.com">m</a>'
      + '<a href="//example.com/">x</a><a data-href="./writer/">x</a><a href="./docs/">Docs</a><a href="./caja/">Caja</a>';
    expect(landingLinks(html)).toEqual(['caja']);
  });

  it('links the docs site once, in a folder that no app uses', () => {
    expect(landing.split(`<a href="./${DOCS_FOLDER}/">`).length - 1).toBe(1);
    expect(PAGES_APPS).not.toContain(DOCS_FOLDER);
    // pages.yml copies the docs build into that folder, and the docs are built for that path.
    expect(read('../.github/workflows/pages.yml')).toContain(`cp -R docs-site/dist dist/pages/${DOCS_FOLDER}\n`);
    expect(read('../docs-site/scripts/site.ts')).toContain(`export const BASE = '${new URL(PAGES_URL).pathname}${DOCS_FOLDER}';`);
  });

  it('has a language, a strict policy, and no inline script or style', () => {
    expect(landing).toMatch(/<html lang="en">/);
    expect(landing).toContain(`content="default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'"`);
    expect(landing).not.toMatch(/<script|<style|style="/);
  });

  it('loads the shared look first, which has a dark scheme, and has a visible focus ring', () => {
    expect(landing.indexOf('href="./shared/brand.css"')).toBeGreaterThan(-1);
    expect(landing.indexOf('href="./shared/brand.css"')).toBeLessThan(landing.indexOf('href="./index.css"'));
    expect(read('./shared/brand.css')).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(read('./index.css')).toMatch(/:focus-visible \{\s*outline: 3px solid/);
  });

  it('serves every font the shared look names, with its licence', () => {
    const css = read('./shared/brand.css');
    const fonts = [...css.matchAll(/url\('\.\/(fonts\/[a-z0-9-]+\.woff2)'\)/g)].map((m) => m[1] ?? '');
    expect(fonts.length).toBe(3);
    for (const font of fonts) expect(readFileSync(new URL(`./shared/${font}`, import.meta.url)).byteLength).toBeGreaterThan(1000);
    expect(read('./shared/fonts/OFL.txt')).toContain('SIL Open Font License, Version 1.1');
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

describe('the npm scripts', () => {
  const scripts = (JSON.parse(read('../package.json')) as { scripts: Record<string, string> }).scripts;

  it('build:pages builds exactly PAGES_APPS, in order, then assembles', () => {
    const steps = (scripts['build:pages'] ?? '').split(' && ');
    expect(steps.at(-1)).toBe('node apps/pages.ts');
    expect(steps.slice(0, -1)).toEqual(PAGES_APPS.map((app) => `npm run build:${app}`));
  });

  it('guard:pages runs csp-build-guard over exactly PAGES_APPS, each with its own config', () => {
    const steps = (scripts['guard:pages'] ?? '').split(' && ');
    expect(steps).toEqual(PAGES_APPS.map((app) => `node csp-build-guard/cli.ts --dir dist/apps/${app} --config apps/${app}/csp-guard.config.json`));
  });

  it.each(PAGES_APPS)('apps/%s/csp-guard.config.json searches the build for the key placeholder pages.yml sets', (app) => {
    const config: unknown = JSON.parse(read(`./${app}/csp-guard.config.json`));
    expect(config).toMatchObject({ secrets: { env: expect.arrayContaining(['ANTHROPIC_API_KEY']) } });
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
    mkdirSync(join(root, 'apps/shared/fonts'), { recursive: true });
    writeFileSync(join(root, 'apps/shared/brand.css'), 'body {}');
    writeFileSync(join(root, 'apps/shared/fonts/a.woff2'), '');
    for (const app of apps) {
      mkdirSync(join(root, 'dist/apps', app, 'assets'), { recursive: true });
      writeFileSync(join(root, 'dist/apps', app, 'index.html'), `<title>${app}</title>`);
      writeFileSync(join(root, 'dist/apps', app, 'assets/a.js'), '');
    }
    return pathToFileURL(`${root}/`);
  };

  it('copies the landing page, the shared look and each published build, and nothing else', () => {
    const out = assemblePages(tree([...PAGES_APPS, 'chat-widget']));
    expect(readdirSync(out).sort()).toEqual([...PAGES_APPS, 'index.css', 'index.html', 'shared'].sort());
    expect(readdirSync(join(out, 'shared/fonts'))).toEqual(['a.woff2']);
    expect(readFileSync(join(out, 'replay-lab/index.html'), 'utf8')).toBe('<title>replay-lab</title>');
    expect(readdirSync(join(out, 'caja/assets'))).toEqual(['a.js']);
  });

  it('refuses to assemble when the landing page links an app that PAGES_APPS does not list', () => {
    const url = tree(PAGES_APPS);
    writeFileSync(join(root, 'apps/index.html'), landing.replace('</ol>', '<li><a class="x" href="./writer/">Writer</a></li></ol>'));
    expect(() => assemblePages(url)).toThrow(/apps\/index.html links .*writer; PAGES_APPS lists/);
  });

  it('refuses to assemble when the landing page leaves out an app that PAGES_APPS lists', () => {
    const url = tree(PAGES_APPS);
    writeFileSync(join(root, 'apps/index.html'), landing.replace('<a href="./receipt/">Receipt</a>', 'Receipt'));
    expect(() => assemblePages(url)).toThrow(/apps\/index.html links caja, replay-lab, checklist; PAGES_APPS lists/);
  });

  it('refuses to assemble when a published build is missing', () => {
    expect(() => assemblePages(tree(PAGES_APPS.filter((a) => a !== 'checklist')))).toThrow(/dist\/apps\/checklist\/index.html is missing/);
  });
});
