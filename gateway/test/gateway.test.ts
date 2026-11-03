/**
 * The gateway end to end, offline: the real Anthropic client over a fake HTTP API
 * (helpers/fake-claude.ts) and the in-memory stores (helpers/fake-stores.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { estimateInputTokens } from '../src/cost.ts';
import { ApiError, CapError, ConfigError, GatewayError, RecordError, RequestError, ReservationError, ResponseError, SetupError } from '../src/errors.ts';
import { createGateway, MAX_TOKENS_WITHOUT_STREAMING, type GatewayRequest } from '../src/gateway.ts';
import { FALLBACK_DEFAULT_BETA } from '../src/models.ts';
import { toApiJsonSchema } from '../src/schema.ts';
import {
  bodyThatFails,
  connectionRefused,
  connectTimesOut,
  errorResponse,
  fakeApi,
  fakeMessage,
  fakeUsage,
  fallbackBlock,
  hangs,
  jsonResponse,
  refusalDetails,
  REQUEST_ID,
  sseResponse,
  sseThatKeepsGoing,
  textBlock,
  thinkingBlock,
} from './helpers/fake-claude.ts';
import { CLOCK_STEP_MS, earlierRow, fakeDeps, JOB, NOW, OTHER_USER, setup, StoreError, USER, type Harness } from './helpers/fake-stores.ts';

const Triage = z.object({
  category: z.enum(['billing', 'bug', 'question']),
  priority: z.int().min(1).max(5),
  tags: z.array(z.object({ tag: z.string(), confidence: z.enum(['low', 'medium', 'high']) })),
});
const TRIAGE = { category: 'bug', priority: 2, tags: [{ tag: 'login', confidence: 'high' }] } as const;

const REQUEST = {
  task: 'triage',
  userId: USER,
  promptVersion: 'triage@1',
  maxTokens: 16_000,
  system: ['Global instructions', 'Per-tenant context'],
  messages: [{ role: 'user', content: '<ticket>Fictional ticket text</ticket>' }],
} satisfies GatewayRequest;

/** 1200 input, 300 output (120 of it thinking) and 5000 read from cache. */
const TRIAGE_USAGE = fakeUsage({ input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000, output_tokens_details: { thinking_tokens: 120 } });
/** At the Sonnet 5.5 fixture prices: 1200 x 2 + 300 x 10 + 5000 x 0.20 = 6400 per million. */
const TRIAGE_COST = 0.0064;

const PDF = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjcK'.repeat(1000) } } as const;
const IMAGE_URL = { type: 'image', source: { type: 'url', url: 'https://example.test/scan.png' } } as const;
const READ_IT = { type: 'text', text: 'Extract the fields' } as const;
const WITH_BREAKPOINT = { type: 'text' as const, text: 'Ticket', cache_control: { type: 'ephemeral' as const } };

function triageResponse(partial: Parameters<typeof fakeMessage>[0] = {}) {
  return fakeMessage({ content: [thinkingBlock(), textBlock(JSON.stringify(TRIAGE))], usage: TRIAGE_USAGE, ...partial });
}

/** The error a promise rejects with, to inspect it whole. */
async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error('The call did not fail');
}

/** The system blocks and the format the gateway sends for REQUEST, for computing the input estimate. */
function sentParts(messages: GatewayRequest['messages'] = REQUEST.messages) {
  return {
    system: REQUEST.system.map((text) => ({ type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } })),
    messages: [...messages],
    output_config: { effort: 'medium' as const, format: { type: 'json_schema' as const, schema: toApiJsonSchema(z.toJSONSchema(Triage, { io: 'input' })) } },
  };
}

