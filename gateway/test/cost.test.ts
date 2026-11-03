import { describe, expect, it } from 'vitest';
import { costUsd, countAttachments, estimateInputTokens, pricesInForce, splitUsage, sumTokens, tariffModifiers, type AttemptUsage, type PriceRow } from '../src/cost.ts';
import { fakeMessage, fakeUsage } from './helpers/fake-claude.ts';
import { PRICES } from './helpers/fake-stores.ts';

const AT = new Date('2026-10-23T15:00:00Z');
const inForce = pricesInForce(PRICES, AT);

function attempt(partial: Partial<AttemptUsage>): AttemptUsage {
  return { kind: 'single', model: 'claude-sonnet-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...partial };
}

describe('pricesInForce', () => {
  it('takes the latest row already in force for each model and ignores future ones', () => {
    const row = (model: string, validFrom: string, input: number): PriceRow => ({ model, validFrom, input, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    const prices = pricesInForce(
      [
        row('claude-sonnet-5-5', '2026-01-01T00:00:00Z', 3),
        row('claude-sonnet-5-5', '2026-10-23T00:00:00Z', 2),
        row('claude-sonnet-5-5', '2026-11-01T00:00:00Z', 1),
        row('claude-fable-5-1', '2026-12-01T00:00:00Z', 10),
      ],
      AT,
    );
    expect(prices.get('claude-sonnet-5-5')?.input).toBe(2);
    expect(prices.has('claude-fable-5-1')).toBe(false);
  });
});

describe('splitUsage', () => {
  it('without iterations: one attempt with the top-level usage and the response model', () => {
    const response = fakeMessage({ usage: fakeUsage({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 600 }) });
    expect(splitUsage(response, 'claude-sonnet-5-5')).toEqual([attempt({ input: 100, output: 50, cacheRead: 4000, cacheWrite5m: 600 })]);
  });

  it('splits cache writes by TTL when the API reports them', () => {
    const response = fakeMessage({ usage: fakeUsage({ cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 300 } }) });
    expect(splitUsage(response, 'claude-sonnet-5-5')[0]).toMatchObject({ cacheWrite5m: 600, cacheWrite1h: 300 });
  });

  it('with a fallback: one attempt per iteration, and a "message" without a model belongs to the requested model', () => {
    const response = fakeMessage({
      model: 'claude-opus-4-8',
      usage: fakeUsage({
        input_tokens: 2000,
        output_tokens: 700,
        iterations: [
          { type: 'message', model: null, input_tokens: 2000, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 2000, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        ],
      }),
    });
    expect(splitUsage(response, 'claude-fable-5-1')).toEqual([
      attempt({ kind: 'message', model: 'claude-fable-5-1', input: 2000, output: 150 }),
      attempt({ kind: 'fallback_message', model: 'claude-opus-4-8', input: 2000, output: 700 }),
    ]);
  });

  it('an empty iterations list counts as no iterations', () => {
    const response = fakeMessage({ usage: fakeUsage({ input_tokens: 10, iterations: [] }) });
    expect(splitUsage(response, 'claude-sonnet-5-5')).toEqual([attempt({ input: 10 })]);
  });
});

describe('costUsd', () => {
  it('prices each token type per million', () => {
    // Sonnet fixture: 1000 x 2 + 500 x 10 + 4000 x 0.2 + 400 x 2.5 + 100 x 4 = 9200 per million.
    const attempts = [attempt({ input: 1000, output: 500, cacheRead: 4000, cacheWrite5m: 400, cacheWrite1h: 100 })];
    expect(costUsd(attempts, inForce)).toEqual({ usd: 0.0092, unpriced: [] });
  });

  it('prices each attempt at its own model', () => {
    const attempts = [attempt({ kind: 'message', model: 'claude-fable-5-1', input: 1000, output: 100 }), attempt({ kind: 'fallback_message', model: 'claude-opus-5-5', input: 1000, output: 1000 })];
    // Fable: 1000 x 10 + 100 x 50 = 15,000. Opus 5.5: 1000 x 4 + 1000 x 20 = 24,000.
    expect(costUsd(attempts, inForce)).toEqual({ usd: 0.039, unpriced: [] });
  });

  it('a model without a price makes the cost null and names it: never an invented number', () => {
    const attempts = [attempt({ kind: 'message', input: 1000 }), attempt({ kind: 'fallback_message', model: 'claude-sonnet-5', input: 1000, output: 500 })];
    expect(costUsd(attempts, inForce)).toEqual({ usd: null, unpriced: ['claude-sonnet-5'] });
  });

  it('sums in integers: no float drift, rounded to 6 decimals like the ledger column', () => {
    // In floating point, 0.1 + 0.2 is 0.30000000000000004.
    const prices = new Map([['claude-sonnet-5-5', { input: 0, output: 0, cacheRead: 0.1, cacheWrite5m: 0, cacheWrite1h: 0 }]]);
    expect(costUsd([attempt({ cacheRead: 1_000_000 }), attempt({ cacheRead: 2_000_000 })], prices).usd).toBe(0.3);
    // 7 tokens at US$0.25 per million = 0.00000175: rounds to 0.000002.
    expect(costUsd([attempt({ model: 'claude-fable-5-1', cacheRead: 7 })], inForce).usd).toBe(0.000002);
  });
});

describe('tariffModifiers', () => {
  it('the standard tariff, or a field that did not come, has no modifiers', () => {
    expect(tariffModifiers(fakeUsage({ service_tier: 'standard', speed: 'standard', inference_geo: 'global' }))).toEqual([]);
    expect(tariffModifiers(fakeUsage({ service_tier: null, speed: null, inference_geo: null }))).toEqual([]);
  });

  it('a pinned region, fast, priority or batch: the price table has no such tariff', () => {
    expect(tariffModifiers(fakeUsage({ inference_geo: 'us' }))).toEqual(['inference_geo:us']);
    expect(tariffModifiers(fakeUsage({ speed: 'fast', service_tier: 'priority' }))).toEqual(['service_tier:priority', 'speed:fast']);
    expect(tariffModifiers(fakeUsage({ service_tier: 'batch' }))).toEqual(['service_tier:batch']);
  });
});

describe('sumTokens', () => {
  it('adds all attempts', () => {
    expect(sumTokens([attempt({ input: 10, output: 1, cacheRead: 3 }), attempt({ input: 5, output: 2, cacheWrite1h: 4 })])).toEqual({ input: 15, output: 3, cacheRead: 3, cacheWrite5m: 0, cacheWrite1h: 4 });
  });
});

describe('estimateInputTokens', () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length;

  it('counts UTF-8 bytes of the text, so it never falls below its token count', () => {
    const text = 'Señalá los requisitos que faltan, with accents and ümlauts. '.repeat(50);
    const estimate = estimateInputTokens({ system: [{ type: 'text', text }], messages: [{ role: 'user', content: text }] });
    expect(estimate).toBeGreaterThan(2 * bytes(text));
    expect(estimate).toBeLessThan(2 * bytes(text) + 200);
  });

  it('adds the output schema', () => {
    const base = { messages: [{ role: 'user' as const, content: 'Ticket' }] };
    const schema = { type: 'object', properties: { verdict: { type: 'string', enum: ['accept', 'revise', 'reject'] } } };
    const withFormat = estimateInputTokens({ ...base, output_config: { format: { type: 'json_schema', schema } } });
    expect(withFormat - estimateInputTokens(base)).toBeGreaterThanOrEqual(bytes(JSON.stringify(schema)));
  });

  it('skips base64 PDF content: its tokens do not follow from file size', () => {
    const pdf = 'JVBERi0xLjcK'.repeat(100_000);
    const estimate = estimateInputTokens({
      messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }, { type: 'text', text: 'Extract the fields' }] }],
    });
    expect(estimate).toBeLessThan(300);
  });
});

describe('countAttachments', () => {
  it('counts images and PDFs as base64, url or file, also nested inside a content document', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjcK' } },
          { type: 'image', source: { type: 'url', url: 'https://example.test/scan.png' } },
          { type: 'document', source: { type: 'file', file_id: 'file_fake' } },
          { type: 'document', source: { type: 'content', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }] } },
          { type: 'text', text: 'Extract the fields' },
        ],
      },
    ];
    expect(countAttachments(messages)).toBe(4);
  });

  it('text, including a plain-text document, is estimated by size: not an attachment', () => {
    const messages = [
      { role: 'user', content: 'Ticket' },
      { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
      { role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'pasted text' } }] },
    ];
    expect(countAttachments(messages)).toBe(0);
  });
});
