/**
 * The gateway over the Postgres adapter, end to end and offline: the real Anthropic client over
 * the fake HTTP API, and a real Postgres in process (PGlite) with sql/schema.sql applied. The
 * time is the system's, because created_at is the database's now().
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, CapError, ReservationError } from '../src/errors.ts';
import { createGateway, type FailureEvent, type GatewayRequest, type NoticeEvent } from '../src/gateway.ts';
import { BUILT_IN_REGISTRY } from '../src/models.ts';
import { systemClock, type LogData } from '../src/ports.ts';
import type { PgQueryable, PostgresStores } from '../src/postgres-store.ts';
import { fakeApi, fakeMessage, fakeUsage, jsonResponse, sseResponse, textBlock, type Responder } from './helpers/fake-claude.ts';
import { earlierRow, GLOBAL_CAPS, NO_OWN_CAPS, OTHER_USER, PRICES, TASKS, USER } from './helpers/fake-stores.ts';
import { ledger, openDb, openReservations, seedDb } from './helpers/pg.ts';

const SEED = { prices: PRICES, tasks: TASKS, globalCaps: GLOBAL_CAPS, accounts: { [USER]: NO_OWN_CAPS, [OTHER_USER]: NO_OWN_CAPS } };
const Verdict = z.object({ ok: z.boolean() });
const REQUEST = { task: 'triage', userId: USER, promptVersion: 'triage@1', maxTokens: 16_000, system: ['Triage the ticket'], messages: [{ role: 'user', content: 'Fictional ticket' }] } satisfies GatewayRequest;
/** At the Sonnet 5.5 fixture prices: 1200 x 2 + 300 x 10 = 5400 per million. */
const answer = () => fakeMessage({ content: [textBlock('{"ok":true}')], usage: fakeUsage({ input_tokens: 1200, output_tokens: 300 }) });

let db: PGlite;
beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  await db.close();
});

/** fail: throws without running the statement. run_then_fail: runs it and throws, like a response lost on the way back. */
type QueryFault = { readonly match: string; readonly kind: 'fail' | 'run_then_fail' };

async function setup(responders: readonly Responder[], faults: QueryFault[] = []) {
  const client: PgQueryable = {
    query: async (text, params) => {
      const at = faults.findIndex((fault) => text.includes(fault.match));
      const fault = at === -1 ? undefined : faults.splice(at, 1)[0];
      if (fault?.kind === 'fail') throw new Error('connection lost');
      const result = await db.query(text, params);
      if (fault?.kind === 'run_then_fail') throw new Error('connection lost');
      return result;
    },
  };
  const stores: PostgresStores = await seedDb(db, SEED, client);
  const api = fakeApi(responders);
  const notices: Array<{ event: NoticeEvent; data: LogData }> = [];
  const failures: Array<{ event: FailureEvent; data: LogData }> = [];
  const gateway = createGateway({
    client: api.client,
    clock: systemClock,
    ...stores,
    notices: { log: (event, data) => void notices.push({ event, data }) },
    failures: { log: (event, data) => void failures.push({ event, data }) },
    timeZone: 'UTC',
    timeoutMs: 60_000,
  });
  const spent = async (costUsd: number) => {
    const { createdAt: _createdAt, ...row } = earlierRow({ costUsd });
    await stores.usage.record(row);
  };
  return { ...api, stores, gateway, notices, failures, spent };
}

describe('a call through Postgres', () => {
  it('writes a reservation and the row that closes it, priced from model_prices', async () => {
    const { gateway, requests } = await setup([() => jsonResponse(answer())]);
    const { data, meta } = await gateway.structured(Verdict, REQUEST);
    expect(data).toEqual({ ok: true });
    expect(meta.costUsd).toBe(0.0054);
    expect(requests).toHaveLength(1);
    const rows = await ledger(db);
    expect(rows).toMatchObject([
      { reservation: true, incomplete: true, costUsd: null, replaces: null },
      { reservation: false, incomplete: false, costUsd: 0.0054, modelResponded: 'claude-sonnet-5-5', id: meta.usageId },
    ]);
    expect(rows[1]?.replaces).toBe(rows[0]?.id);
    expect(await openReservations(db)).toBe(0);
  });

  it('the registry price rows load once and stay as loaded', async () => {
    const { stores } = await setup([]);
    await stores.loadPrices(BUILT_IN_REGISTRY.priceRows());
    await stores.loadPrices(BUILT_IN_REGISTRY.priceRows().map((row) => ({ ...row, input: 999 })));
    const rows = await db.query<{ model: string; input: number; source: string }>(
      `select model, input::float8 as input, source from public.model_prices where valid_from = '2026-11-03T00:00:00Z' order by model`,
    );
    expect(rows.rows.map((row) => [row.model, row.input])).toEqual([
      ['claude-fable-5-1', 10],
      ['claude-fable-5-2', 8],
      ['claude-opus-5-5', 4],
      ['claude-sonnet-5-5', 2],
    ]);
    expect(rows.rows[0]?.source).toContain('checked 2026-11-03');
  });
});

