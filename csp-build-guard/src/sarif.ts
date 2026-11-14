/**
 * The report as SARIF 2.1.0, for GitHub code scanning and other SARIF viewers. --sarif prints it.
 *
 * Every failure of a failing check becomes one result with level "error": the report has no
 * warnings, so neither has the SARIF. A failing check with no failure listed still gets one result,
 * so a check that could not run is never dropped. Skipped checks are not findings; they are listed
 * as notes in the run's invocation, the way the text report lists them as SKIP lines.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CheckId, GuardReport } from './types.ts';

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const INFORMATION_URI = 'https://github.com/Fedemedinilla/applied-ai-toolkit/tree/main/csp-build-guard';
/** The partialFingerprints key. Bump the version if fingerprintKey changes, so old alerts close cleanly. */
export const FINGERPRINT_KEY = 'cspBuildGuardFinding/v1';

interface RuleText {
  readonly name: string;
  readonly short: string;
  readonly full: string;
  /** The README heading that explains the check. */
  readonly anchor: string;
}

/** One rule per check, in the order the report runs them. */
export const RULES: Readonly<Record<CheckId, RuleText>> = {
  'inline-hashes': {
    name: 'InlineHashes',
    short: 'Every inline script and style is allowed by a listed hash, and no listed hash is stale',
    full: "An inline script or style whose hash the policy does not list is blocked by the browser. A listed hash that matches no inline content keeps allowing a script nobody ships. 'unsafe-inline' in a directive that governs inline content also fails.",
    anchor: '1-inline-hashes-inline-hashes',
  },
  policy: {
    name: 'ExactPolicy',
    short: 'Every page is served with exactly the expected Content-Security-Policy',
    full: 'The policy each page receives is compared with the expected one as sets of directives and sources, read the way the browser reads it. An extra source, a missing one, a repeated or dropped directive, or two rules for one page fail.',
    anchor: '2-exact-policy-policy',
  },
  headers: {
    name: 'Headers',
    short: 'Every page is served with the expected values of other response headers',
    full: 'Each header in the config must be set once for every page, with exactly the configured value, by the deploy configuration.',
    anchor: 'other-headers-headers-optional',
  },
  secrets: {
    name: 'Secrets',
    short: 'No value of a named environment variable appears in the build',
    full: 'Every file of the build is searched for the value of each named variable, in plain and encoded forms and inside .gz and .br files. An unset or too short variable fails, since the search could not run.',
    anchor: '3-secrets-secrets',
  },
  lookbehind: {
    name: 'RegexLookbehind',
    short: 'No regex lookbehind in code that an older target browser loads',
    full: 'Safari before 16.4 cannot parse a regex lookbehind, so the whole script or module that holds one fails to load.',
    anchor: '4-regex-lookbehind-lookbehind',
  },
  'js-budget': {
    name: 'JavaScriptBudget',
    short: 'The JavaScript each page loads stays within its budget',
    full: 'Each page is measured with the scripts it loads and their static imports, compressed with gzip and brotli. A page over its budget fails, and so does a script that cannot be measured.',
    anchor: '5-javascript-budget-js-budget',
  },
};

const CHECK_IDS = Object.keys(RULES) as CheckId[];

export interface SarifRegion {
  readonly startLine: number;
  readonly startColumn?: number;
}

export interface SarifResult {
  readonly ruleId: CheckId;
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
        readonly name: 'csp-build-guard';
        readonly informationUri: string;
        readonly rules: ReadonlyArray<{
          readonly id: CheckId;
          readonly name: string;
          readonly shortDescription: { readonly text: string };
          readonly fullDescription: { readonly text: string };
          readonly helpUri: string;
          readonly defaultConfiguration: { readonly level: 'error' };
        }>;
      };
    };
    readonly invocations: ReadonlyArray<{
      readonly executionSuccessful: true;
      readonly toolExecutionNotifications: ReadonlyArray<{
        readonly level: 'note';
        readonly message: { readonly text: string };
        readonly descriptor: { readonly id: CheckId };
      }>;
    }>;
    readonly columnKind: 'utf16CodeUnits';
    readonly results: readonly SarifResult[];
  }>;
}

