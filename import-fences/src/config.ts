/**
 * The config format. A config is a TypeScript module whose default export goes through
 * defineConfig, so the editor checks it, and it is validated again with zod when the CLI loads it,
 * because a typo in a rule name must stop the run instead of turning a fence off.
 */
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DEFAULT_IGNORE } from './files.ts';

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
const globs = z.array(text);
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
  specifiers: globs.default([]),
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
  external: globs.default([]),
  why,
});

const SingleImporter = z.strictObject({
  rule: z.literal('single-importer'),
  group: text,
  package: text,
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

/** Imports a config module and returns it with its root resolved to an absolute path. */
export async function loadConfig(path: string): Promise<{ config: FencesConfig; root: string }> {
  const absolute = resolve(path);
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(absolute).href)) as { default?: unknown };
  } catch (error) {
    throw new ConfigError(`cannot load ${path}: ${(error as Error).message}`);
  }
  if (module.default === undefined) throw new ConfigError(`${path} has no default export`);
  const config = parseConfig(module.default);
  return { config, root: resolve(dirname(absolute), config.root ?? '.') };
}
