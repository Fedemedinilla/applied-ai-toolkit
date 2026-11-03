/**
 * Every failure the gateway reports is a GatewayError with a stable `code` from ERROR_CODES, so
 * callers branch on the code and never on a message. The extra fields hold ids, codes, counts and
 * costs: the only things that may go to a log. None of them carries prompt text, model output or
 * the API's own error message.
 */
import Anthropic from '@anthropic-ai/sdk';

type RefusalCategory = NonNullable<Anthropic.Beta.BetaRefusalStopDetails['category']>;

/** The catalog. A code keeps one meaning; tests check that every error class uses a listed code. */
export const ERROR_CODES = {
  // Before calling
  invalid_setup: 'A value the gateway or client was built with is unusable: an empty key, a timeout that is not a positive integer, an unknown time zone.',
  invalid_request: 'The request breaks a gateway rule (prefill, too many cache breakpoints, an unsupported schema). A bug in the caller; the API is not called.',
  invalid_config: 'Task or cap configuration read from the store is missing or fails its schema, for example a model the gateway was not verified with.',
  unknown_account: 'The user has no account caps row, so the gateway cannot tell which caps apply. Fails closed.',
  invalid_usage_totals: 'The usage totals for the caps failed their schema, came back null where a sum was requested, or could not be read for the second check after the reservation. A cap that did not sum cannot stop anything.',
  cap_monthly_global: 'Spend this month across all users reached the global monthly cap.',
  cap_daily_user: 'Spend today for this user reached the daily cap.',
  cap_per_job: 'Spend for this job reached the per-job cap.',
  // HTTP 200 responses that are not usable. They were billed and are in the ledger.
  refusal: 'stop_reason refusal, also after a server-side fallback ran.',
  truncated: 'stop_reason max_tokens.',
  context_window_exceeded: 'stop_reason model_context_window_exceeded.',
  invalid_output: 'The text is not JSON or does not satisfy the zod schema.',
  unexpected_stop_reason: 'A stop_reason the gateway never asks for (tool_use, pause_turn, stop_sequence, compaction).',
  // API and transport
  rate_limited: 'HTTP 429 or a rate_limit_error event. Retryable.',
  overloaded: 'HTTP 529 or an overloaded_error event. Retryable.',
  server_error: 'HTTP 5xx other than 529. Retryable.',
  conflict: 'HTTP 409. Retryable.',
  connection: 'The connection failed or dropped. Retryable.',
  timeout: 'The gateway timeout fired, or the SDK did not get response headers in time. Retryable.',
  cancelled: "The caller's AbortSignal fired.",
  bad_request: 'HTTP 400, 413 or 422.',
  authentication: 'HTTP 401.',
  permission_denied: 'HTTP 403.',
  not_found: 'HTTP 404.',
  billing: 'HTTP 402 or a billing_error event.',
  api_error: 'An API error without a more specific class.',
  sdk_error: 'The SDK failed on its own, outside the network.',
  // The ledger
  reservation_failed: 'The reservation row could not be written, even after one retry. The API was not called.',
  record_failed: 'The row that closes the reservation could not be written. The result is withheld and the reservation keeps counting at its worst case.',
} as const;

