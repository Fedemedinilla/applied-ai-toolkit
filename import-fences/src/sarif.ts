/**
 * The check result as SARIF 2.1.0, for GitHub code scanning and other SARIF viewers. --sarif
 * prints it. This module only builds the log: the same result gives the same bytes.
 *
 * Every violation is one result with level "error", since every violation fails the CLI. A
 * violation in code points at the importing file, line and column. empty-group and stale-allow are
 * about the config itself, so they point at the config file, with no region: the checker knows
 * which entry is stale, not which line of the file holds it.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CheckResult, RuleId, Violation } from './check.ts';

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const INFORMATION_URI = 'https://github.com/Fedemedinilla/applied-ai-toolkit/tree/main/import-fences';
/** The partialFingerprints key. The version changes if the hash input ever does, so old alerts close cleanly. */
export const FINGERPRINT_KEY = 'importFencesViolation/v1';

interface RuleText {
  readonly name: string;
  readonly short: string;
  readonly full: string;
}

/** One SARIF rule per id the checker reports, in a fixed order, so ruleIndex is stable. */
export const RULES: Readonly<Record<RuleId, RuleText>> = {
  'forbidden-import': {
    name: 'ForbiddenImport',
    short: 'A file of the group reaches a package or a path the config forbids',
    full: 'A forbidden-import rule walks relative imports from every file of its group and reports the line that imports a forbidden package or path, with the chain of files that led there.',
  },
  'unresolved-import': {
    name: 'UnresolvedImport',
    short: 'The walk of a forbidden-import rule cannot follow an import',
    full: 'A computed import(), a relative path that names no file, or a bare specifier that is neither a built-in nor an installed package. The walk would stop there without checking what is behind it, so it is reported instead.',
  },
  'single-importer': {
    name: 'SingleImporter',
    short: 'A file outside the allow list imports the fenced package',
    full: 'A single-importer rule names the only files that may import the values of one package, such as the one module that creates an API client.',
  },
  'no-reexport': {
    name: 'NoReexport',
    short: 'A file hands a value of the fenced package to its importers',
    full: 'A re-export of a single-importer package opens a second way in: other files get the value without importing the package. Reported for every file of the group, allowed or not.',
  },
  'single-reader': {
    name: 'SingleReader',
    short: 'A file outside the allow list names the fenced environment variable',
    full: 'A single-reader rule names the only files that may read one environment variable. Every identifier or exact string with the variable name counts as a read.',
  },
  'single-string': {
    name: 'SingleString',
    short: 'A file outside the allow list contains the fenced text in a string',
    full: 'A single-string rule names the only files whose string and template literals may contain a text, such as an API host.',
  },
  'relative-extension': {
    name: 'RelativeExtension',
    short: 'A relative import does not name an existing file with its extension',
    full: 'Node does not resolve ./x to ./x.ts the way a bundler does. A relative import without an extension, one that names a folder, or one that names a file that does not exist is reported.',
  },
  'dynamic-import': {
    name: 'DynamicImport',
    short: 'A computed import that a bundler turns into a glob',
    full: 'import(), require() and new URL(x, import.meta.url) with a computed argument, and import.meta.glob(): a bundler includes every file that matches, and the fences cannot follow it.',
  },
  'stale-allow': {
    name: 'StaleAllow',
    short: 'An allow or except entry of the config matches nothing that still needs it',
    full: 'An exception nobody uses would let a file start crossing the fence later without review. The entry is reported so it leaves the config.',
  },
  'empty-group': {
    name: 'EmptyGroup',
    short: 'A group of the config matches no file',
    full: 'A group that matches no file leaves its rules checking nothing, which is what a renamed folder does. Set allowEmpty on a group kept for code that does not exist yet.',
  },
};

const RULE_IDS = Object.keys(RULES) as RuleId[];

export interface SarifRegion {
  readonly startLine: number;
  readonly startColumn: number;
}

export interface SarifResult {
  readonly ruleId: RuleId;
  readonly ruleIndex: number;
  readonly level: 'error';
  readonly message: { readonly text: string };
  readonly locations: ReadonlyArray<{
    readonly physicalLocation: { readonly artifactLocation: { readonly uri: string }; readonly region?: SarifRegion };
  }>;
  readonly partialFingerprints: Readonly<Record<string, string>>;
}

