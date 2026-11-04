// Build for apps/chat-widget: `npx vite build --config apps/chat-widget/vite.config.ts` from the
// repository root writes dist/apps/chat-widget.
//
// Three entries: the demo page (index.html), the panel (panel/index.html) and the loader
// (src/embed.ts). The loader is emitted as embed/chat.js with no hash, because the snippet a
// business pastes names that URL and must keep working across builds. It is loaded as a classic
// script (document.currentScript is null in a module), so the plugin below fails the build if the
// emitted file imports or exports anything, and wraps it in a function scope. Vite warns that the
// demo page's <script src="./embed/chat.js"> cannot be bundled: that is intended, the page loads
// the emitted file exactly as a business's site does. base './' keeps every other URL relative.

import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const here = import.meta.dirname;
export const LOADER = 'embed/chat.js';

function classicLoader(): Plugin {
  return {
    name: 'chat-widget-loader',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const loader = bundle[LOADER];
        if (!loader || loader.type !== 'chunk') throw new Error(`chat-widget: ${LOADER} missing from the bundle`);
        if (loader.imports.length > 0 || loader.dynamicImports.length > 0 || loader.exports.length > 0) {
          throw new Error(`chat-widget: ${LOADER} must be a classic script with no imports or exports`);
        }
        // In a classic script, top-level declarations become properties of the host page's
        // window (the minifier names them e, t, n...). One function scope keeps them private.
        loader.code = `(function () {\n${loader.code}\n})();\n`;
      },
    },
  };
}

export default defineConfig({
  root: here,
  base: './',
  plugins: [classicLoader()],
  build: {
    outDir: resolve(here, '../../dist/apps/chat-widget'),
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      input: {
        index: resolve(here, 'index.html'),
        panel: resolve(here, 'panel/index.html'),
        loader: resolve(here, 'src/embed.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'loader' ? LOADER : 'assets/[name]-[hash].js'),
      },
    },
  },
});