describe('structured', () => {
  it('validates the output with zod and returns the data, the content as received and the call meta', async () => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
    const result = await gateway.structured(Triage, REQUEST);

    expect(result.data).toEqual(TRIAGE);
    // The thinking block comes first: content is read by type, never by position.
    expect(result.content.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect(result.meta).toEqual({
      usageId: harness.calls[0]?.id,
      requestId: REQUEST_ID,
      modelRequested: 'claude-sonnet-5-5',
      modelResponded: 'claude-sonnet-5-5',
      fellBack: false,
      effort: 'medium',
      costUsd: TRIAGE_COST,
      durationMs: CLOCK_STEP_MS,
      tokens: { input: 1200, output: 300, cacheRead: 5000, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 120 },
    });
  });

  it('sends the verified request: beta messages, fallbacks "default", the task effort and nothing else', async () => {
    const { gateway, requests } = setup([() => jsonResponse(triageResponse())]);
    await gateway.structured(Triage, REQUEST);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(requests[0]?.headers.get('anthropic-beta')).toBe(FALLBACK_DEFAULT_BETA);
    expect(requests[0]?.body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 16_000,
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: toApiJsonSchema(z.toJSONSchema(Triage, { io: 'input' })) } },
      system: [
        { type: 'text', text: 'Global instructions', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Per-tenant context', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: '<ticket>Fictional ticket text</ticket>' }],
    });
  });

  it('never sends temperature, top_p, top_k, thinking, tool_choice, tools or a prefill', async () => {
    const { gateway, requests } = setup([
      () => jsonResponse(triageResponse()),
      () => jsonResponse(fakeMessage({ model: 'claude-fable-5-1', content: [textBlock('"ok"')] })),
    ]);
    await gateway.structured(Triage, REQUEST);
    await gateway.structured(z.string(), { ...REQUEST, task: 'extract', hardCase: true });
    for (const { body } of requests) {
      for (const forbidden of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools', 'stop_sequences']) expect(body).not.toHaveProperty(forbidden);
      const messages = z.array(z.object({ role: z.string() })).parse(body['messages']);
      expect(messages.at(-1)?.role).toBe('user');
    }
  });

  it('keeps the enum in the schema it sends, and moves the range zod enforces into the description', async () => {
    const { gateway, requests } = setup([() => jsonResponse(triageResponse())]);
    await gateway.structured(Triage, REQUEST);
    expect(requests[0]?.body).toHaveProperty('output_config.format.schema.properties.category.enum', ['billing', 'bug', 'question']);
    expect(requests[0]?.body).toHaveProperty('output_config.format.schema.properties.priority', { type: 'integer', description: '{"minimum":1,"maximum":5}' });
  });

  it('writes a worst-case reservation before calling, and the response row closes it', async () => {
    let openWhenCalled: unknown[] = [];
    const { gateway, harness } = setup([
      () => {
        openWhenCalled = [...harness.openReservations];
        return jsonResponse(triageResponse());
      },
    ]);
    await gateway.structured(Triage, { ...REQUEST, jobId: JOB });

    const [reservation] = harness.ledger;
    expect(openWhenCalled).toEqual([reservation]);
    expect(reservation).toMatchObject({
      reservation: true,
      userId: USER,
      task: 'triage',
      jobId: JOB,
      modelRequested: 'claude-sonnet-5-5',
      modelResponded: null,
      incomplete: true,
      costUsd: null,
      maxTokens: 16_000,
      estimatedInputTokens: estimateInputTokens(sentParts()),
    });
    expect(harness.calls).toEqual([expect.objectContaining({ replaces: reservation?.id, costUsd: TRIAGE_COST })]);
    expect(harness.openReservations).toEqual([]);
  });

  it('records every field of the call in the ledger', async () => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
    const { meta } = await gateway.structured(Triage, { ...REQUEST, jobId: JOB });
    const { createdAt: _createdAt, ...row } = harness.calls[0] ?? { createdAt: null };
    expect(row).toEqual({
      id: meta.usageId,
      reservation: false,
      replaces: harness.ledger[0]?.id,
      userId: USER,
      task: 'triage',
      jobId: JOB,
      effort: 'medium',
      promptVersion: 'triage@1',
      modelRequested: 'claude-sonnet-5-5',
      modelResponded: 'claude-sonnet-5-5',
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 5000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      thinkingTokens: 120,
      costUsd: TRIAGE_COST,
      stopReason: 'end_turn',
      refusalCategory: null,
      attempts: null,
      requestId: REQUEST_ID,
      durationMs: CLOCK_STEP_MS,
      maxTokens: 16_000,
      incomplete: false,
      estimatedInputTokens: null,
      errorCode: null,
    });
  });

  it('asks for usage with the day and month windows of the configured time zone', async () => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
    await gateway.structured(Triage, { ...REQUEST, jobId: JOB });
    const windows = { dayStart: new Date('2026-10-23T03:00:00Z'), monthStart: new Date('2026-10-01T03:00:00Z'), userId: USER, jobId: JOB };
    // Once before the reservation, and once after it without the call's own reservation.
    expect(harness.windowsRequested).toEqual([windows, { ...windows, excludeId: harness.ledger[0]?.id }]);
  });

  it('output that is not JSON, or fails the schema: invalid_output, with the call recorded and no model text in the error', async () => {
    const { gateway, harness } = setup([
      () => jsonResponse(triageResponse({ content: [textBlock('Not JSON at all')] })),
      () => jsonResponse(triageResponse({ content: [textBlock(JSON.stringify({ ...TRIAGE, priority: 9 }))] })),
    ]);
    const notJson = await failure(gateway.structured(Triage, REQUEST));
    const outOfRange = await failure(gateway.structured(Triage, REQUEST));

    expect(notJson).toBeInstanceOf(ResponseError);
    expect(notJson).toMatchObject({ code: 'invalid_output', problems: [{ path: '', code: 'invalid_json' }], usageId: harness.calls[0]?.id });
    expect(outOfRange).toMatchObject({ code: 'invalid_output', problems: [{ path: 'priority', code: 'too_big' }], costUsd: TRIAGE_COST });
    expect(harness.calls).toHaveLength(2);
    expect(`${notJson.message} ${JSON.stringify(notJson)}`).not.toContain('Not JSON at all');
  });

  it('refusal: checks stop_reason before the partial content and reports the category', async () => {
    const { gateway, harness } = setup([
      () => jsonResponse(triageResponse({ content: [textBlock('{"category": "bu')], stop_reason: 'refusal', stop_details: refusalDetails('cyber', 'claude-sonnet-5') })),
    ]);
    const error = await failure(gateway.structured(Triage, REQUEST));
    expect(error).toBeInstanceOf(ResponseError);
    expect(error).toMatchObject({ code: 'refusal', refusalCategory: 'cyber', recommendedModel: 'claude-sonnet-5', stopReason: 'refusal', problems: [] });
    expect(harness.calls[0]).toMatchObject({ stopReason: 'refusal', refusalCategory: 'cyber', costUsd: TRIAGE_COST });
  });

  it.each([
    ['max_tokens', 'truncated'],
    ['model_context_window_exceeded', 'context_window_exceeded'],
    ['pause_turn', 'unexpected_stop_reason'],
    ['tool_use', 'unexpected_stop_reason'],
    ['stop_sequence', 'unexpected_stop_reason'],
  ] as const)('stop_reason %s is %s, and the call is recorded', async (stopReason, code) => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse({ stop_reason: stopReason }))]);
    expect(await failure(gateway.structured(Triage, REQUEST))).toMatchObject({ code, stopReason });
    expect(harness.calls).toEqual([expect.objectContaining({ stopReason, costUsd: TRIAGE_COST })]);
  });

  describe('server-side fallback', () => {
    /** Sonnet 5.5 refused (cyber) before answering and Sonnet 5 answered. */
    const withFallback = () =>
      triageResponse({
        model: 'claude-sonnet-5',
        content: [fallbackBlock('claude-sonnet-5-5', 'claude-sonnet-5', 'cyber'), textBlock(JSON.stringify(TRIAGE))],
        usage: fakeUsage({
          input_tokens: 1000,
          output_tokens: 500,
          output_tokens_details: { thinking_tokens: 90 },
          iterations: [
            { type: 'message', model: null, input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
            { type: 'fallback_message', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          ],
        }),
      });

    it('prices each iteration at its own model and keeps the per-attempt breakdown', async () => {
      const { gateway, harness } = setup([() => jsonResponse(withFallback())]);
      // A fixture price for the fallback model, different from Sonnet 5.5 so the split shows.
      harness.stores.prices.rows.push({ model: 'claude-sonnet-5', validFrom: '2026-10-01T00:00:00Z', input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 });
      const { data, meta } = await gateway.structured(Triage, REQUEST);

      expect(data).toEqual(TRIAGE);
      // Sonnet 5.5: 1000 x 2. Sonnet 5: 1000 x 3 + 500 x 15. Total 12,500 per million.
      expect(meta).toMatchObject({ modelRequested: 'claude-sonnet-5-5', modelResponded: 'claude-sonnet-5', fellBack: true, costUsd: 0.0125, tokens: { input: 2000, output: 500, thinking: null } });
      expect(harness.calls[0]).toMatchObject({
        costUsd: 0.0125,
        // With several attempts the API reports thinking only for the last one: not mixed in.
        thinkingTokens: null,
        attempts: [
          { kind: 'message', model: 'claude-sonnet-5-5', input: 1000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          { kind: 'fallback_message', model: 'claude-sonnet-5', input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        ],
      });
      expect(harness.notices).toEqual([]);
    });

    it('an unpriced fallback model leaves the cost null with a notice, and the response is still usable', async () => {
      const { gateway, harness } = setup([() => jsonResponse(withFallback())]);
      const { data, meta } = await gateway.structured(Triage, REQUEST);
      expect(data).toEqual(TRIAGE);
      expect(meta.costUsd).toBeNull();
      expect(harness.calls[0]).toMatchObject({ costUsd: null, inputTokens: 2000, outputTokens: 500 });
      expect(harness.notices).toEqual([{ event: 'model_unpriced', data: { usageId: meta.usageId, models: ['claude-sonnet-5'] } }]);
    });

    it('if the whole chain refuses, it is a refusal even though the fallback ran', async () => {
      const { gateway } = setup([
        () => jsonResponse({ ...withFallback(), content: [fallbackBlock('claude-sonnet-5-5', 'claude-sonnet-5', 'cyber')], stop_reason: 'refusal', stop_details: refusalDetails('cyber') }),
      ]);
      expect(await failure(gateway.structured(Triage, REQUEST))).toMatchObject({ code: 'refusal', modelResponded: 'claude-sonnet-5' });
    });
  });

  it('a tariff the price table lacks (a pinned region) leaves the cost null with a notice', async () => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse({ usage: { ...TRIAGE_USAGE, inference_geo: 'us' } }))]);
    const { meta } = await gateway.structured(Triage, REQUEST);
    expect(meta.costUsd).toBeNull();
    expect(harness.calls[0]).toMatchObject({ costUsd: null, inputTokens: 1200 });
    expect(harness.notices).toEqual([{ event: 'tariff_unpriced', data: { usageId: meta.usageId, modifiers: ['inference_geo:us'] } }]);
  });

  it('if the price table does not answer, the call is recorded without cost and a notice says why', async () => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
    harness.pricesError = new StoreError('connection_failure');
    const { meta } = await gateway.structured(Triage, REQUEST);
    expect(meta.costUsd).toBeNull();
    expect(harness.calls[0]?.inputTokens).toBe(1200);
    expect(harness.notices).toEqual([{ event: 'prices_unavailable', data: { usageId: meta.usageId, error: 'connection_failure' } }]);
  });

  it('a call without a user reads no account caps and only the monthly cap applies', async () => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
    harness.stores.config.accounts.clear();
    await gateway.structured(Triage, { ...REQUEST, userId: null, promptVersion: 'triage@2' });
    expect(harness.windowsRequested[0]).toMatchObject({ userId: null, jobId: null });
    expect(harness.calls[0]).toMatchObject({ userId: null, promptVersion: 'triage@2' });
  });

  describe('config carried by the request', () => {
    it('an eval run tries another model and effort without reading the task config', async () => {
      const { gateway, harness, requests } = setup([() => jsonResponse(triageResponse({ model: 'claude-opus-5-5' }))]);
      // If it read the config, a missing row would fail with invalid_config.
      harness.stores.config.tasks.delete('triage');
      await gateway.structured(Triage, { ...REQUEST, userId: null, config: { model: 'claude-opus-5-5', effort: 'low' } });
      expect(requests[0]?.body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low' } });
      expect(harness.calls[0]).toMatchObject({ modelRequested: 'claude-opus-5-5', effort: 'low' });
    });

    it('a job that froze its config keeps it when the task config changes halfway', async () => {
      const { gateway, harness, requests } = setup([() => jsonResponse(triageResponse()), () => jsonResponse(triageResponse())]);
      const frozen = { ...REQUEST, jobId: JOB, config: { model: 'claude-sonnet-5-5', effort: 'medium' } } satisfies GatewayRequest;
      await gateway.structured(Triage, frozen);
      harness.stores.config.tasks.set('triage', { task: 'triage', model: 'claude-opus-5-5', effort: 'high', hardCaseEffort: null });
      await gateway.structured(Triage, frozen);
      for (const request of requests) expect(request.body).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'medium' } });
    });
  });

  it('a hard case uses hardCaseEffort when the task has one, and keeps the normal effort otherwise', async () => {
    const { gateway, requests } = setup([
      () => jsonResponse(fakeMessage({ model: 'claude-fable-5-1', content: [textBlock('"ok"')] })),
      () => jsonResponse(triageResponse()),
    ]);
    await gateway.structured(z.string(), { ...REQUEST, task: 'extract', hardCase: true });
    await gateway.structured(Triage, { ...REQUEST, hardCase: true });
    expect(requests[0]?.body).toMatchObject({ model: 'claude-fable-5-1', output_config: { effort: 'high' } });
    expect(requests[1]?.body).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'medium' } });
  });
});

