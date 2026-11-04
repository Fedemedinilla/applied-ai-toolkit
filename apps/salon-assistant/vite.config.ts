// Build for apps/salon-assistant: `npx vite build --config apps/salon-assistant/vite.config.ts`
// from the repository root writes dist/apps/salon-assistant. base './' keeps every URL relative.
// The server (server/serve.ts) is not part of the build.

import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: resolve(here, '../../dist/apps/salon-assistant'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
