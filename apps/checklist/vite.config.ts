// Build for apps/checklist: `npx vite build --config apps/checklist/vite.config.ts` from the
// repository root writes dist/apps/checklist.
//
// base './' makes every URL relative, so the output works at a domain root or under a subpath
// such as GitHub Pages. The plugin builds src/sw.ts as sw.js at the root of the output with no hash
// (a worker's URL is its identity; a hashed name would install a second worker on every build) and
// writes into it the list of every file the build produced and a hash of their contents. A file
// added later is precached without anyone editing a list, and any change gives a new cache name.
// public/catalogue.json is the output of data/build-catalogue.ts and is copied as it is.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

const here = import.meta.dirname;
const SW_NAME = 'sw.js';

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'));
}

function precachePlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'checklist-precache',
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle: {
      // 'post', so index.html (emitted by Vite's HTML plugin) is already in the bundle.
      order: 'post',
      handler(_options, bundle) {
        const sw = bundle[SW_NAME];
        if (!sw || sw.type !== 'chunk') throw new Error(`checklist: ${SW_NAME} missing from the bundle`);
        const hash = createHash('sha256');
        const files: string[] = [];
        for (const [name, out] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
          if (name === SW_NAME || name.endsWith('.map')) continue;
          files.push(name);
          hash.update(name).update(out.type === 'chunk' ? out.code : out.source);
        }
        // Public files are copied after the bundle is written, so they are listed from disk.
        const publicDir = config.publicDir;
        for (const name of (publicDir ? filesUnder(publicDir) : []).sort()) {
          files.push(name);
          hash.update(name).update(readFileSync(join(publicDir, name)));
        }
        if (!files.includes('index.html') || !files.includes('catalogue.json')) throw new Error('checklist: index.html or catalogue.json missing from the precache');
        const before = sw.code;
        sw.code = sw.code
          .replaceAll('__CHECKLIST_PRECACHE__', JSON.stringify(['./', ...files]))
          .replaceAll('__CHECKLIST_VERSION__', JSON.stringify(hash.digest('hex').slice(0, 16)));
        if (sw.code === before || /__CHECKLIST_(PRECACHE|VERSION)__/u.test(sw.code)) throw new Error('checklist: service worker placeholders were not replaced');
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  root: here,
  base: './',
  define: { __CHECKLIST_DEV__: JSON.stringify(command === 'serve') },
  plugins: [precachePlugin()],
  build: {
    outDir: resolve(here, '../../dist/apps/checklist'),
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      input: { index: resolve(here, 'index.html'), sw: resolve(here, 'src/sw.ts') },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? SW_NAME : 'assets/[name]-[hash].js'),
      },
    },
  },
}));
