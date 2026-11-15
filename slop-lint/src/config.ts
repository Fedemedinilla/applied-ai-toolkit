/**
 * The config file as data: its shape, the hand-written validator, and how its settings resolve
 * for one file. Nothing here touches the file system (config-file.ts finds and reads the file),
 * so the same value gives the same answer everywhere.
 *
 * The validator is written by hand because this package has no runtime dependency.
 * schema/config.schema.json describes the same shape for editors, and test/config-schema.test.ts
 * runs both over one fixture set so they cannot drift apart.
 */
import { globProblem, matchesAny } from './glob.ts';
import { RULES } from './rules.ts';
import type { Format, Lang, Level, PatternRule, Rule, RuleLang, Severity } from './types.ts';

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
  const record = object(value, path, ['files', 'lang', 'format', 'anchors', 'ruleSettings'], ['files']);
  const files = list(record['files'], join(path, 'files'), glob);
  if (files.length === 0) throw new ConfigError(join(path, 'files'), 'must hold at least one pattern');
  const out: OverrideConfig = { files };
  if ('lang' in record) out.lang = oneOf(record['lang'], join(path, 'lang'), LANGS);
  if ('format' in record) out.format = oneOf(record['format'], join(path, 'format'), FORMATS);
  if ('anchors' in record) out.anchors = list(record['anchors'], join(path, 'anchors'), text);
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
  const known = ['$schema', 'lang', 'format', 'anchors', 'ignore', 'ruleSettings', 'rules', 'overrides', 'suppressions'];
  const record = object(value, '', known);
  const config: Config = {};
  if ('$schema' in record) {
    if (typeof record['$schema'] !== 'string') throw new ConfigError('$schema', 'must be a string');
    config.$schema = record['$schema'];
  }
  if ('lang' in record) config.lang = oneOf(record['lang'], 'lang', LANGS);
  if ('format' in record) config.format = oneOf(record['format'], 'format', FORMATS);
  if ('anchors' in record) config.anchors = list(record['anchors'], 'anchors', text);
  if ('ignore' in record) config.ignore = list(record['ignore'], 'ignore', glob);
  if ('ruleSettings' in record) config.ruleSettings = ruleSettings(record['ruleSettings'], 'ruleSettings');
  if ('rules' in record) config.rules = list(record['rules'], 'rules', customRule);
  if ('overrides' in record) config.overrides = list(record['overrides'], 'overrides', override);
  if ('suppressions' in record) config.suppressions = suppressions(record['suppressions'], 'suppressions');
  return config;
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
    if (re.test('')) throw new ConfigError(`${path}.pattern`, 'matches the empty string, so it would match everywhere; make at least one character required');
  });
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
  anchors: string[];
  /** The rules that apply, in catalog order with the custom rules after them. Rules set to "off" are left out. */
  rules: Rule[];
  /** Ids of the rules set to "off". */
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
 */
export function settingsFor(config: Config, path: string | undefined, origin: string = 'config file'): Settings {
  let lang = config.lang;
  let format = config.format;
  const anchors = [...(config.anchors ?? [])];
  const settings: Record<string, RuleSetting> = { ...config.ruleSettings };
  for (const o of config.overrides ?? []) {
    if (path === undefined || !matchesAny(o.files, path)) continue;
    if (o.lang !== undefined) lang = o.lang;
    if (o.format !== undefined) format = o.format;
    anchors.push(...(o.anchors ?? []));
    Object.assign(settings, o.ruleSettings);
  }
  const all: Rule[] = [...RULES, ...(config.rules ?? []).map((r) => toRule(r, origin))];
  const rules: Rule[] = [];
  const off: string[] = [];
  for (const rule of all) {
    const setting = settings[rule.id];
    if (setting === 'off') off.push(rule.id);
    else if (setting === undefined) rules.push(rule);
    else rules.push({ ...rule, level: setting.level ?? rule.level, severity: setting.severity ?? rule.severity });
  }
  return { lang, format, anchors, rules, off, suppressions: { ...DEFAULT_SUPPRESSIONS, ...config.suppressions } };
}

/** True when the config's `ignore` globs match the file. Standard input (undefined) is never ignored. */
export function isIgnored(config: Config, path: string | undefined): boolean {
  return path !== undefined && matchesAny(config.ignore ?? [], path);
}
