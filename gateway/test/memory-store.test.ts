/**
 * The in-memory usage store carries the semantics of sql/schema.sql (usage_for_caps and the check
 * constraints). These tests pin those semantics; sql/test.sql asserts the totals cases and the
 * constraints the gateway's own rows could break, in Postgres.
 */
import { describe, expect, it } from 'vitest';
import { ConstraintViolation, createMemoryStores } from '../src/memory-store.ts';
import type { UsageRow, UsageWindows } from '../src/ports.ts';
import { earlierRow, JOB, NOW, OTHER_USER, PRICES, USER } from './helpers/fake-stores.ts';

const WINDOWS: UsageWindows = { dayStart: new Date('2026-10-23T03:00:00Z'), monthStart: new Date('2026-10-01T03:00:00Z'), userId: USER, jobId: JOB };
const clock = { now: () => NOW, monotonicMs: () => 0 };

function stores(prices: readonly unknown[] = PRICES) {
  return createMemoryStores({ prices, clock });
}

/** A reservation as the gateway writes it: nothing measured, the estimated input and max_tokens. */
function reservation(partial: Partial<UsageRow> = {}): UsageRow {
  return earlierRow({ reservation: true, modelResponded: null, costUsd: null, stopReason: null, durationMs: null, incomplete: true, estimatedInputTokens: 1000, maxTokens: 2000, ...partial });
}

describe('MemoryUsageStore.totalsForCaps', () => {
  it('sums cost per window and returns null for the windows that were not requested', async () => {
    const { usage } = stores();
    await usage.record(earlierRow({ costUsd: 1.5 }));
    await usage.record(earlierRow({ costUsd: 2, jobId: JOB }));
    await usage.record(earlierRow({ costUsd: 4, userId: OTHER_USER }));
    expect(await usage.totalsForCaps(WINDOWS)).toEqual({
      userDayUsd: 3.5,
      userDayUnpriced: 0,
      userDayBoundUsd: 0,
      monthUsd: 7.5,
      monthUnpriced: 0,
      monthBoundUsd: 0,
      jobUsd: 2,
      jobUnpriced: 0,
      jobBoundUsd: 0,
    });
    expect(await usage.totalsForCaps({ ...WINDOWS, userId: null, jobId: null })).toMatchObject({ userDayUsd: null, userDayUnpriced: null, userDayBoundUsd: null, jobUsd: null });
  });

  it('an open reservation counts in the bound at the highest price, but not as an unpriced call', async () => {
    const { usage } = stores();
    await usage.record(reservation());
    // Highest fixture prices are Fable's: 1000 x 10 + 2000 x 50 = 110,000 per million.
    expect(await usage.totalsForCaps(WINDOWS)).toMatchObject({ userDayUnpriced: 0, userDayBoundUsd: 0.11, monthUnpriced: 0, monthBoundUsd: 0.11 });
  });

  it('a closed reservation does not count: each call counts once', async () => {
    const { usage } = stores();
    const open = reservation();
    await usage.record(open);
    await usage.record(earlierRow({ replaces: open.id, costUsd: 0.25 }));
    expect(await usage.totalsForCaps(WINDOWS)).toMatchObject({ userDayUsd: 0.25, userDayBoundUsd: 0, monthBoundUsd: 0 });
  });

  it('an incomplete row is valued at the price of the model that was answering, when it has one', async () => {
    const { usage } = stores();
    const open = reservation();
    await usage.record(open);
    await usage.record(earlierRow({ replaces: open.id, incomplete: true, costUsd: null, modelResponded: 'claude-sonnet-5-5', inputTokens: 2000, outputTokens: 1, maxTokens: 16_000 }));
    // Sonnet fixture: 2000 x 2 + 1 x 10 + 16,000 x 10 = 164,010 per million.
    expect(await usage.totalsForCaps(WINDOWS)).toMatchObject({ userDayUnpriced: 1, userDayBoundUsd: 0.16401 });
  });

  it('cache reads of an unpriced model are floored at 0.1x the highest input price', async () => {
    const { usage } = stores();
    await usage.record(earlierRow({ costUsd: null, modelResponded: 'claude-sonnet-5', cacheReadTokens: 1_000_000 }));
    // Highest cache read in the fixtures is 0.25; 0.1 x the highest input (10) is 1.
    expect(await usage.totalsForCaps(WINDOWS)).toMatchObject({ userDayBoundUsd: 1 });
  });

  it('with unpriced rows and no price in force, the bound is null rather than zero', async () => {
    const { usage } = stores([]);
    await usage.record(earlierRow({ costUsd: null, modelResponded: 'claude-sonnet-5', inputTokens: 10 }));
    expect(await usage.totalsForCaps(WINDOWS)).toMatchObject({ userDayBoundUsd: null, monthBoundUsd: null });
  });

  it('excludeId leaves one row out: the second cap check does not count its own reservation', async () => {
    const { usage } = stores();
    const own = reservation();
    await usage.record(own);
    await usage.record(reservation());
    expect(await usage.totalsForCaps({ ...WINDOWS, excludeId: own.id })).toMatchObject({ userDayBoundUsd: 0.11, monthBoundUsd: 0.11 });
  });

  it('rows before the window start do not count for the day, and job rows count whatever their date', async () => {
    const { usage } = stores();
    await usage.record(earlierRow({ costUsd: 3, jobId: JOB }));
    usage.rows[0] = { ...usage.rows[0]!, createdAt: new Date('2026-10-20T12:00:00Z') };
    expect(await usage.totalsForCaps(WINDOWS)).toMatchObject({ userDayUsd: 0, monthUsd: 3, jobUsd: 3 });
  });
});

