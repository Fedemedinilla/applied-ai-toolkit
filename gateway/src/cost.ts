/**
 * Tokens and cost of a Claude response. Cost is computed from usage.iterations, each attempt at the
 * price of the model that ran it: after a server-side fallback the top-level usage only describes
 * the final attempt, and the refused attempt would be billed without being counted.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaUsage = Anthropic.Beta.BetaUsage;

/** US$ per million tokens. */
export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

/** A row of the price table. A price change is a new row with a later validFrom; rows are never edited. */
export const PriceRow = z.object({
  model: z.string().min(1),
  validFrom: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid date'),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite5m: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative(),
});
export type PriceRow = z.infer<typeof PriceRow>;

/** The price in force for each model at `at`: the latest validFrom not after it. Models without one are absent. */
export function pricesInForce(rows: readonly PriceRow[], at: Date): ReadonlyMap<string, Price> {
  const chosen = new Map<string, { from: number; row: PriceRow }>();
  for (const row of rows) {
    const from = Date.parse(row.validFrom);
    if (from > at.getTime()) continue;
    const current = chosen.get(row.model);
    if (!current || from > current.from) chosen.set(row.model, { from, row });
  }
  return new Map(
    [...chosen].map(([model, { row }]) => [
      model,
      { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite5m: row.cacheWrite5m, cacheWrite1h: row.cacheWrite1h },
    ]),
  );
}

export type AttemptKind = 'single' | Anthropic.Beta.BetaIterationsUsage[number]['type'];

