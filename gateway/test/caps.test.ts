import { describe, expect, it } from 'vitest';
import { capWindows, checkCaps, type CapCheck } from '../src/caps.ts';
import type { UsageTotals } from '../src/config.ts';
import { CapError, ConfigError, SetupError } from '../src/errors.ts';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';

describe('capWindows', () => {
  it('day and month start at midnight in the configured zone (03:00 UTC for Buenos Aires)', () => {
    expect(capWindows(new Date('2026-10-23T15:00:00Z'), BUENOS_AIRES)).toEqual({ dayStart: new Date('2026-10-23T03:00:00Z'), monthStart: new Date('2026-10-01T03:00:00Z') });
  });

  it('at 23:00 local it is still the previous day, even though UTC already rolled over', () => {
    expect(capWindows(new Date('2026-10-23T02:00:00Z'), BUENOS_AIRES).dayStart).toEqual(new Date('2026-10-22T03:00:00Z'));
    expect(capWindows(new Date('2026-10-01T02:59:59Z'), BUENOS_AIRES).monthStart).toEqual(new Date('2026-09-01T03:00:00Z'));
    expect(capWindows(new Date('2026-10-01T03:00:00Z'), BUENOS_AIRES).monthStart).toEqual(new Date('2026-10-01T03:00:00Z'));
  });

  it("on a DST change day it uses midnight's offset, not the current one", () => {
    // New York moves to UTC-4 on 2026-03-08 at 02:00; midnight that day is still UTC-5.
    expect(capWindows(new Date('2026-03-08T12:00:00Z'), 'America/New_York')).toEqual({ dayStart: new Date('2026-03-08T05:00:00Z'), monthStart: new Date('2026-03-01T05:00:00Z') });
  });

  it('an unknown zone is a setup error', () => {
    expect(() => capWindows(new Date('2026-10-23T15:00:00Z'), 'America/Nowhere')).toThrow(SetupError);
  });
});

const NOTHING: UsageTotals = {
  userDayUsd: 0,
  userDayUnpriced: 0,
  userDayBoundUsd: 0,
  monthUsd: 0,
  monthUnpriced: 0,
  monthBoundUsd: 0,
  jobUsd: null,
  jobUnpriced: null,
  jobBoundUsd: null,
};

function check(partial: Partial<Omit<CapCheck, 'totals'>> & { totals?: Partial<UsageTotals> }): CapCheck {
  return {
    userId: 'u1',
    jobId: null,
    global: { perJobUsd: 5, dailyPerUserUsd: 10, monthlyUsd: 60 },
    account: { perJobUsd: null, dailyPerUserUsd: null },
    ...partial,
    totals: { ...NOTHING, ...partial.totals },
  };
}

function capThatStops(input: CapCheck): { code: string; spentUsd: number; capUsd: number; unpricedBoundUsd: number } | null {
  try {
    checkCaps(input);
    return null;
  } catch (error) {
    if (!(error instanceof CapError)) throw error;
    return { code: error.code, spentUsd: error.spentUsd, capUsd: error.capUsd, unpricedBoundUsd: error.unpricedBoundUsd };
  }
}

describe('checkCaps', () => {
  it('with no usage it passes and returns the unpriced calls of the user', () => {
    expect(checkCaps(check({}))).toEqual({ userDay: { calls: 0, boundUsd: 0 }, job: null });
  });

  it('the monthly global cap stops everyone, including calls without a user', () => {
    expect(capThatStops(check({ userId: null, totals: { monthUsd: 60, userDayUsd: null, userDayUnpriced: null, userDayBoundUsd: null } }))).toMatchObject({ code: 'cap_monthly_global' });
  });

  it('reaching a cap is enough: the call that would pass it does not go out', () => {
    expect(capThatStops(check({ totals: { userDayUsd: 9.999999 } }))).toBeNull();
    expect(capThatStops(check({ totals: { userDayUsd: 10 } }))).toEqual({ code: 'cap_daily_user', spentUsd: 10, capUsd: 10, unpricedBoundUsd: 0 });
  });

  it("an account's cap can lower the global one, never raise it", () => {
    expect(capThatStops(check({ account: { perJobUsd: null, dailyPerUserUsd: 2 }, totals: { userDayUsd: 2 } }))).toMatchObject({ code: 'cap_daily_user', capUsd: 2 });
    expect(capThatStops(check({ account: { perJobUsd: null, dailyPerUserUsd: 50 }, totals: { userDayUsd: 10 } }))).toMatchObject({ capUsd: 10 });
  });

  it('the per-job cap only applies to calls that belong to a job', () => {
    expect(capThatStops(check({ totals: { jobUsd: 5 } }))).toBeNull();
    expect(capThatStops(check({ jobId: 'j1', totals: { jobUsd: 5, jobUnpriced: 0, jobBoundUsd: 0 } }))).toMatchObject({ code: 'cap_per_job', capUsd: 5 });
  });

  it('a null where a sum was requested does not pass as zero', () => {
    expect(() => checkCaps(check({ totals: { userDayUsd: null } }))).toThrow(ConfigError);
    expect(() => checkCaps(check({ jobId: 'j1' }))).toThrow(/jobBoundUsd/);
  });

  it('caps in US$ count unpriced usage at its bound', () => {
    expect(capThatStops(check({ totals: { userDayUsd: 7, userDayUnpriced: 2, userDayBoundUsd: 3 } }))).toEqual({ code: 'cap_daily_user', spentUsd: 10, capUsd: 10, unpricedBoundUsd: 3 });
  });

  it('adds cost and bound without float noise', () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004, which would read as over a 0.3 cap.
    const result = capThatStops(check({ global: { perJobUsd: 5, dailyPerUserUsd: 0.3, monthlyUsd: 60 }, totals: { userDayUsd: 0.1, userDayBoundUsd: 0.2 } }));
    expect(result).toMatchObject({ spentUsd: 0.3 });
  });

  it('a null bound (unpriced rows and no price in force at all) does not pass as zero', () => {
    expect(() => checkCaps(check({ totals: { monthBoundUsd: null } }))).toThrow(/monthBoundUsd/);
  });

  it('returns the unpriced calls of the user and the job with their bound, not those of the month', () => {
    const totals = { userDayUnpriced: 2, userDayBoundUsd: 0.5, monthUnpriced: 9, monthBoundUsd: 4, jobUsd: 0, jobUnpriced: 1, jobBoundUsd: 0.25 };
    expect(checkCaps(check({ jobId: 'j1', totals }))).toEqual({ userDay: { calls: 2, boundUsd: 0.5 }, job: { calls: 1, boundUsd: 0.25 } });
  });
});
