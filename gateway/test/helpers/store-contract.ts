/**
 * What the gateway asks of its stores, as one suite that runs against any implementation.
 * store-contract.test.ts runs it over the in-memory stores and over Postgres (PGlite), so the two
 * cannot drift apart unnoticed: the same rows in, the same totals and the same refusals out.
 *
 * Rows are written now, by the store's own clock, so the windows here start an hour ago. Window
 * boundaries with older rows are covered per store (memory-store.test.ts, sql/test.sql).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AccountCaps, GlobalCaps, TaskConfig, UsageTotals } from '../../src/config.ts';
import { PriceRow } from '../../src/cost.ts';
import type { ConfigStore, PriceStore, UsageRow, UsageStore, UsageWindows } from '../../src/ports.ts';
import { earlierRow, GLOBAL_CAPS, JOB, NO_OWN_CAPS, OTHER_USER, PRICES, TASKS, USER } from './fake-stores.ts';

export interface ContractStores {
  readonly config: ConfigStore;
  readonly usage: UsageStore;
  readonly prices: PriceStore;
}

/** The fixtures of fake-stores.ts: its tasks, caps and accounts, with or without its prices. */
export interface ContractSeed {
  readonly prices: typeof PRICES | readonly [];
  readonly tasks: typeof TASKS | readonly [];
  readonly globalCaps: typeof GLOBAL_CAPS;
  readonly accounts: Readonly<Record<string, typeof NO_OWN_CAPS>>;
}

const SEED: ContractSeed = { prices: PRICES, tasks: TASKS, globalCaps: GLOBAL_CAPS, accounts: { [USER]: NO_OWN_CAPS, [OTHER_USER]: NO_OWN_CAPS } };

function row(partial: Partial<UsageRow> = {}): UsageRow {
  const { createdAt: _createdAt, ...rest } = earlierRow(partial);
  return rest;
}

/** A reservation worth 0.81 at the highest fixture prices: 1000 x 10 + 16000 x 50 per million. */
function reservation(partial: Partial<UsageRow> = {}): UsageRow {
  return row({ reservation: true, modelResponded: null, costUsd: null, stopReason: null, durationMs: null, incomplete: true, estimatedInputTokens: 1000, maxTokens: 16_000, ...partial });
}

function windows(partial: Partial<UsageWindows> = {}): UsageWindows {
  const hourAgo = new Date(Date.now() - 3_600_000);
  return { dayStart: hourAgo, monthStart: hourAgo, userId: USER, jobId: null, ...partial };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('The store accepted it');
}

