/**
 * SARIF 2.1.0 output, the format GitHub code scanning reads. One log, one run, every input file.
 * The CLI prints it with --sarif; this module only builds it, so the same input gives the same
 * bytes and nothing here touches the file system.
 */
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { RULES } from './rules.ts';
import { DOCUMENT_SCOPE_IDS } from './structural.ts';
import { lineColumn, lineStarts } from './text.ts';
import { DIRECTIVE_RULES, type DirectiveRule } from './suppress.ts';
import type { Finding, Genre, Level, LintResult, Rule, Severity } from './types.ts';

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const INFORMATION_URI = 'https://github.com/Fedemedinilla/applied-ai-toolkit/tree/main/slop-lint';
/** The partialFingerprints key. The version changes if the hash input ever does. */
export const FINGERPRINT_KEY = 'slopLint/v1';

export type SarifLevel = 'error' | 'warning' | 'note';

export interface SarifRegion {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: SarifRegion } }>;
  partialFingerprints: Record<string, string>;
  /** Only on a finding an inline directive suppressed. Absent otherwise, as before directives existed. */
  suppressions?: Array<{ kind: 'inSource'; justification?: string }>;
}

export interface SarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string };
  helpUri?: string;
  defaultConfiguration: { level: SarifLevel };
  properties: { level: Level; severity: Severity; evidence: string[]; source: string };
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: [
    {
      tool: { driver: { name: 'slop-lint'; informationUri: string; rules: SarifRule[] } };
      columnKind: 'unicodeCodePoints';
      results: SarifResult[];
      /** Present only when an input was linted as a genre other than 'cover-letter': that genre per uri. */
      properties?: { genres: Record<string, Genre> };
    },
  ];
}

/** One linted input: its SARIF uri (see artifactUri), the text that was linted, and the result. */
export interface SarifInput {
  uri: string;
  text: string;
  result: LintResult;
  /** The rules that ran on this input, when they are not the catalog: a config file's. */
  rules?: readonly Rule[];
}

/**
 * error for a level 1 rule, which fails the CLI, and for a high or disqualifying severity,
 * which costs 3 or all 15 points of the score even when budgeted (ESP-02 is level 2 and high).
 * warning for the rest of level 2, note for level 3 context words.
 */
export function sarifLevel(f: { level: Level; severity: Severity }): SarifLevel {
  if (f.level === 1 || f.severity === 'disqualify' || f.severity === 'high') return 'error';
  return f.level === 2 ? 'warning' : 'note';
}

/**
 * The first web address in a rule's source reference, as https. The catalog writes them
 * without a scheme, in parentheses: "Kobak et al. 2025 (arxiv.org/pdf/2406.07016)".
 * A reference without a host and a path ("erkansaka.net summary") has none.
 */
export function helpUri(ref: string): string | undefined {
  const m = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s);,]*)/iu.exec(ref);
  return m?.[1] === undefined ? undefined : `https://${m[1]}`;
}

const DRIVE = /^[A-Za-z]:[\\/]/u;
const UNC = /^(?:\\\\|\/\/)/u;
const ROOTED = /^[\\/]/u;

/**
 * The path given on the command line as a SARIF artifact uri: forward slashes, relative to
 * `cwd`, no leading ./, each segment percent-encoded. GitHub resolves a relative uri against
 * the repository root, so the CLI has to run from there. An absolute path is made relative to
 * `cwd`; a path on another Windows drive, or a Windows path under a POSIX working directory,
 * cannot be, and throws.
 */
export function artifactUri(path: string, cwd: string): string {
  if (path === '') throw new Error('an empty path has no uri');
  const winCwd = DRIVE.test(cwd) || UNC.test(cwd);
  let rel: string;
  if (DRIVE.test(path) || UNC.test(path) || (winCwd && ROOTED.test(path))) {
    if (!winCwd) throw new Error(`${path} is a Windows path and the working directory ${cwd} is not`);
    // A path rooted without a drive ("\docs\a.md") is on the working directory's drive.
    const full = ROOTED.test(path) && !UNC.test(path) && DRIVE.test(cwd) ? `${cwd.slice(0, 2)}${path}` : path;
    rel = win32.relative(cwd, full);
    if (win32.isAbsolute(rel)) throw new Error(`${path} is not on the drive of the working directory ${cwd}`);
  } else if (ROOTED.test(path)) {
    rel = posix.relative(cwd, path.replace(/\\/gu, '/'));
  } else {
    rel = path;
  }
  let p = posix.normalize(rel.replace(/\\/gu, '/'));
  while (p.startsWith('./')) p = p.slice(2);
  if (p === '.' || p === '' || p.endsWith('/')) throw new Error(`${path} names a directory, not a file`);
  return p.split('/').map(encodeURIComponent).join('/');
}

/** 1-based line, and 1-based column in Unicode code points, of a UTF-16 offset. */
function position(text: string, starts: readonly number[], offset: number): { line: number; column: number } {
  const { line } = lineColumn(starts, offset);
  const lineStart = starts[line - 1] ?? 0;
  return { line, column: Array.from(text.slice(lineStart, offset)).length + 1 };
}

/** The region of a finding. lint() counts columns in UTF-16 code units; SARIF here counts code points. */
export function region(text: string, f: Pick<Finding, 'start' | 'end'>, starts: readonly number[] = lineStarts(text)): SarifRegion {
  const a = position(text, starts, f.start);
  const b = position(text, starts, f.end);
  return { startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column };
}

/**
 * Stable across edits that only move the text: the rule, the file, the matched text and which
 * occurrence of that rule and text in the file it is. No line or column goes in, so a paragraph
 * added above a finding does not turn it into a new alert.
 */
