/**
 * The observer hook and the OpenTelemetry adapter, offline: the gateway over the fake API and the
 * in-memory stores, with an observer that collects spans and a fake tracer that records what an
 * OpenTelemetry tracer would be asked to do.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GatewayError } from '../src/errors.ts';
import { createGateway, type GatewayRequest } from '../src/gateway.ts';
import { otelAttributes, otelObserver, type CallSpan, type OtelTracer } from '../src/observe.ts';
import { errorResponse, fakeApi, fakeMessage, fakeUsage, fallbackBlock, jsonResponse, refusalDetails, sseResponse, textBlock, type Responder } from './helpers/fake-claude.ts';
import { CLOCK_STEP_MS, earlierRow, fakeDeps, NOW, USER } from './helpers/fake-stores.ts';

const Verdict = z.object({ ok: z.boolean() });
const PROMPT = 'SECRET-PROMPT-TEXT about a fictional ticket';
const SYSTEM = 'SECRET-SYSTEM-TEXT';
const COMPLETION = '{"ok":true}';
const REQUEST = { task: 'triage', userId: USER, promptVersion: 'triage@1', maxTokens: 16_000, system: [SYSTEM], messages: [{ role: 'user', content: PROMPT }] } satisfies GatewayRequest;
/** At the Sonnet 5.5 fixture prices: 1200 x 2 + 300 x 10 + 5000 x 0.2 + 400 x 2.5 = 7400 per million. */
const USAGE = fakeUsage({ input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 400 });
const answer = (text = COMPLETION) => fakeMessage({ content: [textBlock(text)], usage: USAGE });

function setup(responders: readonly Responder[], onCall?: (span: CallSpan) => void) {
  const api = fakeApi(responders);
  const { deps, harness } = fakeDeps(api.client);
  const spans: CallSpan[] = [];
  const gateway = createGateway({ ...deps, observer: { onCall: onCall ?? ((span) => void spans.push(span)) } });
  return { ...api, deps, harness, spans, gateway };
}

async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error('The call did not fail');
}

