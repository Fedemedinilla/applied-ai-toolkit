/**
 * The config file as data: its shape, the hand-written validator, and how its settings resolve
 * for one file. Nothing here touches the file system (config-file.ts finds and reads the file),
 * so the same value gives the same answer everywhere.
 *
 * The validator is written by hand because this package has no runtime dependency.
 * schema/config.schema.json describes the same shape for editors, and test/config-schema.test.ts
 * runs both over one fixture set so they cannot drift apart.
 */
import { addedRules, applySetting, GENRE_PROFILES, GENRES, SPLIT_PART_IDS, splitRule } from './genres.ts';
import { globProblem, matchesAny } from './glob.ts';
import { messageFor } from './messages.ts';
import { GENRE_RULES, RULES } from './rules.ts';
import type { Format, Genre, Lang, Level, PatternRule, Rule, RuleLang, Severity, Variety } from './types.ts';

export const CONFIG_FILE = 'slop-lint.config.json';

/** A custom rule's id starts with this, so it can never take the id of a built-in rule, today's or a later one. */
export const CUSTOM_PREFIX = 'X-';
const CUSTOM_ID = /^X-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;
/** g and u are always on: lint() uses matchAll, and every catalog pattern is written for u. */
const ALLOWED_FLAGS = 'gimsu';

/** 'off' removes the rule; an object changes its level, its severity or both. */
export type RuleSetting = 'off' | { level?: Level; severity?: Severity };

export interface CustomRuleConfig {
  id: string;
  /** Short name for --list-rules and SARIF. The id when left out. */
  name?: string;
  message: string;
  suggestion: string;
  lang: RuleLang;
  level: Level;
  severity: Severity;
  /** Regex source, as `new RegExp(pattern, flags)` takes it. */
  pattern: string;
  /** Any of g, i, m, s, u. "giu" when left out; g and u are added when missing. */
  flags?: string;
}

export interface OverrideConfig {
  files: string[];
  lang?: Lang;
  format?: Format;
  genre?: Genre;
  variety?: Variety;
  anchors?: string[];
  ruleSettings?: Record<string, RuleSetting>;
}

export interface SuppressionConfig {
  /** Lets an inline directive suppress a rule whose severity is disqualify. False when left out. */
  allowDisqualify?: boolean;
  /** Honors the directives without a rule id, which mask a span from every rule. True when left out. */
  mask?: boolean;
  /** Makes the CLI exit 1 on an unused, refused or invalid directive. False when left out. */
  failOnProblems?: boolean;
}

export interface Config {
  $schema?: string;
  lang?: Lang;
  format?: Format;
  /** The genre of every file when --genre is not given. 'cover-letter' when left out. */
  genre?: Genre;
  /** The Spanish variety when --variety is not given. */
  variety?: Variety;
  anchors?: string[];
  ignore?: string[];
  ruleSettings?: Record<string, RuleSetting>;
  rules?: CustomRuleConfig[];
  overrides?: OverrideConfig[];
  suppressions?: SuppressionConfig;
}

