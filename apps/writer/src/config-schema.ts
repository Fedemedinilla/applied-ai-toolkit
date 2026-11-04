// The writer's configuration is data: three JSON files under config/, validated here with zod.
// The server parses them when it starts and the Vite build parses them before it writes a file,
// so a category that names a role that does not exist, or an example longer than its own
// category allows, stops the build instead of reaching a prompt.
//
// The browser never imports this file at runtime: it gets the parsed catalog through Vite's
// `define` (vite.config.ts) and imports only the types, which are erased.

import { z } from 'zod';
import { lengthOf } from './checks.ts';

const Id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'a kebab-case id');
const Line = z.string().trim().min(1).max(400);

export const Role = z.strictObject({
  id: Id,
  name: z.string().min(1).max(40),
  description: Line,
  /** The closing line of every draft this role writes. May hold a [COMPLETAR: ...] the user fills. */
  signature: z.string().min(1).max(80),
});

const Frequency = z.enum(['never', 'sometimes', 'usually']);
export const SENSITIVITIES = ['normal', 'high', 'critical'] as const;
export const LANGUAGES = ['es', 'en'] as const;

export const Category = z.strictObject({
  id: Id,
  name: z.string().min(1).max(40),
  purpose: Line,
  roles: z.array(Id).min(1),
  audience: Line,
  tone: Line,
  /** Characters of each language's body, as a reader sees it. Checked in code after every draft. */
  length: z.strictObject({ min: z.int().min(100), max: z.int().max(4000) }),
  sensitivity: z.enum(SENSITIVITIES),
  emoji: z.enum(['none', 'few']),
  /** Spanish always comes first; a bilingual category adds an English version of the same text. */
  languages: z.union([z.tuple([z.literal('es')]), z.tuple([z.literal('es'), z.literal('en')])]),
  cta: z.strictObject({ mode: z.enum(['required', 'optional', 'none']), hint: z.string().min(1).max(120).nullable() }),
  attachments: Frequency,
  photos: Frequency,
  graphics: z.boolean(),
  /** A role id. Null when the author can send without a second reader. */
  reviewer: Id.nullable(),
});

export const Catalog = z.strictObject({
  version: z.string().min(1).max(40),
  roles: z.array(Role).min(1),
  /** How high and critical communications are signed, whoever drafts them. */
  committeeSignature: z.string().min(1).max(80),
  categories: z.array(Category).min(1).max(12),
});

export const School = z.strictObject({
  name: z.string().min(1).max(80),
  /** Must be true: this repository ships no real school. */
  fictional: z.literal(true),
  /** IANA zone of the TODAY line, so "el jueves que viene" resolves against the school's calendar. */
  timeZone: z.string().refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'an IANA time zone'),
  description: Line,
  facts: z.array(Line).min(1).max(20),
  style: z.array(Line).min(1).max(20),
  vocabulary: z.array(z.strictObject({ use: z.string().min(1), avoid: z.array(z.string().min(1)).min(1) })),
});

export const Example = z.strictObject({
  category: Id,
  role: Id,
  title: z.string().min(1).max(120),
  es: z.string().min(1),
  en: z.string().min(1).optional(),
});

export const Examples = z.array(Example).max(8);

export type Role = z.infer<typeof Role>;
export type Category = z.infer<typeof Category>;
export type Catalog = z.infer<typeof Catalog>;
export type School = z.infer<typeof School>;
export type Example = z.infer<typeof Example>;
export type Sensitivity = Category['sensitivity'];
export type Language = (typeof LANGUAGES)[number];

export interface WriterConfig {
  readonly school: School;
  readonly catalog: Catalog;
  readonly examples: readonly Example[];
}

