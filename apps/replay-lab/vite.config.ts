// Build for apps/replay-lab: `npx vite build --config apps/replay-lab/vite.config.ts` from the
// repository root writes dist/apps/replay-lab.
//
// base './' makes every URL relative, so the output works at a domain root or under a subpath.
// The plugin builds src/sw.ts as sw.js at the root of the output with no hash (a service worker's
// URL is its identity), and writes into it the list of every file the build produced and a hash of
// their contents. The batch worker is emitted by Vite as a hashed asset, so it is in that list too.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

const here = import.meta.dirname;
const SW_NAME = 'sw.js';

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'));
}

function precachePlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'replay-lab-precache',
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const sw = bundle[SW_NAME];
        if (!sw || sw.type !== 'chunk') throw new Error(`replay-lab: ${SW_NAME} missing from the bundle`);
        const publicDir = config.publicDir;
        const publicFiles = publicDir ? filesUnder(publicDir) : [];
        const hash = createHash('sha256');
        const files: string[] = [];
        for (const [fileName, output] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
          if (fileName === SW_NAME || fileName.endsWith('.map')) continue;
          files.push(fileName);
          hash.update(fileName).update(output.type === 'chunk' ? output.code : output.source);
        }
        for (const fileName of publicFiles.sort()) {
          files.push(fileName);
          hash.update(fileName).update(readFileSync(join(publicDir, fileName)));
        }
        const precache = ['./', ...files];
        const before = sw.code;
        sw.code = sw.code
          .replaceAll('__REPLAY_LAB_PRECACHE__', JSON.stringify(precache))
          .replaceAll('__REPLAY_LAB_VERSION__', JSON.stringify(hash.digest('hex').slice(0, 16)));
        if (sw.code === before || /__REPLAY_LAB_(PRECACHE|VERSION)__/u.test(sw.code)) throw new Error('replay-lab: the service worker placeholders were not replaced');
        if (!precache.includes('index.html')) throw new Error('replay-lab: index.html is not in the precache');
        if (!files.some((f) => /^assets\/batch-worker-[\w-]+\.js$/u.test(f))) throw new Error('replay-lab: the batch worker is not in the precache');
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  root: here,
  base: './',
  define: { __REPLAY_LAB_DEV__: JSON.stringify(command === 'serve') },
  plugins: [precachePlugin()],
  worker: { format: 'es' },
  build: {
    outDir: resolve(here, '../../dist/apps/replay-lab'),
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
