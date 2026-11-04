import { defineConfig } from 'vitest/config';

// Every *.test.ts in the repository runs here. A browser-facing test opts into jsdom with a
// `// @vitest-environment jsdom` comment at the top of the file.
//
// The timeouts are raised from Vitest's defaults (5 s per test, 10 s per hook). Some tests boot a
// real Postgres in PGlite, run fast-check properties through jsdom, build a 120-line PDF or start a
// CLI as a child process. Alone they take 2 to 4.5 s; on a loaded machine (a two-core CI runner, or
// two suites at once) they went past 5 s and failed for no reason in the code. A test that hangs
// still fails, 30 s later.
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