describe('reservations that race', () => {
  it('twelve calls at once with room for three: three go out, nine are refused, the cap holds', async () => {
    // US$8 spent of the US$10 daily cap, each reservation just over US$0.80: the first three
    // reservations in lock order see 8.00, 8.80 and 9.61 and pass; the fourth sees 10.41.
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const held: Responder = async () => {
      await gate;
      return jsonResponse(answer());
    };
    const { gateway, requests, spent } = await setup(Array.from({ length: 12 }, () => held));
    await spent(8);

    const calls = Array.from({ length: 12 }, () => gateway.structured(Verdict, REQUEST));
    const settled = Promise.allSettled(calls);
    // While the three that passed are still in flight, the other nine have already been refused.
    await vi.waitFor(async () => expect(await openReservations(db)).toBe(3), { timeout: 20_000 });
    expect(requests).toHaveLength(3);
    release();

    const results = await settled;
    const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(refused).toHaveLength(9);
    for (const reason of refused) {
      expect(reason).toBeInstanceOf(CapError);
      expect(reason).toMatchObject({ code: 'cap_daily_user', capUsd: 10 });
    }
    expect(requests).toHaveLength(3);
    expect(await openReservations(db)).toBe(0);
    const rows = await ledger(db);
    // 1 earlier row, 12 reservations, 3 measured rows and 9 zero-usage rows for the refusals.
    expect(rows).toHaveLength(25);
    expect(rows.filter((row) => row.errorCode === 'cap_daily_user' && row.costUsd === 0)).toHaveLength(9);
    const total = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    expect(total).toBeCloseTo(8 + 3 * 0.0054, 6);
    expect(total).toBeLessThan(10);
  });

  it('reserve_usage refuses a transaction whose snapshot would hide other reservations', async () => {
    const { stores } = await setup([]);
    const { createdAt: _createdAt, ...row } = earlierRow({ reservation: true, modelResponded: null, costUsd: null, stopReason: null, durationMs: null, incomplete: true, estimatedInputTokens: 10 });
    const hourAgo = new Date(Date.now() - 3_600_000);
    await db.exec('begin isolation level repeatable read');
    try {
      await expect(stores.usage.reserve(row, { dayStart: hourAgo, monthStart: hourAgo, userId: USER, jobId: null })).rejects.toThrow(/READ COMMITTED/);
    } finally {
      await db.exec('rollback');
    }
    expect(await ledger(db)).toEqual([]);
  });
});

