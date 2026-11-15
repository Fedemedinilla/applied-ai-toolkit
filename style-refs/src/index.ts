/**
 * The public entry of style-refs: the shapes of its data files and the validator that checks them.
 * The data (sources.json, principles/, excerpts/, examples/) is plain JSON next to this folder's
 * README. Nothing here reads a file: the caller loads the JSON and passes it in, so the module has
 * no I/O at runtime and runs anywhere.
 *
 * Phase F0 of the design ships the shapes and empty data. Phase F3 fills the data and adds
 * test/licensing.test.ts, which checks each source's legal status and the excerpt length cap.
 */
import { z } from 'zod';

/** The four genres of the design. slop-lint gains the same list in phase F1. */
export const GENRES = ['cover-letter', 'email', 'follow-up', 'whatsapp'] as const;
export type Genre = (typeof GENRES)[number];

export const LANGS = ['es', 'en'] as const;
export type Lang = (typeof LANGS)[number];

/** A principle declares the registers it applies to, so a casual source never reaches a formal prompt. */
export const REGISTERS = ['formal', 'neutral', 'casual'] as const;
export type Register = (typeof REGISTERS)[number];

/** Legal status of a source in one jurisdiction. `unverified` counts as not free. */
export const LegalStatus = z.enum(['public-domain', 'open-licence', 'protected', 'unverified']);
export type LegalStatus = z.infer<typeof LegalStatus>;

const Id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a kebab-case id');
const Year = z.number().int().min(1500).max(2100);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a YYYY-MM-DD date');

/** One entry of sources.json: a work, or a style guide under an open licence. */
export const Source = z.strictObject({
  id: Id,
  kind: z.enum(['literary', 'guide']),
  author: z.string().min(1),
  work: z.string().min(1),
  published: Year,
  /** Null for a guide written by an institution. */
  authorDied: Year.nullable(),
  /** A translation counts only with the translator's year of death, which sets its own term. */
  translator: z.strictObject({ name: z.string().min(1), died: Year }).optional(),
  status: z.strictObject({ ar: LegalStatus, us: LegalStatus, eu: LegalStatus, es: LegalStatus }),
  licence: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
  /** When the status was last checked against the law or the licence. */
  verified: IsoDate,
});
export type Source = z.infer<typeof Source>;

/** A principle in our own words, with the sources it comes from and how it is checked. */
export const Principle = z.strictObject({
  id: Id,
  lang: z.enum(LANGS),
  genres: z.array(z.enum(GENRES)).min(1),
  registers: z.array(z.enum(REGISTERS)).min(1),
  /** The sentence a prompt shows, word for word. */
  text: z.string().min(1),
  /** How code or a reviewer checks that a rewrite follows it. */
  check: z.string().min(1),
  sources: z.array(Id).min(1),
});
export type Principle = z.infer<typeof Principle>;

/** A short annotated excerpt. Not a few-shot example: it is shown with what it teaches and what not to imitate. */
export const Excerpt = z.strictObject({
  id: Id,
  source: Id,
  lang: z.enum(LANGS),
  text: z.string().min(1),
  teaches: z.string().min(1),
  avoid: z.string().min(1),
});
export type Excerpt = z.infer<typeof Excerpt>;

/** A before and after pair we wrote, over a fictional CV. These are the only few-shot examples. */
export const Example = z.strictObject({
  id: Id,
  genre: z.enum(GENRES),
  lang: z.enum(LANGS),
  variety: z.enum(['rioplatense', 'neutral']).optional(),
  before: z.string().min(1),
  after: z.string().min(1),
  notes: z.string().min(1),
  /** Always true: an example never carries a real person's data. */
  fictional: z.literal(true),
});
export type Example = z.infer<typeof Example>;

/** The data files, as the caller loaded them, each one keyed by its path inside style-refs/. */
export interface RefsData {
  readonly sources: unknown;
  readonly principles: Readonly<Record<string, unknown>>;
  readonly excerpts: Readonly<Record<string, unknown>>;
  readonly examples: Readonly<Record<string, unknown>>;
}

export interface RefsProblem {
  /** The data file, e.g. principles/es.json. */
  readonly file: string;
  /** Where in the file, as a dotted path ('' for the whole file). */
  readonly path: string;
  readonly message: string;
}

const EXAMPLE_FILE = /^examples\/(cover-letter|email|follow-up|whatsapp)\.(es|en)\.json$/;
const LANG_FILE = /^(principles|excerpts)\/(es|en)\.json$/;

/**
 * Checks every data file against its shape, then the links between them: unique ids, each
 * principle and excerpt citing a source that exists, each entry in the file of its language (and
 * genre, for examples). Returns the problems; an empty list means the data is usable.
 */
export function validateRefs(data: RefsData): RefsProblem[] {
  const problems: RefsProblem[] = [];
  const parse = <T>(schema: z.ZodType<T>, file: string, value: unknown): T[] => {
    const result = z.array(schema).safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues) problems.push({ file, path: issue.path.map(String).join('.'), message: issue.message });
    return [];
  };
  const seen = new Map<string, string>();
  const unique = (file: string, entries: ReadonlyArray<{ id: string }>) => {
    entries.forEach((entry, i) => {
      const first = seen.get(entry.id);
      if (first !== undefined) problems.push({ file, path: `${i}.id`, message: `id ${entry.id} is already used in ${first}` });
      else seen.set(entry.id, file);
    });
  };

  const sources = parse(Source, 'sources.json', data.sources);
  unique('sources.json', sources);
  const sourceIds = new Set(sources.map((s) => s.id));
  const cites = (file: string, path: string, id: string) => {
    if (!sourceIds.has(id)) problems.push({ file, path, message: `cites source ${id}, which is not in sources.json` });
  };

  for (const [file, value] of Object.entries(data.principles)) {
    const lang = LANG_FILE.exec(file)?.[2];
    if (!file.startsWith('principles/') || lang === undefined) {
      problems.push({ file, path: '', message: 'a principles file is principles/<es|en>.json' });
      continue;
    }
    const entries = parse(Principle, file, value);
    unique(file, entries);
    entries.forEach((p, i) => {
      if (p.lang !== lang) problems.push({ file, path: `${i}.lang`, message: `lang ${p.lang} in the ${lang} file` });
      p.sources.forEach((id, j) => cites(file, `${i}.sources.${j}`, id));
    });
  }
  for (const [file, value] of Object.entries(data.excerpts)) {
    const lang = LANG_FILE.exec(file)?.[2];
    if (!file.startsWith('excerpts/') || lang === undefined) {
      problems.push({ file, path: '', message: 'an excerpts file is excerpts/<es|en>.json' });
      continue;
    }
    const entries = parse(Excerpt, file, value);
    unique(file, entries);
    entries.forEach((e, i) => {
      if (e.lang !== lang) problems.push({ file, path: `${i}.lang`, message: `lang ${e.lang} in the ${lang} file` });
      cites(file, `${i}.source`, e.source);
    });
  }
  for (const [file, value] of Object.entries(data.examples)) {
    const match = EXAMPLE_FILE.exec(file);
    if (match === null) {
      problems.push({ file, path: '', message: 'an examples file is examples/<genre>.<es|en>.json' });
      continue;
    }
    const entries = parse(Example, file, value);
    unique(file, entries);
    entries.forEach((e, i) => {
      if (e.genre !== match[1]) problems.push({ file, path: `${i}.genre`, message: `genre ${e.genre} in the ${match[1]} file` });
      if (e.lang !== match[2]) problems.push({ file, path: `${i}.lang`, message: `lang ${e.lang} in the ${match[2]} file` });
    });
  }
  return problems;
}
