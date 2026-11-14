import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { SetupError } from './errors.ts';

/**
 * Models the request shape was verified against with SDK 1.1.0 (API version 2026-10-21): thinking
 * always on or adaptive, so the gateway never sends `thinking`; no temperature, top_p or top_k,
 * which that API version rejects; no forced tool_choice; and no assistant prefill. A model outside
 * the registry is rejected before any call (invalid_config or invalid_request). These four are the
 * built-in entries (BUILT_IN_MODELS below). A caller adds others with createModelRegistry, which
 * asks for the same facts about each one.
 *
 * claude-fable-5-2 (added 11/2026): same request surface as claude-fable-5-1 per Anthropic's
 * migration guide (always-on adaptive thinking, temperature/top_p/top_k rejected, prefill and forced
 * tool_choice rejected, effort low..max, default high). Its thinking blocks are bound to the
 * conversation for every account; the gateway never replays thinking blocks, so nothing changes.
 */
export const SUPPORTED_MODELS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

/** output_config.effort, as the SDK types it. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly NonNullable<Anthropic.Beta.BetaOutputConfig['effort']>[];
export type Effort = (typeof EFFORTS)[number];

/**
 * Beta header for server-side fallbacks in `fallbacks: "default"` mode. The explicit-list mode
 * uses a different header (server-side-fallback-2026-06-01) and mixing the two returns a 400.
 * `fallbacks` only exists on client.beta.messages, which is why every call goes through the beta
 * namespace.
 */
export const FALLBACK_DEFAULT_BETA = 'server-side-fallback-2026-07-01' satisfies Anthropic.Beta.AnthropicBeta;

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Prices have four decimals: numeric(10, 4) in the SQL schema, and the cost sum runs in integers of that unit. */
const usdPerMillion = z
  .number()
  .positive()
  .refine((value) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6, 'more than 4 decimals');

/**
 * The list price of a model, in US$ per million tokens, with where it was read. Every field is
 * required and above zero: an entry with a missing price fails to register, because a zero would
 * price the model's calls at nothing. This is the standard tariff at one rate per token type. A
 * model billed on several rate cards has to be registered at its highest card (see the README).
 */