/** A config value that cannot be used. The message starts with the key path: `rules[0].flags: ...`. */
export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(path === '' ? problem : `${path}: ${problem}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

const LANGS: readonly Lang[] = ['en', 'es'];
const RULE_LANGS: readonly RuleLang[] = ['en', 'es', 'both'];
const FORMATS: readonly Format[] = ['text', 'markdown'];
const VARIETIES: readonly Variety[] = ['rioplatense', 'neutral'];
const LEVELS: readonly Level[] = [1, 2, 3];
const SEVERITIES: readonly Severity[] = ['disqualify', 'high', 'medium', 'low'];

const show = (values: readonly (string | number)[]): string => values.map((v) => (typeof v === 'string' ? `"${v}"` : String(v))).join(', ');
const join = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

function object(value: unknown, path: string, known: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConfigError(path, 'must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) throw new ConfigError(join(path, key), `unknown key; the known keys are ${known.join(', ')}`);
  }
  for (const key of required) {
    if (!(key in record)) throw new ConfigError(join(path, key), 'is required');
  }
  return record;
}

function oneOf<T extends string | number>(value: unknown, path: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new ConfigError(path, `must be one of ${show(allowed)}`);
  return value as T;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ConfigError(path, 'must be a string');
  if (value === '') throw new ConfigError(path, 'must not be empty');
  return value;
}

/** An anchor term: a string with at least one character that is not whitespace, as --anchors keeps them. */
function anchor(value: unknown, path: string): string {
  const term = text(value, path);
  if (term.trim() === '') throw new ConfigError(path, 'must hold a character other than whitespace; a blank anchor would count in every sentence');
  return term;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(path, 'must be true or false');
  return value;
}

function list<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new ConfigError(path, 'must be an array');
  return value.map((v, i) => item(v, `${path}[${i}]`));
}

function glob(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ConfigError(path, 'must be a string');
  const problem = globProblem(value);
  if (problem !== undefined) throw new ConfigError(path, problem);
  return value;
}

function ruleSettings(value: unknown, path: string): Record<string, RuleSetting> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConfigError(path, 'must be an object');
  // No prototype: JSON.parse leaves "__proto__" an own key, and on a plain object assigning it would
  // set the prototype instead, so the key would vanish before the unknown-id check sees it.
  const out = Object.create(null) as Record<string, RuleSetting>;
  for (const [id, raw] of Object.entries(value)) {
    const at = join(path, id);
    if (raw === 'off') {
      out[id] = 'off';
      continue;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ConfigError(at, 'must be "off" or an object with level, severity or both');
    const record = object(raw, at, ['level', 'severity']);
    const setting: { level?: Level; severity?: Severity } = {};
    if ('level' in record) setting.level = oneOf(record['level'], join(at, 'level'), LEVELS);
    if ('severity' in record) setting.severity = oneOf(record['severity'], join(at, 'severity'), SEVERITIES);
    if (setting.level === undefined && setting.severity === undefined) throw new ConfigError(at, 'must set level, severity or both');
    out[id] = setting;
  }
  return out;
}

function customRule(value: unknown, path: string): CustomRuleConfig {
  const known = ['id', 'name', 'message', 'suggestion', 'lang', 'level', 'severity', 'pattern', 'flags'];
  const record = object(value, path, known, ['id', 'message', 'suggestion', 'lang', 'level', 'severity', 'pattern']);
  const id = text(record['id'], join(path, 'id'));
  if (!CUSTOM_ID.test(id)) {
    throw new ConfigError(join(path, 'id'), `must start with ${CUSTOM_PREFIX} and hold capitals, digits and hyphens, such as X-SYNERGY; the prefix keeps it apart from the built-in ids`);
  }
  const rule: CustomRuleConfig = {
    id,
    message: text(record['message'], join(path, 'message')),
    suggestion: text(record['suggestion'], join(path, 'suggestion')),
    lang: oneOf(record['lang'], join(path, 'lang'), RULE_LANGS),
    level: oneOf(record['level'], join(path, 'level'), LEVELS),
    severity: oneOf(record['severity'], join(path, 'severity'), SEVERITIES),
    pattern: text(record['pattern'], join(path, 'pattern')),
  };
  if ('name' in record) rule.name = text(record['name'], join(path, 'name'));
  if ('flags' in record) {
    const flags = record['flags'];
    if (typeof flags !== 'string') throw new ConfigError(join(path, 'flags'), 'must be a string');
    const bad = [...flags].find((f) => !ALLOWED_FLAGS.includes(f));
    if (bad !== undefined) throw new ConfigError(join(path, 'flags'), `has the flag ${bad}; only ${[...ALLOWED_FLAGS].join(', ')} are supported`);
    rule.flags = flags;
  }
  return rule;
}

function override(value: unknown, path: string): OverrideConfig {
  const record = object(value, path, ['files', 'lang', 'format', 'genre', 'variety', 'anchors', 'ruleSettings'], ['files']);
  const files = list(record['files'], join(path, 'files'), glob);
  if (files.length === 0) throw new ConfigError(join(path, 'files'), 'must hold at least one pattern');
  const out: OverrideConfig = { files };
  if ('lang' in record) out.lang = oneOf(record['lang'], join(path, 'lang'), LANGS);
  if ('format' in record) out.format = oneOf(record['format'], join(path, 'format'), FORMATS);
  if ('genre' in record) out.genre = oneOf(record['genre'], join(path, 'genre'), GENRES);
  if ('variety' in record) out.variety = oneOf(record['variety'], join(path, 'variety'), VARIETIES);
  if ('anchors' in record) out.anchors = list(record['anchors'], join(path, 'anchors'), anchor);
  if ('ruleSettings' in record) out.ruleSettings = ruleSettings(record['ruleSettings'], join(path, 'ruleSettings'));
  return out;
}

function suppressions(value: unknown, path: string): SuppressionConfig {
  const record = object(value, path, ['allowDisqualify', 'mask', 'failOnProblems']);
  const out: SuppressionConfig = {};
  for (const key of ['allowDisqualify', 'mask', 'failOnProblems'] as const) {
    if (key in record) out[key] = bool(record[key], join(path, key));
  }
  return out;
}

/** The flags a custom rule compiles with: its own, plus g and u. */
export function customFlags(flags: string | undefined): string {
  let out = flags ?? 'giu';
  for (const needed of 'gu') if (!out.includes(needed)) out += needed;
  return out;
}

/**
 * The shape checks, which schema/config.schema.json states too: keys, types, enums, the id prefix,
 * the flag letters, the glob syntax. Throws a ConfigError that names the key path.
 */
export function validateShape(value: unknown): Config {
  const known = ['$schema', 'lang', 'format', 'genre', 'variety', 'anchors', 'ignore', 'ruleSettings', 'rules', 'overrides', 'suppressions'];
  const record = object(value, '', known);
  const config: Config = {};
  if ('$schema' in record) {
    if (typeof record['$schema'] !== 'string') throw new ConfigError('$schema', 'must be a string');
    config.$schema = record['$schema'];
  }
  if ('lang' in record) config.lang = oneOf(record['lang'], 'lang', LANGS);
  if ('format' in record) config.format = oneOf(record['format'], 'format', FORMATS);
  if ('genre' in record) config.genre = oneOf(record['genre'], 'genre', GENRES);
  if ('variety' in record) config.variety = oneOf(record['variety'], 'variety', VARIETIES);
  if ('anchors' in record) config.anchors = list(record['anchors'], 'anchors', anchor);
  if ('ignore' in record) config.ignore = list(record['ignore'], 'ignore', glob);
  if ('ruleSettings' in record) config.ruleSettings = ruleSettings(record['ruleSettings'], 'ruleSettings');
  if ('rules' in record) config.rules = list(record['rules'], 'rules', customRule);
  if ('overrides' in record) config.overrides = list(record['overrides'], 'overrides', override);
  if ('suppressions' in record) config.suppressions = suppressions(record['suppressions'], 'suppressions');
  return config;
}

/**
 * Whether the pattern, with its lookarounds, \b, \B, ^ and $ removed, matches the empty text.
 * Assertions only ever narrow where a pattern matches, so a pattern that can match empty anywhere
 * still matches empty once they are gone. A source that no longer compiles after the cut (a
 * back-reference into a removed lookaround) gives false and is left to the probe texts.
 */
function matchesEmptyWithoutAssertions(source: string, flags: string): boolean {
  let out = '';
  let i = 0;
  // Index just past the class that starts at `from` ("[").
  const classEnd = (from: number): number => {
    let j = from + 1;
    while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
    return j + 1;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      const next = source[i + 1];
      if (next !== 'b' && next !== 'B') out += source.slice(i, i + 2);
      i += 2;
    } else if (c === '[') {
      const end = classEnd(i);
      out += source.slice(i, end);
      i = end;
    } else if (c === '^' || c === '$') {
      i++;
    } else if (/^\(\?(?:=|!|<=|<!)/u.test(source.slice(i))) {
      // Skip to the parenthesis that closes this lookaround.
      let depth = 0;
      let j = i;
      while (j < source.length) {
        const d = source[j];
        if (d === '\\') j += 2;
        else if (d === '[') j = classEnd(j);
        else {
          if (d === '(') depth++;
          else if (d === ')' && --depth === 0) break;
          j++;
        }
      }
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  try {
    return new RegExp(`^(?:${out})$`, flags.replace('g', '')).test('');
  } catch {
    return false;
  }
}

/**
 * The checks a JSON Schema cannot state: every custom regex compiles and cannot match the empty
 * string, custom ids are unique, and every id under ruleSettings names a rule that exists.
 */
export function validateMeaning(config: Config): void {
  const ids = new Set(RULES.map((r) => r.id));
  (config.rules ?? []).forEach((rule, i) => {
    const path = `rules[${i}]`;
    if (ids.has(rule.id)) throw new ConfigError(`${path}.id`, `${rule.id} is defined twice`);
    ids.add(rule.id);
    const flags = customFlags(rule.flags);
    try {
      new RegExp('x', flags);
    } catch {
      throw new ConfigError(`${path}.flags`, `"${rule.flags ?? ''}" is not a valid set of flags; each of ${[...ALLOWED_FLAGS].join(', ')} may appear once`);
    }
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, flags);
    } catch (error) {
      throw new ConfigError(`${path}.pattern`, `does not compile: ${(error as Error).message}`);
    }
    // Such a pattern matches between every two characters of a text, and no match of it has any text to report.
    // lint() drops every empty match, so a pattern that matches empty only at some positions, such as a
    // lookahead or \b, would load and never report. With its assertions taken out, such a pattern
    // matches the empty text, whatever the lookahead holds (`(?=[Ss]ynergy)`). A few probe texts stay
    // as a second net for what that misses, such as a back-reference to an empty group.
    const probes = ['', ' ', 'a', 'a b.', 'Ab 1, c-d.\n', rule.pattern];
    if (matchesEmptyWithoutAssertions(rule.pattern, flags) || probes.some((probe) => [...probe.matchAll(re)].some((m) => m[0] === ''))) {
      throw new ConfigError(`${path}.pattern`, 'matches the empty string, so it would match everywhere or report nothing; make at least one character required');
    }
  });
  // A split part such as FMT-01-LIST can be set on its own; custom ids start with X-, so they cannot collide.
  for (const id of SPLIT_PART_IDS) ids.add(id);
  // So can a rule only some genres run, such as MAIL-01; in a genre that does not run it, the setting changes nothing.
  for (const rule of GENRE_RULES) ids.add(rule.id);
  const check = (settings: Record<string, RuleSetting> | undefined, path: string): void => {
    for (const id of Object.keys(settings ?? {})) {
      if (!ids.has(id)) throw new ConfigError(join(path, id), 'is not the id of a built-in rule or of a rule under rules; --list-rules prints every id');
    }
  };
  check(config.ruleSettings, 'ruleSettings');
  (config.overrides ?? []).forEach((o, i) => check(o.ruleSettings, `overrides[${i}].ruleSettings`));
}

/** Validates a parsed config file. Throws a ConfigError whose message starts with the key path. */
export function validateConfig(value: unknown): Config {
  const config = validateShape(value);
  validateMeaning(config);
  return config;
}

/** True for the id of a rule that came from a config file. */
export const isCustomId = (id: string): boolean => id.startsWith(CUSTOM_PREFIX);

/**
 * A custom rule as the engine reads it. Level 1 is always reported and fails the run, level 2 is
 * reported with no budget, and level 3 is a context word: it passes in a sentence with an anchor
 * and otherwise joins the Tier 2 budget, as the built-in level 3 rules do.
 */
export function toRule(custom: CustomRuleConfig, origin: string = 'config file'): PatternRule {
  const langs: Lang[] = custom.lang === 'both' ? ['en', 'es'] : [custom.lang];
  return {
    kind: 'pattern',
    id: custom.id,
    name: custom.name ?? custom.id,
    lang: custom.lang,
    level: custom.level,
    severity: custom.severity,
    message: custom.message,
    suggestion: custom.suggestion,
    source: { evidence: [], ref: origin, section: '' },
    patterns: Object.fromEntries(langs.map((l) => [l, custom.pattern])),
    flags: customFlags(custom.flags),
    examples: [],
  };
}

/** What a config file says for one file, before the command line has its say. */
export interface Settings {
  lang: Lang | undefined;
  format: Format | undefined;
  /** The genre whose profile the rules hold: the one passed in, else the config's, else 'cover-letter'. */
  genre: Genre;
  variety: Variety | undefined;
  anchors: string[];
  /** The rules that apply, in catalog order with the custom rules after them. Rules set to "off" are left out. */
  rules: Rule[];
  /** Ids of the rules set to "off", by the config or by the genre's profile. */
  off: string[];
  suppressions: Required<SuppressionConfig>;
}

export const DEFAULT_SUPPRESSIONS: Required<SuppressionConfig> = { allowDisqualify: false, mask: true, failOnProblems: false };

/**
 * The settings for one file. `path` is the file's path relative to the folder of the config file,
 * with forward slashes; undefined for standard input and for a file outside that folder, which
 * match no glob and get the top-level settings.
 *
 * Every override whose `files` match applies, in the order written, so a later one wins. `lang`
 * and `format` replace, `anchors` are added to the top-level ones, and a rule's setting replaces
 * the earlier setting of that rule as a whole.
 *
 * `flags` holds the command line's --genre and --variety, which win over the config. The genre's
 * profile (genres.ts) applies to the catalog first, and a rule's setting in the config replaces
 * the profile's setting for that rule as a whole, so the config wins over the genre.
 */
export function settingsFor(config: Config, path: string | undefined, origin: string = 'config file', flags: { genre?: Genre; variety?: Variety } = {}): Settings {
  let lang = config.lang;
  let format = config.format;
  let genre = config.genre;
  let variety = config.variety;
  const anchors = [...(config.anchors ?? [])];
  const settings: Record<string, RuleSetting> = { ...config.ruleSettings };
  for (const o of config.overrides ?? []) {
    if (path === undefined || !matchesAny(o.files, path)) continue;
    if (o.lang !== undefined) lang = o.lang;
    if (o.format !== undefined) format = o.format;
    if (o.genre !== undefined) genre = o.genre;
    if (o.variety !== undefined) variety = o.variety;
    anchors.push(...(o.anchors ?? []));
    Object.assign(settings, o.ruleSettings);
  }
  const resolvedGenre = flags.genre ?? genre ?? 'cover-letter';
  const resolvedVariety = flags.variety ?? variety;
  const profile = GENRE_PROFILES[resolvedGenre].rules;
  const all: Rule[] = [...RULES, ...addedRules(resolvedGenre), ...(config.rules ?? []).map((r) => toRule(r, origin))];
  const rules: Rule[] = [];
  const off: string[] = [];
  for (const rule of all) {
    // The config's setting for a rule replaces the genre's as a whole: the config wins over the genre.
    // A rule the genre splits takes that setting on every part, except a part whose own id is set.
    const parts = splitRule(rule, resolvedGenre);
    const offParts: string[] = [];
    let offByOwnId = false;
    for (const part of parts) {
      const own = part.id === rule.id ? undefined : (settings[part.id] ?? (settings[rule.id] === undefined ? profile[part.id] : undefined));
      const setting = own ?? settings[rule.id] ?? profile[rule.id];
      const applied = applySetting(part, setting);
      if (applied === undefined) {
        offParts.push(part.id);
        if (own !== undefined) offByOwnId = true;
        continue;
      }
      const message = messageFor(applied, resolvedGenre);
      rules.push(message === applied.message ? applied : { ...applied, message });
    }
    // The whole rule turned off by its catalog id is one rule off, as it was before the genre split it.
    if (offParts.length === parts.length && !offByOwnId) off.push(rule.id);
    else off.push(...offParts);
  }
  return { lang, format, genre: resolvedGenre, variety: resolvedVariety, anchors, rules, off, suppressions: { ...DEFAULT_SUPPRESSIONS, ...config.suppressions } };
}

/** True when the config's `ignore` globs match the file. Standard input (undefined) is never ignored. */
export function isIgnored(config: Config, path: string | undefined): boolean {
  return path !== undefined && matchesAny(config.ignore ?? [], path);
}