describe('MemoryUsageStore.record', () => {
  it('the same id twice stores one row: a retried insert does not double the cost', async () => {
    const { usage } = stores();
    const row = earlierRow({ costUsd: 1 });
    await usage.record(row);
    await usage.record(row);
    expect(usage.rows).toHaveLength(1);
  });

  it.each([
    ['a reservation with measured tokens', () => reservation({ inputTokens: 5 }), 'llm_usage_reservation_unmeasured'],
    ['a reservation that names a model', () => reservation({ modelResponded: 'claude-sonnet-5-5' }), 'llm_usage_reservation_unmeasured'],
    ['an incomplete row with a cost', () => earlierRow({ incomplete: true, costUsd: 1 }), 'llm_usage_incomplete_without_cost'],
    ['an estimate on a complete row', () => earlierRow({ estimatedInputTokens: 10 }), 'llm_usage_estimate_only_if_incomplete'],
    ['a complete row without a model that is not a zero-usage error', () => earlierRow({ modelResponded: null, inputTokens: 3 }), 'llm_usage_model_responded_if_consumed'],
    ['a row that replaces a missing reservation', () => earlierRow({ replaces: '00000000-0000-4000-8000-00000000dead' }), 'llm_usage_replaces_fkey'],
    ['negative tokens', () => earlierRow({ outputTokens: -1 }), 'llm_usage_tokens_nonnegative'],
    ['negative thinking tokens', () => earlierRow({ thinkingTokens: -1 }), 'llm_usage_thinking_nonnegative'],
    ['a negative duration', () => earlierRow({ durationMs: -1 }), 'llm_usage_duration_nonnegative'],
    ['a negative input estimate', () => reservation({ estimatedInputTokens: -1 }), 'llm_usage_estimated_input_nonnegative'],
    ['max_tokens of zero', () => earlierRow({ maxTokens: 0 }), 'llm_usage_max_tokens_positive'],
    ['a negative cost', () => earlierRow({ costUsd: -0.01 }), 'llm_usage_cost_nonnegative'],
    ['a blank task', () => earlierRow({ task: ' ' }), 'llm_usage_task_not_blank'],
    ['a blank prompt version', () => earlierRow({ promptVersion: '' }), 'llm_usage_prompt_version_not_blank'],
    ['a blank requested model', () => earlierRow({ modelRequested: '' }), 'llm_usage_model_requested_not_blank'],
    ['a blank error code', () => earlierRow({ errorCode: ' ' }), 'llm_usage_error_code_not_blank'],
    ['attempts that are not an array', () => earlierRow({ attempts: {} as unknown as UsageRow['attempts'] }), 'llm_usage_attempts_is_array'],
    ['a row that replaces itself', () => {
      const id = crypto.randomUUID();
      return earlierRow({ id, replaces: id });
    }, 'llm_usage_replaces_other'],
  ])('rejects %s, as the SQL constraints do', async (_name, build, constraint) => {
    const { usage } = stores();
    await expect(usage.record(build())).rejects.toThrow(ConstraintViolation);
    await expect(usage.record(build())).rejects.toThrow(constraint);
  });

  it('a reservation is closed by one row only', async () => {
    const { usage } = stores();
    const open = reservation();
    await usage.record(open);
    await usage.record(earlierRow({ replaces: open.id }));
    await expect(usage.record(earlierRow({ replaces: open.id }))).rejects.toThrow('llm_usage_replaces_key');
  });

  it('accepts a zero-usage error row without a model: an HTTP error that was not billed', async () => {
    const { usage } = stores();
    const open = reservation();
    await usage.record(open);
    await usage.record(earlierRow({ replaces: open.id, modelResponded: null, costUsd: 0, errorCode: 'overloaded', stopReason: null }));
    expect(usage.openReservations).toEqual([]);
  });
});