describe('caps: a reached cap does not call the API', () => {
  it.each([
    {
      name: 'monthly global, even if another user spent it',
      ledger: [earlierRow({ userId: OTHER_USER, costUsd: 60, createdAt: new Date('2026-10-05T12:00:00Z') })],
      request: REQUEST,
      expected: { code: 'cap_monthly_global', spentUsd: 60, capUsd: 60 },
    },
    {
      name: 'daily per user',
      ledger: [earlierRow({ costUsd: 6 }), earlierRow({ costUsd: 4 })],
      request: REQUEST,
      expected: { code: 'cap_daily_user', spentUsd: 10, capUsd: 10 },
    },
    {
      name: 'per job, which can span earlier days',
      ledger: [earlierRow({ jobId: JOB, costUsd: 3, createdAt: new Date('2026-10-20T12:00:00Z') }), earlierRow({ jobId: JOB, costUsd: 2 })],
      request: { ...REQUEST, jobId: JOB },
      expected: { code: 'cap_per_job', spentUsd: 5, capUsd: 5 },
    },
  ])('$name', async ({ ledger, request, expected }) => {
    const { gateway, harness, requests } = setup([]);
    harness.ledger.push(...ledger);
    const error = await failure(gateway.structured(Triage, request));
    expect(error).toBeInstanceOf(CapError);
    expect(error).toMatchObject(expected);
    expect(requests).toHaveLength(0);
    // Not even a reservation: the caps are checked before writing it.
    expect(harness.ledger).toHaveLength(ledger.length);
  });

  it("an account's own cap can lower the global one", async () => {
    const { gateway, harness, requests } = setup([]);
    harness.stores.config.accounts.set(USER, { perJobUsd: null, dailyPerUserUsd: 1 });
    harness.ledger.push(earlierRow({ costUsd: 1 }));
    expect(await failure(gateway.structured(Triage, REQUEST))).toMatchObject({ code: 'cap_daily_user', capUsd: 1 });
    expect(requests).toHaveLength(0);
  });

  it('yesterday in the configured zone does not count for today, even when UTC already rolled over', async () => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
    // 2026-10-22 at 23:00 in Buenos Aires is already the 23rd in UTC.
    harness.ledger.push(earlierRow({ costUsd: 10, createdAt: new Date('2026-10-23T02:00:00Z') }));
    await expect(gateway.structured(Triage, REQUEST)).resolves.toMatchObject({ data: TRIAGE });
  });

  describe('concurrent calls: the second check after the reservation', () => {
    /** A reservation of another call in flight, worth just over US$0.80 at the highest fixture price. */
    const inFlight = () =>
      earlierRow({ reservation: true, modelResponded: null, costUsd: null, stopReason: null, durationMs: null, incomplete: true, estimatedInputTokens: 1000, maxTokens: 16_000 });

    it('refuses a call when another one reserved between its first check and its own reservation', async () => {
      const api = fakeApi([() => jsonResponse(triageResponse())]);
      const { deps, harness } = fakeDeps(api.client);
      harness.ledger.push(earlierRow({ costUsd: 9.5 }));
      let reads = 0;
      const gateway = createGateway({
        ...deps,
        usage: {
          ...deps.usage,
          totalsForCaps: async (windows, signal) => {
            const totals = await deps.usage.totalsForCaps(windows, signal);
            // Right after the first check passes, another call writes its reservation.
            reads += 1;
            if (reads === 1) harness.ledger.push(inFlight());
            return totals;
          },
        },
      });

      const error = await failure(gateway.structured(Triage, REQUEST));
      expect(error).toBeInstanceOf(CapError);
      expect(error).toMatchObject({ code: 'cap_daily_user', spentUsd: 10.31, unpricedBoundUsd: 0.81, capUsd: 10 });
      expect(api.requests).toHaveLength(0);
      // Its own reservation is closed with a zero-usage row; only the other call's stays open.
      expect(harness.calls).toMatchObject([{ costUsd: 9.5 }, { costUsd: 0, errorCode: 'cap_daily_user', modelResponded: null }]);
      expect(harness.openReservations).toHaveLength(1);
    });

    it('parallel calls near a cap overrun it by at most one worst case', async () => {
      // US$8 spent of the US$10 daily cap, each reservation just over US$0.80: called one after
      // another, three calls start (8, 8.8 and 9.6 are below the cap) and the fourth is refused.
      const { gateway, harness, requests } = setup(Array.from({ length: 6 }, () => () => jsonResponse(triageResponse())));
      harness.ledger.push(earlierRow({ costUsd: 8 }));
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => gateway.structured(Triage, REQUEST)));

      const passed = results.filter((r) => r.status === 'fulfilled');
      const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
      // Without the second check all six would start. With it, at most the three of the sequential
      // case can. In this store all six reserve before any of them reads again, so all six are
      // refused: near a cap, a burst errs toward refusing.
      expect(passed.length).toBeLessThanOrEqual(3);
      expect(requests).toHaveLength(passed.length);
      for (const reason of refused) expect(reason).toMatchObject({ code: 'cap_daily_user' });
      expect(harness.openReservations).toEqual([]);
    });

    it('a store failure in the second check refuses the call and closes the reservation', async () => {
      const api = fakeApi([() => jsonResponse(triageResponse())]);
      const { deps, harness } = fakeDeps(api.client);
      const gateway = createGateway({
        ...deps,
        usage: {
          ...deps.usage,
          totalsForCaps: async (windows, signal) => {
            if (windows.excludeId !== undefined) throw new StoreError('connection_failure');
            return deps.usage.totalsForCaps(windows, signal);
          },
        },
      });

      const error = await failure(gateway.structured(Triage, REQUEST));
      expect(error).toBeInstanceOf(ConfigError);
      expect(error).toMatchObject({ code: 'invalid_usage_totals' });
      expect(api.requests).toHaveLength(0);
      expect(harness.calls).toMatchObject([{ costUsd: 0, errorCode: 'invalid_usage_totals' }]);
      expect(harness.openReservations).toEqual([]);
    });
  });

  describe('unpriced calls count at their upper bound', () => {
    /** A model with no price answered (a turn that sticky routing sent straight to the fallback). */
    const unpriced = () => jsonResponse(fakeMessage({ model: 'claude-sonnet-5', content: [textBlock(JSON.stringify(TRIAGE))], usage: fakeUsage({ input_tokens: 100_000, output_tokens: 100_000 }) }));

    it.each([
      { name: 'a model without a price', prepare: (_h: Harness) => undefined },
      { name: 'a price table that was down while recording', prepare: (h: Harness) => void (h.pricesError = new StoreError('connection_failure')) },
    ])('$name: repeated unpriced calls end in CapError', async ({ prepare }) => {
      // Each at the highest price in force (Fable 5.1 fixture: 10 and 50 per million): 1 + 5 = US$6.
      const { gateway, harness, requests } = setup([unpriced, unpriced, unpriced]);
      prepare(harness);
      await gateway.structured(Triage, REQUEST);
      await gateway.structured(Triage, REQUEST);
      const third = await failure(gateway.structured(Triage, REQUEST));

      expect(harness.calls.map((row) => row.costUsd)).toEqual([null, null]);
      expect(third).toMatchObject({ code: 'cap_daily_user', spentUsd: 12, unpricedBoundUsd: 12, capUsd: 10 });
      expect(requests).toHaveLength(2);
    });

    it("logs when the user's cap was checked against a bound", async () => {
      const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
      harness.ledger.push(earlierRow({ costUsd: null, modelResponded: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 2000 }));
      await gateway.structured(Triage, REQUEST);
      expect(harness.notices).toEqual([
        { event: 'unpriced_calls_in_window', data: { task: 'triage', userDayUnpriced: 1, userDayBoundUsd: 0.11, jobUnpriced: null, jobBoundUsd: null } },
      ]);
    });

    it("another user's unpriced call counts in the global month but does not log on everyone else's calls", async () => {
      const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
      harness.ledger.push(earlierRow({ userId: OTHER_USER, costUsd: null, modelResponded: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 2000 }));
      await gateway.structured(Triage, REQUEST);
      expect(harness.notices).toEqual([]);
      // With 59.90 spent this month, the 0.11 bound reaches the cap.
      harness.ledger.push(earlierRow({ userId: OTHER_USER, costUsd: 59.9 }));
      expect(await failure(gateway.structured(Triage, REQUEST))).toMatchObject({ code: 'cap_monthly_global', unpricedBoundUsd: 0.11 });
    });
  });
});

