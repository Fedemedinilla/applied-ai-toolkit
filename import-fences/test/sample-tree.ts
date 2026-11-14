/**
 * A small project with the typical layout (src/client, src/server, src/shared, one SDK importer)
 * and one violation of each kind the CLI prints. The tests write it to a temporary folder, so no
 * file with a broken import lives in this repository. The config is plain JavaScript in a .ts
 * file, so the tree does not need this folder's sources.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SAMPLE_CONFIG = `export default {
  groups: {
    client: { include: ['src/client/**'] },
    server: { include: ['src/server/**'] },
    all: { include: ['src/**'] },
    workers: { include: ['src/workers/**'] },
  },
  rules: [
    { rule: 'forbidden-import', group: 'client', specifiers: ['node:*'], paths: ['src/server/**'], why: 'client code ships to the browser' },
    { rule: 'single-importer', group: 'all', package: '@vendor/sdk', allow: ['src/server/llm.ts', 'src/server/gone.ts'], why: 'every call goes through the spending cap' },
    { rule: 'single-reader', group: 'all', variable: 'VENDOR_API_KEY', allow: ['src/server/llm.ts'] },
    { rule: 'relative-extension', group: 'all' },
    { rule: 'dynamic-import', group: 'client' },
  ],
};
`;

export const SAMPLE_FILES: Readonly<Record<string, string>> = {
  'src/client/app.ts':
    "import { format } from '../shared/format';\nimport { readFileSync } from 'node:fs';\nimport { rows } from '../server/db.ts';\nexport const page = (name: string) => import(`./pages/${name}.ts`);\n",
  'src/client/widget.ts': "import { label } from '../shared/label.ts';\nexport const widget = label;\n",
  'src/shared/format.ts': 'export const format = (n: number) => String(n);\n',
  'src/shared/label.ts': "import { secret } from '../server/secret.ts';\nexport const label = secret;\n",
  'src/server/db.ts': 'export const rows = [];\n',
  'src/server/secret.ts': "export const secret = 'x';\n",
  'src/server/llm.ts': "import { Client } from '@vendor/sdk';\nexport const make = () => new Client(process.env.VENDOR_API_KEY);\n",
  'src/server/report.ts': "import { Client } from '@vendor/sdk';\n\nconst key = process.env['VENDOR_API_KEY'];\nexport const report = () => new Client(key);\n",
};

/** The same layout with every violation fixed and the config trimmed to what the code does. */
export const CLEAN_CONFIG = `export default {
  groups: { client: { include: ['src/client/**'] }, all: { include: ['src/**'] } },
  rules: [
    { rule: 'forbidden-import', group: 'client', specifiers: ['node:*'], paths: ['src/server/**'] },
    { rule: 'single-importer', group: 'all', package: '@vendor/sdk', allow: ['src/server/llm.ts'] },
    { rule: 'relative-extension', group: 'all' },
  ],
};
`;

export const CLEAN_FILES: Readonly<Record<string, string>> = {
  'src/client/app.ts': "import { format } from '../shared/format.ts';\nexport const app = format(1);\n",
  'src/shared/format.ts': 'export const format = (n: number) => String(n);\n',
  'src/server/llm.ts': "import { Client } from '@vendor/sdk';\nexport const make = () => new Client();\n",
};

/** Writes files to a new temporary folder and returns its path. The caller removes it. */
export function writeTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'import-fences-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

export const SAMPLE = { 'import-fences.config.ts': SAMPLE_CONFIG, ...SAMPLE_FILES };
export const CLEAN = { 'import-fences.config.ts': CLEAN_CONFIG, ...CLEAN_FILES };
