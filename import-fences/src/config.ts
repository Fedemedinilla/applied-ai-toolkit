/**
 * The config format. A config is a TypeScript module whose default export goes through
 * defineConfig, so the editor checks it, or a JSON file that an editor checks against
 * schema/config.schema.json. Either one is validated again with zod when the CLI loads it, because
 * a typo in a rule name must stop the run instead of turning a fence off.
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DEFAULT_IGNORE } from './files.ts';
import { globToRegExp } from './glob.ts';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Node's built-in modules in both spellings, `node:fs` and `fs`, for a forbidden-import rule.
 * Subpaths (`node:fs/promises`) match their parent.
 */
export const NODE_BUILTINS: readonly string[] = [
  'node:*',
  ...builtinModules.filter((m) => !m.startsWith('node:') && !m.startsWith('_') && !m.includes('/')),
];

const text = z.string().min(1);

/**
 * A repository glob is matched against posix paths relative to the root, such as `server/x.ts`.
 * `./server/**`, `/server/**` and `server\**` would match none of them and turn the rule off
 * silently, so they stop the run, and so does a glob that does not compile.
 */
const glob = text.superRefine((value, ctx) => {
  if (value.startsWith('./') || value.startsWith('/')) {
    ctx.addIssue({ code: 'custom', message: `glob ${JSON.stringify(value)} starts with "${value.startsWith('/') ? '/' : './'}"; paths are relative to the root without it, as in "server/**"` });
  } else if (value.includes('\\')) {
    ctx.addIssue({ code: 'custom', message: `glob ${JSON.stringify(value)} has a backslash; use forward slashes` });
  } else {
    try {
      globToRegExp(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
    }
  }
});
const globs = z.array(glob);
/**
 * A module specifier, not a path: `@vendor/sdk` (subpaths match) or a prefix ending in `*`, such as
 * `node:*`. Any other `*` would be compared literally and match nothing, so it stops the run.
 */
const specifier = text.refine((value) => !value.slice(0, -1).includes('*'), {
  message: 'only a trailing * is supported, as in "node:*"; a * anywhere else is not a wildcard',
});
const specifierList = z.array(specifier);
const why = z.string().min(1).optional();

const Group = z.strictObject({
  include: globs.min(1),
  exclude: globs.default([]),
  /** A group that matches no file is reported, since a renamed folder would turn its rules off. */
  allowEmpty: z.boolean().default(false),
});

const TypeOnly = z.enum(['allow', 'forbid']);

const ForbiddenImport = z.strictObject({
  rule: z.literal('forbidden-import'),
  group: text,
  /** Package names (subpaths match) or prefixes ending in `*`, such as `node:*`. */
  specifiers: specifierList.default([]),
  /** Repository globs that the group may not reach through relative imports. */
  paths: globs.default([]),
  /**
   * Repository globs carved out of `paths`, such as a library's public entry. An entry that no
   * import of the group uses is reported as stale-allow.
   */
  except: globs.default([]),
  /** `allow`: type-only imports are not checked and not followed, since they bring no code. */
  typeOnly: TypeOnly.default('forbid'),
  /** Follow relative imports into every file the group reaches, inside the repository. */
  transitive: z.boolean().default(true),
  /** Bare specifiers that resolve outside node_modules (virtual modules, aliases): not reported as unresolved. */
  external: specifierList.default([]),
  why,
});

const SingleImporter = z.strictObject({
  rule: z.literal('single-importer'),
  group: text,
  package: specifier,
  /** The only files of the group that may import the package's values. */
  allow: globs,
  /** `allow`: any file may import the package's types. */
  typeOnly: TypeOnly.default('allow'),
  why,
});

const SingleReader = z.strictObject({
  rule: z.literal('single-reader'),
  group: text,
  variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name'),
  allow: globs,
  why,
});

const SingleString = z.strictObject({
  rule: z.literal('single-string'),
  group: text,
  /** A substring of string and template literals, such as an API host. */
  text,
  allow: globs,
  why,
});

const RelativeExtension = z.strictObject({ rule: z.literal('relative-extension'), group: text, why });
const DynamicImport = z.strictObject({ rule: z.literal('dynamic-import'), group: text, why });

const Rule = z.discriminatedUnion('rule', [ForbiddenImport, SingleImporter, SingleReader, SingleString, RelativeExtension, DynamicImport]);

const Config = z
  .strictObject({
    /** The repository root, relative to the config file. Defaults to the config file's folder. */
    root: z.string().optional(),
    ignore: globs.default([...DEFAULT_IGNORE]),
    groups: z.record(text, Group),
    rules: z.array(Rule).min(1),
  })
  .superRefine((config, ctx) => {
    config.rules.forEach((rule, i) => {
      if (!Object.hasOwn(config.groups, rule.group)) {
        ctx.addIssue({ code: 'custom', path: ['rules', i, 'group'], message: `unknown group "${rule.group}"` });
      }
      if (rule.rule === 'forbidden-import' && rule.specifiers.length === 0 && rule.paths.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['rules', i], message: 'a forbidden-import rule needs specifiers or paths' });
      }
      if (rule.rule === 'forbidden-import' && rule.except.length > 0 && rule.paths.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['rules', i, 'except'], message: 'except narrows paths, and this rule has none' });
      }
    });
  });