describe('invalid config or request: no API call', () => {
  it.each([
    { name: 'a model the gateway was not verified with', change: (h: Harness) => void h.stores.config.tasks.set('triage', { task: 'triage', model: 'claude-haiku-4-5', effort: 'low', hardCaseEffort: null }), code: 'invalid_config' },
    { name: 'a task without config', change: (h: Harness) => void h.stores.config.tasks.delete('triage'), code: 'invalid_config' },
    { name: 'no global caps row', change: (h: Harness) => void (h.stores.config.global = null), code: 'invalid_config' },
    { name: 'a user without an account caps row', change: (h: Harness) => void h.stores.config.accounts.delete(USER), code: 'unknown_account' },
  ])('$name: $code', async ({ change, code }) => {
    const { gateway, harness, requests } = setup([]);
    change(harness);
    const error = await failure(gateway.structured(Triage, REQUEST));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.code).toBe(code);
    expect(requests).toHaveLength(0);
  });

  it('usage totals that fail their schema: invalid_usage_totals', async () => {
    const { client, requests } = fakeApi([]);
    const { deps } = fakeDeps(client);
    const gateway = createGateway({ ...deps, usage: { ...deps.usage, totalsForCaps: async () => ({ monthUsd: 0 }) } });
    expect(await failure(gateway.structured(Triage, REQUEST))).toMatchObject({ code: 'invalid_usage_totals' });
    expect(requests).toHaveLength(0);
  });

  it('a malformed request fails before any store read', async () => {
    const { gateway, harness, requests } = setup([]);
    const malformed: GatewayRequest[] = [
      { ...REQUEST, promptVersion: ' ' },
      { ...REQUEST, task: '' },
      { ...REQUEST, maxTokens: 0 },
      { ...REQUEST, userId: 'not-a-uuid' },
      { ...REQUEST, jobId: 'neither' },
      { ...REQUEST, system: ['a', 'b', 'c', 'd', 'e'] },
      { ...REQUEST, system: [''] },
      { ...REQUEST, timeoutMs: -1 },
      // 2 in the system and 3 in the messages: the API allows 4 per request.
      { ...REQUEST, messages: [{ role: 'user', content: [WITH_BREAKPOINT, WITH_BREAKPOINT, WITH_BREAKPOINT] }] },
      { ...REQUEST, config: { model: 'claude-sonnet-5-5', effort: 'medium' }, hardCase: true },
      { ...REQUEST, maxTokens: MAX_TOKENS_WITHOUT_STREAMING + 1 },
      // Attachments need streaming, even with a bound.
      { ...REQUEST, messages: [{ role: 'user', content: [PDF, READ_IT] }], attachmentTokenBound: 10_000 },
      { ...REQUEST, messages: [{ role: 'user', content: [IMAGE_URL, READ_IT] }], attachmentTokenBound: 2_000 },
      // A bound without attachments bounds nothing.
      { ...REQUEST, attachmentTokenBound: 1_000 },
    ];
    for (const request of malformed) expect(await failure(gateway.structured(Triage, request))).toBeInstanceOf(RequestError);
    expect(harness.windowsRequested).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('allows up to 16,000 maxTokens without streaming, and more through structuredStream', async () => {
    const { gateway, requests } = setup([() => jsonResponse(triageResponse()), () => sseResponse(triageResponse())]);
    await gateway.structured(Triage, { ...REQUEST, maxTokens: 16_000 });
    expect(await failure(gateway.structured(Triage, { ...REQUEST, maxTokens: 64_000 }))).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('structuredStream') });
    await gateway.structuredStream(Triage, { ...REQUEST, maxTokens: 64_000 }).final;
    expect(requests.map((r) => r.body['max_tokens'])).toEqual([16_000, 64_000]);
  });

  it('with streaming, an attachment requires attachmentTokenBound as a positive integer', async () => {
    const { gateway, requests } = setup([]);
    const withPdf = { ...REQUEST, messages: [{ role: 'user', content: [PDF, READ_IT] }] } satisfies GatewayRequest;
    for (const request of [withPdf, { ...withPdf, attachmentTokenBound: 0 }, { ...withPdf, attachmentTokenBound: 1.5 }]) {
      expect(await failure(gateway.structuredStream(Triage, request).final)).toMatchObject({ code: 'invalid_request' });
    }
    expect(requests).toHaveLength(0);
  });

  it('counts message breakpoints together with the system ones: 4 pass', async () => {
    const { gateway, requests } = setup([() => jsonResponse(triageResponse())]);
    await gateway.structured(Triage, { ...REQUEST, messages: [{ role: 'user', content: [WITH_BREAKPOINT, WITH_BREAKPOINT, { type: 'text', text: 'no breakpoint' }] }] });
    expect(requests).toHaveLength(1);
  });

  it('a fixed config with an unverified model is a malformed request', async () => {
    const { gateway, requests } = setup([]);
    // @ts-expect-error: the type only accepts SUPPORTED_MODELS.
    const bad: GatewayRequest = { ...REQUEST, config: { model: 'claude-haiku-4-5', effort: 'low' } };
    expect(await failure(gateway.structured(Triage, bad))).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('config') });
    expect(requests).toHaveLength(0);
  });

  it('no prefill: the type rejects a conversation ending on an assistant turn, and so does the runtime check', async () => {
    const { gateway, requests } = setup([]);
    const withPrefill = {
      ...REQUEST,
      messages: [
        { role: 'user', content: 'Ticket' },
        { role: 'assistant', content: '{"category":' },
      ],
    } as const;
    // @ts-expect-error: Conversation always ends on a user turn.
    const promise = gateway.structured(Triage, withPrefill);
    expect(await failure(promise)).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('prefill') });
    expect(requests).toHaveLength(0);
  });
});

