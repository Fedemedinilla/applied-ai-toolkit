/**
 * The fences of this repository, checked by test/repo.test.ts on every CI run. Each rule holds
 * today; a change that breaks one fails the suite with the file, the line and the reason.
 */
import { readdirSync } from 'node:fs';
import { defineConfig, NODE_BUILTINS, type FencesConfigInput } from './src/config.ts';

const ROOT = new URL('..', import.meta.url);
const TESTS = ['**/test/**', '**/tests/**', '**/*.test.ts', '**/fixtures/**'];
/** This file names the variable and the host it fences. */
const SELF = 'import-fences/repo.config.ts';

/**
 * Folder fences. The repository has two kinds of folder:
 *
 * - Library folders (every top-level folder except apps/) are self-contained: none imports
 *   another folder's files, so each one can be copied out of the repository alone.
 * - Apps (apps/<name>/) are built on libraries, as a reader of the repository would build on them.
 *   An app may reach a library only through what the library publishes: its public entry and its
 *   published data, listed in PUBLIC_SURFACE, and only the entries named for it in APP_USES. A
 *   library's internals and its test/ stay closed, so a library can change its internals without
 *   breaking an app, and an app never depends on another folder's test helpers. Apps do not
 *   import each other, and no library imports an app.
 *
 * Every crossing is checked as written (transitive: false). Following imports would walk from
 * amount-parser/src/index.ts into the library's own files, which the library is free to do.
 */
type Groups = NonNullable<FencesConfigInput['groups']>;
type Rules = FencesConfigInput['rules'];

/** What each library publishes to apps. A library that is not here publishes nothing. */
export const PUBLIC_SURFACE: Readonly<Record<string, readonly string[]>> = {
  'amount-parser': ['amount-parser/src/index.ts', 'amount-parser/corpus/*.json'],
  evals: ['evals/src/index.ts'],
  gateway: ['gateway/src/index.ts'],
  'idempotent-orders': ['idempotent-orders/src/index.ts'],
  'pdf-receipt': ['pdf-receipt/src/index.ts'],
};

/**
 * The published entries each app uses, each one taken from PUBLIC_SURFACE. An app names only what
 * it uses: an entry it stops using is reported as stale-allow, so the list stays a true description
 * of the dependencies, and an app that needs only a library's public entry does not have to touch
 * its data to pass.
 */
export const APP_USES: Readonly<Record<string, readonly string[]>> = {
  caja: ['amount-parser/src/index.ts', 'amount-parser/corpus/*.json', 'gateway/src/index.ts'],
  'chat-widget': ['gateway/src/index.ts'],
  receipt: ['pdf-receipt/src/index.ts'],
  writer: ['evals/src/index.ts', 'gateway/src/index.ts'],
};

export interface Layout {
  readonly libraries: readonly string[];
  readonly apps: readonly string[];
  readonly surface: Readonly<Record<string, readonly string[]>>;
  readonly uses: Readonly<Record<string, readonly string[]>>;
}

const SELF_CONTAINED = 'each library folder is self-contained and can be copied out of the repository alone';
const THROUGH_THE_ENTRY =
  "an app uses a library only through its public entry and published data; another folder's internals and test/ are not an interface";