export function fingerprint(ruleId: string, uri: string, match: string, occurrence: number): string {
  return createHash('sha256').update([ruleId, uri, match, String(occurrence)].join('\0'), 'utf8').digest('hex');
}

function messageText(f: Finding): string {
  const detail = f.detail ? ` (${f.detail})` : '';
  const shown = f.match.length > 60 ? `${f.match.slice(0, 57)}...` : f.match;
  return `${f.message}${detail} Found "${shown.replace(/\s+/gu, ' ')}". Suggestion: ${f.suggestion}`;
}

function descriptor(rule: Rule): SarifRule {
  const uri = helpUri(rule.source.ref);
  return {
    id: rule.id,
    shortDescription: { text: rule.name },
    fullDescription: { text: rule.message },
    help: { text: rule.suggestion },
    ...(uri === undefined ? {} : { helpUri: uri }),
    defaultConfiguration: { level: sarifLevel(rule) },
    properties: { level: rule.level, severity: rule.severity, evidence: [...rule.source.evidence], source: rule.source.ref },
  };
}

function directiveDescriptor(rule: DirectiveRule): SarifRule {
  return {
    id: rule.id,
    shortDescription: { text: rule.name },
    fullDescription: { text: rule.message },
    help: { text: rule.suggestion },
    defaultConfiguration: { level: 'warning' },
    properties: { level: 2, severity: 'low', evidence: [], source: 'slop-lint' },
  };
}

/**
 * The rules of every input, once each: the catalog's in catalog order, then the custom ones in
 * the order they first appear. A rule whose level differs between inputs (an override) is
 * described as the first input has it; each result carries its own level.
 */
function allRules(inputs: readonly SarifInput[]): Rule[] {
  const byId = new Map<string, Rule>();
  for (const input of inputs) {
    for (const rule of input.rules ?? RULES) if (!byId.has(rule.id)) byId.set(rule.id, rule);
  }
  const catalog = RULES.flatMap((r) => byId.get(r.id) ?? []);
  const catalogIds = new Set(RULES.map((r) => r.id));
  return [...catalog, ...[...byId.values()].filter((r) => !catalogIds.has(r.id))];
}

/**
 * One SARIF log for every input, in input order. rules[] lists, in catalog order, each rule that has a finding.
 * An input whose uri came earlier is left out: it names the same file again (a.md and ./a.md, or two
 * globs that overlap), and its results would repeat with the same fingerprints.
 *
 * A finding an inline directive suppressed is a result too, with `suppressions: [{ kind: 'inSource' }]`
 * and the directive's reason as its justification, so a viewer shows it as suppressed and not
 * as gone. Directive problems (SUP-01 to SUP-03) are warnings after the rules of the prose.
 */
export function toSarif(all: readonly SarifInput[]): SarifLog {
  const uris = new Set<string>();
  const inputs = all.filter(({ uri }) => !uris.has(uri) && uris.add(uri));
  const used = new Set(
    inputs.flatMap((i) => [...i.result.findings, ...(i.result.suppressed ?? []), ...(i.result.directiveProblems ?? [])].map((f) => f.ruleId)),
  );
  const descriptors = [
    ...allRules(inputs).filter((r) => used.has(r.id)).map(descriptor),
    ...DIRECTIVE_RULES.filter((r) => used.has(r.id)).map(directiveDescriptor),
  ];
  const index = new Map(descriptors.map((r, i) => [r.id, i]));
  const results: SarifResult[] = [];
  for (const { uri, text, result } of inputs) {
    const starts = lineStarts(text);
    const seen = new Map<string, number>();
    const suppressed = new Map((result.suppressed ?? []).map((f) => [f as Finding, f.suppressedBy]));
    // Suppressed findings take their place in reading order, so the occurrence number in a
    // fingerprint is the same whether a finding is suppressed or not.
    const prose = [...result.findings, ...suppressed.keys()].sort((a, b) => a.start - b.start);
    for (const f of [...prose, ...(result.directiveProblems ?? [])]) {
      // A whole-document finding (ESP-02, EST-11, OFI-01) quotes the whole prose, so its match changes
      // on any edit; it is fingerprinted by rule and file alone, and keeps its alert as the text moves.
      const match = DOCUMENT_SCOPE_IDS.has(f.ruleId) ? '' : f.match;
      const key = `${f.ruleId}\0${match}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const ruleIndex = index.get(f.ruleId);
      if (ruleIndex === undefined) throw new Error(`finding for ${f.ruleId}, which is not in the catalog`);
      const by = suppressed.get(f);
      results.push({
        ruleId: f.ruleId,
        ruleIndex,
        level: sarifLevel(f),
        message: { text: messageText(f) },
        locations: [{ physicalLocation: { artifactLocation: { uri }, region: region(text, f, starts) } }],
        partialFingerprints: { [FINGERPRINT_KEY]: fingerprint(f.ruleId, uri, match, occurrence) },
        ...(by === undefined ? {} : { suppressions: [{ kind: 'inSource' as const, ...(by.reason === undefined ? {} : { justification: by.reason }) }] }),
      });
    }
  }
  const genres = Object.fromEntries(inputs.flatMap(({ uri, result }) => (result.genre === undefined ? [] : [[uri, result.genre]])));
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'slop-lint', informationUri: INFORMATION_URI, rules: descriptors } },
        columnKind: 'unicodeCodePoints',
        results,
        ...(Object.keys(genres).length === 0 ? {} : { properties: { genres } }),
      },
    ],
  };
}