describe('API errors', () => {
  it.each([
    [400, 'invalid_request_error', 'bad_request', false],
    [401, 'authentication_error', 'authentication', false],
    [402, 'billing_error', 'billing', false],
    [403, 'permission_error', 'permission_denied', false],
    [404, 'not_found_error', 'not_found', false],
    [409, 'conflict_error', 'conflict', true],
    [413, 'request_too_large', 'bad_request', false],
    [429, 'rate_limit_error', 'rate_limited', true],
    [500, 'api_error', 'server_error', true],
    [529, 'overloaded_error', 'overloaded', true],
  ] as const)('HTTP %i %s is %s: one request, and the reservation closed with zero usage', async (status, type, code, retryable) => {
    const { gateway, harness, requests } = setup([() => errorResponse(status, type, { 'retry-after': '7' })]);
    const error = await failure(gateway.structured(Triage, REQUEST));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code, status, apiType: type, retryable, retryAfterSec: 7, requestId: REQUEST_ID, usageId: null });
    expect(requests).toHaveLength(1);
    // An HTTP error is not billed: the closing row adds nothing.
    expect(harness.calls).toEqual([
      expect.objectContaining({ replaces: harness.ledger[0]?.id, errorCode: code, costUsd: 0, incomplete: false, modelResponded: null, inputTokens: 0, outputTokens: 0, requestId: REQUEST_ID }),
    ]);
    expect(harness.openReservations).toEqual([]);
  });

  describe('a connection that never opened: connection, with zero usage, because the request did not leave', () => {
    it.each([
      ['connection refused', connectionRefused],
      // The SDK reported this one as a request timeout, which used to leave a worst-case row.
      ['connect timeout (a network outage)', connectTimesOut],
    ])('%s, without streaming', async (_name, responder) => {
      const { gateway, harness } = setup([responder]);
      expect(await failure(gateway.structured(Triage, REQUEST))).toMatchObject({ code: 'connection', retryable: true, usageId: null });
      expect(harness.calls).toEqual([expect.objectContaining({ errorCode: 'connection', costUsd: 0, incomplete: false })]);
      expect(harness.openReservations).toEqual([]);
      expect(harness.notices).toEqual([]);
    });

    it('connect timeout, with streaming', async () => {
      const { gateway, harness } = setup([connectTimesOut, connectTimesOut]);
      expect(await failure(gateway.structuredStream(Triage, REQUEST).final)).toMatchObject({ code: 'connection', usageId: null });
      expect(await failure(gateway.text({ ...REQUEST, task: 'draft' }))).toMatchObject({ code: 'connection', usageId: null });
      expect(harness.calls.map((row) => [row.errorCode, row.costUsd])).toEqual([
        ['connection', 0],
        ['connection', 0],
      ]);
      expect(harness.openReservations).toEqual([]);
    });

    it('an outage with retries does not fill the caps: twenty connect timeouts in a row never reach CapError', async () => {
      const { gateway, harness, requests } = setup(Array.from({ length: 20 }, () => connectTimesOut));
      for (let i = 0; i < 20; i += 1) expect(await failure(gateway.structured(Triage, REQUEST))).toMatchObject({ code: 'connection' });
      expect(requests).toHaveLength(20);
      expect(harness.calls.every((row) => row.costUsd === 0 && !row.incomplete)).toBe(true);
      expect(harness.openReservations).toEqual([]);
    });
  });

  /** The row a non-streaming cut leaves: nothing measured, the estimated input and max_tokens. */
  const unmeasuredCut = (code: string) => ({
    incomplete: true,
    costUsd: null,
    modelResponded: null,
    inputTokens: 0,
    outputTokens: 0,
    maxTokens: 16_000,
    estimatedInputTokens: estimateInputTokens(sentParts()),
    stopReason: null,
    errorCode: code,
  });

  it('the gateway timeout cuts the call: timeout, recorded as incomplete at its worst case', async () => {
    const { gateway, harness } = setup([hangs]);
    const error = await failure(gateway.structured(Triage, { ...REQUEST, timeoutMs: 30 }));
    expect(error).toMatchObject({ code: 'timeout', retryable: true, usageId: harness.calls[0]?.id });
    expect(harness.calls).toEqual([expect.objectContaining({ ...unmeasuredCut('timeout'), replaces: harness.ledger[0]?.id })]);
    expect(harness.notices).toEqual([
      { event: 'usage_unmeasured', data: expect.objectContaining({ usageId: harness.calls[0]?.id, code: 'timeout', streaming: false, inputMeasured: false, maxTokens: 16_000 }) },
    ]);
  });

  it("the caller's signal cuts the call: cancelled, also recorded at its worst case", async () => {
    const { gateway, harness } = setup([hangs]);
    const controller = new AbortController();
    const promise = gateway.structured(Triage, { ...REQUEST, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(await failure(promise)).toMatchObject({ code: 'cancelled', retryable: false, usageId: harness.calls[0]?.id });
    expect(harness.calls[0]).toMatchObject(unmeasuredCut('cancelled'));
  });

  it('a connection that drops while the body arrives: connection, and the API may already have billed it', async () => {
    const { gateway, harness } = setup([bodyThatFails(new TypeError('terminated'))]);
    expect(await failure(gateway.structured(Triage, REQUEST))).toMatchObject({ code: 'connection', retryable: true, usageId: harness.calls[0]?.id });
    expect(harness.calls[0]).toMatchObject(unmeasuredCut('connection'));
  });

  it('an error from outside the API, SDK and network comes out as is, and the reservation stays open at its worst case', async () => {
    const own = new RangeError('a bug of ours');
    const { gateway, harness } = setup([bodyThatFails(own)]);
    await expect(gateway.structured(Triage, REQUEST)).rejects.toBe(own);
    // Nobody knows whether the request left: it is not closed as unbilled.
    expect(harness.calls).toEqual([]);
    expect(harness.openReservations).toEqual([harness.ledger[0]]);
    expect(harness.notices).toEqual([{ event: 'usage_unmeasured', data: expect.objectContaining({ usageId: harness.ledger[0]?.id, code: null }) }]);
  });
});