export interface SarifOptions {
  /** The config file of the run. A failure about no file in the build points at it. */
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

/** Extensions of build assets whose names carry a content hash. */
const ASSET = String.raw`(?:m?js|cjs|css|map|wasm|json|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|avif|ico)(?:\.(?:map|gz|br))*`;
/**
 * A content hash before an asset extension: eight characters of Rollup's alphabet (Vite, Astro),
 * which may hold - and _, or six or more letters, digits and _ (webpack and others). Either form
 * must hold a digit or an uppercase letter, so a plain name such as chunk-vendors.js or
 * about.client.js is kept.
 */
const HASHED_NAME = new RegExp(String.raw`([-.])([A-Za-z0-9_-]{8}|[A-Za-z0-9_]{6,64})(?=\.${ASSET}(?![\w.-]))`, 'g');

/** A path or text with content hashes in asset names replaced by *: index-AbC123de.js is index-*.js. */
export function withoutContentHashes(text: string): string {
  return text.replace(HASHED_NAME, (match, separator: string, hash: string) => (/[0-9A-Z]/.test(hash) ? `${separator}*` : match));
}

/**
 * The stable part of a finding, for its fingerprint. A build tool names chunks after their content
 * (index-AbC123de.js), so the same finding gets a new file name on every change to that chunk; the
 * hash is replaced with *, as in index-*.js. Standalone numbers (line and column, sizes in kB, the
 * page count in "and 3 more pages") are replaced with #, except inside a path such as blog/2024/: they move while the finding stays the same.
 * A count also decides whether the words after it are plural ("1 regex lookbehind", "2 regex
 * lookbehinds"), so a final s in the one or two lowercase words after a # is dropped as well.
 * Hashes of inline content stay, since they name what the finding is about.
 */
export function fingerprintKey(text: string): string {
  return withoutContentHashes(text)
    .replace(/(?<![\w./-])\d+(?:\.\d+)?(?![\w/-])/g, '#')
    .replace(/(#(?: [a-z]+)??) ([a-z]+?)s\b/g, '$1 $2');
}

const LINE_AND_COLUMN = /^:(\d+):(\d+): /;

/** The line and column a failure names after its file, as the lookbehind check writes them. */
function regionOf(message: string, file: string): SarifRegion | undefined {
  if (!message.startsWith(file)) return undefined;
  const match = LINE_AND_COLUMN.exec(message.slice(file.length));
  if (match === null) return undefined;
  return { startLine: Number(match[1]), startColumn: Number(match[2]) };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function toSarif(report: GuardReport, { configPath, base = process.cwd() }: SarifOptions): SarifLog {
  const root = resolve(base);
  const configUri = artifactUri(resolve(configPath), root);
  const draft: Array<Omit<SarifResult, 'partialFingerprints'>> = [];
  for (const check of report.checks) {
    if (check.status !== 'fail') continue;
    const ruleIndex = CHECK_IDS.indexOf(check.id);
    // A failing check always explains itself in its failures; the summary is the fallback.
    const failures = check.failures.length ? check.failures : [{ message: check.summary }];
    for (const failure of failures) {
      const uri = failure.file === undefined ? configUri : artifactUri(resolve(report.dir, failure.file), root);
      const region = failure.file === undefined ? undefined : regionOf(failure.message, failure.file);
      draft.push({
        ruleId: check.id,
        ruleIndex,
        level: 'error',
        message: { text: failure.message },
        locations: [{ physicalLocation: { artifactLocation: { uri }, ...(region === undefined ? {} : { region }) } }],
      });
    }
  }
  const location = (r: (typeof draft)[number]) => r.locations[0]?.physicalLocation;
  draft.sort(
    (a, b) =>
      a.ruleIndex - b.ruleIndex ||
      compare(location(a)?.artifactLocation.uri ?? '', location(b)?.artifactLocation.uri ?? '') ||
      (location(a)?.region?.startLine ?? 0) - (location(b)?.region?.startLine ?? 0) ||
      (location(a)?.region?.startColumn ?? 0) - (location(b)?.region?.startColumn ?? 0) ||
      compare(a.message.text, b.message.text),
  );
  // Two findings with the same stable key are told apart by their order, as GitHub's own
  // fingerprints are (hash:1, hash:2).
  const seen = new Map<string, number>();
  const results: SarifResult[] = draft.map((r) => {
    const key = [r.ruleId, withoutContentHashes(location(r)?.artifactLocation.uri ?? ''), fingerprintKey(r.message.text)].join('\n');
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
    const n = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, n);
    return { ...r, partialFingerprints: { [FINGERPRINT_KEY]: `${hash}:${n}` } };
  });
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'csp-build-guard',
            informationUri: INFORMATION_URI,
            rules: CHECK_IDS.map((id) => ({
              id,
              name: RULES[id].name,
              shortDescription: { text: RULES[id].short },
              fullDescription: { text: RULES[id].full },
              helpUri: `${INFORMATION_URI}#${RULES[id].anchor}`,
              defaultConfiguration: { level: 'error' as const },
            })),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: report.checks
              .filter((c) => c.status === 'skip')
              .map((c) => ({ level: 'note' as const, message: { text: `${c.id} skipped: ${c.summary}` }, descriptor: { id: c.id } })),
          },
        ],
        columnKind: 'utf16CodeUnits',
        results,
      },
    ],
  };
}
