/**
 * The configuration file, csp-guard.config.json or a .ts module with a default export, validated
 * with zod. Relative paths in it resolve against the config file's directory.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const directiveName = z.string().regex(/^[a-z][a-z0-9-]*$/, 'a lowercase directive name');

const expectedDirective = z.union([
  z.array(z.string().min(1)).transform((sources) => ({ sources, hashes: false })),
  z.strictObject({ sources: z.array(z.string().min(1)), hashes: z.boolean().default(false) }),
]);

const cspSource = z.discriminatedUnion('from', [
  /** The `headers` of a vercel.json file. `file` defaults to vercel.json next to the config. */
  z.strictObject({ from: z.literal('vercel-json'), file: z.string().default('vercel.json') }),
  /** The routes of a Vercel Build Output config.json. `file` defaults to config.json in --dir. */
  z.strictObject({ from: z.literal('vercel-output'), file: z.string().optional() }),
  /** A Netlify _headers file. `file` defaults to _headers in the static root. */
  z.strictObject({ from: z.literal('netlify-headers'), file: z.string().optional() }),
  /** A `<meta http-equiv="Content-Security-Policy">` in each HTML page. */
  z.strictObject({ from: z.literal('meta') }),
  /** One literal policy for every page, for hosts configured some other way. */
  z.strictObject({ from: z.literal('literal'), value: z.string() }),
]);

const budget = z
  .strictObject({
    /** A glob over HTML paths relative to the static root, such as "index.html" or "blog/**". */
    pages: z.string().min(1),
    gzipKb: z.number().positive().optional(),
    brotliKb: z.number().positive().optional(),
  })
  .refine((b) => b.gzipKb !== undefined || b.brotliKb !== undefined, 'a budget needs gzipKb, brotliKb or both');

/** A browser version as [major, minor], compared as a tuple: 16.10 is newer than 16.4. */
export type Version = readonly [major: number, minor: number];

/** The first version of each browser that parses regex lookbehind, keyed as in `lookbehind.targets`. */
export const LOOKBEHIND_SUPPORT = {
  chrome: [62, 0], edge: [79, 0], firefox: [78, 0], safari: [16, 4], ios: [16, 4], opera: [49, 0], samsung: [8, 2],
} as const satisfies Record<string, Version>;
export type Browser = keyof typeof LOOKBEHIND_SUPPORT;

/** Negative when a is older than b, zero when equal, positive when newer. */
export const compareVersions = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1];

/**
 * A target version, written "16.4" or "16" (a string, so "16.10" keeps its meaning). A number is
 * accepted for whole versions only, since 16.10 as a number is 16.1. The text is kept for reports.
 */
const version = z
  .union([z.number().int().nonnegative().transform(String), z.string().regex(/^\d+(\.\d+)?$/, 'a version such as "16.4"')])
  .transform((text) => {
    const [major = '0', minor = '0'] = text.split('.');
    return { text, version: [Number(major), Number(minor)] as Version };
  });

export const configSchema = z.strictObject({
  /** URL prefix the site is served under, such as "/app". Stripped when mapping URLs to files. */
  basePath: z.string().regex(/^\//, 'must start with "/"').default('/'),
  /** HTML pages to leave out of every check, as globs relative to the static root. */
  exclude: z.array(z.string()).default([]),
  csp: cspSource.optional(),
  /** The exact policy every page must send. */
  policy: z.record(directiveName, expectedDirective).optional(),
  inline: z
    .strictObject({
      /** "hash": inline styles need a listed hash, like scripts. "skip": styles are not checked. */
      styles: z.enum(['hash', 'skip']).default('hash'),
    })
    .default({ styles: 'hash' }),
  /** Other response headers every page must send, with their exact values. Header sources only. */
  headers: z.record(z.string(), z.string()).optional(),
  secrets: z
    .strictObject({
      /** Names of environment variables whose values must not appear in any output file. */
      env: z.array(z.string().min(1)).min(1),
      /** A value shorter than this would show up by chance, so it fails as unusable. */
      minLength: z.number().int().min(1).default(8),
      /** "fail" (default): a variable that is unset or too short fails the check. "skip": it is reported and skipped. */
      missing: z.enum(['fail', 'skip']).default('fail'),
    })
    .optional(),
  lookbehind: z
    .union([
      z.literal(false),
      z.strictObject({
        /** Browser files to scan, as globs relative to the static root. Inline scripts are always scanned. */
        files: z.array(z.string()).default(['**/*.js', '**/*.mjs']),
        /** Oldest supported version per browser. Omitted: any lookbehind fails. */
        targets: z.partialRecord(z.enum(Object.keys(LOOKBEHIND_SUPPORT) as [Browser, ...Browser[]]), version).optional(),
      }),
    ])
    .default({ files: ['**/*.js', '**/*.mjs'] }),
  /** JS budgets; each page uses the first entry whose glob matches it. */
  budgets: z.array(budget).default([]),
});

export type GuardConfigInput = z.input<typeof configSchema>;
export type GuardConfig = z.output<typeof configSchema> & { readonly configDir: string };

/** Parses an already loaded config object. `configDir` anchors the relative paths. */
export function parseConfig(value: unknown, configDir: string): GuardConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`invalid config:\n  ${issues.join('\n  ')}`);
  }
  return { ...parsed.data, configDir };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Loads a .json file, or imports a .ts/.js/.mjs module and takes its default export. */
export async function loadConfig(path: string): Promise<GuardConfig> {
  const absolute = resolve(path);
  let value: unknown;
  try {
    if (absolute.endsWith('.json')) value = JSON.parse(readFileSync(absolute, 'utf8'));
    else value = ((await import(pathToFileURL(absolute).href)) as { default?: unknown }).default;
  } catch (error) {
    throw new ConfigError(`cannot load config ${path}: ${(error as Error).message}`);
  }
  return parseConfig(value, dirname(absolute));
}