export const ModelPrice = z.strictObject({
  /** The price applies to calls from this instant on. */
  validFrom: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid date'),
  input: usdPerMillion,
  output: usdPerMillion,
  cacheRead: usdPerMillion,
  cacheWrite5m: usdPerMillion,
  cacheWrite1h: usdPerMillion,
  /** Where the price came from and when it was checked. Goes to model_prices.source. */
  source: z.string().trim().min(1),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/**
 * What the gateway needs to know about a model's request surface. The first four fields describe
 * what the model does with things the gateway never sends. The request is valid under either
 * value, and they are required so that registering a model states that each was checked. The last
 * three change what the gateway sends or accepts.
 */
export const ModelSurface = z.strictObject({
  /**
   * What the model does when the request has no `thinking` field, which is how the gateway always
   * calls. With thinking on, max_tokens has to leave room for it.
   */
  thinking: z.enum(['always_on', 'adaptive_by_default', 'off_by_default']),
  /** temperature, top_p and top_k. The gateway sends none. */
  samplingParams: z.enum(['rejected', 'accepted']),
  /** tool_choice any or tool. The gateway sends no tools. */
  forcedToolChoice: z.enum(['rejected', 'accepted']),
  /** A conversation ending on an assistant turn. The gateway refuses it for every model. */
  assistantPrefill: z.enum(['rejected', 'accepted']),
  /**
   * The output_config.effort levels the model accepts. The gateway sends one on every call, so a
   * model without effort cannot be registered.
   */
  efforts: z
    .array(z.enum(EFFORTS))
    .min(1)
    .refine((levels) => new Set(levels).size === levels.length, 'repeated effort'),
  /** default: the gateway sends fallbacks "default" with its beta header. none: it sends neither. */
  serverFallback: z.enum(['default', 'none']),
  /** output_config.format with a JSON schema. False: structured() and structuredStream() refuse the model. */
  structuredOutputs: z.boolean(),
});
export type ModelSurface = z.infer<typeof ModelSurface>;

/** One registry entry. Strict: an unknown key is a typo, and it fails. */
export const ModelSpec = z.strictObject({
  /** The model id as sent to the API. The same pattern as the model columns of the SQL schema. */
  id: z.string().regex(/^claude-[a-z0-9.-]+$/),
  /** The model's output limit. A request whose maxTokens is higher is refused before any call. */
  maxOutputTokens: z.int().positive(),
  price: ModelPrice,
  surface: ModelSurface,
});
export type ModelSpec = z.infer<typeof ModelSpec>;

/** A price row as the price stores take it (PriceRow in cost.ts), plus its source. */
export interface RegistryPriceRow {
  readonly model: string;
  readonly validFrom: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly source: string;
}

/**
 * Input, output and cache read prices as listed in Anthropic's API reference on 2026-11-03. Cache
 * writes are listed there for claude-fable-5-2. For the other three they follow the published
 * multipliers: 1.25x the input price for 5 minutes, 2x for 1 hour.
 */
const PRICE_SOURCE = 'Anthropic API reference, checked 2026-11-03; cache writes at the published 1.25x and 2x of input';
const PRICE_FROM = '2026-11-03T00:00:00Z';

function builtIn(id: SupportedModel, thinking: ModelSurface['thinking'], price: Omit<ModelPrice, 'validFrom' | 'source'>): ModelSpec {
  return {
    id,
    maxOutputTokens: 128_000,
    price: { validFrom: PRICE_FROM, ...price, source: PRICE_SOURCE },
    surface: {
      thinking,
      samplingParams: 'rejected',
      forcedToolChoice: 'rejected',
      assistantPrefill: 'rejected',
      efforts: [...EFFORTS],
      serverFallback: 'default',
      structuredOutputs: true,
    },
  };
}

/** The verified entries, one per SUPPORTED_MODELS id. A custom entry cannot replace one. */
export const BUILT_IN_MODELS: readonly ModelSpec[] = [
  builtIn('claude-fable-5-2', 'always_on', { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 }),
  builtIn('claude-fable-5-1', 'always_on', { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 }),
  builtIn('claude-sonnet-5-5', 'adaptive_by_default', { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 }),
  builtIn('claude-opus-5-5', 'always_on', { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 }),
];

/** The id of a custom entry when it is written as a literal, and string when it comes from config. */
type IdOf<E> = E extends { readonly id: infer I extends string } ? I : string;

/** The models a gateway accepts. M is the union of their ids. */
export interface ModelRegistry<M extends string = SupportedModel> {
  readonly ids: readonly M[];
  has(id: string): id is M;
  /** The entry for that id, or undefined: the gateway then rejects the call before any store write. */
  get(id: string): ModelSpec | undefined;
  /** Each entry's list price as a price row, to load into a price store. Loading them is the caller's step. */
  priceRows(): RegistryPriceRow[];
}

/**
 * The built-in entries plus the caller's. Each custom entry is validated with ModelSpec. An
 * invalid one, a repeated id or a built-in id throws SetupError at startup, naming the entry and
 * the fields at fault and never their values.
 */
export function createModelRegistry<const C extends readonly unknown[] = readonly []>(custom?: C): ModelRegistry<SupportedModel | IdOf<C[number]>> {
  const entries = new Map<string, ModelSpec>(BUILT_IN_MODELS.map((spec) => [spec.id, spec]));
  (custom ?? []).forEach((raw, index) => {
    const parsed = ModelSpec.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.code}`).join(', ');
      throw new SetupError(`Model entry ${index} fails its schema (${issues})`, { cause: parsed.error });
    }
    if (entries.has(parsed.data.id)) throw new SetupError(`Model ${parsed.data.id} is already registered, and a built-in entry cannot be replaced`);
    entries.set(parsed.data.id, parsed.data);
  });
  type Id = SupportedModel | IdOf<C[number]>;
  return {
    // Every key is a built-in id or the id of an entry that passed ModelSpec, which is what Id says.
    ids: [...entries.keys()] as Id[],
    has: (id): id is Id => entries.has(id),
    get: (id) => entries.get(id),
    priceRows: () => [...entries.values()].map((spec) => ({ model: spec.id, ...spec.price })),
  };
}

/** The registry a gateway uses when it is given none: the built-in entries only. */
export const BUILT_IN_REGISTRY: ModelRegistry = createModelRegistry();
