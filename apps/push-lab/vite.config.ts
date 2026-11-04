// Build for apps/push-lab: `npx vite build --config apps/push-lab/vite.config.ts` from the
// repository root writes dist/apps/push-lab. server/serve.ts serves that folder and the API.
//
// base './' makes every URL relative, so the output works at a domain root or under a subpath.
// The plugin builds src/sw.ts as sw.js at the root of the output with no hash (a worker's URL is
// its identity; a hashed name would install a second worker on every build) and writes a hash of
// the other files into it, so each build gets its own asset cache and drops the last one.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const here = import.meta.dirname;
const SW_NAME = 'sw.js';
const PLACEHOLDER = '__PUSH_LAB_VERSION__';

function workerVersion(): Plugin {
  return {
    name: 'push-lab-worker',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const sw = bundle[SW_NAME];
        if (!sw || sw.type !== 'chunk') throw new Error(`push-lab: ${SW_NAME} missing from the bundle`);
        const hash = createHash('sha256');
        for (const [fileName, output] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
          if (fileName === SW_NAME) continue;
          hash.update(fileName).update(output.type === 'chunk' ? output.code : output.source);
        }
        const before = sw.code;
        sw.code = sw.code.replaceAll(PLACEHOLDER, JSON.stringify(hash.digest('hex').slice(0, 16)));
        if (sw.code === before || sw.code.includes(PLACEHOLDER)) throw new Error('push-lab: the worker version was not replaced');
      },
    },
  };
}

export default defineConfig({
  root: here,
  base: './',
  plugins: [workerVersion()],
  build: {
    outDir: resolve(here, '../../dist/apps/push-lab'),
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      input: { index: resolve(here, 'index.html'), sw: resolve(here, 'src/sw.ts') },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? SW_NAME : 'assets/[name]-[hash].js'),
      },
    },
  },
});