describe('one span per call', () => {
  it('a call that succeeds: model, tokens, the cost reserved and settled, and its ledger ids', async () => {
    const { gateway, spans, harness } = setup([() => jsonResponse(answer())]);
    const { meta } = await gateway.structured(Verdict, REQUEST);
    expect(spans).toHaveLength(1);
    const reservation = harness.ledger.find((row) => row.reservation);
    expect(spans[0]).toEqual({
      operation: 'structured',
      task: 'triage',
      promptVersion: 'triage@1',
      model: 'claude-sonnet-5-5',
      modelResponded: 'claude-sonnet-5-5',
      effort: 'medium',
      maxTokens: 16_000,
      streaming: false,
      tokens: { input: 1200, output: 300, cacheRead: 5000, cacheWrite5m: 400, cacheWrite1h: 0 },
      // The estimated input at 10 and 16,000 output tokens at 50, the highest fixture prices.
      reservedUsd: ((reservation?.estimatedInputTokens ?? 0) * 10 + 16_000 * 50) / 1_000_000,
      settledUsd: 0.0074,
      outcome: 'ok',
      errorCode: null,
      stopReason: 'end_turn',
      fellBack: false,
      requestId: meta.requestId,
      reservationId: reservation?.id,
      usageId: meta.usageId,
      startTime: NOW,
      durationMs: expect.any(Number),
    });
    expect(spans[0]?.reservedUsd).toBeGreaterThan(0.8);
    expect(spans[0]?.durationMs).toBeGreaterThanOrEqual(CLOCK_STEP_MS);
  });

  it('never carries prompt, system or completion text, in the span or in the OpenTelemetry attributes', async () => {
    const { gateway, spans } = setup([() => sseResponse(answer('SECRET-COMPLETION-TEXT'))]);
    await gateway.text(REQUEST);
    const everything = JSON.stringify([spans, spans.map(otelAttributes)]);
    expect(everything).not.toContain('SECRET');
    expect(everything).not.toContain(USER);
    expect(spans[0]).toMatchObject({ operation: 'text', streaming: true, outcome: 'ok' });
  });

  it('a refusal after a fallback: an error span with the cost that was billed', async () => {
    const usage = fakeUsage({
      input_tokens: 1000,
      output_tokens: 100,
      iterations: [
        { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        { type: 'fallback_message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
      ],
    });
    const refused = fakeMessage({
      model: 'claude-opus-5-5',
      content: [fallbackBlock('claude-sonnet-5-5', 'claude-opus-5-5', 'cyber')],
      stop_reason: 'refusal',
      stop_details: refusalDetails('cyber'),
      usage,
    });
    const { gateway, spans } = setup([() => jsonResponse(refused)]);
    expect((await failure(gateway.structured(Verdict, REQUEST))).code).toBe('refusal');
    // 1000 x 2 for the first attempt, 1000 x 4 + 100 x 20 for the fallback: 8000 per million.
    expect(spans[0]).toMatchObject({
      outcome: 'error',
      errorCode: 'refusal',
      stopReason: 'refusal',
      model: 'claude-sonnet-5-5',
      modelResponded: 'claude-opus-5-5',
      fellBack: true,
      settledUsd: 0.008,
      tokens: { input: 2000, output: 100 },
    });
  });

  it('an HTTP error that was not billed settles at zero, with the code', async () => {
    const { gateway, spans } = setup([() => errorResponse(529, 'overloaded_error')]);
    expect((await failure(gateway.structured(Verdict, REQUEST))).code).toBe('overloaded');
    expect(spans[0]).toMatchObject({ outcome: 'error', errorCode: 'overloaded', settledUsd: 0, tokens: { input: 0, output: 0 }, modelResponded: null });
    expect(spans[0]?.reservedUsd).toBeGreaterThan(0.8);
  });

  it('a cut stream settles at null, not zero: its cost is unknown', async () => {
    const { gateway, spans } = setup([() => sseResponse(answer(), { cutAfter: 1 })]);
    expect((await failure(gateway.structuredStream(Verdict, REQUEST).final)).code).toBe('connection');
    expect(spans[0]).toMatchObject({ operation: 'structured_stream', streaming: true, errorCode: 'connection', settledUsd: null, tokens: { input: 1200 }, modelResponded: 'claude-sonnet-5-5' });
    expect(spans[0]?.usageId).not.toBeNull();
  });

  it('a call stopped by a cap before reserving has no reservation and no cost', async () => {
    const { gateway, spans, harness, requests } = setup([]);
    harness.ledger.push(earlierRow({ costUsd: 10 }));
    expect((await failure(gateway.structured(Verdict, REQUEST))).code).toBe('cap_daily_user');
    expect(requests).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: 'error', errorCode: 'cap_daily_user', reservedUsd: null, settledUsd: null, reservationId: null, usageId: null, tokens: null, model: null });
  });

  it('invalid output is an error span whose cost was still settled', async () => {
    const { gateway, spans } = setup([() => jsonResponse(answer('{"ok":"yes"}'))]);
    expect((await failure(gateway.structured(Verdict, REQUEST))).code).toBe('invalid_output');
    expect(spans[0]).toMatchObject({ outcome: 'error', errorCode: 'invalid_output', settledUsd: 0.0074, stopReason: 'end_turn' });
  });

  it('when the prices cannot be read, the reserved cost is null and the call is unaffected', async () => {
    const { gateway, spans, harness } = setup([() => errorResponse(529, 'overloaded_error')]);
    harness.pricesError = new Error('prices down');
    await failure(gateway.structured(Verdict, REQUEST));
    expect(spans[0]).toMatchObject({ reservedUsd: null, settledUsd: 0 });
  });

  it('an observer that throws does not change the result: the gateway logs a notice', async () => {
    const { gateway, harness } = setup([() => jsonResponse(answer())], () => {
      throw new TypeError('exporter down');
    });
    const { data } = await gateway.structured(Verdict, REQUEST);
    expect(data).toEqual({ ok: true });
    expect(harness.notices).toContainEqual({ event: 'observer_failed', data: { task: 'triage', error: 'TypeError' } });
  });

  it("the span's duration ends before the observer's own price read", async () => {
    const api = fakeApi([() => jsonResponse(answer())]);
    const { deps, harness } = fakeDeps(api.client);
    const spans: CallSpan[] = [];
    const prices = deps.prices;
    // The read made for the span comes after the closing row; it takes 100 clock steps here.
    const slowAfterClose = {
      pricesFor: async (models: readonly string[], at: Date) => {
        if (harness.ledger.some((row) => !row.reservation)) for (let i = 0; i < 100; i += 1) deps.clock.monotonicMs();
        return prices.pricesFor(models, at);
      },
    };
    await createGateway({ ...deps, prices: slowAfterClose, observer: { onCall: (span) => void spans.push(span) } }).structured(Verdict, REQUEST);
    expect(spans[0]?.reservedUsd).toBeGreaterThan(0.8);
    expect(spans[0]?.durationMs).toBeLessThan(100 * CLOCK_STEP_MS);
  });

  it('without an observer the clock is read exactly as before', async () => {
    const api = fakeApi([() => jsonResponse(answer())]);
    const { deps, harness } = fakeDeps(api.client);
    await createGateway(deps).structured(Verdict, REQUEST);
    const plain = harness.calls[0]?.durationMs;
    const observedRun = setup([() => jsonResponse(answer())]);
    await observedRun.gateway.structured(Verdict, REQUEST);
    expect(observedRun.harness.calls[0]?.durationMs).toBe(plain);
  });
});

