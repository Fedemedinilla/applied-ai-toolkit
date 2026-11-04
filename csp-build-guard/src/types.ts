import type { GuardConfig } from './config.ts';
import type { Policy } from './csp.ts';
import type { PageParts } from './html.ts';
import type { HeaderRule } from './routes.ts';
import type { Site } from './site.ts';

export type CheckId = 'inline-hashes' | 'policy' | 'headers' | 'secrets' | 'lookbehind' | 'js-budget';
export type Status = 'pass' | 'fail' | 'skip';

export interface Failure {
  readonly message: string;
  /** A path relative to --dir, when the failure is about one file. */
  readonly file?: string;
}

export interface CheckResult {
  readonly id: CheckId;
  readonly status: Status;
  /** One line: what was checked and what was found. */
  readonly summary: string;
  readonly failures: readonly Failure[];
  /** Measurements for --json, such as per-page sizes. */
  readonly details?: unknown;
}

/** One HTML page with what the checks need from it. */
export interface Page {
  /** Path relative to the static root. */
  readonly path: string;
  /** Path relative to --dir, for reports. */
  readonly display: string;
  readonly urlPaths: readonly string[];
  readonly parts: PageParts;
  /**
   * The Content-Security-Policy the page is served with: each delivery that applies (a header
   * rule, a meta element, the literal), in order.
   */
  readonly csp: ReadonlyArray<{ readonly origin: string; readonly value: string }>;
  /**
   * The policies the browser enforces, read from `csp`: header values as a comma-separated list,
   * each `<meta>` content as one policy, since a comma separates nothing there.
   */
  readonly policies: readonly Policy[];
}

export interface Context {
  readonly site: Site;
  readonly config: GuardConfig;
  readonly pages: readonly Page[];
  /** Header rules when the CSP source is a headers file; null for meta and literal. */
  readonly headerRules: readonly HeaderRule[] | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface GuardReport {
  readonly ok: boolean;
  readonly dir: string;
  readonly staticRoot: string;
  readonly pages: number;
  readonly checks: readonly CheckResult[];
}

/** "1 page", "2 pages". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "index.html" or "index.html and 3 more pages". */
export function pagesLabel(pages: readonly string[]): string {
  const [first, ...rest] = pages;
  if (first === undefined) return 'no page';
  return rest.length ? `${first} and ${rest.length} more page${rest.length === 1 ? '' : 's'}` : first;
}

/** Groups items by a key, keeping first-seen order. */
export function groupBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
