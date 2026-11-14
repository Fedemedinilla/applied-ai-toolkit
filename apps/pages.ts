/**
 * Assembles the GitHub Pages site in dist/pages/ from the app builds in dist/apps/: the landing
 * page (apps/index.html and apps/index.css) at the root, the shared look it loads (apps/shared/:
 * brand.css and the fonts) in shared/, and each published app in its own folder. The apps bundle
 * their own copy of the shared look at build time.
 * Run it after the builds (npm run build:pages does both). .github/workflows/pages.yml deploys the
 * result.
 *
 * The landing page also links the docs site at docs/. That folder is not an app and is not built
 * here: docs-site/ builds it (npm run build:docs) and pages.yml copies it in after this script.
 *
 * Only apps that work as static files are published. Caja checks ./api/health and keeps its model
 * mode hidden when the host answers 404, so it degrades to its offline mode. The chat widget, the
 * writer, the salon assistant and push-lab need their own server and are left out.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGES_APPS = ['caja', 'receipt', 'replay-lab', 'checklist'] as const;
export const PAGES_URL = 'https://fedemedinilla.github.io/applied-ai-toolkit/';

/** The folder of the docs site inside the Pages site. The landing page links it; it is not an app. */
export const DOCS_FOLDER = 'docs';

const ROOT = new URL('..', import.meta.url);

/** The app folders the landing page links to, in page order. The link to the docs is not one. */
export function landingLinks(html: string): string[] {
  return [...html.matchAll(/<a href="\.\/([a-z-]+)\/">/g)].map((m) => m[1] ?? '').filter((folder) => folder !== DOCS_FOLDER);
}

export function assemblePages(root: URL = ROOT): string {
  const out = fileURLToPath(new URL('dist/pages/', root));
  const landing = readFileSync(new URL('apps/index.html', root), 'utf8');
  const linked = landingLinks(landing);
  if (linked.join() !== PAGES_APPS.join()) {
    throw new Error(`apps/index.html links ${linked.join(', ')}; PAGES_APPS lists ${PAGES_APPS.join(', ')}`);
  }
  for (const app of PAGES_APPS) {
    if (!existsSync(new URL(`dist/apps/${app}/index.html`, root))) {
      throw new Error(`dist/apps/${app}/index.html is missing; run npm run build:${app} first`);
    }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(new URL('apps/index.html', root), join(out, 'index.html'));
  cpSync(new URL('apps/index.css', root), join(out, 'index.css'));
  cpSync(new URL('apps/shared/', root), join(out, 'shared'), { recursive: true });
  for (const app of PAGES_APPS) {
    cpSync(new URL(`dist/apps/${app}/`, root), join(out, app), { recursive: true });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = assemblePages();
  console.log(`pages: ${PAGES_APPS.length} apps and the landing page in ${out}`);
}