describe('the OpenTelemetry adapter', () => {
  interface Recorded {
    name: string;
    options: Parameters<OtelTracer['startSpan']>[1];
    status: { code: number; message?: string } | null;
    endTime: Date | undefined;
    ended: number;
  }

  function fakeTracer(): { tracer: OtelTracer; recorded: Recorded[] } {
    const recorded: Recorded[] = [];
    const tracer: OtelTracer = {
      startSpan(name, options) {
        const entry: Recorded = { name, options, status: null, endTime: undefined, ended: 0 };
        recorded.push(entry);
        return {
          setStatus: (status) => void (entry.status = status),
          end: (endTime) => {
            entry.endTime = endTime;
            entry.ended += 1;
          },
        };
      },
    };
    return { tracer, recorded };
  }

  it('writes a CLIENT span named after the operation and model, with the GenAI attribute names', async () => {
    const { tracer, recorded } = fakeTracer();
    const api = fakeApi([() => jsonResponse(answer())]);
    const { deps } = fakeDeps(api.client);
    const { meta } = await createGateway({ ...deps, observer: otelObserver(tracer) }).structured(Verdict, REQUEST);

    expect(recorded).toHaveLength(1);
    const span = recorded[0];
    expect(span?.name).toBe('chat claude-sonnet-5-5');
    expect(span?.options?.kind).toBe(2);
    expect(span?.options?.startTime).toEqual(NOW);
    expect(span?.options?.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-5-5',
      'gen_ai.response.model': 'claude-sonnet-5-5',
      'gen_ai.request.max_tokens': 16_000,
      // Everything that was input: 1200 uncached, 5000 read from cache, 400 written to it.
      'gen_ai.usage.input_tokens': 6600,
      'gen_ai.usage.output_tokens': 300,
      'gen_ai.usage.cache_read.input_tokens': 5000,
      'gen_ai.usage.cache_creation.input_tokens': 400,
      'gen_ai.response.finish_reasons': ['end_turn'],
      'claude_gateway.operation': 'structured',
      'claude_gateway.task': 'triage',
      'claude_gateway.prompt_version': 'triage@1',
      'claude_gateway.effort': 'medium',
      'claude_gateway.streaming': false,
      'claude_gateway.outcome': 'ok',
      'claude_gateway.fell_back': false,
      'claude_gateway.cost.reserved_usd': expect.any(Number),
      'claude_gateway.cost.settled_usd': 0.0074,
      'claude_gateway.request_id': meta.requestId,
      'claude_gateway.reservation_id': expect.any(String),
      'claude_gateway.usage_id': meta.usageId,
    });
    // No error: the status is left unset, as OpenTelemetry asks of instrumentation.
    expect(span?.status).toBeNull();
    expect(span?.ended).toBe(1);
    expect((span?.endTime?.getTime() ?? 0) - NOW.getTime()).toBeGreaterThanOrEqual(CLOCK_STEP_MS);
  });

  it('an error sets error.type and an ERROR status with the code, and leaves unknown values out', async () => {
    const { tracer, recorded } = fakeTracer();
    const api = fakeApi([() => sseResponse(answer(), { cutAfter: 0 })]);
    const { deps } = fakeDeps(api.client);
    await failure(createGateway({ ...deps, observer: otelObserver(tracer) }).text(REQUEST));

    const attributes = recorded[0]?.options?.attributes ?? {};
    expect(recorded[0]?.status).toEqual({ code: 2, message: 'connection' });
    expect(attributes).toMatchObject({ 'error.type': 'connection', 'claude_gateway.outcome': 'error', 'gen_ai.usage.input_tokens': 0 });
    // Cut before message_start: no model answered and the cost is unknown, so neither is set.
    expect(attributes).not.toHaveProperty('gen_ai.response.model');
    expect(attributes).not.toHaveProperty('claude_gateway.cost.settled_usd');
    expect(attributes).not.toHaveProperty('gen_ai.response.finish_reasons');
    expect(recorded[0]?.ended).toBe(1);
  });

  it('a call that failed before its config was read is named after the operation alone', () => {
    const { tracer, recorded } = fakeTracer();
    otelObserver(tracer).onCall({
      operation: 'structured',
      task: 'triage',
      promptVersion: 'triage@1',
      model: null,
      modelResponded: null,
      effort: null,
      maxTokens: 100,
      streaming: false,
      tokens: null,
      reservedUsd: null,
      settledUsd: null,
      outcome: 'error',
      errorCode: 'invalid_config',
      stopReason: null,
      fellBack: false,
      requestId: null,
      reservationId: null,
      usageId: null,
      startTime: NOW,
      durationMs: 12,
    });
    expect(recorded[0]?.name).toBe('chat');
    expect(recorded[0]?.options?.attributes).not.toHaveProperty('gen_ai.request.model');
    expect(recorded[0]?.options?.attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
    expect(recorded[0]?.endTime).toEqual(new Date(NOW.getTime() + 12));
  });
});
