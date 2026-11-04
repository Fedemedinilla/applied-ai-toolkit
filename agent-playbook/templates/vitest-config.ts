/**
 * Template for a project's vitest.config.ts: the environment is cleaned once, here, before any
 * project or worker starts, so every worker inherits it. In a project, copy src/test-env.ts to
 * test/helpers/test-env.ts and import it from there.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { applyTestEnv, DEFAULT_POLICY } from '../src/test-env.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

applyTestEnv(ROOT, {
  ...DEFAULT_POLICY,
  // The database prefix joins the default ones; the two kept names configure a local stack.
  prefixes: [...DEFAULT_POLICY.prefixes, 'SUPABASE_'],
  keep: new Set(['SUPABASE_EXPERIMENTAL_STACK', 'SUPABASE_NATIVE_POSTGRES_USER']),
});

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
