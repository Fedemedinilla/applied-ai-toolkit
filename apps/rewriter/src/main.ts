// Browser entry: the real fetch and the real clipboard.

import { mountApp } from './app.ts';

mountApp(document, {
  fetch: (input, init) => fetch(input, init),
  ...(navigator.clipboard ? { copy: (text: string) => navigator.clipboard.writeText(text) } : {}),
});
