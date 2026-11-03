/**
 * The single path to the Claude API. Every call:
 * 1. validates the request (no assistant prefill, cache breakpoints within the limit, ids, bounds);
 * 2. reads the task's model and effort (unless the request carries its own), the caps and the
 *    usage totals, all validated with zod;
 * 3. checks the caps, with unpriced usage valued at its upper bound: a reached cap throws CapError
 *    and the API is not called;
 * 4. writes a reservation row at the call's worst case (estimated input, max_tokens of output).
 *    No row, no call: if the reservation cannot be written, it throws ReservationError;
 * 5. checks the caps again without its own reservation, so calls that reserved concurrently see
 *    each other; a reached cap closes the reservation with a zero-usage row and throws CapError;
 * 6. calls client.beta.messages with server-side fallbacks in "default" mode and nothing else the
 *    caller could set: no temperature, thinking, tool_choice or tools. Only this module builds the
 *    request body;
 * 7. closes the reservation with a row for what happened: the measured response, priced per
 *    attempt at its model's price (also when the response is unusable); an incomplete row if the
 *    call was cut before the API reported everything; or a zero-usage row when the request is known
 *    not to have been billed. If that row cannot be written, the reservation stays open and keeps
 *    counting at its worst case;
 * 8. checks stop_reason before the content, then validates the output with zod.
 *
 * The call's deadline (timeoutMs) and the caller's signal cover everything before the response,
 * including the store reads. What runs after the response (prices and the closing row) is bounded
 * by the stores' own timeouts, so a cut call is still recorded.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { capWindows, checkCaps, type CapCheck, type CapWindows } from './caps.ts';
import { parseAccountCaps, parseCallConfig, parseGlobalCaps, parseTaskConfig, parseUsageTotals, type CallConfig } from './config.ts';
import {
  costUsd,
  countAttachments,
  estimateInputTokens,
  PriceRow,
  pricesInForce,
  splitUsage,
  sumTokens,
  tariffModifiers,
  type AttemptUsage,
  type Cost,
  type TokenTotals,
} from './cost.ts';
import {
  ApiError,
  CapError,
  classifyApiError,
  ConfigError,
  GatewayError,
  isConnectFailure,
  RecordError,
  RequestError,
  ReservationError,
  ResponseError,
  type ApiErrorCode,
  type GatewayErrorCode,
  type OutputProblem,
  type ResponseErrorCode,
} from './errors.ts';
import { FALLBACK_DEFAULT_BETA, type Effort, type SupportedModel } from './models.ts';
import type { Clock, ConfigStore, EventLog, PriceStore, UsageRow, UsageStore } from './ports.ts';
import { structuredFormat, type StructuredFormat } from './schema.ts';
import { requirePositiveInt, requireTimeZone } from './setup.ts';

type BetaMessage = Anthropic.Beta.BetaMessage;
export type ContentBlock = Anthropic.Beta.BetaContentBlock;
export type { CallConfig } from './config.ts';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Something someone should look at, which did not cost anyone their result. */
export type NoticeEvent =
  /** A model with no price answered: costUsd is null. */
  | 'model_unpriced'
  /** usage reported a tariff the price table does not have (region, speed or tier): costUsd is null. */
  | 'tariff_unpriced'
  /** The price table did not answer while recording: costUsd is null. */
  | 'prices_unavailable'
  /** The user or the job has unpriced calls in the window, so its cap was checked against a bound. */
  | 'unpriced_calls_in_window'
  /**
   * A call that may have reached the API was cut before it reported all usage: it is in the ledger
   * as incomplete and the caps value it at its worst case. Also logged when the failure came from
   * outside the API, SDK and network (a bug): the reservation stays open at its worst case.
   */
  | 'usage_unmeasured'
  /** The first insert failed and the retry went in. */
  | 'record_retried';

/** A failure that left someone without their result. Logged on its own channel, at error level. */
export type FailureEvent = 'reservation_failed' | 'record_failed';

