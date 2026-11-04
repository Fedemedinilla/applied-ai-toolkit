// Build for apps/writer: `npx vite build --config apps/writer/vite.config.ts` from the repository
// root writes dist/apps/writer.
//
// base './' makes every URL relative, so the output works at a domain root or under a subpath.
// The config files are parsed with the same zod schema the server uses before anything is
// written: a category that names a missing role, or an example outside its own length range,
// fails the build with one line per problem. Only the public part of the catalog (names, roles,
// length ranges, sensitivity) reaches the page, through `define`; the prompt text stays on the
// server. In dev, /api goes to server/dev-server.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { clientCatalog, parseConfig } from './src/config-schema.ts';

const here = import.meta.dirname;
/** server/dev-server.ts listens here. Not imported from it: that would start the server. */
const API_PORT = 8788;

const read = (name: string): unknown => JSON.parse(readFileSync(resolve(here, 'config', name), 'utf8'));
const config = parseConfig({ school: read('school.json'), catalog: read('categories.json'), examples: read('examples.json') });

export default defineConfig({
  root: here,
  base: './',
  define: {
    __WRITER_CATALOG__: JSON.stringify(clientCatalog(config)),
  },
  server: {
    proxy: { '/api': `http://127.0.0.1:${API_PORT}` },
  },
  build: {
    outDir: resolve(here, '../../dist/apps/writer'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
