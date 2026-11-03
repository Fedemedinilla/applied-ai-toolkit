/**
 * Spending caps. They are a guard against bugs and runaway loops, not a billing quota. Before each
 * call the gateway compares the usage totals with the caps, and a reached cap throws CapError
 * without calling the API.
 *
 * Unpriced usage counts too, in US$, at the upper bound the store computes: rows answered by a
 * model with no price, rows recorded while the price table was down, calls cut before the API
 * reported everything, and reservations of calls still in flight. Without that, a model with no
 * price or a series of cut calls could spend with no cap at all.
 *
 * The gateway runs this check twice: before writing the reservation, and again after it, with the
 * call's own reservation left out of the totals. The second check is what keeps concurrent calls
 * within one worst case of a cap (see recheckCaps in gateway.ts).
 */
import { CapError, ConfigError } from './errors.ts';
import type { AccountCaps, GlobalCaps, UsageTotals } from './config.ts';
import { requireTimeZone } from './setup.ts';

// ---------------------------------------------------------------------------
// Windows: the day and the month in the configured time zone
// ---------------------------------------------------------------------------

export interface CapWindows {
  /** Midnight today in the configured zone. */
  readonly dayStart: Date;
  /** Midnight on the first of the month in the configured zone. */
  readonly monthStart: Date;
}

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: requireTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
}

function partsAt(instantMs: number, format: Intl.DateTimeFormat): DateParts {
  const parts = format.formatToParts(instantMs);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
}

/** How far the zone is from UTC at that instant (-3 h in Buenos Aires), in milliseconds. */
function offsetMs(instantMs: number, format: Intl.DateTimeFormat): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const p = partsAt(whole, format);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/** The UTC instant of local midnight on that date. Two passes: the offset can change that day (DST). */
function localMidnight(year: number, month: number, day: number, format: Intl.DateTimeFormat): Date {
  const asUtc = Date.UTC(year, month - 1, day);
  const approx = asUtc - offsetMs(asUtc, format);
  return new Date(asUtc - offsetMs(approx, format));
}

/** Cap windows for `now`. Never uses the process time zone, which is UTC on most hosts. */
export function capWindows(now: Date, timeZone: string): CapWindows {
  const format = formatter(timeZone);
  const today = partsAt(now.getTime(), format);
  return { dayStart: localMidnight(today.year, today.month, today.day, format), monthStart: localMidnight(today.year, today.month, 1, format) };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface CapCheck {
  /** Null for calls without a user (an eval run or a system job): only the monthly cap applies. */
  readonly userId: string | null;
  readonly jobId: string | null;
  readonly global: GlobalCaps;
  /** The user's own caps. Null without a user. */
  readonly account: AccountCaps | null;
  readonly totals: UsageTotals;
}

export interface UnpricedWindow {
  readonly calls: number;
  readonly boundUsd: number;
}

/** Unpriced calls in the user's day and in the job. Null when the call has no user or no job. */
export interface Unpriced {
  readonly userDay: UnpricedWindow | null;
  readonly job: UnpricedWindow | null;
}

/** The lower one wins: an account can lower a global cap, never raise it. */
function effectiveCap(global: number, own: number | null | undefined): number {
  return own === null || own === undefined ? global : Math.min(global, own);
}

function required(value: number | null, field: string): number {
  // A null where a sum was requested cannot pass as zero: it would let everything through.
  if (value === null) throw new ConfigError('invalid_usage_totals', `Usage totals returned null in ${field}`);
  return value;
}

/** Cost plus bound, at the ledger's 6 decimals, without float noise. */
function addUsd(a: number, b: number): number {
  return Math.round((a + b) * 1_000_000) / 1_000_000;
}

/**
 * Throws CapError for the first cap reached: monthly global, daily per user, per job. Each compares
 * measured cost plus the unpriced bound. Reaching is enough: spend equal to the cap blocks the
 * next call. Returns the unpriced calls of the user and the job, so the gateway can log that
 * those caps were checked against a bound.
 */
export function checkCaps(input: CapCheck): Unpriced {
  const { global, account, totals } = input;

  const monthBound = required(totals.monthBoundUsd, 'monthBoundUsd');
  const month = addUsd(totals.monthUsd, monthBound);
  if (month >= global.monthlyUsd) throw new CapError('cap_monthly_global', month, global.monthlyUsd, monthBound);

  let userDay: UnpricedWindow | null = null;
  if (input.userId !== null) {
    const bound = required(totals.userDayBoundUsd, 'userDayBoundUsd');
    const day = addUsd(required(totals.userDayUsd, 'userDayUsd'), bound);
    const cap = effectiveCap(global.dailyPerUserUsd, account?.dailyPerUserUsd);
    if (day >= cap) throw new CapError('cap_daily_user', day, cap, bound);
    userDay = { calls: required(totals.userDayUnpriced, 'userDayUnpriced'), boundUsd: bound };
  }

  let job: UnpricedWindow | null = null;
  if (input.jobId !== null) {
    const bound = required(totals.jobBoundUsd, 'jobBoundUsd');
    const total = addUsd(required(totals.jobUsd, 'jobUsd'), bound);
    const cap = effectiveCap(global.perJobUsd, account?.perJobUsd);
    if (total >= cap) throw new CapError('cap_per_job', total, cap, bound);
    job = { calls: required(totals.jobUnpriced, 'jobUnpriced'), boundUsd: bound };
  }

  return { userDay, job };
}
