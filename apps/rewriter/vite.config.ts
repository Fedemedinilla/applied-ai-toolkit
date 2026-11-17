// Build for apps/rewriter: `npx vite build --config apps/rewriter/vite.config.ts` from the
// repository root writes dist/apps/rewriter.
//
// base './' makes every URL relative, so the output works at a domain root or under a subpath such
// as GitHub Pages. demo/ is the public folder: its examples.json is copied next to the page and
// fetched only when there is no server behind it, so the recordings stay out of the script. In
// dev, /api goes to server/dev-server.ts.

import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const here = import.meta.dirname;
/** server/dev-server.ts listens here. Not imported from it: that would start the server. */
const API_PORT = 8789;

export default defineConfig({
  root: here,
  base: './',
  publicDir: resolve(here, 'demo'),
  server: {
    proxy: { '/api': `http://127.0.0.1:${API_PORT}` },
  },
  build: {
    outDir: resolve(here, '../../dist/apps/rewriter'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