export type GatewayErrorCode = keyof typeof ERROR_CODES;

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  constructor(code: GatewayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Before calling
// ---------------------------------------------------------------------------

export class SetupError extends GatewayError {
  declare readonly code: 'invalid_setup';
  constructor(message: string, options?: ErrorOptions) {
    super('invalid_setup', message, options);
  }
}

export class RequestError extends GatewayError {
  declare readonly code: 'invalid_request';
  constructor(message: string, options?: ErrorOptions) {
    super('invalid_request', message, options);
  }
}

export type ConfigErrorCode = 'invalid_config' | 'unknown_account' | 'invalid_usage_totals';

export class ConfigError extends GatewayError {
  declare readonly code: ConfigErrorCode;
  constructor(code: ConfigErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

export type CapCode = 'cap_monthly_global' | 'cap_daily_user' | 'cap_per_job';

/** A spending cap was reached. The API was not called. */
export class CapError extends GatewayError {
  declare readonly code: CapCode;
  /** US$ spent in the cap's window, including `unpricedBoundUsd`. */
  readonly spentUsd: number;
  /**
   * The part of `spentUsd` that is an upper bound and not a measured cost: unpriced rows, cut
   * calls and open reservations, valued at their worst case.
   */
  readonly unpricedBoundUsd: number;
  /** The cap that applied: the lower of the global cap and the account's own. */
  readonly capUsd: number;

  constructor(code: CapCode, spentUsd: number, capUsd: number, unpricedBoundUsd = 0) {
    const bound = unpricedBoundUsd > 0 ? `, ${unpricedBoundUsd} of it an upper bound for unpriced usage` : '';
    super(code, `Cap reached (${code}): US$${spentUsd} of US$${capUsd}${bound}`);
    this.spentUsd = spentUsd;
    this.unpricedBoundUsd = unpricedBoundUsd;
    this.capUsd = capUsd;
  }
}

// ---------------------------------------------------------------------------
// HTTP 200 responses that are not usable (billed, and in the ledger)
// ---------------------------------------------------------------------------

export type ResponseErrorCode = 'refusal' | 'truncated' | 'context_window_exceeded' | 'invalid_output' | 'unexpected_stop_reason';

/** Where structured output failed: the zod issue path and code, never the value. */
export interface OutputProblem {
  readonly path: string;
  readonly code: string;
}

export interface FailedResponse {
  readonly usageId: string;
  readonly requestId: string | null;
  readonly modelResponded: string;
  readonly stopReason: string | null;
  readonly costUsd: number | null;
  readonly refusalCategory?: RefusalCategory | null;
  /**
   * stop_details.recommended_model: the fallback did not run (its model was rate limited or
   * overloaded) and the API suggests retrying on this model directly. A hint, not a promise.
   */
  readonly recommendedModel?: string | null;
  readonly problems?: readonly OutputProblem[];
}

export class ResponseError extends GatewayError {
  declare readonly code: ResponseErrorCode;
  readonly usageId: string;
  readonly requestId: string | null;
  readonly modelResponded: string;
  readonly stopReason: string | null;
  readonly costUsd: number | null;
  readonly refusalCategory: RefusalCategory | null;
  readonly recommendedModel: string | null;
  readonly problems: readonly OutputProblem[];

  constructor(code: ResponseErrorCode, message: string, data: FailedResponse, options?: ErrorOptions) {
    super(code, message, options);
    this.usageId = data.usageId;
    this.requestId = data.requestId;
    this.modelResponded = data.modelResponded;
    this.stopReason = data.stopReason;
    this.costUsd = data.costUsd;
    this.refusalCategory = data.refusalCategory ?? null;
    this.recommendedModel = data.recommendedModel ?? null;
    this.problems = data.problems ?? [];
  }
}

// ---------------------------------------------------------------------------
// API and transport errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'conflict'
  | 'connection'
  | 'timeout'
  | 'cancelled'
  | 'bad_request'
  | 'authentication'
  | 'permission_denied'
  | 'not_found'
  | 'billing'
  | 'api_error'
  | 'sdk_error';

/** Worth retrying later. The rest fail the same way next time. */
const RETRYABLE: ReadonlySet<ApiErrorCode> = new Set(['rate_limited', 'overloaded', 'server_error', 'conflict', 'connection', 'timeout']);

/** What an API failure says, without its message. Built by classifyApiError. */
export interface ApiFailure {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  /** error.type from the API, such as overloaded_error. */
  readonly apiType: string | null;
  readonly retryAfterSec: number | null;
  readonly requestId: string | null;
}

export class ApiError extends GatewayError {
  declare readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly apiType: string | null;
  /** Seconds the API asks to wait (retry-after-ms or retry-after). */
  readonly retryAfterSec: number | null;
  readonly requestId: string | null;
  /**
   * The ledger row for what the call may have spent: a stream cut after message_start, or a cut
   * (timeout, signal, dropped connection) of a request that may have reached the API. If that row
   * could not be written, this is the reservation, which keeps counting at its worst case. Null
   * when the request never left (an aborted signal, a connection that never opened) or when the
   * API answered with an HTTP error, which is not billed: the reservation was closed with a
   * zero-usage row.
   */
  readonly usageId: string | null;

  constructor(failure: ApiFailure, usageId: string | null, options?: ErrorOptions) {
    const detail = [failure.status, failure.apiType].filter((v) => v !== null).join(' ');
    super(failure.code, `Claude API call failed (${failure.code}${detail ? `, ${detail}` : ''})`, options);
    this.retryable = RETRYABLE.has(failure.code);
    this.status = failure.status;
    this.apiType = failure.apiType;
    this.retryAfterSec = failure.retryAfterSec;
    this.requestId = failure.requestId;
    this.usageId = usageId;
  }
}

/** By error.type, for errors that arrive as a stream event (no HTTP status). */
const BY_API_TYPE: Readonly<Record<string, ApiErrorCode>> = {
  overloaded_error: 'overloaded',
  rate_limit_error: 'rate_limited',
  api_error: 'server_error',
  timeout_error: 'server_error',
  invalid_request_error: 'bad_request',
  authentication_error: 'authentication',
  permission_error: 'permission_denied',
  not_found_error: 'not_found',
  billing_error: 'billing',
};

/** Seconds to wait. Reads retry-after-ms, then retry-after in seconds or as an HTTP date. */
export function parseRetryAfter(headers: Headers | undefined, nowMs: number): number | null {
  const ms = Number(headers?.get('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms / 1000;
  const value = headers?.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, (date - nowMs) / 1000);
}

export interface CutSignals {
  /** The gateway's own timeout fired. Otherwise a cut came from the caller's signal. */
  readonly timedOut: boolean;
  readonly streaming: boolean;
}

/** undici and Node codes for a connection that dropped or never opened. */
const NETWORK_CODE = /^(?:UND_ERR_|ECONN|EPIPE$|ETIMEDOUT$|ENOTFOUND$|EAI_AGAIN$|EHOSTUNREACH$|ENETUNREACH$|ENETDOWN$)/;

/**
 * The TypeError that Node's fetch (undici) throws when the network drops: "fetch failed" on
 * connect, or "terminated" while the body arrives, with the socket error in `cause`. A TypeError
 * from a bug does not look like this.
 */
export function isNetworkDrop(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  if (error.message === 'fetch failed' || error.message === 'terminated') return true;
  const cause: unknown = error.cause;
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' && NETWORK_CODE.test(cause.code);
}

/**
 * Codes for a connection that never opened, so the request did not leave: DNS, refused, no route,
 * undici's connect timeout, a certificate that does not validate, a TLS handshake that did not
 * finish. ECONNRESET and closed sockets are excluded because they can happen after the request was
 * sent. ETIMEDOUT only counts on connect (CONNECT_SYSCALLS).
 *
 * Of the OpenSSL codes, only the ones raised during the handshake count, before a byte of the
 * request is written: a server that does not speak TLS (WRONG_VERSION_NUMBER), no shared version
 * or protocol, and handshake alerts. Other ERR_SSL_ codes can happen on an open connection and are
 * treated as a cut, at the worst case.
 */
const CONNECT_CODE =
  /^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|UND_ERR_CONNECT_TIMEOUT|ERR_TLS_|CERT_|UNABLE_TO_(?:GET|VERIFY)_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|ERR_SSL_(?:WRONG_VERSION_NUMBER|UNSUPPORTED_PROTOCOL|NO_PROTOCOLS_AVAILABLE|(?:SSL\/TLS|SSLV3|TLSV1)_ALERT_(?:HANDSHAKE_FAILURE|PROTOCOL_VERSION|UNRECOGNIZED_NAME))$)/;

/** Node's reset when the server closes before the TLS handshake ends (_tls_wrap.js, onConnectEnd). */
const RESET_BEFORE_HANDSHAKE = 'Client network socket disconnected before secure TLS connection was established';

/** Node system calls that fail before a connection exists: `connect ETIMEDOUT`, `getaddrinfo ENOTFOUND`. */
const CONNECT_SYSCALLS: ReadonlySet<unknown> = new Set(['connect', 'getaddrinfo']);

export const CONNECTION_NOT_OPENED = 'CONNECTION_NOT_OPENED';

/**
 * Thrown by the client's fetch wrapper (client.ts) instead of undici's error when the connection
 * never opened. The SDK treats any fetch error whose text or cause mentions "timeout" as a request
 * timeout and replaces it with an APIConnectionTimeoutError without a cause. undici's connect
 * timeout says exactly that, so the evidence that nothing was sent was lost and the gateway would
 * charge the worst case for a request that never left. This error avoids those words and keeps
 * the original in `original`, not in `cause`, so the SDK wraps it in an APIConnectionError and
 * isConnectFailure finds it.
 */
export class ConnectionNotOpenedError extends Error {
  readonly code = CONNECTION_NOT_OPENED;
  readonly original: unknown;

  constructor(original: unknown) {
    super('The connection to the Claude API never opened: the request was not sent');
    this.name = 'ConnectionNotOpenedError';
    this.original = original;
  }
}

function saysNotOpened(error: object): boolean {
  if (error instanceof ConnectionNotOpenedError) return true;
  if ('code' in error && typeof error.code === 'string' && CONNECT_CODE.test(error.code)) return true;
  if (error instanceof Error && 'code' in error && error.code === 'ECONNRESET' && error.message === RESET_BEFORE_HANDSHAKE) return true;
  if ('syscall' in error && CONNECT_SYSCALLS.has(error.syscall)) return true;
  // With autoSelectFamily Node tries each address and, if all fail, collects them in an AggregateError.
  return error instanceof AggregateError && error.errors.length > 0 && error.errors.every(isConnectFailure);
}

/**
 * Whether the error proves the connection never opened. Walks the `cause` chain looking for a
 * ConnectionNotOpenedError or a socket error with a connect-time code or syscall. Without such
 * evidence it returns false: when in doubt, the request may have been sent.
 *
 * Known overcount: a timeout or caller abort that fires while the connection is still opening
 * arrives as a plain cut, and is recorded at its worst case even though nothing was sent. That
 * errs on the safe side.
 */
export function isConnectFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if (saysNotOpened(current)) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Maps what an SDK call threw to a stable code, from the most specific class to the most general
 * (several inherit from APIError). An abort arrives as APIUserAbortError, or as fetch's AbortError
 * if it fired while the body was arriving; the cut signals tell a gateway timeout from a caller
 * cancel. They are only consulted for an abort, so a 529 that landed just before the timeout is
 * still a 529.
 *
 * Returns null when the error comes from neither the API, the SDK nor the network. That is a bug,
 * and the gateway rethrows it as is instead of dressing it up as a retryable outage.
 */
export function classifyApiError(error: unknown, signals: CutSignals, nowMs: number): ApiFailure | null {
  const noHttp = (code: ApiErrorCode): ApiFailure => ({ code, status: null, apiType: null, retryAfterSec: null, requestId: null });
  const isAbort = error instanceof Anthropic.APIUserAbortError || (error instanceof Error && error.name === 'AbortError');
  if (isAbort) return noHttp(signals.timedOut ? 'timeout' : 'cancelled');
  // The SDK's own timeout (headers did not arrive in time). A connect timeout does not land here:
  // client.ts turns it into ConnectionNotOpenedError, which the SDK wraps in APIConnectionError.
  if (error instanceof Anthropic.APIConnectionTimeoutError) return noHttp('timeout');
  if (error instanceof Anthropic.APIConnectionError) return noHttp('connection');

  if (error instanceof Anthropic.APIError) {
    const http = (code: ApiErrorCode): ApiFailure => ({
      code,
      status: error.status ?? null,
      apiType: error.type,
      retryAfterSec: parseRetryAfter(error.headers, nowMs),
      requestId: error.requestID ?? null,
    });
    if (error instanceof Anthropic.RateLimitError) return http('rate_limited');
    if (error instanceof Anthropic.InternalServerError) {
      return http(error.status === 529 || error.type === 'overloaded_error' ? 'overloaded' : 'server_error');
    }
    if (error instanceof Anthropic.ConflictError) return http('conflict');
    if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.UnprocessableEntityError) return http('bad_request');
    if (error instanceof Anthropic.AuthenticationError) return http('authentication');
    if (error instanceof Anthropic.PermissionDeniedError) return http('permission_denied');
    if (error instanceof Anthropic.NotFoundError) return http('not_found');
    // No dedicated class: 402 and 413 by status, and stream error events (no status) by error.type.
    if (error.status === 402) return http('billing');
    if (error.status === 413) return http('bad_request');
    return http((error.type && BY_API_TYPE[error.type]) || 'api_error');
  }
  if (error instanceof Anthropic.AnthropicError) {
    // While streaming, the SDK wraps whatever stops the read in an AnthropicError with the original
    // in `cause`: undici's TypeError for a dropped connection, or an exception from a stream
    // handler (a bug). Without a cause it is the SDK's own, such as "stream ended without producing
    // a Message" for a body that ended before message_stop: a dropped connection.
    if (!signals.streaming) return noHttp('sdk_error');
    if (error.cause === undefined) return noHttp('connection');
    return noHttp(isNetworkDrop(error.cause) ? 'connection' : 'sdk_error');
  }
  // Outside the SDK: undici throws a TypeError if the connection drops while a non-streaming body
  // arrives. Anything else is a bug.
  return isNetworkDrop(error) ? noHttp('connection') : null;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** The reservation could not be written, even after one retry. The API was not called. */
export class ReservationError extends GatewayError {
  declare readonly code: 'reservation_failed';
  /** The id the reservation was attempted with. It is not in the ledger. */
  readonly usageId: string;

  constructor(usageId: string, options?: ErrorOptions) {
    super('reservation_failed', `Could not write reservation ${usageId}: Claude was not called`, options);
    this.usageId = usageId;
  }
}

/**
 * The call finished but the row that closes its reservation was not saved. The result is withheld,
 * and the call keeps counting toward the caps at the reservation's worst case.
 */
export class RecordError extends GatewayError {
  declare readonly code: 'record_failed';
  /** The reservation: the row that stays in the ledger, open, at its worst case. */
  readonly usageId: string;
  /** What the call cost, if it could be computed. It did not reach the ledger. */
  readonly costUsd: number | null;

  constructor(usageId: string, costUsd: number | null, options?: ErrorOptions) {
    super('record_failed', `Could not close reservation ${usageId}: it stays at its worst case`, options);
    this.usageId = usageId;
    this.costUsd = costUsd;
  }
}