export interface GatewayDeps {
  /** Built with createClaudeClient (client.ts): maxRetries 0, explicit baseURL and timeout. */
  readonly client: Anthropic;
  readonly clock: Clock;
  readonly config: ConfigStore;
  readonly usage: UsageStore;
  readonly prices: PriceStore;
  readonly notices: EventLog<NoticeEvent>;
  readonly failures: EventLog<FailureEvent>;
  /** IANA zone of the cap's day and month. */
  readonly timeZone: string;
  /**
   * Deadline for a whole call when the request does not bring its own: store reads, waiting for
   * headers, the body and the stream. The SDK timeout only covers the headers. The reservation is
   * inside the deadline; the closing row is outside it.
   */
  readonly timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

type UserMessage = Anthropic.Beta.BetaUserMessageParam;
type AssistantMessage = Anthropic.Beta.BetaAssistantMessageParam;

/** The conversation always ends on a user turn: no assistant prefill. */
export type Conversation = readonly [...(UserMessage | AssistantMessage)[], UserMessage];

export interface GatewayRequest {
  /** Picks the model and effort from the task config, and labels the ledger row. */
  readonly task: string;
  /** Who the call is for. Null for calls without a user (an eval run, a system job): only the monthly cap applies. */
  readonly userId: string | null;
  /** Groups calls under one per-job cap. */
  readonly jobId?: string | null;
  /** Version of the prompt and schema, for the ledger ("summary@3"). */
  readonly promptVersion: string;
  /**
   * Includes thinking, so leave room. Without streaming, at most MAX_TOKENS_WITHOUT_STREAMING. If
   * the call is cut, the caps count this whole output as the worst case.
   */
  readonly maxTokens: number;
  /**
   * System blocks from most to least stable, each with its own cache breakpoint. The API allows
   * up to 4 breakpoints per request including those in the messages; the gateway checks.
   */
  readonly system: readonly string[];
  /** An attachment (image or PDF as base64, url or file) needs streaming and attachmentTokenBound. */
  readonly messages: Conversation;
  /**
   * Upper bound on the input tokens of the attachments. Required with attachments and only then:
   * their tokens follow from pages and pixels, not from request size. Used as the input estimate if
   * the call is cut before message_start.
   */
  readonly attachmentTokenBound?: number;
  /** Model and effort for this call instead of the task config. The task config is then not read. */
  readonly config?: CallConfig;
  /** Use the task's hardCaseEffort if it has one. Not combinable with `config`. */
  readonly hardCase?: boolean;
  readonly signal?: AbortSignal;
  /** Deadline for this call instead of the default. */
  readonly timeoutMs?: number;
}

export interface TextRequest extends GatewayRequest {
  /** Each piece of text as it arrives. */
  readonly onText?: (delta: string) => void;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface CallMeta {
  /** The ledger row that closed this call's reservation. */
  readonly usageId: string;
  readonly requestId: string | null;
  readonly modelRequested: SupportedModel;
  /** response.model: another model after a server-side fallback. */
  readonly modelResponded: string;
  readonly fellBack: boolean;
  readonly effort: Effort;
  /** Null if any model that answered has no price, or the tariff is not the standard one. */
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly tokens: TokenTotals & { readonly thinking: number | null };
}

export interface StructuredResult<T> {
  readonly data: T;
  /** The content as it arrived, thinking and fallback blocks included. */
  readonly content: readonly ContentBlock[];
  readonly meta: CallMeta;
}

export interface TextResult {
  readonly text: string;
  readonly content: readonly ContentBlock[];
  readonly meta: CallMeta;
}

export interface StreamingCall<R> {
  /**
   * Resolves when the response starts (message_start). From then on the prompt cache can be read,
   * so calls that share the prefix can be launched. Never rejects: it also resolves when the call
   * fails before starting. The error comes out of `final`.
   */
  readonly started: Promise<void>;
  readonly final: Promise<R>;
}

export interface Gateway {
  /**
   * Structured output without streaming, for short calls: maxTokens up to
   * MAX_TOKENS_WITHOUT_STREAMING. Without streaming there is no usage until the end, so a cut
   * call is recorded as incomplete with the estimated input and max_tokens of output.
   */
  structured<S extends z.ZodType>(schema: S, request: GatewayRequest): Promise<StructuredResult<z.output<S>>>;
  /**
   * Structured output with streaming, for long calls and attachments. message_start brings the
   * measured input; output arrives at the end (message_delta). A cut after message_start is
   * recorded with the measured input and max_tokens of output.
   */
  structuredStream<S extends z.ZodType>(schema: S, request: GatewayRequest): StreamingCall<StructuredResult<z.output<S>>>;
  /** Free text with streaming. */
  text(request: TextRequest): Promise<TextResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const Id = z.guid();
/** Cache breakpoints per request, across system and messages. */
const MAX_CACHE_BREAKPOINTS = 4;
/**
 * Highest maxTokens without streaming. Above it, Anthropic's migration guidance asks for streaming
 * on every model: such calls approach request deadlines, and the SDK's own guard
 * (calculateNonstreamingTimeout) does not run because the client sets an explicit timeout.
 */
export const MAX_TOKENS_WITHOUT_STREAMING = 16_000;
/** Failures without a response where the request may have reached the API. HTTP errors are not billed. */
const CUTS: ReadonlySet<ApiErrorCode> = new Set(['timeout', 'cancelled', 'connection']);
const NO_TOKENS: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
const NO_TOKEN_COLUMNS = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 } as const;

/** Fields the reservation and the closing row share. */
type RowBase = Pick<UsageRow, 'userId' | 'task' | 'jobId' | 'effort' | 'promptVersion' | 'modelRequested' | 'maxTokens'>;

interface Prepared {
  readonly params: Anthropic.Beta.MessageCreateParamsNonStreaming;
  readonly model: SupportedModel;
  readonly effort: Effort;
  readonly attachmentBound: number;
  readonly row: RowBase;
  /** What the second cap check needs, read once in prepare. */
  readonly caps: Omit<CapCheck, 'totals'> & { readonly windows: CapWindows };
}

interface Reservation {
  readonly id: string;
  /** Text size plus the attachment bound: the input if message_start never arrives. */
  readonly estimatedInput: number;
}

interface Deadline {
  readonly signal: AbortSignal;
  /** The timeout alone: tells a timeout from a caller cancel. */
  readonly timer: AbortSignal;
  readonly timeoutMs: number;
}

/** What a stream received before it ended or was cut. */
interface Received {
  partial: BetaMessage | null;
  /** message_delta arrived: the partial's usage is final. */
  finalUsage: boolean;
  requestId: string | null;
  listenerError: { readonly error: unknown } | null;
}

type Mode = { readonly kind: 'complete' } | { readonly kind: 'stream'; readonly onText?: (delta: string) => void; readonly onStart?: () => void };

interface Executed {
  readonly response: BetaMessage;
  readonly requestId: string | null;
  readonly startedAt: Date;
  readonly durationMs: number;
}

interface Call {
  readonly response: BetaMessage;
  readonly meta: CallMeta;
}

/** A cut before the request left. usageId is set only if a reservation stayed open. */
function cutBeforeSending(code: 'timeout' | 'cancelled', cause: unknown, usageId: string | null = null): ApiError {
  return new ApiError({ code, status: null, apiType: null, retryAfterSec: null, requestId: null }, usageId, { cause });
}

function breakpointsInMessages(messages: Conversation): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) if ('cache_control' in block && block.cache_control) total += 1;
  }
  return total;
}

