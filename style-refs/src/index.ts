/**
 * The public entry of style-refs: the shapes of its data files and the validator that checks them.
 * The data (sources.json, principles/, excerpts/, examples/) is plain JSON next to this folder's
 * README. Nothing here reads a file: the caller loads the JSON and passes it in, so the module has
 * no I/O at runtime and runs anywhere.
 *
 * Phase F0 of the design shipped the shapes and empty data. Phase F3 adds the licensing rules of
 * design section 4.8 to validateRefs (test/licensing.test.ts tries each one): an excerpt only from a
 * work in the public domain in the United States, where GitHub serves the repository, and published
 * in US_FREE_THROUGH or earlier, from the ebook its source names; no excerpt
 * of an Argentine author while the paid public domain of Decreto-ley 1224/58 is unresolved; a cap
 * of two sentences and a word count; text only from Gutenberg or Wikisource, never naming Project
 * Gutenberg; a translation only with its translator's year of death.
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

/** The jurisdictions every source declares: Argentina, the United States, the European Union, Spain. */
export const JURISDICTIONS = ['ar', 'us', 'eu', 'es'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

/** The evidence tags of the reports this data comes from. A legal status from research is REPORTADO. */
export const EVIDENCE = ['MEDIDO', 'REPORTADO', 'CONSENSO', 'SÍNTESIS'] as const;

/**
 * What a source may give. `excerpts` also allows principles; `principles` means our own words only;
 * `link-only` is a pointer for the reader, never copied or paraphrased into a principle; `excluded`
 * is recorded so nothing can cite it.
 */
export const USES = ['excerpts', 'principles', 'link-only', 'excluded'] as const;
export type Use = (typeof USES)[number];

/** A `do` principle is a lesson for the prompt; an `avoid` entry belongs to the "no imitar" list of design 4.8. */
export const PRINCIPLE_KINDS = ['do', 'avoid'] as const;
export type PrincipleKind = (typeof PRINCIPLE_KINDS)[number];

/** The varieties of Spanish the design names; `rioplatense` brings voseo. */
export const VARIETIES = ['rioplatense', 'neutral'] as const;
export type Variety = (typeof VARIETIES)[number];

/** Design decision D11: an excerpt is at most two sentences and this many words. */
export const EXCERPT_MAX_SENTENCES = 2;
export const EXCERPT_MAX_WORDS = 45;

/**
 * The last year of publication that is free in the United States: since 2026-01-01, what was published
 * in 1930 or earlier (design 4.8, after Duke CSPD). It moves one year each January; raise it then.
 */
export const US_FREE_THROUGH = 1930;

/** Excerpt text comes only from these hosts (and their subdomains), without what they add to it. */
export const TEXT_HOSTS = ['gutenberg.org', 'wikisource.org'] as const;

const Id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a kebab-case id');
const Year = z.number().int().min(1500).max(2100);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a YYYY-MM-DD date');
/** An ISO 639-1 language or ISO 3166-1 country code, lower case; `eu` stands for the European Union. */
const Code = z.string().regex(/^[a-z]{2}$/, 'a two-letter lower-case code');

/** One entry of sources.json: a work, or a style guide under an open licence. */
export const Source = z.strictObject({
  id: Id,
  kind: z.enum(['literary', 'guide']),
  author: z.string().min(1),
  work: z.string().min(1),
  /** Null when the year of publication is unverified. */
  published: Year.nullable(),
  /** Null for a guide written by an institution. */
  authorDied: Year.nullable(),
  /** The language of the text we read, and the language it was written in. They differ for a translation. */
  lang: z.enum(LANGS),
  originalLang: Code,
  /** A translation counts only with the translator's year of death, which sets its own term. */
  translator: z.strictObject({ name: z.string().min(1), died: Year }).optional(),
  /** The author's countries, or the issuing country of a guide. `ar` brings in Decreto-ley 1224/58. */
  nationality: z.array(Code).min(1),
  status: z.strictObject({ ar: LegalStatus, us: LegalStatus, eu: LegalStatus, es: LegalStatus }),
  /** The day a jurisdiction that is not free yet becomes free, e.g. Spain on 2027-01-01. */
  freeFrom: z.partialRecord(z.enum(JURISDICTIONS), IsoDate).optional(),
  /**
   * Whether the paid public domain of Decreto-ley 1224/58 reaches this repository. Required for a
   * work by an Argentine author; while it is not `cleared`, no Argentine source gives excerpts
   * (design decision D12). A guide under an open licence is not in the public domain, so it needs none.
   */
  paidPublicDomain: z.enum(['unresolved', 'cleared']).optional(),
  licence: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
  /** When the status was last checked against the law or the licence. */
  verified: IsoDate,
  /** How the status is known. Nothing here was checked against each law, so it is REPORTADO. */
  evidence: z.enum(EVIDENCE),
  use: z.enum(USES),
  /** Limits the principles that cite this source, as a casual register source never reaches a formal prompt. */
  scope: z.strictObject({ genres: z.array(z.enum(GENRES)).min(1), registers: z.array(z.enum(REGISTERS)).min(1) }).optional(),
  /**
   * The credit line an open licence asks for (OGL v3.0, CC BY 4.0). Required before a source under
   * an open licence gives principles or excerpts; our principles are adapted from it, never copied.
   */
  attribution: z.string().min(1).optional(),
  /** What the source is for and what stays unverified, in plain words. */
  note: z.string().min(1).optional(),
});
export type Source = z.infer<typeof Source>;

/** A slop-lint rule id such as OFI-01 or SIN-EN-01. style-refs imports no other library, so only the form is checked. */
const SlopRuleId = z.string().regex(/^[A-Z]{2,4}(?:-[A-Z]{2})?-\d{2}$/, 'a slop-lint rule id such as OFI-01');

/**
 * A principle in our own words, with the sources it comes from and how it is checked. An `avoid`
 * entry is one item of the "no imitar" list: the rewriter shows its text as a negative constraint
 * (stage S4) and looks for its terms after the rewrite (stage S6). Its sources are the works whose
 * trait it warns against, or that warn against it, so the scope of a casual source does not limit it.
 */
export const Principle = z.strictObject({
  id: Id,
  /** Absent means `do`. */
  kind: z.enum(PRINCIPLE_KINDS).optional(),
  lang: z.enum(LANGS),
  /** Only for that variety of Spanish, e.g. voseo for rioplatense. Absent means every variety. */
  variety: z.enum(VARIETIES).optional(),
  genres: z.array(z.enum(GENRES)).min(1),
  registers: z.array(z.enum(REGISTERS)).min(1),
  /** The sentence a prompt shows, word for word. */
  text: z.string().min(1),
  /** How code or a reviewer checks that a rewrite follows it. */
  check: z.string().min(1),
  /** For an `avoid` entry: words stage S6 looks for, whole and ignoring case. */
  terms: z.array(z.string().min(1)).min(1).optional(),
  /** The slop-lint rules that check the same thing, so the prompt and the linter point at one fault. */
  slopRules: z.array(SlopRuleId).min(1).optional(),
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
  /** What not to imitate: the archaism, the dialect, the tone. */
  avoid: z.string().min(1),
  /** The plain text the excerpt was checked against, word for word, and the day it was fetched. */
  url: z.url({ protocol: /^https$/ }),
  fetched: IsoDate,
});
export type Excerpt = z.infer<typeof Excerpt>;

/** A before and after pair we wrote, over a fictional CV. These are the only few-shot examples. */
export const Example = z.strictObject({
  id: Id,
  genre: z.enum(GENRES),
  lang: z.enum(LANGS),
  variety: z.enum(VARIETIES).optional(),
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
  sources.forEach((s, i) => problems.push(...sourceProblems(s).map((p) => ({ file: 'sources.json', path: `${i}.${p.path}`, message: p.message }))));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const cites = (file: string, path: string, id: string): Source | undefined => {
    const source = byId.get(id);
    if (source === undefined) problems.push({ file, path, message: `cites source ${id}, which is not in sources.json` });
    return source;
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
      if (p.variety !== undefined && p.lang !== 'es') problems.push({ file, path: `${i}.variety`, message: `a variety of Spanish on an ${p.lang} principle` });
      if (p.terms !== undefined && p.kind !== 'avoid') problems.push({ file, path: `${i}.terms`, message: 'only an avoid entry has terms' });
      p.sources.forEach((id, j) => {
        const source = cites(file, `${i}.sources.${j}`, id);
        if (source === undefined) return;
        if (source.use === 'link-only' || source.use === 'excluded') problems.push({ file, path: `${i}.sources.${j}`, message: `${id} is ${source.use}` });
        // An avoid entry warns against the source's trait, so it may name a casual source in a formal register.
        if (source.scope === undefined || p.kind === 'avoid') return;
        const genres = p.genres.filter((g) => !source.scope?.genres.includes(g));
        const registers = p.registers.filter((r) => !source.scope?.registers.includes(r));
        if (genres.length > 0) problems.push({ file, path: `${i}.genres`, message: `${id} is limited to ${source.scope.genres.join(', ')}, and this principle also covers ${genres.join(', ')}` });
        if (registers.length > 0) problems.push({ file, path: `${i}.registers`, message: `${id} is limited to ${source.scope.registers.join(', ')}, and this principle also covers ${registers.join(', ')}` });
      });
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
      const source = cites(file, `${i}.source`, e.source);
      for (const p of excerptProblems(e, source)) problems.push({ file, path: `${i}.${p.path}`, message: p.message });
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

export interface PrincipleQuery {
  readonly lang: Lang;
  readonly genre: Genre;
  readonly register: Register;
  /** Absent means a Spanish text of no particular variety, so only principles with no variety match. */
  readonly variety?: Variety;
  /** Absent returns both lessons and avoid entries. */
  readonly kind?: PrincipleKind;
}

/**
 * The principles a prompt for one text may show, in file order. It checks the scope of each cited
 * source again, so a lesson from a casual source stays out of a formal prompt even when the data
 * skipped validateRefs, and a lesson citing a missing or unusable source is dropped.
 */
export function principlesFor(principles: readonly Principle[], sources: readonly Source[], q: PrincipleQuery): Principle[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return principles.filter((p) => {
    const kind = p.kind ?? 'do';
    if (p.lang !== q.lang || !p.genres.includes(q.genre) || !p.registers.includes(q.register)) return false;
    if (p.variety !== undefined && p.variety !== q.variety) return false;
    if (q.kind !== undefined && kind !== q.kind) return false;
    if (kind === 'avoid') return true;
    return p.sources.every((id) => {
      const s = byId.get(id);
      if (s === undefined || (s.use !== 'principles' && s.use !== 'excerpts')) return false;
      return s.scope === undefined || (s.scope.genres.includes(q.genre) && s.scope.registers.includes(q.register));
    });
  });
}

type Local = { path: string; message: string };

const FREE: ReadonlySet<LegalStatus> = new Set(['public-domain', 'open-licence']);

/** The host of a URL the schema already parsed, and whether it is one of TEXT_HOSTS. */
function textHost(url: string): { host: string; allowed: boolean } {
  const host = new URL(url).hostname.toLowerCase();
  return { host, allowed: TEXT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) };
}

/** The rules of one source on its own: translation, Argentine authors, dates of freedom, text host. */
function sourceProblems(s: Source): Local[] {
  const out: Local[] = [];
  const translated = s.originalLang !== s.lang;
  if (translated && s.translator === undefined) out.push({ path: 'translator', message: `a translation from ${s.originalLang} needs its translator and the year they died` });
  if (!translated && s.translator !== undefined) out.push({ path: 'translator', message: 'the work is read in its original language, so it has no translator' });
  if (s.kind === 'literary' && s.nationality.includes('ar') && s.paidPublicDomain === undefined) out.push({ path: 'paidPublicDomain', message: 'an Argentine author needs paidPublicDomain (Decreto-ley 1224/58)' });
  for (const place of JURISDICTIONS) {
    const from = s.freeFrom?.[place];
    if (from !== undefined && FREE.has(s.status[place])) out.push({ path: `freeFrom.${place}`, message: `free from ${from}, so ${place} cannot be ${s.status[place]} yet` });
  }
  if (s.scope?.registers.includes('casual') === true && s.scope.registers.includes('formal')) {
    out.push({ path: 'scope.registers', message: 'a source scoped to the casual register cannot also reach formal' });
  }
  const open = JURISDICTIONS.some((place) => s.status[place] === 'open-licence');
  if (open && (s.use === 'principles' || s.use === 'excerpts') && s.attribution === undefined) {
    out.push({ path: 'attribution', message: `an open licence asks for attribution, and this source gives ${s.use} without one` });
  }
  if (s.use === 'excerpts' && (s.published === null || s.published > US_FREE_THROUGH)) {
    const year = s.published === null ? 'its year is unverified' : `it is ${s.published}`;
    out.push({ path: 'published', message: `a source for excerpts must be published in ${US_FREE_THROUGH} or earlier to be free in the US, and ${year}` });
  }
  if (s.use === 'excerpts' && s.status.us !== 'public-domain') out.push({ path: 'use', message: `a source for excerpts must be public-domain in the US, and it is ${s.status.us}` });
  if (s.kind === 'literary' && s.use !== 'excluded') {
    const { host, allowed } = textHost(s.url);
    if (!allowed) out.push({ path: 'url', message: `${host} is not ${TEXT_HOSTS.join(' or ')}` });
  }
  return out;
}

/** The ebook number of a gutenberg.org URL (/ebooks/N, /cache/epub/N/, /files/N/), or undefined. */
function gutenbergEbook(url: string): string | undefined {
  const u = new URL(url);
  if (!textHost(url).host.endsWith('gutenberg.org')) return undefined;
  return /^\/(?:ebooks|cache\/epub|files)\/(\d+)(?:[./]|$)/.exec(u.pathname)?.[1];
}

/** Sentences end at . ! ? or an ellipsis, before a space or the end; a closing quote may follow. */
const SENTENCE_END = /[.!?\u2026]+["'\u201d\u2019\u00bb)\]]*(?=\s|$)/g;

/** Counts sentences the way the cap reads them. An abbreviation counts as an end: the cap errs short. */
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  const ends = [...trimmed.matchAll(SENTENCE_END)];
  const last = ends.at(-1);
  const closed = last !== undefined && (last.index ?? 0) + last[0].length === trimmed.length;
  return ends.length + (closed ? 0 : 1);
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w !== '').length;
}

/** The rules of one excerpt against the source it cites (undefined when the source is missing). */
function excerptProblems(e: Excerpt, source: Source | undefined): Local[] {
  const out: Local[] = [];
  if (source !== undefined) {
    if (source.use !== 'excerpts') out.push({ path: 'source', message: source.use === 'principles' ? `${source.id} is for principles only` : `${source.id} is ${source.use}` });
    if (source.use !== 'excluded' && source.status.us !== 'public-domain') out.push({ path: 'source', message: `${source.id} is ${source.status.us} in the US; an excerpt needs public-domain there` });
    if (source.nationality.includes('ar') && source.paidPublicDomain !== 'cleared') {
      out.push({ path: 'source', message: `${source.id} is by an Argentine author and the paid public domain (Decreto-ley 1224/58) is unresolved` });
    }
    if (source.lang !== e.lang) out.push({ path: 'lang', message: `the source ${source.id} is read in ${source.lang}` });
  }
  const sentences = countSentences(e.text);
  if (sentences > EXCERPT_MAX_SENTENCES) out.push({ path: 'text', message: `${sentences} sentences; the cap is ${EXCERPT_MAX_SENTENCES}` });
  const words = countWords(e.text);
  if (words > EXCERPT_MAX_WORDS) out.push({ path: 'text', message: `${words} words; the cap is ${EXCERPT_MAX_WORDS}` });
  if (/gutenberg/i.test(e.text)) out.push({ path: 'text', message: 'names Project Gutenberg; its licence lets the text go only without that name' });
  const { host, allowed } = textHost(e.url);
  if (!allowed) out.push({ path: 'url', message: `${host} is not ${TEXT_HOSTS.join(' or ')}` });
  // A Gutenberg excerpt is checked against the ebook its source names, not a neighbour's text.
  const ebook = gutenbergEbook(e.url);
  const sourceEbook = source === undefined ? undefined : gutenbergEbook(source.url);
  if (ebook !== undefined && sourceEbook !== undefined && ebook !== sourceEbook) {
    out.push({ path: 'url', message: `Gutenberg ebook ${ebook}, and the source ${source?.id} is ebook ${sourceEbook}` });
  }
  return out;
}