describe('a reservation that cannot be written', () => {
  it('fails twice: ReservationError, no row and no call', async () => {
    const fail: QueryFault = { match: 'reserve_usage', kind: 'fail' };
    const { gateway, requests, failures } = await setup([], [fail, { ...fail }]);
    await expect(gateway.structured(Verdict, REQUEST)).rejects.toBeInstanceOf(ReservationError);
    expect(requests).toHaveLength(0);
    expect(await ledger(db)).toEqual([]);
    expect(failures.map((f) => f.event)).toEqual(['reservation_failed']);
  });

  it('fails once: the retry writes it and the call goes on', async () => {
    const { gateway, requests, notices } = await setup([() => jsonResponse(answer())], [{ match: 'reserve_usage', kind: 'fail' }]);
    await gateway.structured(Verdict, REQUEST);
    expect(requests).toHaveLength(1);
    expect(notices.map((n) => n.event)).toEqual(['record_retried']);
    expect((await ledger(db)).filter((row) => row.reservation)).toHaveLength(1);
  });

  it('is written but its response is lost: the retry with the same id does not write a second one', async () => {
    const { gateway, notices } = await setup([() => jsonResponse(answer())], [{ match: 'reserve_usage', kind: 'run_then_fail' }]);
    const { meta } = await gateway.structured(Verdict, REQUEST);
    expect(meta.costUsd).toBe(0.0054);
    expect(notices.map((n) => n.event)).toEqual(['record_retried']);
    expect(await ledger(db)).toHaveLength(2);
    expect(await openReservations(db)).toBe(0);
  });

  it('a closing row whose response is lost is not written twice either', async () => {
    const { gateway } = await setup([() => jsonResponse(answer())], [{ match: 'insert into public.llm_usage', kind: 'run_then_fail' }]);
    await gateway.structured(Verdict, REQUEST);
    expect(await ledger(db)).toHaveLength(2);
  });

  it('a closing row that fails twice leaves the reservation open, counting at its worst case', async () => {
    const fail: QueryFault = { match: 'insert into public.llm_usage', kind: 'fail' };
    const { gateway, stores, failures } = await setup([() => jsonResponse(answer())], [fail, { ...fail }]);
    await expect(gateway.structured(Verdict, REQUEST)).rejects.toMatchObject({ code: 'record_failed', costUsd: 0.0054 });
    expect(failures.map((f) => f.event)).toEqual(['record_failed']);
    expect(await openReservations(db)).toBe(1);
    const hourAgo = new Date(Date.now() - 3_600_000);
    const totals = await stores.usage.totalsForCaps({ dayStart: hourAgo, monthStart: hourAgo, userId: USER, jobId: null });
    expect(totals).toMatchObject({ userDayUsd: 0, userDayUnpriced: 0 });
    // 16,000 output tokens at the highest fixture price (50) alone are 0.80.
    expect((totals as { userDayBoundUsd: number }).userDayBoundUsd).toBeGreaterThan(0.8);
  });
});

describe('settling after a cut stream', () => {
  it('a stream cut after message_start closes the reservation with an incomplete row at its worst case', async () => {
    const { gateway, stores } = await setup([() => sseResponse(answer(), { cutAfter: 1 })]);
    const error = await gateway.structuredStream(Verdict, REQUEST).final.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'connection' });

    const rows = await ledger(db);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ reservation: false, incomplete: true, costUsd: null, errorCode: 'connection', inputTokens: 1200, modelResponded: 'claude-sonnet-5-5', estimatedInputTokens: null });
    expect((error as ApiError).usageId).toBe(rows[1]?.id);
    expect(await openReservations(db)).toBe(0);
    const hourAgo = new Date(Date.now() - 3_600_000);
    // Measured input and message_start's one output token at the Sonnet price, plus max_tokens of
    // output: 1200 x 2 + 1 x 10 + 16000 x 10 = 162,410 per million.
    expect(await stores.usage.totalsForCaps({ dayStart: hourAgo, monthStart: hourAgo, userId: USER, jobId: null })).toMatchObject({
      userDayUsd: 0,
      userDayUnpriced: 1,
      userDayBoundUsd: 0.16241,
    });
  });

  it('a stream cut before message_start keeps the estimated input in the bound', async () => {
    const { gateway } = await setup([() => sseResponse(answer(), { cutAfter: 0 })]);
    await expect(gateway.structuredStream(Verdict, REQUEST).final).rejects.toBeInstanceOf(ApiError);
    const rows = await ledger(db);
    expect(rows[1]).toMatchObject({ incomplete: true, costUsd: null, inputTokens: 0, modelResponded: null });
    expect(rows[1]?.estimatedInputTokens).toBe(rows[0]?.estimatedInputTokens);
    expect(rows[1]?.estimatedInputTokens).toBeGreaterThan(0);
  });
});

describe('model_prices', () => {
  it.each(['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'])('refuses a %s price of zero, which would price calls at nothing', async (column) => {
    await seedDb(db, SEED);
    const values = { input: 2, output: 10, cache_read: 0.2, cache_write_5m: 2.5, cache_write_1h: 4, [column]: 0 };
    const insert = db.query(
      `insert into public.model_prices (model, valid_from, input, output, cache_read, cache_write_5m, cache_write_1h, source) values ('claude-sonnet-5-5', now(), $1, $2, $3, $4, $5, 'test')`,
      [values.input, values.output, values.cache_read, values.cache_write_5m, values.cache_write_1h],
    );
    await expect(insert).rejects.toThrow(`model_prices_${column}_positive`);
  });
});