/** Tokens of one attempt, with the model that ran it. */
export interface AttemptUsage {
  /** single: no usage.iterations. message: an attempt by the requested model. fallback_message: by the fallback. */
  readonly kind: AttemptKind;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

function cacheWritesByTtl(total: number | null, byTtl: Anthropic.Beta.BetaCacheCreation | null): Pick<AttemptUsage, 'cacheWrite5m' | 'cacheWrite1h'> {
  if (byTtl) return { cacheWrite5m: byTtl.ephemeral_5m_input_tokens, cacheWrite1h: byTtl.ephemeral_1h_input_tokens };
  // No TTL breakdown: the gateway only writes with the default 5 minute ephemeral cache_control.
  return { cacheWrite5m: total ?? 0, cacheWrite1h: 0 };
}

/**
 * One AttemptUsage per attempt. Without usage.iterations (or with an empty list), the top-level
 * usage with the response's model. A "message" iteration without a model belongs to the requested
 * model: after a fallback, `response.model` is already the other one.
 */
export function splitUsage(response: BetaMessage, requestedModel: string): AttemptUsage[] {
  const u = response.usage;
  const iterations = u.iterations ?? [];
  if (iterations.length === 0) {
    return [
      {
        kind: 'single',
        model: response.model,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        ...cacheWritesByTtl(u.cache_creation_input_tokens, u.cache_creation),
      },
    ];
  }
  return iterations.map((it): AttemptUsage => {
    const base = {
      input: it.input_tokens,
      output: it.output_tokens,
      cacheRead: it.cache_read_input_tokens,
      ...cacheWritesByTtl(it.cache_creation_input_tokens, it.cache_creation),
    };
    switch (it.type) {
      case 'message':
        return { ...base, kind: it.type, model: it.model ?? requestedModel };
      case 'fallback_message':
      case 'advisor_message':
        return { ...base, kind: it.type, model: it.model };
      case 'compaction':
        return { ...base, kind: it.type, model: response.model };
    }
  });
}

export interface TokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

export function sumTokens(attempts: readonly AttemptUsage[]): TokenTotals {
  const sum = (field: keyof TokenTotals) => attempts.reduce((total, a) => total + a[field], 0);
  return { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite5m: sum('cacheWrite5m'), cacheWrite1h: sum('cacheWrite1h') };
}

/**
 * What the price table does not cover. Its prices are the standard tariff: service_tier standard,
 * speed standard, inference_geo global. A request without inference_geo follows the workspace
 * default, and fast, priority or a pinned region are billed at a premium (batch at a discount).
 * Returns what usage reported outside the standard tariff, such as "inference_geo:us"; if anything
 * comes back, the cost cannot be taken from the table. A field that is null says nothing and
 * does not count.
 */
export function tariffModifiers(usage: BetaUsage): string[] {
  const outside: string[] = [];
  const tier = usage.service_tier ?? null;
  const speed = usage.speed ?? null;
  const geo = usage.inference_geo ?? null;
  if (tier !== null && tier !== 'standard') outside.push(`service_tier:${tier}`);
  if (speed !== null && speed !== 'standard') outside.push(`speed:${speed}`);
  if (geo !== null && geo !== 'global') outside.push(`inference_geo:${geo}`);
  return outside;
}

export type Cost = { readonly usd: number; readonly unpriced: readonly [] } | { readonly usd: null; readonly unpriced: readonly string[] };

/** Prices carry 4 decimals (numeric(10,4) in the SQL schema), so the sum can run in integers. */
const PRICE_SCALE = 10_000;

/**
 * US$ for the call, rounded to 6 decimals like the ledger column. If any model has no price the
 * cost is null with the list of models missing: never an invented number. The sum runs in integers
 * (tokens times ten-thousandths of a dollar per million) so it does not accumulate float error.
 */
export function costUsd(attempts: readonly AttemptUsage[], prices: ReadonlyMap<string, Price>): Cost {
  const scale = (usdPerMillion: number) => Math.round(usdPerMillion * PRICE_SCALE);
  const unpriced = new Set<string>();
  let total = 0;
  for (const a of attempts) {
    const p = prices.get(a.model);
    if (!p) {
      unpriced.add(a.model);
      continue;
    }
    total +=
      a.input * scale(p.input) +
      a.output * scale(p.output) +
      a.cacheRead * scale(p.cacheRead) +
      a.cacheWrite5m * scale(p.cacheWrite5m) +
      a.cacheWrite1h * scale(p.cacheWrite1h);
  }
  if (unpriced.size > 0) return { usd: null, unpriced: [...unpriced] };
  // total is in units of 1e-10 US$ (1e-4 from the price times 1e-6 from the million).
  return { usd: Math.round(total / PRICE_SCALE) / 1_000_000, unpriced: [] };
}

/** The parts of a request that weigh on input tokens. */
export type InputParts = Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, 'system' | 'messages' | 'output_config'>;

/** Sources of an image or PDF whose tokens do not follow from the request size. */
const ATTACHMENT_SOURCES: ReadonlySet<unknown> = new Set(['base64', 'url', 'file']);

function isAttachment(value: object): boolean {
  if (!('source' in value) || typeof value.source !== 'object' || value.source === null) return false;
  return 'type' in value.source && ATTACHMENT_SOURCES.has(value.source.type);
}

/**
 * Attachments in the messages: blocks (an image, a PDF) with a base64, url or file source, also
 * nested in another block. Their tokens depend on pages and pixels, not on request size, so
 * estimateInputTokens skips them and the gateway asks the caller for an explicit bound.
 */
export function countAttachments(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  let total = isAttachment(value) ? 1 : 0;
  // Object.values walks objects and arrays alike.
  for (const child of Object.values(value)) total += countAttachments(child);
  return total;
}

function withoutBinary(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'base64' && 'data' in value) {
    return { ...value, data: '' };
  }
  return value;
}

/**
 * An upper bound on the text input tokens of a request whose usage never arrived (cut before a
 * non-streaming response, or before message_start): the UTF-8 bytes of the JSON of the system
 * prompt, the messages and the output schema. A text token takes at least one byte, and the JSON
 * keys and quotes cover the per-message overhead the API adds. Attachments are excluded: by bytes
 * they would count thousands of times over. Their bound comes with the request.
 */
export function estimateInputTokens(parts: InputParts): number {
  const json = JSON.stringify({ system: parts.system ?? null, messages: parts.messages, format: parts.output_config?.format ?? null }, withoutBinary);
  return new TextEncoder().encode(json).length;
}
