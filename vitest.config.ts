import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['gateway/**/*.test.ts', 'evals/**/*.test.ts', 'slop-lint/**/*.test.ts', 'n8n-templates/**/*.test.ts'],
  },
});
