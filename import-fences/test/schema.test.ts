/**
 * JSON configs: the committed JSON Schema is the one the zod schema generates, the CLI loads a
 * .json config the way it loads a module, and the examples in the README are valid configs.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFIG_SCHEMA_URL, configJsonSchema, loadConfig, parseConfig } from '../src/config.ts';
import { CLEAN_FILES, SAMPLE_FILES, writeTree } from './sample-tree.ts';

const FOLDER = join(import.meta.dirname, '..');
const CLI = join(FOLDER, 'cli.ts');
const README = readFileSync(join(FOLDER, 'README.md'), 'utf8');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function tree(files: Readonly<Record<string, string>>): string {
  const root = writeTree(files);
  roots.push(root);
  return root;
}
function cli(cwd: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const JSON_CONFIG = {
  $schema: CONFIG_SCHEMA_URL,
  groups: { client: { include: ['src/client/**'] }, all: { include: ['src/**'] } },
  rules: [
    { rule: 'forbidden-import', group: 'client', specifiers: ['node:*'], paths: ['src/server/**'], why: 'client code ships to the browser' },
    { rule: 'single-importer', group: 'all', package: '@vendor/sdk', allow: ['src/server/llm.ts'] },
    { rule: 'relative-extension', group: 'all' },
  ],
};

describe('schema/config.schema.json', () => {
  const committed = readFileSync(join(FOLDER, 'schema', 'config.schema.json'), 'utf8');

  it('is what the zod schema generates; run scripts/write-schema.ts after changing the config format', () => {
    expect(committed).toBe(`${JSON.stringify(configJsonSchema(), null, 2)}\n`);
  });

  it('is a strict draft 2020-12 schema with every rule and the $schema key', () => {
    const schema = JSON.parse(committed) as {
      $schema: string;
      $id: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown> & { rules: { items: { oneOf: Array<{ additionalProperties: boolean; properties: { rule: { const: string } } }> } } };
    };
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(CONFIG_SCHEMA_URL);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(['groups', 'rules']);
    expect(Object.keys(schema.properties).sort()).toEqual(['$schema', 'groups', 'ignore', 'root', 'rules']);
    const rules = schema.properties.rules.items.oneOf;
    expect(rules.map((r) => r.properties.rule.const)).toEqual(['forbidden-import', 'single-importer', 'single-reader', 'single-string', 'relative-extension', 'dynamic-import']);
    for (const rule of rules) expect(rule.additionalProperties).toBe(false);
  });
});

describe('a JSON config', () => {
  it('gives the same result as the same config written as a module', () => {
    const { $schema: _schema, ...plain } = JSON_CONFIG;
    const asJson = tree({ ...SAMPLE_FILES, 'import-fences.config.json': JSON.stringify(JSON_CONFIG) });
    const asModule = tree({ ...SAMPLE_FILES, 'import-fences.config.ts': `export default ${JSON.stringify(plain)};` });
    const json = cli(asJson, ['--json']);
    const module = cli(asModule, ['--json']);
    expect(json.code).toBe(1);
    // The one difference is the file that config-level violations would name, and this config has none.
    expect(JSON.parse(json.stdout)).toEqual({ ...(JSON.parse(module.stdout) as object), files: 8 });
    expect((JSON.parse(module.stdout) as { files: number }).files).toBe(9);
  });

  it('is found without --config when there is no import-fences.config.ts, and the .ts one wins when both exist', () => {
    const only = tree({ ...CLEAN_FILES, 'import-fences.config.json': JSON.stringify(JSON_CONFIG) });
    expect(cli(only)).toMatchObject({ code: 0, stdout: 'import-fences: 0 violations in 3 files, 3 rules\n', stderr: '' });
    const both = tree({ ...CLEAN_FILES, 'import-fences.config.json': '{ not json', 'import-fences.config.ts': `export default ${JSON.stringify({ groups: JSON_CONFIG.groups, rules: [{ rule: 'relative-extension', group: 'all' }] })};` });
    expect(cli(both)).toMatchObject({ code: 0, stdout: 'import-fences: 0 violations in 4 files, 1 rules\n' });
  });

  it('resolves root against the config file, as a module config does', async () => {
    const root = tree({ ...CLEAN_FILES, 'config/fences.json': JSON.stringify({ ...JSON_CONFIG, root: '..' }) });
    expect((await loadConfig(join(root, 'config', 'fences.json'))).root).toBe(root);
    expect(cli(root, ['--config', 'config/fences.json'])).toMatchObject({ code: 0, stdout: 'import-fences: 0 violations in 3 files, 3 rules\n' });
  });

  it('loads a file saved with a UTF-8 byte order mark, as Windows editors write it', async () => {
    const root = tree({ ...CLEAN_FILES, 'import-fences.config.json': `\uFEFF${JSON.stringify(JSON_CONFIG)}` });
    const { $schema: _schema, ...plain } = JSON_CONFIG;
    expect((await loadConfig(join(root, 'import-fences.config.json'))).config).toEqual(parseConfig(plain));
    expect(cli(root)).toMatchObject({ code: 0, stdout: 'import-fences: 0 violations in 3 files, 3 rules\n' });
  });

  it('exits 2 with nothing on stdout when it is not JSON, not an object, or not a valid config', () => {
    const root = tree({
      ...CLEAN_FILES,
      'broken.json': '{ "groups": ',
      'list.json': '[]',
      'typo.json': JSON.stringify({ ...JSON_CONFIG, rules: [{ rule: 'single-importer', group: 'all', pakage: 'x', allow: [] }] }),
      'extra.json': JSON.stringify({ ...JSON_CONFIG, comment: 'not a key of the config' }),
    });
    expect(cli(root, ['--config', 'broken.json'])).toMatchObject({ code: 2, stdout: '', stderr: expect.stringMatching(/^cannot load broken\.json: /) as unknown });
    for (const name of ['list.json', 'typo.json', 'extra.json']) {
      expect(cli(root, ['--config', name]), name).toMatchObject({ code: 2, stdout: '', stderr: expect.stringMatching(/^invalid config:/) as unknown });
    }
  });
});

describe('a module config', () => {
  it('is read again when the file changes in the same process', async () => {
    const write = (include: string) => `export default { groups: { a: { include: ['${include}'] } }, rules: [{ rule: 'dynamic-import', group: 'a' }] };\n`;
    const root = tree({ 'fences.config.ts': write('a/**') });
    const path = join(root, 'fences.config.ts');
    expect((await loadConfig(path)).config.groups['a']?.include).toEqual(['a/**']);
    writeFileSync(path, write('b/**'));
    expect((await loadConfig(path)).config.groups['a']?.include).toEqual(['b/**']);
  });
});

describe('the README', () => {
  const blocks = (lang: string) => [...README.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, 'g'))].map((m) => m[1] ?? '');

  it('shows a JSON config that names the schema and is valid', () => {
    const configs = blocks('json').filter((b) => b.includes('"rules"'));
    expect(configs.length).toBeGreaterThan(0);
    for (const text of configs) {
      const { $schema, ...config } = JSON.parse(text) as Record<string, unknown>;
      expect($schema).toBe(CONFIG_SCHEMA_URL);
      expect(() => parseConfig(config)).not.toThrow();
    }
  });

  it('shows that JSON config passing on the layout it describes', () => {
    const text = blocks('json').find((b) => b.includes('"rules"')) ?? '';
    const root = tree({
      'import-fences.config.json': text,
      'src/client/main.ts': "import { format } from '../shared/format.ts';\nexport const main = format(1);\n",
      'src/shared/format.ts': 'export const format = (n: number) => String(n);\n',
      'src/server/llm/client.ts': "import { Client } from '@vendor/sdk';\nexport const make = () => new Client(process.env.VENDOR_API_KEY);\n",
      'src/server/routes.ts': "import { make } from './llm/client.ts';\nexport const client = make();\n",
    });
    const clean = cli(root);
    expect(clean.stderr).toBe('');
    expect(clean).toMatchObject({ code: 0, stdout: expect.stringMatching(/^import-fences: 0 violations in 4 files, 3 rules\n$/) as unknown });
  });
});
