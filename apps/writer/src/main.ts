// Browser entry: the catalog the build validated, the real fetch and the real clipboard.

import { mountApp } from './app.ts';
import { browserClipboard } from './clipboard.ts';
import type { ClientCatalog } from './config-schema.ts';

// Replaced by Vite's `define` (vite.config.ts) with the catalog parsed from config/ at build time.
declare const __WRITER_CATALOG__: ClientCatalog;

mountApp(document, {
  catalog: __WRITER_CATALOG__,
  fetch: (input, init) => fetch(input, init),
  clipboard: browserClipboard(),
});