export interface SarifLog {
  readonly $schema: string;
  readonly version: '2.1.0';
  readonly runs: ReadonlyArray<{
    readonly tool: {
      readonly driver: {
        readonly name: 'import-fences';
        readonly informationUri: string;
        readonly rules: ReadonlyArray<{
          readonly id: RuleId;
          readonly name: string;
          readonly shortDescription: { readonly text: string };
          readonly fullDescription: { readonly text: string };
          readonly helpUri: string;
          readonly defaultConfiguration: { readonly level: 'error' };
        }>;
      };
    };
    readonly columnKind: 'utf16CodeUnits';
    readonly results: readonly SarifResult[];
  }>;
}

export interface SarifOptions {
  /** The root the violations' paths are relative to, as loadConfig returns it. */
  readonly root: string;
  /** The config file of the run. empty-group and stale-allow point at it. */
  readonly configPath: string;
  /** The folder result paths are relative to, usually the repository root. Default: the current folder. */
  readonly base?: string;
}

/**
 * A path as a SARIF artifact URI: relative to `base` with forward slashes, each segment
 * percent-encoded. A file outside `base` gets an absolute file: URI, since a relative one starting
 * with ../ would point outside the repository that code scanning maps results to.
 */
export function artifactUri(absolute: string, base: string): string {
  const rel = relative(base, absolute);
  if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..') return pathToFileURL(absolute).href;
  return rel.split(sep).map(encodeURIComponent).join('/');
}

/** The text of a result: the reason, then the rule's why, as the text report prints them. */
export function messageOf(violation: Violation): string {
  return `${violation.reason}${violation.why === undefined ? '' : `. Why: ${violation.why}`}`;
}

/** Code-unit order, the same on every machine; localeCompare depends on the locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function toSarif(result: CheckResult, { root, configPath, base = process.cwd() }: SarifOptions): SarifLog {
  const baseDir = resolve(base);
  const configUri = artifactUri(resolve(configPath), baseDir);
  const draft = result.violations.map((v) => {
    // Line 0 marks a violation about the config itself (empty-group, stale-allow).
    const inCode = v.line > 0;
    const uri = inCode ? artifactUri(resolve(root, v.file), baseDir) : configUri;
    const region: SarifRegion | undefined = inCode ? { startLine: v.line, startColumn: Math.max(1, v.column) } : undefined;
    return { violation: v, uri, region };
  });
  draft.sort(
    (a, b) =>
      compare(a.uri, b.uri) ||
      (a.region?.startLine ?? 0) - (b.region?.startLine ?? 0) ||
      (a.region?.startColumn ?? 0) - (b.region?.startColumn ?? 0) ||
      compare(a.violation.rule, b.violation.rule) ||
      compare(messageOf(a.violation), messageOf(b.violation)),
  );
  // The fingerprint holds the rule, the file and the reason, and no line, column or why: code added
  // above an import, or a reworded why, keeps the alert. Two violations with the same key (the same
  // import written twice in one file) are told apart by their order, as GitHub's own fingerprints
  // are (hash:1, hash:2).
  const seen = new Map<string, number>();
  const results: SarifResult[] = draft.map(({ violation, uri, region }) => {
    const hash = createHash('sha256').update([violation.rule, uri, violation.reason].join('\n')).digest('hex').slice(0, 32);
    const n = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, n);
    return {
      ruleId: violation.rule,
      ruleIndex: RULE_IDS.indexOf(violation.rule),
      level: 'error',
      message: { text: messageOf(violation) },
      locations: [{ physicalLocation: { artifactLocation: { uri }, ...(region === undefined ? {} : { region }) } }],
      partialFingerprints: { [FINGERPRINT_KEY]: `${hash}:${n}` },
    };
  });
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'import-fences',
            informationUri: INFORMATION_URI,
            rules: RULE_IDS.map((id) => ({
              id,
              name: RULES[id].name,
              shortDescription: { text: RULES[id].short },
              fullDescription: { text: RULES[id].full },
              helpUri: `${INFORMATION_URI}#rule-reference`,
              defaultConfiguration: { level: 'error' as const },
            })),
          },
        },
        columnKind: 'utf16CodeUnits',
        results,
      },
    ],
  };
}