describe('the ledger', () => {
  it('if an insert landed but its response was lost, the retry with the same id does not duplicate the row', async () => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
    // The first record is the reservation; the second, the response row.
    harness.recordBehavior = ['ok', 'store_then_fail'];
    const { meta } = await gateway.structured(Triage, REQUEST);
    expect(harness.recordAttempts.map((row) => row.id)).toEqual([harness.ledger[0]?.id, meta.usageId, meta.usageId]);
    expect(harness.calls).toHaveLength(1);
    expect(harness.notices).toEqual([{ event: 'record_retried', data: { usageId: meta.usageId, error: 'connection_failure' } }]);
    expect(harness.failures).toEqual([]);
  });

  it('duration comes from the monotonic clock: a wall clock jumping backwards mid-call does not make it negative', async () => {
    const api = fakeApi([() => jsonResponse(triageResponse())]);
    const { deps, harness } = fakeDeps(api.client);
    // Every wall-clock read goes back one minute, like an NTP adjustment.
    let reads = 0;
    const now = () => new Date(NOW.getTime() - 60_000 * reads++);
    const { meta } = await createGateway({ ...deps, clock: { now, monotonicMs: deps.clock.monotonicMs } }).structured(Triage, REQUEST);
    expect(meta).toMatchObject({ durationMs: CLOCK_STEP_MS, costUsd: TRIAGE_COST });
    expect(harness.calls[0]?.durationMs).toBe(CLOCK_STEP_MS);
  });

  it('if the response row fails twice, the result is withheld and the reservation keeps its worst case', async () => {
    const { gateway, harness } = setup([() => jsonResponse(triageResponse())]);
    harness.recordBehavior = ['ok', 'fail', 'fail'];
    const error = await failure(gateway.structured(Triage, REQUEST));
    const [reservation] = harness.ledger;
    expect(error).toBeInstanceOf(RecordError);
    expect(error).toMatchObject({ code: 'record_failed', costUsd: TRIAGE_COST, usageId: reservation?.id });
    expect(harness.openReservations).toEqual([reservation]);
    expect(harness.failures).toEqual([{ event: 'record_failed', data: { usageId: reservation?.id, costUsd: TRIAGE_COST, error: 'connection_failure' } }]);
    expect(harness.notices).toEqual([]);
  });

  it('no row, no call: if the reservation fails twice, the API is not called', async () => {
    const { gateway, harness, requests } = setup([]);
    harness.recordBehavior = ['fail', 'fail'];
    const error = await failure(gateway.structured(Triage, REQUEST));
    expect(error).toBeInstanceOf(ReservationError);
    expect(error).toMatchObject({ code: 'reservation_failed', usageId: harness.recordAttempts[0]?.id });
    expect(requests).toHaveLength(0);
    expect(harness.ledger).toEqual([]);
    expect(harness.failures).toEqual([{ event: 'reservation_failed', data: { usageId: harness.recordAttempts[0]?.id, task: 'triage', error: 'connection_failure' } }]);
  });

  it('when closing rows always fail, each call leaves its worst-case reservation and the caps end up cutting', async () => {
    // Like a deploy that writes a column the database does not have yet, only on closing rows.
    const { gateway, harness, requests } = setup(Array.from({ length: 20 }, () => () => jsonResponse(triageResponse())));
    harness.beforeRecord = (row) => {
      if (!row.reservation) throw new StoreError('undefined_column');
    };
    let last: GatewayError | null = null;
    for (let i = 0; i < 20 && !(last instanceof CapError); i += 1) last = await failure(gateway.structured(Triage, REQUEST));

    expect(last).toBeInstanceOf(CapError);
    // Each reservation is worth the estimated input at 10 and 16,000 output at 50 per million (the
    // model that will answer is unknown, so the highest price): just over US$0.80, against the
    // US$0.0064 the call really cost.
    const estimated = harness.ledger[0]?.estimatedInputTokens ?? 0;
    const perReservation = (estimated * 10 + 16_000 * 50) / 1_000_000;
    expect(requests).toHaveLength(Math.ceil(10 / perReservation));
    expect(harness.openReservations).toHaveLength(requests.length);
    expect(harness.calls).toEqual([]);
  });

  it('a cut while the reservation is being written does not call, and closes it with zero usage', async () => {
    const { gateway, harness, requests } = setup([]);
    const controller = new AbortController();
    harness.beforeRecord = (row) => {
      if (row.reservation) controller.abort();
    };
    expect(await failure(gateway.structured(Triage, { ...REQUEST, signal: controller.signal }))).toMatchObject({ code: 'cancelled', usageId: null });
    expect(requests).toHaveLength(0);
    expect(harness.calls).toEqual([expect.objectContaining({ errorCode: 'cancelled', costUsd: 0, replaces: harness.ledger[0]?.id })]);
    expect(harness.openReservations).toEqual([]);
  });
});

