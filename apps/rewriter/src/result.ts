// The page's view of a RewriteResult, and a shape check on it. The check is written by hand,
// because zod would be most of the page's JavaScript; the server built the result with
// prose-rewriter's schema before sending it, and the demo's recordings are checked against that
// schema by test/demo.test.ts. test/result.test.ts checks that a RewriteResult fits these types.

export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface ResultChange {
  readonly id: string;
  readonly span: Span;
  readonly before: string;
  readonly after: string;
  readonly reason: string;
  readonly ruleId?: string | undefined;
  readonly principleId?: string | undefined;
  readonly stage: string;
  /** 'reverted' means the checks took it back: the page never offers to accept it. */
  readonly status: 'applied' | 'reverted';
  readonly revertReason?: string | undefined;
}

export interface ResultFinding {
  readonly ruleId: string;
  readonly level: 1 | 2 | 3;
  readonly severity: string;
  /** UTF-16 offsets into the text, as String.prototype.slice takes them. */
  readonly start: number;
  readonly end: number;
  readonly match: string;
  readonly message: string;
  readonly suggestion: string;
  readonly detail?: string | undefined;
}

export interface ResultLint {
  readonly findings: readonly ResultFinding[];
  readonly passesTier1: boolean;
  readonly score: { readonly points: number; readonly max: number };
}

export const FLAG_KINDS = ['not-in-cv', 'missing-fact', 'tone-risk', 'length', 'injection'] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export interface ResultFlag {
  readonly kind: FlagKind;
  readonly span?: Span | undefined;
  readonly message: string;
}

export interface ResultFacts {
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
  readonly added: readonly string[];
  readonly fromCv: readonly string[];
  readonly notInCv: readonly string[];
  readonly placeholders: readonly string[];
}

export type Status = 'ok' | 'needs-review' | 'blocked';

export interface Result {
  readonly rewritten: string;
  readonly changes: readonly ResultChange[];
  readonly facts: ResultFacts;
  readonly lint: { readonly before: ResultLint; readonly after: ResultLint };
  readonly flags: readonly ResultFlag[];
  readonly status: Status;
  readonly usage: { readonly calls: number; readonly costUsd: number | null };
  readonly message?: string | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optional = (v: unknown, check: (x: unknown) => boolean): boolean => v === undefined || check(v);

const isSpan = (v: unknown): v is Span => isObject(v) && isCount(v['start']) && isCount(v['end']) && v['start'] <= v['end'];

function isChange(v: unknown): v is ResultChange {
  return (
    isObject(v) &&
    isString(v['id']) &&
    isSpan(v['span']) &&
    isString(v['before']) &&
    isString(v['after']) &&
    isString(v['reason']) &&
    optional(v['ruleId'], isString) &&
    optional(v['principleId'], isString) &&
    isString(v['stage']) &&
    (v['status'] === 'applied' || v['status'] === 'reverted') &&
    optional(v['revertReason'], isString)
  );
}

function isFinding(v: unknown): v is ResultFinding {
  return (
    isObject(v) &&
    isString(v['ruleId']) &&
    (v['level'] === 1 || v['level'] === 2 || v['level'] === 3) &&
    isString(v['severity']) &&
    isCount(v['start']) &&
    isCount(v['end']) &&
    isString(v['match']) &&
    isString(v['message']) &&
    isString(v['suggestion']) &&
    optional(v['detail'], isString)
  );
}

function isLint(v: unknown): v is ResultLint {
  return (
    isObject(v) &&
    Array.isArray(v['findings']) &&
    v['findings'].every(isFinding) &&
    typeof v['passesTier1'] === 'boolean' &&
    isObject(v['score']) &&
    isNumber(v['score']['points']) &&
    isNumber(v['score']['max'])
  );
}

const isFlag = (v: unknown): v is ResultFlag =>
  isObject(v) && (FLAG_KINDS as readonly unknown[]).includes(v['kind']) && optional(v['span'], isSpan) && isString(v['message']);

const FACT_KEYS = ['kept', 'dropped', 'added', 'fromCv', 'notInCv', 'placeholders'] as const;
const isFacts = (v: unknown): v is ResultFacts => isObject(v) && FACT_KEYS.every((k) => isStrings(v[k]));

function isResult(v: unknown): v is Result {
  if (!isObject(v)) return false;
  const lint = v['lint'];
  const usage = v['usage'];
  return (
    isString(v['rewritten']) &&
    Array.isArray(v['changes']) &&
    v['changes'].every(isChange) &&
    isFacts(v['facts']) &&
    isObject(lint) &&
    isLint(lint['before']) &&
    isLint(lint['after']) &&
    Array.isArray(v['flags']) &&
    v['flags'].every(isFlag) &&
    (v['status'] === 'ok' || v['status'] === 'needs-review' || v['status'] === 'blocked') &&
    isObject(usage) &&
    isCount(usage['calls']) &&
    (usage['costUsd'] === null || (isNumber(usage['costUsd']) && usage['costUsd'] >= 0)) &&
    optional(v['message'], isString)
  );
}

/** The result, or null when it does not have the shape the page reads. */
export function asResult(v: unknown): Result | null {
  return isResult(v) ? v : null;
}

/** What POST ./api/rewrite answers with: the text the spans point into, and the result. */
export interface RewriteReply {
  /** The text as the rewriter read it (NFC). Every span of the result is an offset into it. */
  readonly original: string;
  readonly result: Result;
}

export function asReply(v: unknown): RewriteReply | null {
  if (!isObject(v) || !isString(v['original'])) return null;
  const result = asResult(v['result']);
  return result === null ? null : { original: v['original'], result };
}