/** One group and one forbidden-import rule per library folder and per app. */
export function folderFences({ libraries, apps, surface, uses }: Layout): { groups: Groups; rules: Rules } {
  for (const [app, used] of Object.entries(uses)) {
    if (!apps.includes(app)) throw new Error(`APP_USES names apps/${app}, which does not exist`);
    for (const entry of used) {
      const library = entry.split('/')[0] ?? '';
      if (!libraries.includes(library)) throw new Error(`apps/${app} uses ${entry}, which is not in a library folder`);
      if (!(surface[library] ?? []).includes(entry)) {
        const published = surface[library] ?? [];
        throw new Error(
          `apps/${app} uses ${entry}, which ${library} does not publish in PUBLIC_SURFACE${published.length ? ` (it publishes ${published.join(', ')})` : ' (it publishes nothing)'}`,
        );
      }
    }
  }
  const everyLibrary = libraries.map((f) => `${f}/**`);
  const groups: Groups = {
    // Files directly under apps/ belong to no app and import nothing outside apps/.
    'apps:loose': { include: ['apps/*'], allowEmpty: true },
  };
  const rules: Rules = [
    { rule: 'forbidden-import', group: 'apps:loose', paths: everyLibrary, transitive: false, why: SELF_CONTAINED },
  ];
  for (const library of libraries) {
    groups[`folder:${library}`] = { include: [`${library}/**`], allowEmpty: true };
    rules.push({
      rule: 'forbidden-import',
      group: `folder:${library}`,
      paths: [...everyLibrary.filter((p) => p !== `${library}/**`), 'apps/**'],
      transitive: false,
      why: SELF_CONTAINED,
    });
  }
  for (const app of apps) {
    groups[`app:${app}`] = { include: [`apps/${app}/**`], allowEmpty: true };
    rules.push({
      rule: 'forbidden-import',
      group: `app:${app}`,
      paths: [...everyLibrary, ...apps.filter((a) => a !== app).map((a) => `apps/${a}/**`)],
      except: [...(uses[app] ?? [])],
      transitive: false,
      why: THROUGH_THE_ENTRY,
    });
  }
  return { groups, rules };
}

const subfolders = (url: URL): string[] =>
  readdirSync(url, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
    .map((e) => e.name)
    .sort();

/** Listed from disk, so a new folder gets its fence without anyone editing this file. */
const fences = folderFences({
  libraries: subfolders(ROOT).filter((f) => f !== 'apps'),
  apps: subfolders(new URL('apps/', ROOT)),
  surface: PUBLIC_SURFACE,
  uses: APP_USES,
});

export default defineConfig({
  root: '..',
  groups: {
    all: { include: ['**/*'] },
    source: { include: ['**/*'], exclude: [...TESTS, SELF] },
    // amount-parser, idempotent-orders and pdf-receipt document that a browser app can import their src/.
    browser: {
      include: ['amount-parser/src/**', 'idempotent-orders/src/**', 'pdf-receipt/src/**', 'apps/*/src/**'],
      exclude: TESTS,
    },
    ...fences.groups,
  },
  rules: [
    {
      rule: 'relative-extension',
      group: 'all',
      why: 'Node 24 runs these files without a build step, and it does not add extensions',
    },
    {
      rule: 'single-importer',
      group: 'source',
      package: '@anthropic-ai/sdk',
      allow: ['gateway/src/client.ts', 'gateway/src/errors.ts', 'evals/scripts/cli.ts'],
      why: 'the gateway creates the only client and classifies its errors; the opt-in eval runner calls the model directly',
    },
    {
      rule: 'single-reader',
      group: 'source',
      variable: 'ANTHROPIC_API_KEY',
      allow: [
        'gateway/examples/live-call.ts',
        'evals/scripts/cli.ts',
        'apps/caja/server/env.ts',
        'apps/chat-widget/server/env.ts',
        'apps/writer/server/env.ts',
      ],
      why: 'the key is read by the opt-in live scripts and by one env module per app server, and passed in explicitly; library code never reads it',
    },
    {
      rule: 'single-string',
      group: 'source',
      text: 'api.anthropic.com',
      allow: ['gateway/src/client.ts'],
      why: 'a fetch of its own to the API would bypass the gateway; it needs the host',
    },
    {
      rule: 'forbidden-import',
      group: 'browser',
      specifiers: [...NODE_BUILTINS, '@anthropic-ai/sdk'],
      paths: ['gateway/**'],
      typeOnly: 'allow',
      why: 'browser code has no Node built-ins and must never hold the API client',
    },
    { rule: 'dynamic-import', group: 'browser', why: 'a computed import() makes the bundler include every file that matches' },
    {
      rule: 'forbidden-import',
      group: 'source',
      paths: TESTS,
      transitive: false,
      why: 'shipped code never depends on test helpers or fixtures',
    },
    ...fences.rules,
  ],
});