describe('text with streaming', () => {
  const draft = fakeMessage({
    model: 'claude-fable-5-1',
    content: [thinkingBlock(), textBlock('Dear support team, thanks for the report.')],
    usage: fakeUsage({ input_tokens: 2000, output_tokens: 800 }),
  });
  const DRAFT_REQUEST = { ...REQUEST, task: 'draft', promptVersion: 'draft@1' } satisfies GatewayRequest;

  it('passes text along as it arrives and returns the full message, recorded', async () => {
    const { gateway, harness, requests } = setup([() => sseResponse(draft)]);
    const pieces: string[] = [];
    const result = await gateway.text({ ...DRAFT_REQUEST, onText: (delta) => pieces.push(delta) });

    expect(requests[0]?.body).toMatchObject({ stream: true, model: 'claude-fable-5-1', fallbacks: 'default', output_config: { effort: 'medium' } });
    expect(requests[0]?.body).not.toHaveProperty('output_config.format');
    expect(pieces).toHaveLength(2);
    expect(result.text).toBe('Dear support team, thanks for the report.');
    expect(pieces.join('')).toBe(result.text);
    // Fable fixture: 2000 x 10 + 800 x 50 = 60,000 per million.
    expect(result.meta).toMatchObject({ requestId: REQUEST_ID, modelResponded: 'claude-fable-5-1', costUsd: 0.06 });
    expect(harness.calls[0]).toMatchObject({ task: 'draft', inputTokens: 2000, outputTokens: 800, stopReason: 'end_turn' });
  });

  /** The row of a stream cut before message_delta: input measured, output not. */
  const streamWithoutOutput = {
    incomplete: true,
    costUsd: null,
    modelResponded: 'claude-fable-5-1',
    inputTokens: 2000,
    // What message_start says: a floor, not the output.
    outputTokens: 1,
    maxTokens: 16_000,
    estimatedInputTokens: null,
    thinkingTokens: null,
    stopReason: null,
    requestId: REQUEST_ID,
  };

  it('an API error mid-stream: ApiError, and the call is recorded as incomplete', async () => {
    const { gateway, harness } = setup([() => sseResponse(draft, { errorAfter: { events: 3, type: 'overloaded_error' } })]);
    expect(await failure(gateway.text(DRAFT_REQUEST))).toMatchObject({ code: 'overloaded', retryable: true, usageId: harness.calls[0]?.id });
    expect(harness.calls[0]).toMatchObject(streamWithoutOutput);
    expect(harness.notices).toEqual([{ event: 'usage_unmeasured', data: expect.objectContaining({ code: 'overloaded', streaming: true, inputMeasured: true }) }]);
  });

  it('a stream that ends before message_delta: connection, recorded as incomplete', async () => {
    const { gateway, harness } = setup([() => sseResponse(draft, { cutAfter: 4 })]);
    const error = await failure(gateway.text(DRAFT_REQUEST));
    expect(error).toMatchObject({ code: 'connection', retryable: true, usageId: harness.calls[0]?.id });
    expect(harness.calls).toEqual([expect.objectContaining(streamWithoutOutput)]);
  });

  it('a stream that ends after message_delta but before message_stop is fully measured: a row with its cost', async () => {
    // message_start, the thinking block, the text in two pieces and message_delta; no message_stop.
    const { gateway, harness } = setup([() => sseResponse(draft, { cutAfter: 8 })]);
    expect(await failure(gateway.text(DRAFT_REQUEST))).toMatchObject({ code: 'connection', usageId: harness.calls[0]?.id });
    expect(harness.calls[0]).toMatchObject({ incomplete: false, inputTokens: 2000, outputTokens: 800, costUsd: 0.06, stopReason: 'end_turn', errorCode: 'connection' });
    expect(harness.notices).toEqual([]);
  });

  it('if onText throws, its error comes out as is and what was spent is recorded', async () => {
    // The model keeps writing after the first piece: the stream stays open until the gateway aborts it.
    const { gateway, harness } = setup([sseThatKeepsGoing(draft, 5)]);
    const fromListener = new RangeError('the screen was closed');
    await expect(
      gateway.text({
        ...DRAFT_REQUEST,
        onText: () => {
          throw fromListener;
        },
      }),
    ).rejects.toBe(fromListener);
    expect(harness.calls).toEqual([expect.objectContaining(streamWithoutOutput)]);
  });

  it('a refusal while streaming is also checked before the text', async () => {
    const refused = { ...draft, content: [textBlock('Dear')], stop_reason: 'refusal' as const, stop_details: refusalDetails('general_harms') };
    const { gateway } = setup([() => sseResponse(refused)]);
    expect(await failure(gateway.text(DRAFT_REQUEST))).toMatchObject({ code: 'refusal', refusalCategory: 'general_harms' });
  });
});

describe('structuredStream', () => {
  it('started resolves when the response begins, before final', async () => {
    const { gateway, harness } = setup([() => sseResponse(triageResponse())]);
    const order: string[] = [];
    const { started, final } = gateway.structuredStream(Triage, { ...REQUEST, jobId: JOB });
    await Promise.all([started.then(() => order.push('started')), final.then(() => order.push('final'))]);
    expect(order).toEqual(['started', 'final']);
    expect((await final).data).toEqual(TRIAGE);
    expect(harness.calls[0]).toMatchObject({ jobId: JOB, costUsd: TRIAGE_COST, thinkingTokens: 120 });
  });

  it('if a cap stops the call, started still resolves and the error comes out of final', async () => {
    const { gateway, harness, requests } = setup([]);
    harness.ledger.push(earlierRow({ costUsd: 10 }));
    const { started, final } = gateway.structuredStream(Triage, REQUEST);
    await started;
    // The caller may take a while to await `final`: an unhandled rejection must not crash the process.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await failure(final)).toMatchObject({ code: 'cap_daily_user' });
    expect(requests).toHaveLength(0);
  });
});