/** Validates the request and returns its fixed config, if any. */
function validateRequest(request: GatewayRequest, streaming: boolean): CallConfig | null {
  const fail = (detail: string): never => {
    throw new RequestError(`Malformed request: ${detail}`);
  };
  if (request.task.trim() === '') fail('missing task');
  if (request.promptVersion.trim() === '') fail('missing promptVersion');
  if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) fail(`maxTokens ${request.maxTokens}`);
  if (!streaming && request.maxTokens > MAX_TOKENS_WITHOUT_STREAMING) {
    fail(`maxTokens ${request.maxTokens} without streaming (up to ${MAX_TOKENS_WITHOUT_STREAMING}): use structuredStream`);
  }
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0)) fail(`timeoutMs ${request.timeoutMs}`);
  if (request.system.some((block) => block.trim() === '')) fail('an empty system block');
  // Attachment tokens do not follow from request size. They go through streaming, where
  // message_start measures them, with a bound for a cut before message_start.
  const attachments = countAttachments(request.messages);
  if (attachments > 0 && !streaming) fail(`${attachments} attachments without streaming: use structuredStream`);
  const bound = request.attachmentTokenBound;
  if (bound !== undefined && (!Number.isInteger(bound) || bound <= 0)) fail(`attachmentTokenBound ${bound}`);
  if (attachments > 0 && bound === undefined) fail(`${attachments} attachments without attachmentTokenBound: a cut would not know their weight`);
  if (attachments === 0 && bound !== undefined) fail('attachmentTokenBound without attachments');
  // The type already enforces this; the check covers a request built with a cast.
  const roles: readonly string[] = request.messages.map((m) => m.role);
  if (roles.at(-1) !== 'user') fail('the conversation does not end on a user turn (prefill)');
  if (roles.some((role) => role !== 'user' && role !== 'assistant')) fail('a message whose role is neither user nor assistant');
  const breakpoints = request.system.length + breakpointsInMessages(request.messages);
  if (breakpoints > MAX_CACHE_BREAKPOINTS) {
    fail(`${breakpoints} cache breakpoints across system (${request.system.length}) and messages (max ${MAX_CACHE_BREAKPOINTS})`);
  }
  for (const [name, value] of Object.entries({ userId: request.userId, jobId: request.jobId })) {
    if (value !== undefined && value !== null && !Id.safeParse(value).success) fail(`${name} is not a uuid`);
  }
  if (request.config === undefined) return null;
  if (request.hardCase) fail('hardCase does not combine with config, which already fixes the effort');
  return parseCallConfig(request.config);
}

