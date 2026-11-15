// The gateway's own overhead per call, with N calls in flight at once: the real Anthropic client
// over the fake wire of helpers/fake-claude.ts, which answers at once, and the in-memory stores of
// helpers/fake-stores.ts. What is timed is everything the gateway does around the request: the
// config reads, the first cap check, the reservation, the second check, the request and its
// parsing, and the row that settles the reservation.
//
// Two bursts. Under the cap, all N calls go out and settle. At the cap, the second check refuses
// all N before any request leaves. After each burst (outside the timed part) the ledger is checked:
// the cap held. A burst that broke it fails the bench, whatever its speed.
//
//   npm run bench
//
// The numbers are compared with test/bench/baseline.json by `npm run bench:compare`.

import { expect, test } from 'vitest';
import { z } from 'zod';
import { CapError } from '../src/errors.ts';
import type { GatewayRequest } from '../src/gateway.ts';
import { fakeMessage, fakeUsage, jsonResponse, textBlock } from './helpers/fake-claude.ts';
import { earlierRow, GLOBAL_CAPS, setup, USER } from './helpers/fake-stores.ts';

const CONCURRENT = 50;

const Triage = z.object({ category: z.enum(['billing', 'bug', 'question']), priority: z.int().min(1).max(5) });
const TRIAGE = { category: 'bug', priority: 2 } as const;

/** maxTokens is small so that 50 reservations at once (about US$0.016 each) stay far below the daily cap. */
const REQUEST = {
  task: 'triage',
  userId: USER,
  promptVersion: 'triage@bench',
  maxTokens: 256,
  system: ['Global instructions', 'Per-tenant context'],
  messages: [{ role: 'user', content: '<ticket>Fictional ticket text</ticket>' }],
} satisfies GatewayRequest;

/** 1200 input and 300 output at the Sonnet 5.5 fixture prices: 1200 x 2 + 300 x 10 = 5400 per million. */
const USAGE = fakeUsage({ input_tokens: 1200, output_tokens: 300 });
const CALL_COST = 0.0054;
const answer = () => jsonResponse(fakeMessage({ content: [textBlock(JSON.stringify(TRIAGE))], usage: USAGE }));

type Burst = ReturnType<typeof setup> & { results: PromiseSettledResult<unknown>[] };

function newBurst(spentBefore: number): Burst {
  const burst = setup(Array.from({ length: CONCURRENT }, () => answer));
  if (spentBefore > 0) burst.harness.ledger.push(earlierRow({ costUsd: spentBefore }));
  return { ...burst, results: [] };
}

async function run(burst: Burst): Promise<void> {
  burst.results = await Promise.allSettled(Array.from({ length: CONCURRENT }, () => burst.gateway.structured(Triage, REQUEST)));
}

const spent = (burst: Burst): number => Math.round(burst.harness.calls.reduce((total, row) => total + (row.costUsd ?? 0), 0) * 1e6) / 1e6;

test(`gateway: ${CONCURRENT} concurrent calls under the cap all settle`, async ({ bench }) => {
  let burst = newBurst(0);
  const broken: string[] = [];
  let bursts = 0;
  await bench(
    'gateway/concurrent-50-under-cap',
    {
      writeResult: 'reports/bench/raw/gateway/concurrent-50-under-cap.json',
      beforeEach: () => {
        burst = newBurst(0);
      },
      afterEach: () => {
        bursts += 1;
        const passed = burst.results.filter((r) => r.status === 'fulfilled').length;
        if (passed !== CONCURRENT) broken.push(`${passed} of ${CONCURRENT} calls passed`);
        if (burst.requests.length !== CONCURRENT) broken.push(`${burst.requests.length} requests left`);
        if (burst.harness.openReservations.length !== 0) broken.push(`${burst.harness.openReservations.length} reservations left open`);
        if (burst.harness.calls.length !== CONCURRENT) broken.push(`${burst.harness.calls.length} rows in the ledger`);
        if (spent(burst) !== Math.round(CONCURRENT * CALL_COST * 1e6) / 1e6) broken.push(`US$${spent(burst)} recorded`);
        if (spent(burst) >= GLOBAL_CAPS.dailyPerUserUsd) broken.push('the daily cap was passed');
      },
    },
    () => run(burst),
  ).run();
  expect(bursts).toBeGreaterThan(0);
  expect(broken).toEqual([]);
});

test(`gateway: ${CONCURRENT} concurrent calls at the cap are all refused before any request`, async ({ bench }) => {
  // US$9.50 of the US$10 daily cap is spent. One reservation fits; 50 at once do not, and each
  // call's second check sees the other 49.
  const SPENT_BEFORE = 9.5;
  let burst = newBurst(SPENT_BEFORE);
  const broken: string[] = [];
  let bursts = 0;
  await bench(
    'gateway/concurrent-50-at-cap',
    {
      writeResult: 'reports/bench/raw/gateway/concurrent-50-at-cap.json',
      beforeEach: () => {
        burst = newBurst(SPENT_BEFORE);
      },
      afterEach: () => {
        bursts += 1;
        const refused = burst.results.filter((r) => r.status === 'rejected' && r.reason instanceof CapError && r.reason.code === 'cap_daily_user').length;
        if (refused !== CONCURRENT) broken.push(`${refused} of ${CONCURRENT} calls refused by the daily cap`);
        if (burst.requests.length !== 0) broken.push(`${burst.requests.length} requests left`);
        if (burst.harness.openReservations.length !== 0) broken.push(`${burst.harness.openReservations.length} reservations left open`);
        if (spent(burst) !== SPENT_BEFORE) broken.push(`US$${spent(burst)} recorded, US$${SPENT_BEFORE} before the burst`);
      },
    },
    () => run(burst),
  ).run();
  expect(bursts).toBeGreaterThan(0);
  expect(broken).toEqual([]);
});