export class ConfigInvalid extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`writer config is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigInvalid';
    this.problems = problems;
  }
}

function duplicates(ids: readonly string[]): string[] {
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

/**
 * Parses the three files and checks what no single schema can: references between them, and
 * that the examples obey the rules the code will check on every draft. Throws ConfigInvalid with
 * one line per problem, each naming the file and the path.
 */
export function parseConfig(raw: { school: unknown; catalog: unknown; examples: unknown }): WriterConfig {
  const problems: string[] = [];
  const parsed = <T>(file: string, schema: z.ZodType<T>, value: unknown): T | null => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues) problems.push(`${file}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return null;
  };
  const school = parsed('school.json', School, raw.school);
  const catalog = parsed('categories.json', Catalog, raw.catalog);
  const examples = parsed('examples.json', Examples, raw.examples);
  if (!school || !catalog || !examples) throw new ConfigInvalid(problems);

  const roleIds = catalog.roles.map((r) => r.id);
  for (const id of duplicates(roleIds)) problems.push(`categories.json: role id "${id}" is used twice`);
  for (const id of duplicates(catalog.categories.map((c) => c.id))) problems.push(`categories.json: category id "${id}" is used twice`);

  catalog.categories.forEach((c, i) => {
    const at = `categories.json: categories.${i} (${c.id})`;
    for (const role of c.roles) if (!roleIds.includes(role)) problems.push(`${at}: unknown role "${role}"`);
    if (c.reviewer !== null && !roleIds.includes(c.reviewer)) problems.push(`${at}: unknown reviewer role "${c.reviewer}"`);
    if (c.length.min >= c.length.max) problems.push(`${at}: length.min ${c.length.min} is not below length.max ${c.length.max}`);
    if (c.sensitivity !== 'normal' && c.emoji !== 'none') problems.push(`${at}: a ${c.sensitivity}-sensitivity category cannot allow emoji`);
    if (c.cta.mode === 'none' && c.cta.hint !== null) problems.push(`${at}: cta.hint is set but cta.mode is "none"`);
    if (c.cta.mode !== 'none' && c.cta.hint === null) problems.push(`${at}: cta.mode "${c.cta.mode}" needs a hint`);
  });

  examples.forEach((e, i) => {
    const at = `examples.json: ${i} (${e.title})`;
    const category = catalog.categories.find((c) => c.id === e.category);
    if (!category) {
      problems.push(`${at}: unknown category "${e.category}"`);
      return;
    }
    if (!category.roles.includes(e.role)) problems.push(`${at}: role "${e.role}" does not write "${e.category}"`);
    const bilingual = category.languages.length === 2;
    if (bilingual !== (e.en !== undefined)) problems.push(`${at}: ${bilingual ? 'a bilingual category needs an "en" text' : 'a Spanish-only category takes no "en" text'}`);
    for (const [lang, text] of [['es', e.es], ['en', e.en]] as const) {
      if (text === undefined) continue;
      const n = lengthOf(text);
      if (n < category.length.min || n > category.length.max) {
        problems.push(`${at}: ${lang} is ${n} characters, outside ${category.length.min} to ${category.length.max} for "${e.category}"`);
      }
    }
  });

  if (problems.length > 0) throw new ConfigInvalid(problems);
  return { school, catalog, examples };
}

/** What the browser needs: names and the attributes it shows on a chip. No prompt text. */
export interface ClientCatalog {
  readonly schoolName: string;
  readonly roles: ReadonlyArray<Pick<Role, 'id' | 'name' | 'description'>>;
  readonly categories: ReadonlyArray<Pick<Category, 'id' | 'name' | 'purpose' | 'roles' | 'length' | 'sensitivity' | 'languages'>>;
}

export function clientCatalog(config: WriterConfig): ClientCatalog {
  return {
    schoolName: config.school.name,
    roles: config.catalog.roles.map(({ id, name, description }) => ({ id, name, description })),
    categories: config.catalog.categories.map(({ id, name, purpose, roles, length, sensitivity, languages }) => ({
      id,
      name,
      purpose,
      roles,
      length,
      sensitivity,
      languages,
    })),
  };
}