/** Text blocks in order. Thinking and fallback blocks carry no text. */
export function responseText(content: readonly ContentBlock[]): string {
  let text = '';
  for (const block of content) if (block.type === 'text') text += block.text;
  return text;
}

function fellBack(response: BetaMessage): boolean {
  return (response.usage.iterations ?? []).some((it) => it.type === 'fallback_message');
}

function errorName(error: unknown): string {
  // A retry collects both errors: the last one is what left the row unsaved.
  if (error instanceof AggregateError && error.errors.length > 0) return errorName(error.errors.at(-1));
  if (error instanceof GatewayError) return error.code;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.name : typeof error;
}

export function createGateway(deps: GatewayDeps): Gateway {
  requireTimeZone(deps.timeZone);
  requirePositiveInt(deps.timeoutMs, 'timeoutMs of the gateway');

  /** Reads config and usage, checks the caps and builds the request body. The only place that builds it. */
  async function prepare(request: GatewayRequest, fixed: CallConfig | null, format: StructuredFormat<unknown> | null, signal: AbortSignal): Promise<Prepared> {
    const userId = request.userId;
    const jobId = request.jobId ?? null;
    const windows = capWindows(deps.clock.now(), deps.timeZone);
    const [taskRow, globalRow, accountRow, totalsRaw] = await Promise.all([
      fixed === null ? deps.config.taskConfig(request.task, signal) : null,
      deps.config.globalCaps(signal),
      userId === null ? null : deps.config.accountCaps(userId, signal),
      deps.usage.totalsForCaps({ ...windows, userId, jobId }, signal),
    ]);
    let model: SupportedModel;
    let effort: Effort;
    if (fixed !== null) {
      ({ model, effort } = fixed);
    } else {
      const config = parseTaskConfig(taskRow, request.task);
      model = config.model;
      effort = request.hardCase && config.hardCaseEffort ? config.hardCaseEffort : config.effort;
    }
    const global = parseGlobalCaps(globalRow);
    const account = userId === null ? null : parseAccountCaps(accountRow, userId);
    const totals = parseUsageTotals(totalsRaw);

    const unpriced = checkCaps({ userId, jobId, global, account, totals });
    if ((unpriced.userDay?.calls ?? 0) > 0 || (unpriced.job?.calls ?? 0) > 0) {
      // The global month does not trigger this: one unpriced row would log on every call of every
      // user until the month ends.
      deps.notices.log('unpriced_calls_in_window', {
        task: request.task,
        userDayUnpriced: unpriced.userDay?.calls ?? null,
        userDayBoundUsd: unpriced.userDay?.boundUsd ?? null,
        jobUnpriced: unpriced.job?.calls ?? null,
        jobBoundUsd: unpriced.job?.boundUsd ?? null,
      });
    }

    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: request.maxTokens,
      betas: [FALLBACK_DEFAULT_BETA],
      fallbacks: 'default',
      output_config: format ? { effort, format: format.format } : { effort },
      ...(request.system.length > 0
        ? { system: request.system.map((text) => ({ type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } })) }
        : {}),
      messages: [...request.messages],
    };
    return {
      params,
      model,
      effort,
      attachmentBound: request.attachmentTokenBound ?? 0,
      row: { userId, task: request.task, jobId, effort, promptVersion: request.promptVersion, modelRequested: model, maxTokens: request.maxTokens },
      caps: { userId, jobId, global, account, windows },
    };
  }

  return {
    structured: async (schema, request) => structure(structuredFormat(schema), request, { kind: 'complete' }),
    structuredStream: (schema, request) => {
      const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
      const final = (async () => {
        try {
          return await structure(structuredFormat(schema), request, { kind: 'stream', onStart: () => markStarted() });
        } finally {
          markStarted();
        }
      })();
      // `final` can reject while the caller is still awaiting something else. Without a handler
      // Node treats it as an unhandled rejection. This does not swallow it: `final` still rejects.
      final.catch(() => undefined);
      return { started, final };
    },
    text: async (request) => {
      const mode: Mode = request.onText ? { kind: 'stream', onText: request.onText } : { kind: 'stream' };
      const { response, meta } = await call(request, null, mode);
      requireNormalStop(response, meta);
      return { text: responseText(response.content), content: response.content, meta };
    },
  };

  async function structure<T>(format: StructuredFormat<T>, request: GatewayRequest, mode: Mode): Promise<StructuredResult<T>> {
    const { response, meta } = await call(request, format, mode);
    requireNormalStop(response, meta);
    const validation = format.validate(responseText(response.content));
    if (!validation.ok) throw responseError('invalid_output', 'The output does not satisfy the schema', response, meta, validation.problems);
    return { data: validation.data, content: response.content, meta };
  }

  /**
   * Shared by the three entry points: deadline, preparation, reservation, call and record. A cut
   * before the request leaves (an already aborted signal, or the deadline or signal during the
   * reads) throws ApiError with no row and no notice: nothing was spent. A cut while the
   * reservation was being written closes it with a zero-usage row.
   */
  async function call(request: GatewayRequest, format: StructuredFormat<unknown> | null, mode: Mode): Promise<Call> {
    const fixed = validateRequest(request, mode.kind === 'stream');
    if (request.signal?.aborted) throw cutBeforeSending('cancelled', request.signal.reason);

    const timeoutMs = request.timeoutMs ?? deps.timeoutMs;
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), timeoutMs);
    const deadline: Deadline = {
      signal: request.signal ? AbortSignal.any([request.signal, timer.signal]) : timer.signal,
      timer: timer.signal,
      timeoutMs,
    };
    const cutCode = () => (deadline.timer.aborted ? 'timeout' : 'cancelled');
    let prepared: Prepared;
    let reservation: Reservation;
    let executed: Executed;
    try {
      try {
        prepared = await prepare(request, fixed, format, deadline.signal);
      } catch (error) {
        // A read cut by the deadline or the signal fails like the store fails: report the cut.
        if (deadline.signal.aborted) throw cutBeforeSending(cutCode(), error);
        throw error;
      }
      if (deadline.signal.aborted) throw cutBeforeSending(cutCode(), deadline.signal.reason);
      reservation = await reserve(prepared);
      const refused = deadline.signal.aborted ? null : await recheckCaps(prepared, reservation, deadline.signal);
      if (deadline.signal.aborted) {
        const code = cutCode();
        try {
          await recordUnbilled(prepared, reservation, { code, requestId: null, durationMs: 0 });
        } catch (recordError) {
          throw cutBeforeSending(code, new AggregateError([deadline.signal.reason, recordError], 'Cut before sending, reservation left open'), reservation.id);
        }
        throw cutBeforeSending(code, deadline.signal.reason);
      }
      if (refused !== null) {
        await recordUnbilled(prepared, reservation, { code: refused.code, requestId: null, durationMs: 0 });
        throw refused;
      }
      executed = await execute(prepared, reservation, mode, deadline);
    } finally {
      clearTimeout(handle);
    }
    return { response: executed.response, meta: await recordResponse(prepared, reservation, executed) };
  }

  /** The row before calling: incomplete with nothing measured, valued by the caps at its worst case until closed. */
  async function reserve(prepared: Prepared): Promise<Reservation> {
    const reservation: Reservation = { id: crypto.randomUUID(), estimatedInput: estimateInputTokens(prepared.params) + prepared.attachmentBound };
    try {
      await insert({
        ...prepared.row,
        ...NO_TOKEN_COLUMNS,
        id: reservation.id,
        reservation: true,
        replaces: null,
        modelResponded: null,
        thinkingTokens: null,
        costUsd: null,
        stopReason: null,
        refusalCategory: null,
        attempts: null,
        requestId: null,
        durationMs: null,
        incomplete: true,
        estimatedInputTokens: reservation.estimatedInput,
        errorCode: null,
      });
    } catch (error) {
      deps.failures.log('reservation_failed', { usageId: reservation.id, task: prepared.row.task, error: errorName(error) });
      throw new ReservationError(reservation.id, { cause: error });
    }
    return reservation;
  }

  /**
   * The second cap check, after the reservation is in the ledger. The first check (in prepare)
   * stops a call that is already over a cap without writing anything. This one makes the caps hold
   * under concurrency: it reads the totals again, leaving out this call's own reservation, so it
   * sees every call that reserved before this read. Of the calls that pass, the last one to read
   * saw all the others, so concurrent calls overrun a cap by at most one worst case, the same as
   * sequential calls. Two calls that reserve at the same moment near a cap can both be refused:
   * the error goes toward refusing. Returns the error to throw, or null to go on. A cut during the
   * read returns null and the caller handles the cut.
   */
  async function recheckCaps(prepared: Prepared, reservation: Reservation, signal: AbortSignal): Promise<CapError | ConfigError | null> {
    const { windows, ...caps } = prepared.caps;
    try {
      const totals = parseUsageTotals(await deps.usage.totalsForCaps({ ...windows, userId: caps.userId, jobId: caps.jobId, excludeId: reservation.id }, signal));
      checkCaps({ ...caps, totals });
      return null;
    } catch (error) {
      if (signal.aborted) return null;
      if (error instanceof CapError || error instanceof ConfigError) return error;
      return new ConfigError('invalid_usage_totals', 'Could not read the usage totals after reserving', { cause: error });
    }
  }

  /**
   * Calls the API. On failure it closes the reservation with what the call may have spent
   * (measured, or incomplete) or, when it is known not to have been billed, with a zero-usage row,
   * and throws ApiError. Two errors come out as they are: one thrown by onText, and one from outside
   * the API, SDK and network (a bug, not retried). In that last case nobody knows whether the
   * request left, so the reservation stays open at its worst case.
   */
  async function execute(prepared: Prepared, reservation: Reservation, mode: Mode, deadline: Deadline): Promise<Executed> {
    // Wall-clock time picks the price in force; duration uses the monotonic clock, which does not
    // jump backwards when the system time is adjusted.
    const startedAt = deps.clock.now();
    const startMono = deps.clock.monotonicMs();
    const duration = () => Math.round(deps.clock.monotonicMs() - startMono);
    const options = { signal: deadline.signal, timeout: deadline.timeoutMs };
    // Kept here and not read from stream.currentMessage, which the SDK clears when a stream ends without message_stop.
    const received: Received = { partial: null, finalUsage: false, requestId: null, listenerError: null };
    try {
      if (mode.kind === 'complete') {
        const { data, request_id } = await deps.client.beta.messages.create(prepared.params, options).withResponse();
        return { response: data, requestId: request_id ?? null, startedAt, durationMs: duration() };
      }
      const stream = deps.client.beta.messages.stream(prepared.params, options);
      stream.on('connect', () => {
        received.requestId = stream.request_id ?? null;
      });
      stream.on('streamEvent', (event, snapshot) => {
        received.partial = snapshot;
        // message_start carries the input and output_tokens 1: the output arrives here.
        if (event.type === 'message_delta') received.finalUsage = true;
      });
      if (mode.onStart) stream.once('streamEvent', mode.onStart);
      const onText = mode.onText;
      if (onText) {
        stream.on('text', (delta) => {
          try {
            onText(delta);
          } catch (error) {
            // A listener's error stops the stream and comes out as itself, not as a Claude error.
            received.listenerError ??= { error };
            stream.abort();
          }
        });
      }
      const response = await stream.finalMessage();
      return { response, requestId: stream.request_id ?? null, startedAt, durationMs: duration() };
    } catch (error) {
      const streaming = mode.kind === 'stream';
      const failure = classifyApiError(error, { timedOut: deadline.timer.aborted, streaming }, deps.clock.now().getTime());
      const original = received.listenerError ? received.listenerError.error : error;
      const requestId = received.requestId ?? failure?.requestId ?? null;
      // The reservation counts until something closes it: if the closing row fails, it is what remains.
      let usageId: string | null = reservation.id;
      let recordError: unknown = null;
      try {
        if (received.partial && received.finalUsage) {
          // The final usage arrived and the stream broke afterwards (before message_stop): all measured.
          const executed = { response: received.partial, requestId, startedAt, durationMs: duration() };
          usageId = (await recordResponse(prepared, reservation, executed, failure?.code ?? null)).usageId;
        } else if (received.partial || (failure !== null && CUTS.has(failure.code) && !isConnectFailure(error))) {
          // A stream cut after message_start, or a cut of a request that may have arrived: the API
          // may have billed more than it reported.
          usageId = await recordIncomplete(prepared, reservation, { partial: received.partial, requestId, durationMs: duration() }, failure?.code ?? null, streaming);
        } else if (failure !== null) {
          // The API answered with an HTTP error, which is not billed, or the connection never opened.
          await recordUnbilled(prepared, reservation, { code: failure.code, requestId, durationMs: duration() });
          usageId = null;
        } else {
          // Not from the API, SDK or network: unknown whether the request left. The reservation stays.
          deps.notices.log('usage_unmeasured', {
            usageId: reservation.id,
            task: prepared.row.task,
            model: prepared.model,
            code: null,
            streaming,
            inputMeasured: false,
            maxTokens: prepared.params.max_tokens,
            requestId,
            durationMs: duration(),
          });
        }
      } catch (caught) {
        // close() already logged it and the reservation keeps counting. The call's error is the one
        // that decides on retries, with the record error in its cause.
        recordError = caught;
      }
      if (received.listenerError || failure === null) throw original;
      const cause = recordError === null ? error : new AggregateError([error, recordError], 'The call and its ledger row both failed');
      throw new ApiError(failure, usageId, { cause });
    }
  }

  /** Cost and ledger row for a response with final usage, closing the reservation. */
  async function recordResponse(prepared: Prepared, reservation: Reservation, executed: Executed, errorCode: ApiErrorCode | null = null): Promise<CallMeta> {
    const { response } = executed;
    const usageId = crypto.randomUUID();
    const attempts = splitUsage(response, prepared.model);
    const cost = await priceCall(attempts, response.usage, executed.startedAt, usageId);
    const tokens = sumTokens(attempts);
    // With several attempts the API reports thinking only for the last one: null, so it is never
    // compared with outputTokens, which adds all attempts.
    const thinking = attempts.length > 1 ? null : (response.usage.output_tokens_details?.thinking_tokens ?? null);
    await close(
      {
        ...prepared.row,
        id: usageId,
        reservation: false,
        replaces: reservation.id,
        modelResponded: response.model,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWrite5mTokens: tokens.cacheWrite5m,
        cacheWrite1hTokens: tokens.cacheWrite1h,
        thinkingTokens: thinking,
        costUsd: cost.usd,
        stopReason: response.stop_reason,
        refusalCategory: response.stop_reason === 'refusal' ? (response.stop_details?.category ?? null) : null,
        attempts: attempts.length > 1 ? attempts : null,
        requestId: executed.requestId,
        durationMs: executed.durationMs,
        incomplete: false,
        estimatedInputTokens: null,
        errorCode,
      },
      reservation,
    );
    return {
      usageId,
      requestId: executed.requestId,
      modelRequested: prepared.model,
      modelResponded: response.model,
      fellBack: fellBack(response) && response.stop_reason !== 'refusal',
      effort: prepared.effort,
      costUsd: cost.usd,
      durationMs: executed.durationMs,
      tokens: { ...tokens, thinking },
    };
  }

  /**
   * The row of a call cut before the API reported all usage: what was measured (message_start's
   * input, if it arrived), costUsd null and incomplete. The caps value it at its worst case: the
   * measured tokens, plus max_tokens of output and, without message_start, the estimated input. At
   * the price of the model that was answering when message_start named one with a price, otherwise
   * at the highest price in force for each token type.
   */
  async function recordIncomplete(
    prepared: Prepared,
    reservation: Reservation,
    cut: { readonly partial: BetaMessage | null; readonly requestId: string | null; readonly durationMs: number },
    code: ApiErrorCode | null,
    streaming: boolean,
  ): Promise<string> {
    const { partial } = cut;
    const usageId = crypto.randomUUID();
    const measured = partial ? sumTokens(splitUsage(partial, prepared.model)) : NO_TOKENS;
    deps.notices.log('usage_unmeasured', {
      usageId,
      task: prepared.row.task,
      model: prepared.model,
      code,
      streaming,
      inputMeasured: partial !== null,
      maxTokens: prepared.params.max_tokens,
      requestId: cut.requestId,
      durationMs: cut.durationMs,
    });
    await close(
      {
        ...prepared.row,
        id: usageId,
        reservation: false,
        replaces: reservation.id,
        // message_start names the model that will answer (after an early fallback, the other one).
        modelResponded: partial?.model ?? null,
        inputTokens: measured.input,
        outputTokens: measured.output,
        cacheReadTokens: measured.cacheRead,
        cacheWrite5mTokens: measured.cacheWrite5m,
        cacheWrite1hTokens: measured.cacheWrite1h,
        thinkingTokens: null,
        costUsd: null,
        stopReason: partial?.stop_reason ?? null,
        refusalCategory: null,
        attempts: null,
        requestId: cut.requestId,
        durationMs: cut.durationMs,
        incomplete: true,
        estimatedInputTokens: partial ? null : reservation.estimatedInput,
        errorCode: code,
      },
      reservation,
    );
    return usageId;
  }

  /** The row of a request that was not billed: an HTTP error, a connection that never opened, or a cut before sending. */
  async function recordUnbilled(
    prepared: Prepared,
    reservation: Reservation,
    end: { readonly code: GatewayErrorCode; readonly requestId: string | null; readonly durationMs: number },
  ): Promise<void> {
    await close(
      {
        ...prepared.row,
        ...NO_TOKEN_COLUMNS,
        id: crypto.randomUUID(),
        reservation: false,
        replaces: reservation.id,
        modelResponded: null,
        thinkingTokens: null,
        costUsd: 0,
        stopReason: null,
        refusalCategory: null,
        attempts: null,
        requestId: end.requestId,
        durationMs: end.durationMs,
        incomplete: false,
        estimatedInputTokens: null,
        errorCode: end.code,
      },
      reservation,
    );
  }

  /**
   * Cost at the prices in force when the call started. If the tariff is not standard or the price
   * table does not answer, cost is null with a notice and the row is still recorded: tokens allow a
   * later recomputation, and the caps count it at its bound.
   */
  async function priceCall(attempts: readonly AttemptUsage[], usage: Anthropic.Beta.BetaUsage, at: Date, usageId: string): Promise<Cost> {
    const models = [...new Set(attempts.map((a) => a.model))];
    const modifiers = tariffModifiers(usage);
    if (modifiers.length > 0) {
      deps.notices.log('tariff_unpriced', { usageId, modifiers });
      return { usd: null, unpriced: models };
    }
    let raw: unknown;
    try {
      raw = await deps.prices.pricesFor(models, at);
    } catch (error) {
      deps.notices.log('prices_unavailable', { usageId, error: errorName(error) });
      return { usd: null, unpriced: models };
    }
    const rows = z.array(PriceRow).safeParse(raw);
    if (!rows.success) {
      deps.notices.log('prices_unavailable', { usageId, error: 'schema' });
      return { usd: null, unpriced: models };
    }
    const cost = costUsd(attempts, pricesInForce(rows.data, at));
    if (cost.usd === null) deps.notices.log('model_unpriced', { usageId, models: cost.unpriced });
    return cost;
  }

  /** One retry with the same id: if the first insert reached the store, the second does not double the cost. */
  async function insert(row: UsageRow): Promise<void> {
    try {
      await deps.usage.record(row);
      return;
    } catch (first) {
      try {
        await deps.usage.record(row);
      } catch (second) {
        throw new AggregateError([first, second], `Could not insert ledger row ${row.id}`);
      }
      deps.notices.log('record_retried', { usageId: row.id, error: errorName(first) });
    }
  }

  /** The closing row. If it fails twice the reservation stays open at its worst case and RecordError names it. */
  async function close(row: UsageRow, reservation: Reservation): Promise<void> {
    try {
      await insert(row);
    } catch (error) {
      deps.failures.log('record_failed', { usageId: reservation.id, costUsd: row.costUsd, error: errorName(error) });
      throw new RecordError(reservation.id, row.costUsd, { cause: error });
    }
  }

  function responseError(code: ResponseErrorCode, message: string, response: BetaMessage, meta: CallMeta, problems: readonly OutputProblem[] = []): ResponseError {
    const refusal = response.stop_reason === 'refusal' ? response.stop_details : null;
    return new ResponseError(code, message, {
      usageId: meta.usageId,
      requestId: meta.requestId,
      modelResponded: meta.modelResponded,
      stopReason: response.stop_reason,
      costUsd: meta.costUsd,
      refusalCategory: refusal?.category ?? null,
      recommendedModel: refusal?.recommended_model ?? null,
      problems,
    });
  }

  /** stop_reason first, content second: only end_turn continues. */
  function requireNormalStop(response: BetaMessage, meta: CallMeta): void {
    switch (response.stop_reason) {
      case 'end_turn':
        return;
      case 'refusal':
        throw responseError('refusal', `Claude refused the request (${response.stop_details?.category ?? 'no category'})`, response, meta);
      case 'max_tokens':
        throw responseError('truncated', 'The response hit max_tokens', response, meta);
      case 'model_context_window_exceeded':
        throw responseError('context_window_exceeded', 'The request does not fit in the context window', response, meta);
      default:
        // tool_use, pause_turn, stop_sequence and compaction need tools, stop sequences or
        // compaction, which the gateway never sends.
        throw responseError('unexpected_stop_reason', `Unexpected stop_reason: ${response.stop_reason}`, response, meta);
    }
  }
}
