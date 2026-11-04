import { defineConfig } from 'vitest/config';

// Every *.test.ts in the repository runs here. A browser-facing test opts into jsdom with a
// `// @vitest-environment jsdom` comment at the top of the file.
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '**/dist/**'],
  },
});