describe('cuts: what a cut call may have spent counts toward the caps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Cuts a stream with the gateway timeout only after message_start, using fake timers to avoid races. */
  async function cutAfterStart<R>(call: { readonly started: Promise<void>; readonly final: Promise<R> }, timeoutMs: number): Promise<GatewayError> {
    await call.started;
    vi.advanceTimersByTime(timeoutMs);
    return failure(call.final);
  }

  /** Fable 5.1 starts writing: message_start with 2000 input, the text block and one piece. */
  const startsWriting = fakeMessage({ model: 'claude-fable-5-1', content: [textBlock('{"category":"bug","priority":2,"tags":[]}')], usage: fakeUsage({ input_tokens: 2000, output_tokens: 12_000 }) });
  const LONG_REQUEST = { ...REQUEST, task: 'extract', promptVersion: 'extract@1' } satisfies GatewayRequest;

  it('repeated stream cuts (the timeout halfway through the output) end in CapError without calling the API', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gateway, harness, requests } = setup(Array.from({ length: 4 }, () => sseThatKeepsGoing(startsWriting, 3)));
    const request = { ...LONG_REQUEST, maxTokens: 64_000, timeoutMs: 30 };
    for (let i = 0; i < 4; i += 1) expect(await cutAfterStart(gateway.structuredStream(Triage, request), 30)).toMatchObject({ code: 'timeout', retryable: true });
    // Each cut at its worst case with the Fable fixture prices: 2000 x 10 + 1 x 50 + 64,000 x 50 = US$3.22005.
    expect(harness.calls.map((row) => [row.incomplete, row.inputTokens, row.outputTokens, row.maxTokens, row.costUsd])).toEqual(
      Array.from({ length: 4 }, () => [true, 2000, 1, 64_000, null]),
    );
    const fifth = await cutAfterStart(gateway.structuredStream(Triage, request), 30);
    expect(fifth).toBeInstanceOf(CapError);
    expect(fifth).toMatchObject({ code: 'cap_daily_user', spentUsd: 12.8802, unpricedBoundUsd: 12.8802, capUsd: 10 });
    expect(requests).toHaveLength(4);
  });

  it('repeated cuts without streaming (the timeout before the response) also end in CapError', async () => {
    const { gateway, harness, requests } = setup(Array.from({ length: 20 }, () => hangs));
    const request = { ...LONG_REQUEST, maxTokens: MAX_TOKENS_WITHOUT_STREAMING, timeoutMs: 20 };
    let last: GatewayError | null = null;
    for (let i = 0; i < 20 && !(last instanceof CapError); i += 1) last = await failure(gateway.structured(Triage, request));

    expect(last).toBeInstanceOf(CapError);
    const estimated = harness.calls[0]?.estimatedInputTokens ?? 0;
    expect(estimated).toBeGreaterThan(0);
    const perCut = (estimated * 10 + MAX_TOKENS_WITHOUT_STREAMING * 50) / 1_000_000;
    expect(requests).toHaveLength(Math.ceil(10 / perCut));
    expect(harness.calls.every((row) => row.incomplete && row.costUsd === null && row.modelResponded === null)).toBe(true);
    expect(last).toMatchObject({ code: 'cap_daily_user', unpricedBoundUsd: Math.round(requests.length * perCut * 1_000_000) / 1_000_000 });
  });

  it('a Sonnet 5.5 stream cut after message_start counts at the Sonnet price, not the highest one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gateway, harness } = setup([sseThatKeepsGoing({ ...startsWriting, model: 'claude-sonnet-5-5' }, 3), () => jsonResponse(triageResponse())]);
    expect(await cutAfterStart(gateway.structuredStream(Triage, { ...REQUEST, timeoutMs: 30 }), 30)).toMatchObject({ code: 'timeout' });
    expect(harness.calls[0]).toMatchObject({ incomplete: true, modelResponded: 'claude-sonnet-5-5', inputTokens: 2000, outputTokens: 1, maxTokens: 16_000 });
    await gateway.structured(Triage, REQUEST);
    // At Sonnet 5.5 (2 and 10 per million): 2000 x 2 + 1 x 10 + 16,000 x 10 = US$0.16401. At the highest (Fable) it would be 0.82005.
    expect(harness.notices.find((n) => n.event === 'unpriced_calls_in_window')?.data).toMatchObject({ userDayUnpriced: 1, userDayBoundUsd: 0.16401 });
  });

  it('a PDF stream cut before message_start: the input estimate is the text size plus the attachment bound', async () => {
    const { gateway, harness } = setup([hangs]);
    const messages = [{ role: 'user', content: [PDF, READ_IT] }] satisfies GatewayRequest['messages'];
    const request = { ...REQUEST, task: 'extract', messages, attachmentTokenBound: 12_000, timeoutMs: 30 } satisfies GatewayRequest;
    expect(await failure(gateway.structuredStream(Triage, request).final)).toMatchObject({ code: 'timeout' });
    const text = estimateInputTokens(sentParts(messages));
    // The base64 PDF weighs 12,000 bytes, which do not count: the request's bound covers it.
    expect(text).toBeLessThan(2_000);
    expect(harness.calls[0]).toMatchObject({ incomplete: true, modelResponded: null, inputTokens: 0, estimatedInputTokens: text + 12_000 });
  });

  it('an already aborted signal reads nothing, calls nothing and logs nothing', async () => {
    const { gateway, harness, requests } = setup([]);
    const error = await failure(gateway.structured(Triage, { ...REQUEST, signal: AbortSignal.abort() }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'cancelled', usageId: null });
    expect(harness.readSignals).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(harness.ledger).toHaveLength(0);
    expect(harness.notices).toEqual([]);
  });

  it('the deadline covers the store reads too: a hanging read ends in timeout, without a call or a notice', async () => {
    const { gateway, harness, requests } = setup([]);
    harness.hangingReads = true;
    const error = await failure(gateway.structured(Triage, { ...REQUEST, timeoutMs: 30 }));
    expect(error).toMatchObject({ code: 'timeout', retryable: true, usageId: null });
    expect(error.cause).toBeInstanceOf(StoreError);
    // All four reads got the call's signal.
    expect(harness.readSignals).toHaveLength(4);
    expect(harness.readSignals.every((signal) => signal?.aborted)).toBe(true);
    expect(requests).toHaveLength(0);
    expect(harness.notices).toEqual([]);
  });

  it("the caller's signal also cuts a hanging read: cancelled", async () => {
    const { gateway, harness, requests } = setup([]);
    harness.hangingReads = true;
    const controller = new AbortController();
    const promise = gateway.structured(Triage, { ...REQUEST, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(await failure(promise)).toMatchObject({ code: 'cancelled', usageId: null });
    expect(requests).toHaveLength(0);
  });
});

describe('setup', () => {
  it('an unknown time zone or an invalid timeout fails when the gateway is created, not on the first call', () => {
    const { client } = fakeApi([]);
    const { deps } = fakeDeps(client);
    expect(() => createGateway({ ...deps, timeZone: 'Mars/Olympus_Mons' })).toThrow(SetupError);
    expect(() => createGateway({ ...deps, timeoutMs: 0 })).toThrow(SetupError);
  });
});
