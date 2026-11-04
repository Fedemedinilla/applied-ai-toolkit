// Build for apps/caja: `npm run build:caja` from the repository root writes dist/apps/caja.
//
// base './' makes every URL relative, so the same output works at a domain root or under any
// subpath (GitHub Pages serves it at /<repo>/apps/caja/). The plugin below does three things the
// app needs and Vite does not do on its own:
//   1. Serves and emits corpus.json, the parser's spec, read from ../../amount-parser/corpus/.
//      One file in the repository, no copy to keep in sync.
//   2. Builds src/sw.ts as sw.js at the root of the output, with no hash. A service worker's URL
//      is its identity; a hashed name would install a new worker next to the old one every build.
//   3. Writes into sw.js the list of every file the build produced (the precache) and a hash of
//      their contents (the cache name). A file added later is cached on install without anyone
//      editing a list, and any change to any file gives the next build a new cache.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

const here = import.meta.dirname;
// A URL rather than a joined path, so import-fences sees this read of amount-parser's published data.
const CORPUS = new URL('../../amount-parser/corpus/corpus.json', import.meta.url);
const SW_NAME = 'sw.js';

/** Every file under `dir`, as forward-slash paths relative to it. Dot files are skipped. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'));
}

function cajaPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'caja',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.split('?')[0]?.endsWith('/corpus.json')) return next();
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(readFileSync(CORPUS));
      });
    },
    // 'post', so index.html (emitted by Vite's own HTML plugin) is already in the bundle.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const corpus = readFileSync(CORPUS);
        this.emitFile({ type: 'asset', fileName: 'corpus.json', source: corpus });

        const sw = bundle[SW_NAME];
        if (!sw || sw.type !== 'chunk') throw new Error(`caja: ${SW_NAME} missing from the bundle`);

        // Public files are copied after the bundle is written, so they are listed from disk, with
        // subfolders walked: a folder name in the precache would 404 and fail the whole install.
        const publicDir = config.publicDir;
        const publicFiles = publicDir ? filesUnder(publicDir) : [];

        const hash = createHash('sha256');
        const files: string[] = ['corpus.json'];
        hash.update('corpus.json').update(corpus);
        for (const [fileName, output] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
          if (fileName === SW_NAME || fileName === 'corpus.json' || fileName.endsWith('.map')) continue;
          files.push(fileName);
          hash.update(fileName).update(output.type === 'chunk' ? output.code : output.source);
        }
        for (const fileName of publicFiles.sort()) {
          files.push(fileName);
          hash.update(fileName).update(readFileSync(join(publicDir, fileName)));
        }
        // The scope URL ("./") is what a visitor opens; it is cached under that name too.
        const precache = ['./', ...files];
        const version = hash.digest('hex').slice(0, 16);

        const before = sw.code;
        sw.code = sw.code
          .replaceAll('__CAJA_PRECACHE__', JSON.stringify(precache))
          .replaceAll('__CAJA_VERSION__', JSON.stringify(version));
        if (sw.code === before || /__CAJA_(PRECACHE|VERSION)__/u.test(sw.code)) {
          throw new Error('caja: the service worker placeholders were not replaced');
        }
        if (!precache.includes('index.html')) throw new Error('caja: index.html is not in the precache');
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  root: here,
  base: './',
  define: { __CAJA_DEV__: JSON.stringify(command === 'serve') },
  plugins: [cajaPlugin()],
  build: {
    outDir: resolve(here, '../../dist/apps/caja'),
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