export function describeStoreContract(name: string, open: (seed: ContractSeed) => Promise<ContractStores>): void {
  const totals = async (usage: UsageStore, w: UsageWindows) => UsageTotals.parse(await usage.totalsForCaps(w));

  describe(`store contract: ${name}`, () => {
    describe('config and prices', () => {
      it('returns each config row in the shape the gateway validates, and null when there is none', async () => {
        const { config } = await open(SEED);
        expect(TaskConfig.parse(await config.taskConfig('extract'))).toEqual({ task: 'extract', model: 'claude-fable-5-1', effort: 'medium', hardCaseEffort: 'high' });
        expect(await config.taskConfig('no-such-task')).toBeNull();
        expect(GlobalCaps.parse(await config.globalCaps())).toEqual(GLOBAL_CAPS);
        expect(AccountCaps.parse(await config.accountCaps(USER))).toEqual(NO_OWN_CAPS);
        expect(await config.accountCaps('00000000-0000-4000-8000-0000000000ff')).toBeNull();
      });

      it('returns the price rows of the models asked for that are valid at that time', async () => {
        const { prices } = await open(SEED);
        const now = z.array(PriceRow).parse(await prices.pricesFor(['claude-sonnet-5-5', 'claude-other-1'], new Date()));
        expect(now).toMatchObject([{ model: 'claude-sonnet-5-5', input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }]);
        expect(Date.parse(now[0]?.validFrom ?? '')).toBe(Date.parse(PRICES[0]?.validFrom ?? ''));
        expect(await prices.pricesFor(['claude-sonnet-5-5'], new Date('2026-09-30T00:00:00Z'))).toEqual([]);
      });

      it('a read with a signal that already fired fails', async () => {
        const { config, usage } = await open(SEED);
        const cut = AbortSignal.abort(new Error('cut'));
        await expect(config.globalCaps(cut)).rejects.toThrow();
        await expect(usage.totalsForCaps(windows(), cut)).rejects.toThrow();
      });
    });

    describe('totals for the caps', () => {
      it('an empty ledger sums zero, with null for the windows that were not asked for', async () => {
        const { usage } = await open(SEED);
        expect(await totals(usage, windows({ userId: null }))).toEqual({
          userDayUsd: null,
          userDayUnpriced: null,
          userDayBoundUsd: null,
          monthUsd: 0,
          monthUnpriced: 0,
          monthBoundUsd: 0,
          jobUsd: null,
          jobUnpriced: null,
          jobBoundUsd: null,
        });
      });

      it('sums cost per user, month and job', async () => {
        const { usage } = await open(SEED);
        await usage.record(row({ costUsd: 1.25 }));
        await usage.record(row({ costUsd: 0.5, jobId: JOB }));
        await usage.record(row({ costUsd: 2, userId: OTHER_USER }));
        expect(await totals(usage, windows({ jobId: JOB }))).toMatchObject({ userDayUsd: 1.75, monthUsd: 3.75, jobUsd: 0.5, userDayBoundUsd: 0, jobUnpriced: 0 });
      });

      it('an open reservation counts in the bound at the highest price, and not as an unpriced call', async () => {
        const { usage } = await open(SEED);
        await usage.record(reservation());
        expect(await totals(usage, windows())).toMatchObject({ userDayUsd: 0, userDayUnpriced: 0, userDayBoundUsd: 0.81, monthBoundUsd: 0.81 });
      });

      it('a closed reservation does not count: the call counts once, at what its closing row says', async () => {
        const { usage } = await open(SEED);
        const open_ = reservation();
        await usage.record(open_);
        await usage.record(row({ replaces: open_.id, costUsd: 0.0064 }));
        expect(await totals(usage, windows())).toMatchObject({ userDayUsd: 0.0064, userDayBoundUsd: 0, monthUsd: 0.0064 });
      });

      it('a cut call counts at its worst case: measured input at the answering model, max_tokens of output', async () => {
        const { usage } = await open(SEED);
        const open_ = reservation();
        await usage.record(open_);
        await usage.record(row({ replaces: open_.id, costUsd: null, incomplete: true, stopReason: null, inputTokens: 1200, maxTokens: 16_000, errorCode: 'connection' }));
        // Sonnet 5.5 fixture prices: 1200 x 2 + 16000 x 10 = 162,400 per million.
        expect(await totals(usage, windows())).toMatchObject({ userDayUnpriced: 1, userDayBoundUsd: 0.1624 });
      });

      it('excludeId leaves one row out', async () => {
        const { usage } = await open(SEED);
        const mine = reservation();
        await usage.record(mine);
        await usage.record(reservation());
        expect(await totals(usage, windows({ excludeId: mine.id }))).toMatchObject({ userDayBoundUsd: 0.81 });
        expect(await totals(usage, windows())).toMatchObject({ userDayBoundUsd: 1.62 });
      });

      it('with unpriced rows and no price in force, the bound is null and never zero', async () => {
        const { usage } = await open({ ...SEED, prices: [], tasks: [] });
        await usage.record(reservation());
        expect(await totals(usage, windows())).toMatchObject({ userDayUsd: 0, userDayBoundUsd: null, monthBoundUsd: null });
      });
    });

    describe('record', () => {
      it('the same id twice stores one row: a retried insert does not double the cost', async () => {
        const { usage } = await open(SEED);
        const once = row({ costUsd: 1 });
        await usage.record(once);
        await usage.record(once);
        expect(await totals(usage, windows())).toMatchObject({ userDayUsd: 1 });
      });

      it.each([
        { name: 'a second closing row for one reservation', constraint: 'llm_usage_replaces_key', build: (id: string) => row({ replaces: id }) },
        { name: 'a closing row for a reservation that does not exist', constraint: 'llm_usage_replaces_fkey', build: () => row({ replaces: crypto.randomUUID() }) },
        { name: 'a reservation that measured tokens', constraint: 'llm_usage_reservation_unmeasured', build: () => reservation({ inputTokens: 5 }) },
        { name: 'an incomplete row with a cost', constraint: 'llm_usage_incomplete_without_cost', build: () => row({ incomplete: true, costUsd: 1 }) },
        { name: 'a finished row that names no model', constraint: 'llm_usage_model_responded_if_consumed', build: () => row({ modelResponded: null, costUsd: 1 }) },
      ])('rejects $name ($constraint)', async ({ constraint, build }) => {
        const { usage } = await open(SEED);
        const open_ = reservation();
        await usage.record(open_);
        await usage.record(row({ replaces: open_.id, costUsd: 0 }));
        expect((await rejection(usage.record(build(open_.id)))).message).toContain(constraint);
      });
    });

    describe('reserve', () => {
      const reserveIn = (usage: UsageStore) => {
        if (usage.reserve === undefined) throw new Error(`${name} has no reserve`);
        return usage.reserve.bind(usage);
      };

      it('writes the reservation and returns the totals without it', async () => {
        const { usage } = await open(SEED);
        const reserve = reserveIn(usage);
        await usage.record(row({ costUsd: 2 }));
        expect(UsageTotals.parse(await reserve(reservation(), windows()))).toMatchObject({ userDayUsd: 2, userDayBoundUsd: 0 });
        expect(UsageTotals.parse(await reserve(reservation(), windows()))).toMatchObject({ userDayUsd: 2, userDayBoundUsd: 0.81 });
        expect(await totals(usage, windows())).toMatchObject({ userDayBoundUsd: 1.62 });
      });

      it('the same id twice writes one reservation and returns the totals both times', async () => {
        const { usage } = await open(SEED);
        const reserve = reserveIn(usage);
        const once = reservation();
        expect(UsageTotals.parse(await reserve(once, windows()))).toMatchObject({ userDayBoundUsd: 0 });
        expect(UsageTotals.parse(await reserve(once, windows()))).toMatchObject({ userDayBoundUsd: 0 });
        expect(await totals(usage, windows())).toMatchObject({ userDayBoundUsd: 0.81 });
      });

      it('reservations that race are put in order: each one sees a different number before it', async () => {
        const { usage } = await open(SEED);
        const reserve = reserveIn(usage);
        const seen = await Promise.all(Array.from({ length: 20 }, async () => UsageTotals.parse(await reserve(reservation(), windows())).userDayBoundUsd));
        const before = seen.map((bound) => Math.round((bound ?? -1) / 0.81)).sort((a, b) => a - b);
        // Without the ordering, calls that start together would all see the same count.
        expect(before).toEqual(Array.from({ length: 20 }, (_, index) => index));
      });

      it('a job reservation counts in its job', async () => {
        const { usage } = await open(SEED);
        const reserve = reserveIn(usage);
        await reserve(reservation({ jobId: JOB }), windows({ jobId: JOB }));
        expect(UsageTotals.parse(await reserve(reservation({ jobId: JOB }), windows({ jobId: JOB })))).toMatchObject({ jobUsd: 0, jobBoundUsd: 0.81 });
      });
    });
  });
}
