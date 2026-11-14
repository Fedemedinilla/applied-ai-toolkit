/**
 * The model registry: the built-in entries, what a custom entry has to state, and what the gateway
 * does with an entry (the request it sends, the calls it refuses). Offline, over the fake API.
 * `claude-example-9` and its prices are fixtures, not a real model.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { costUsd, PriceRow, pricesInForce } from '../src/cost.ts';
import { GatewayError, SetupError } from '../src/errors.ts';
import { createGateway, type GatewayRequest } from '../src/gateway.ts';
import { BUILT_IN_MODELS, BUILT_IN_REGISTRY, createModelRegistry, EFFORTS, FALLBACK_DEFAULT_BETA, ModelSpec, SUPPORTED_MODELS } from '../src/models.ts';
import { fakeApi, fakeMessage, fakeUsage, jsonResponse, sseResponse, textBlock, type Responder } from './helpers/fake-claude.ts';
import { fakeDeps, NOW, USER } from './helpers/fake-stores.ts';

const EXAMPLE = {
  id: 'claude-example-9',
  maxOutputTokens: 8_000,
  price: { validFrom: '2026-10-01T00:00:00Z', input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, source: 'test fixture' },
  surface: {
    thinking: 'off_by_default',
    samplingParams: 'accepted',
    forcedToolChoice: 'accepted',
    assistantPrefill: 'rejected',
    efforts: ['low', 'medium'],
    serverFallback: 'none',
    structuredOutputs: true,
  },
} as const;

const Verdict = z.object({ ok: z.boolean() });
const REQUEST = { task: 'sort', userId: USER, promptVersion: 'sort@1', maxTokens: 2_000, system: ['Sort the ticket'], messages: [{ role: 'user', content: 'Fictional ticket' }] } satisfies GatewayRequest;
const answer = (text = '{"ok":true}') => fakeMessage({ model: EXAMPLE.id, content: [textBlock(text)], usage: fakeUsage({ input_tokens: 1000, output_tokens: 200 }) });

/** A gateway whose registry has the example model, with a task that uses it and its price loaded. */
function setupWith<const C extends readonly unknown[]>(custom: C, responders: readonly Responder[], task: Record<string, unknown> = { task: 'sort', model: EXAMPLE.id, effort: 'low', hardCaseEffort: null }) {
  const api = fakeApi(responders);
  const { deps, harness } = fakeDeps(api.client);
  const models = createModelRegistry(custom);
  harness.stores.config.tasks.set('sort', task);
  harness.stores.prices.rows.push(...models.priceRows().filter((row) => row.model === EXAMPLE.id));
  return { ...api, harness, gateway: createGateway({ ...deps, models }) };
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

function setupError(build: () => unknown): SetupError {
  try {
    build();
  } catch (error) {
    if (error instanceof SetupError) return error;
    throw error;
  }
  throw new Error('The registry accepted the entry');
}

describe('built-in entries', () => {
  it('are the supported models, each one a valid entry with every effort level and fallbacks on', () => {
    expect(BUILT_IN_MODELS.map((spec) => spec.id)).toEqual([...SUPPORTED_MODELS]);
    expect(BUILT_IN_REGISTRY.ids).toEqual([...SUPPORTED_MODELS]);
    for (const spec of BUILT_IN_MODELS) {
      expect(ModelSpec.parse(spec)).toEqual(spec);
      expect(spec.surface).toMatchObject({ efforts: [...EFFORTS], serverFallback: 'default', structuredOutputs: true, samplingParams: 'rejected', assistantPrefill: 'rejected' });
    }
  });

  it('price rows are valid price rows, one per model, each with its source', () => {
    const rows = BUILT_IN_REGISTRY.priceRows();
    expect(z.array(PriceRow).parse(rows).map((row) => row.model)).toEqual([...SUPPORTED_MODELS]);
    for (const row of rows) expect(row.source).toMatch(/checked 2026-11-03/);
    // The one model whose five prices the reference lists outright.
    expect(rows[0]).toMatchObject({ model: 'claude-fable-5-2', input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 });
  });

  it('cannot be replaced or repeated', () => {
    expect(setupError(() => createModelRegistry([{ ...EXAMPLE, id: 'claude-sonnet-5-5' }])).message).toContain('claude-sonnet-5-5 is already registered');
    expect(setupError(() => createModelRegistry([EXAMPLE, EXAMPLE])).code).toBe('invalid_setup');
  });
});

describe('a custom entry states everything', () => {
  it('registers next to the built-in ones', () => {
    const models = createModelRegistry([EXAMPLE]);
    expect(models.ids).toEqual([...SUPPORTED_MODELS, 'claude-example-9']);
    expect(models.has('claude-example-9')).toBe(true);
    expect(models.has('claude-haiku-4-5')).toBe(false);
    expect(models.get('claude-example-9')?.surface.serverFallback).toBe('none');
  });

  const without = (path: readonly string[]) => {
    const copy = structuredClone(EXAMPLE) as Record<string, unknown>;
    let at = copy;
    for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
    delete at[path.at(-1) ?? ''];
    return copy;
  };

  it.each([
    'price',
    'price.input',
    'price.output',
    'price.cacheRead',
    'price.cacheWrite5m',
    'price.cacheWrite1h',
    'price.source',
    'price.validFrom',
    'maxOutputTokens',
    'surface',
    'surface.thinking',
    'surface.samplingParams',
    'surface.forcedToolChoice',
    'surface.assistantPrefill',
    'surface.efforts',
    'surface.serverFallback',
    'surface.structuredOutputs',
  ])('a missing %s throws', (path) => {
    const error = setupError(() => createModelRegistry([without(path.split('.'))]));
    // zod reports a missing enum as invalid_value and anything else missing as invalid_type.
    expect(error.message).toMatch(new RegExp(`^Model entry 0 fails its schema \\(${path.replace('.', '\\.')}: invalid_(type|value)\\)$`));
  });

  it.each([
    { name: 'a price of zero', entry: { ...EXAMPLE, price: { ...EXAMPLE.price, cacheRead: 0 } }, issue: 'price.cacheRead: too_small' },
    { name: 'a negative price', entry: { ...EXAMPLE, price: { ...EXAMPLE.price, output: -5 } }, issue: 'price.output: too_small' },
    { name: 'a price with five decimals', entry: { ...EXAMPLE, price: { ...EXAMPLE.price, input: 0.12345 } }, issue: 'price.input: custom' },
    { name: 'a price as text', entry: { ...EXAMPLE, price: { ...EXAMPLE.price, input: '1' } }, issue: 'price.input: invalid_type' },
    { name: 'no effort level', entry: { ...EXAMPLE, surface: { ...EXAMPLE.surface, efforts: [] } }, issue: 'surface.efforts: too_small' },
    { name: 'an unknown effort level', entry: { ...EXAMPLE, surface: { ...EXAMPLE.surface, efforts: ['turbo'] } }, issue: 'surface.efforts.0: invalid_value' },
    { name: 'an unknown key', entry: { ...EXAMPLE, surface: { ...EXAMPLE.surface, tools: true } }, issue: 'surface: unrecognized_keys' },
    { name: 'an id that is not a Claude model id', entry: { ...EXAMPLE, id: 'gpt-example' }, issue: 'id: invalid_format' },
    { name: 'an output limit of zero', entry: { ...EXAMPLE, maxOutputTokens: 0 }, issue: 'maxOutputTokens: too_small' },
  ])('$name throws', ({ entry, issue }) => {
    const error = setupError(() => createModelRegistry([entry]));
    expect(error.message).toBe(`Model entry 0 fails its schema (${issue})`);
  });

  it('the error names fields and codes, never the values of the entry', () => {
    const error = setupError(() => createModelRegistry([{ ...EXAMPLE, price: { ...EXAMPLE.price, source: 'internal price sheet', input: -3 } }]));
    expect(error.message).not.toContain('internal price sheet');
    expect(error.message).not.toContain('-3');
  });
});

describe('the gateway with a custom entry', () => {
  it('calls it without fallbacks or their beta header, and prices the call from its row', async () => {
    const { gateway, requests, harness } = setupWith([EXAMPLE], [() => jsonResponse(answer())]);
    const { data, meta } = await gateway.structured(Verdict, REQUEST);
    expect(data).toEqual({ ok: true });
    expect(requests[0]?.body).toMatchObject({ model: 'claude-example-9', max_tokens: 2_000, output_config: { effort: 'low' } });
    expect(requests[0]?.body).not.toHaveProperty('fallbacks');
    expect(requests[0]?.headers.get('anthropic-beta')).toBeNull();
    for (const field of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools']) expect(requests[0]?.body).not.toHaveProperty(field);
    // 1000 x 1 + 200 x 5 = 2000 per million.
    expect(meta).toMatchObject({ modelRequested: 'claude-example-9', costUsd: 0.002 });
    expect(harness.calls).toMatchObject([{ modelRequested: 'claude-example-9', costUsd: 0.002 }]);
  });

  it('a built-in model in the same gateway still gets fallbacks', async () => {
    const { gateway, requests } = setupWith([EXAMPLE], [() => jsonResponse(fakeMessage({ content: [textBlock('{"ok":true}')] }))]);
    await gateway.structured(Verdict, { ...REQUEST, task: 'triage' });
    expect(requests[0]?.body).toMatchObject({ model: 'claude-sonnet-5-5', fallbacks: 'default' });
    expect(requests[0]?.headers.get('anthropic-beta')).toBe(FALLBACK_DEFAULT_BETA);
  });

  it('accepts the custom id in a fixed config, and the type knows it', async () => {
    const { gateway, requests } = setupWith([EXAMPLE], [() => jsonResponse(answer())]);
    await gateway.structured(Verdict, { ...REQUEST, config: { model: 'claude-example-9', effort: 'medium' } });
    expect(requests[0]?.body).toMatchObject({ model: 'claude-example-9', output_config: { effort: 'medium' } });
    // @ts-expect-error: the type only accepts the ids of this gateway's registry.
    const outside: Parameters<typeof gateway.text>[0] = { ...REQUEST, config: { model: 'claude-other-1', effort: 'low' } };
    expect(outside.config?.model).toBe('claude-other-1');
  });

  it.each([
    { name: 'a model outside the registry in the task config', task: { task: 'sort', model: 'claude-other-1', effort: 'low', hardCaseEffort: null }, request: REQUEST, code: 'invalid_config' },
    { name: 'a model outside the registry in a fixed config', task: undefined, request: { ...REQUEST, config: { model: 'claude-other-1', effort: 'low' } }, code: 'invalid_request' },
    { name: 'an effort the model does not take, in the task config', task: { task: 'sort', model: EXAMPLE.id, effort: 'high', hardCaseEffort: null }, request: REQUEST, code: 'invalid_config' },
    { name: 'an effort the model does not take, in a fixed config', task: undefined, request: { ...REQUEST, config: { model: EXAMPLE.id, effort: 'max' } }, code: 'invalid_request' },
    { name: 'a hard-case effort the model does not take', task: { task: 'sort', model: EXAMPLE.id, effort: 'low', hardCaseEffort: 'xhigh' }, request: { ...REQUEST, hardCase: true }, code: 'invalid_config' },
    { name: 'more output than the model can write', task: undefined, request: { ...REQUEST, maxTokens: 8_001 }, code: 'invalid_request' },
  ])('$name: $code, no reservation and no call', async ({ task, request, code }) => {
    const { gateway, requests, harness } = setupWith([EXAMPLE], [], task);
    // The fixed config is typed with the registry's ids; this request is built as config would arrive.
    const error = await failure(gateway.structured(Verdict, request as typeof REQUEST));
    expect(error.code).toBe(code);
    expect(requests).toHaveLength(0);
    expect(harness.ledger).toEqual([]);
  });

  it('a model registered without structured outputs refuses a schema and answers text', async () => {
    const plain = { ...EXAMPLE, surface: { ...EXAMPLE.surface, structuredOutputs: false } };
    const { gateway, requests, harness } = setupWith([plain], [() => sseResponse(answer('Sorted.'))]);
    expect(await failure(gateway.structured(Verdict, REQUEST))).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('without structured outputs') });
    expect(harness.ledger).toEqual([]);
    const { text } = await gateway.text(REQUEST);
    expect(text).toBe('Sorted.');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).not.toHaveProperty('fallbacks');
  });

  it('a registered model whose price was never loaded costs null and counts at the bound, not at zero', async () => {
    const api = fakeApi([() => jsonResponse(answer())]);
    const { deps, harness } = fakeDeps(api.client);
    harness.stores.config.tasks.set('sort', { task: 'sort', model: EXAMPLE.id, effort: 'low', hardCaseEffort: null });
    const gateway = createGateway({ ...deps, models: createModelRegistry([EXAMPLE]) });
    const { meta } = await gateway.structured(Verdict, REQUEST);
    expect(meta.costUsd).toBeNull();
    expect(harness.notices.map((n) => n.event)).toContain('model_unpriced');
    // 1000 input and 200 output at the highest fixture prices (10 and 50): 0.02.
    const totals = await harness.stores.usage.totalsForCaps({ dayStart: new Date(NOW.getTime() - 86_400_000), monthStart: new Date(NOW.getTime() - 86_400_000), userId: USER, jobId: null });
    expect(totals).toMatchObject({ userDayUsd: 0, userDayUnpriced: 1, userDayBoundUsd: 0.02 });
  });

  it('without a registry, the gateway takes the built-in models only', async () => {
    const api = fakeApi([]);
    const { deps, harness } = fakeDeps(api.client);
    harness.stores.config.tasks.set('sort', { task: 'sort', model: EXAMPLE.id, effort: 'low', hardCaseEffort: null });
    expect((await failure(createGateway(deps).structured(Verdict, REQUEST))).code).toBe('invalid_config');
    expect(api.requests).toHaveLength(0);
  });
});

describe('registry prices and the cost arithmetic', () => {
  it('a registry price row prices tokens like any other row', () => {
    const prices = pricesInForce(z.array(PriceRow).parse(createModelRegistry([EXAMPLE]).priceRows()), new Date('2026-11-14T00:00:00Z'));
    const attempt = { kind: 'single' as const, model: 'claude-example-9', input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(costUsd([attempt], prices)).toEqual({ usd: 1.1, unpriced: [] });
    expect(costUsd([{ ...attempt, model: 'claude-other-1' }], prices)).toEqual({ usd: null, unpriced: ['claude-other-1'] });
  });
});