export type FencesConfigInput = z.input<typeof Config>;
export type FencesConfig = z.output<typeof Config>;
export type RuleConfig = FencesConfig['rules'][number];
export type GroupConfig = FencesConfig['groups'][string];

/** Identity at runtime; gives a config file its types. */
export function defineConfig(config: FencesConfigInput): FencesConfigInput {
  return config;
}

export function parseConfig(value: unknown): FencesConfig {
  const result = Config.safeParse(value);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(`invalid config:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Where the committed JSON Schema of a JSON config is published. */
export const CONFIG_SCHEMA_URL = 'https://raw.githubusercontent.com/Fedemedinilla/applied-ai-toolkit/main/import-fences/schema/config.schema.json';

/**
 * The JSON Schema (draft 2020-12) of a JSON config, generated from the zod schema above so the two
 * cannot drift; schema/config.schema.json is this value, and a test compares them. It describes
 * what a config file may hold before defaults are filled, plus the `$schema` key an editor reads.
 * The three cross-field checks of the CLI (a rule names a known group, a forbidden-import rule has
 * specifiers or paths, except needs paths) are not expressible here and stay with the CLI.
 */
export function configJsonSchema(): Record<string, unknown> {
  const { $schema, ...generated } = z.toJSONSchema(Config, { io: 'input' }) as Record<string, unknown>;
  const properties = (generated['properties'] ?? {}) as Record<string, unknown>;
  return {
    $schema,
    $id: CONFIG_SCHEMA_URL,
    title: 'import-fences config',
    ...generated,
    properties: { $schema: { type: 'string', description: 'The address of this schema, for editors. The CLI ignores it.' }, ...properties },
  };
}

/** A JSON config: the object a module would export, with an optional `$schema` key for editors. */
function readJsonConfig(absolute: string): unknown {
  const value: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const { $schema: _schema, ...config } = value as Record<string, unknown>;
  return config;
}

/**
 * Loads a config and returns it with its root resolved to an absolute path. A path ending in .json
 * is read as JSON; anything else is imported as a module whose default export is the config.
 */
export async function loadConfig(path: string): Promise<{ config: FencesConfig; root: string }> {
  const absolute = resolve(path);
  let value: unknown;
  if (absolute.endsWith('.json')) {
    try {
      value = readJsonConfig(absolute);
    } catch (error) {
      throw new ConfigError(`cannot load ${path}: ${(error as Error).message}`);
    }
  } else {
    let module: { default?: unknown };
    try {
      module = (await import(pathToFileURL(absolute).href)) as { default?: unknown };
    } catch (error) {
      throw new ConfigError(`cannot load ${path}: ${(error as Error).message}`);
    }
    if (module.default === undefined) throw new ConfigError(`${path} has no default export`);
    value = module.default;
  }
  const config = parseConfig(value);
  return { config, root: resolve(dirname(absolute), config.root ?? '.') };
}
