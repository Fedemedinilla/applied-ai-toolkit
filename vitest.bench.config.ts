import { defineConfig } from 'vitest/config';

// The benchmarks: every *.bench.ts, run by `npm run bench` and never by `npm test`. One file at a
// time, so a bench does not share the cores with another one. Before each file, in the same worker
// process, test/bench/calibration.setup.ts times the calibration loop that the comparison divides
// by (see test/bench/README.md).
export default defineConfig({
  test: {
    benchmark: {
      include: ['**/*.bench.ts'],
      // Nested node_modules (docs-site, agent worktrees under .claude/) ship *.bench.ts files of their own.
      exclude: ['**/node_modules/**', 'dist/**', '**/dist/**', '.claude/**', '.stryker-tmp/**', 'reports/**'],
    },
    setupFiles: ['test/bench/calibration.setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
