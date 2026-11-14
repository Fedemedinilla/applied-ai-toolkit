/**
 * Tracing without a dependency. The gateway reports one CallSpan per call to a CallObserver, when
 * it is given one, and otelObserver turns a span into an OpenTelemetry span on a tracer the
 * caller passes in. The tracer is typed by its shape, so this package does not depend on
 * `@opentelemetry/api`.
 *
 * A span holds what the ledger and the logs hold: ids, models, token counts, costs, codes and
 * times. It has no field for prompt or response text, and none for the user or the job.
 */
import type { TokenTotals } from './cost.ts';
import type { GatewayErrorCode } from './errors.ts';
import type { Effort } from './models.ts';

export type CallOperation = 'structured' | 'structured_stream' | 'text';

/** One gateway call, from the first check to the closing row and the output validation. */
export interface CallSpan {
  readonly operation: CallOperation;
  readonly task: string;
  readonly promptVersion: string;
  /** The model asked for. Null when the call stopped before it reserved (a malformed request, bad config, a reached cap). */
  readonly model: string | null;
  /** response.model: another model after a server-side fallback. Null when no response named one. */
  readonly modelResponded: string | null;
  readonly effort: Effort | null;
  readonly maxTokens: number;
  readonly streaming: boolean;
  /**
   * Tokens as the closing row has them: all measured, or what a cut call had measured, or zeros
   * for a request that was not billed. Null when no closing row was written.
   */
  readonly tokens: TokenTotals | null;
  /**
   * The reservation's worst case in US$: the estimated input and maxTokens of output at the
   * highest price in force among the registry's models. Null when nothing was reserved, or when
   * the prices could not be read: never a zero that was not computed.
   */
  readonly reservedUsd: number | null;
  /**
   * What the closing row recorded: the measured cost, or 0 for a request that was not billed.
   * Null when the cost is unknown (an unpriced model, a cut call, no closing row); the caps then
   * count the call at its bound.
   */
  readonly settledUsd: number | null;
  readonly outcome: 'ok' | 'error';
  /** The gateway's error code, or 'unknown' for an error from outside it. Null when the call succeeded. */
  readonly errorCode: GatewayErrorCode | 'unknown' | null;
  readonly stopReason: string | null;
  readonly fellBack: boolean;
  readonly requestId: string | null;
  /** The reservation row, when one was written. */
  readonly reservationId: string | null;
  /** The row that closed the reservation, when one was written. */
  readonly usageId: string | null;
  readonly startTime: Date;
  /** The whole call on the monotonic clock: store reads, the API call, the closing row. */
  readonly durationMs: number;
}

/**
 * Receives each call's span after the call has ended, whatever its outcome. An observer that
 * throws does not change the call's result: the gateway logs the notice `observer_failed`.
 */
export interface CallObserver {
  onCall(span: CallSpan): void;
}

// ---------------------------------------------------------------------------
// OpenTelemetry
// ---------------------------------------------------------------------------

type OtelAttribute = string | number | boolean | string[];

/** The part of an OpenTelemetry Span this adapter uses. */
export interface OtelSpan {
  setStatus(status: { code: number; message?: string }): unknown;
  end(endTime?: Date): void;
}

/** The part of an OpenTelemetry Tracer this adapter uses. A Tracer from `@opentelemetry/api` fits. */
export interface OtelTracer {
  startSpan(name: string, options?: { kind?: number; startTime?: Date; attributes?: Record<string, OtelAttribute> }): OtelSpan;
}

/** SpanKind.CLIENT and SpanStatusCode.ERROR in `@opentelemetry/api`, by value. */
const SPAN_KIND_CLIENT = 2;
const STATUS_ERROR = 2;

/**
 * The attributes of a span. The gen_ai.* names are those of the OpenTelemetry GenAI semantic
 * conventions; what they have no name for goes under claude_gateway.*. An attribute whose value
 * is unknown is left out, never set to zero.
 */
export function otelAttributes(span: CallSpan): Record<string, OtelAttribute> {
  const attributes: Record<string, OtelAttribute> = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': 'anthropic',
    'gen_ai.request.max_tokens': span.maxTokens,
    'claude_gateway.operation': span.operation,
    'claude_gateway.task': span.task,
    'claude_gateway.prompt_version': span.promptVersion,
    'claude_gateway.streaming': span.streaming,
    'claude_gateway.outcome': span.outcome,
    'claude_gateway.fell_back': span.fellBack,
  };
  const set = (key: string, value: OtelAttribute | null) => {
    if (value !== null) attributes[key] = value;
  };
  set('gen_ai.request.model', span.model);
  set('gen_ai.response.model', span.modelResponded);
  set('gen_ai.response.finish_reasons', span.stopReason === null ? null : [span.stopReason]);
  if (span.tokens !== null) {
    const cacheWrites = span.tokens.cacheWrite5m + span.tokens.cacheWrite1h;
    // The convention's input_tokens includes cached tokens; the API's input_tokens does not.
    attributes['gen_ai.usage.input_tokens'] = span.tokens.input + span.tokens.cacheRead + cacheWrites;
    attributes['gen_ai.usage.output_tokens'] = span.tokens.output;
    attributes['gen_ai.usage.cache_read.input_tokens'] = span.tokens.cacheRead;
    attributes['gen_ai.usage.cache_creation.input_tokens'] = cacheWrites;
  }
  set('error.type', span.errorCode);
  set('claude_gateway.effort', span.effort);
  set('claude_gateway.cost.reserved_usd', span.reservedUsd);
  set('claude_gateway.cost.settled_usd', span.settledUsd);
  set('claude_gateway.request_id', span.requestId);
  set('claude_gateway.reservation_id', span.reservationId);
  set('claude_gateway.usage_id', span.usageId);
  return attributes;
}

/**
 * An observer that writes each call as one OpenTelemetry span of kind CLIENT, named
 * "chat <model>" as the GenAI conventions ask, with the call's own start and end times. The span
 * is created when the call ends, so it is a sibling of whatever is active then; pass a tracer
 * bound to the context you want it under.
 */
export function otelObserver(tracer: OtelTracer): CallObserver {
  return {
    onCall(span) {
      const otel = tracer.startSpan(span.model === null ? 'chat' : `chat ${span.model}`, {
        kind: SPAN_KIND_CLIENT,
        startTime: span.startTime,
        attributes: otelAttributes(span),
      });
      // The message is the code: an error's own message never goes into a span.
      if (span.errorCode !== null) otel.setStatus({ code: STATUS_ERROR, message: span.errorCode });
      otel.end(new Date(span.startTime.getTime() + span.durationMs));
    },
  };
}
