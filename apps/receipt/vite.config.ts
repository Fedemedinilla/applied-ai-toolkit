// Build for apps/receipt: `npx vite build --config apps/receipt/vite.config.ts` from the
// repository root writes dist/apps/receipt.
//
// base './' makes every URL relative, so the output works at a domain root or under a subpath
// such as GitHub Pages. There is no server and no service worker: the page, its script (which
// bundles pdf-lib) and the sample logo in public/ are the whole app.

import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: resolve(here, '../../dist/apps/receipt'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
