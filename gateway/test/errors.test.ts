import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  classifyApiError,
  CONNECTION_NOT_OPENED,
  ConnectionNotOpenedError,
  ERROR_CODES,
  isConnectFailure,
  isNetworkDrop,
  parseRetryAfter,
  type ApiErrorCode,
  type CutSignals,
} from '../src/errors.ts';

const NOW = Date.parse('2026-10-23T15:00:00Z');
type ApiType = NonNullable<ConstructorParameters<typeof Anthropic.APIError>[4]>;
const NO_CUT: CutSignals = { timedOut: false, streaming: false };

function httpError(status: number, type: string, headers: Record<string, string> = {}) {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type, message: 'x' } }, undefined, new Headers({ 'request-id': 'req_1', ...headers }));
}

function codeOf(error: unknown, signals: CutSignals = NO_CUT): ApiErrorCode | null {
  return classifyApiError(error, signals, NOW)?.code ?? null;
}

/** The TypeError undici throws when the connection drops, with the socket error in cause. */
function undiciDrop(message: string, socketCode: string): TypeError {
  return new TypeError(message, { cause: Object.assign(new Error('other side closed'), { code: socketCode }) });
}

describe('classifyApiError', () => {
  it.each<[number, string, ApiErrorCode]>([
    [400, 'invalid_request_error', 'bad_request'],
    [401, 'authentication_error', 'authentication'],
    [402, 'billing_error', 'billing'],
    [403, 'permission_error', 'permission_denied'],
    [404, 'not_found_error', 'not_found'],
    [409, 'conflict_error', 'conflict'],
    [413, 'request_too_large', 'bad_request'],
    [422, 'invalid_request_error', 'bad_request'],
    [429, 'rate_limit_error', 'rate_limited'],
    [500, 'api_error', 'server_error'],
    [504, 'timeout_error', 'server_error'],
    [529, 'overloaded_error', 'overloaded'],
  ])('HTTP %i (%s) is %s', (status, type, code) => {
    expect(classifyApiError(httpError(status, type), NO_CUT, NOW)).toEqual({ code, status, apiType: type, retryAfterSec: null, requestId: 'req_1' });
  });

  it('an error that arrives as a stream event has no status: classified by error.type', () => {
    const inStream = (type: ApiType | null) => new Anthropic.APIError(undefined, { type: 'error', error: { type } }, undefined, new Headers(), type);
    expect(codeOf(inStream('overloaded_error'))).toBe('overloaded');
    expect(codeOf(inStream('rate_limit_error'))).toBe('rate_limited');
    expect(codeOf(inStream('api_error'))).toBe('server_error');
    expect(codeOf(inStream(null))).toBe('api_error');
  });

  it('reads retry-after on 429 and 529', () => {
    expect(classifyApiError(httpError(429, 'rate_limit_error', { 'retry-after': '7' }), NO_CUT, NOW)?.retryAfterSec).toBe(7);
    expect(classifyApiError(httpError(529, 'overloaded_error', { 'retry-after-ms': '1500' }), NO_CUT, NOW)?.retryAfterSec).toBe(1.5);
  });

  it('an abort is a timeout if the gateway deadline fired, and cancelled otherwise', () => {
    const sdkAbort = new Anthropic.APIUserAbortError();
    const fetchAbort = new DOMException('This operation was aborted', 'AbortError');
    expect(codeOf(sdkAbort, { timedOut: true, streaming: false })).toBe('timeout');
    expect(codeOf(fetchAbort, { timedOut: true, streaming: false })).toBe('timeout');
    expect(codeOf(sdkAbort)).toBe('cancelled');
    // A 529 that landed just as the deadline fired is still a 529.
    expect(codeOf(httpError(529, 'overloaded_error'), { timedOut: true, streaming: false })).toBe('overloaded');
  });

  it("the SDK's timeout and connection errors, and the network drop fetch throws outside the SDK", () => {
    expect(codeOf(new Anthropic.APIConnectionTimeoutError())).toBe('timeout');
    expect(codeOf(new Anthropic.APIConnectionError({ message: 'x' }))).toBe('connection');
    expect(codeOf(new TypeError('terminated'))).toBe('connection');
    expect(codeOf(undiciDrop('read failed', 'UND_ERR_SOCKET'))).toBe('connection');
    expect(codeOf(undiciDrop('read failed', 'ECONNRESET'))).toBe('connection');
  });

  it('an error from outside the API, SDK and network is not an outage: null, so the gateway rethrows it', () => {
    expect(codeOf(new Error('a bug'))).toBeNull();
    expect(codeOf(new TypeError("Cannot read properties of undefined (reading 'type')"))).toBeNull();
    expect(codeOf(new RangeError('Invalid array length'))).toBeNull();
    expect(codeOf('a string')).toBeNull();
    expect(isNetworkDrop(new TypeError('x', { cause: { code: 'ERR_INVALID_ARG_TYPE' } }))).toBe(false);
  });

  it('a bare AnthropicError while streaming: a cut without a cause or with a network cause, an SDK error with a bug as cause', () => {
    const streaming = { timedOut: false, streaming: true };
    const cut = new Anthropic.AnthropicError('stream ended without producing a Message with role=assistant');
    expect(codeOf(cut, streaming)).toBe('connection');
    expect(codeOf(cut)).toBe('sdk_error');
    const wrap = (cause: Error) => Object.assign(new Anthropic.AnthropicError(cause.message), { cause });
    expect(codeOf(wrap(undiciDrop('terminated', 'UND_ERR_SOCKET')), streaming)).toBe('connection');
    expect(codeOf(wrap(new TypeError('a stream handler with a bug')), streaming)).toBe('sdk_error');
  });
});

describe('isConnectFailure', () => {
  // As Node 24's fetch (undici) throws it: TypeError("fetch failed") with the socket error in cause.
  const fromFetch = (code: string, syscall?: string) =>
    new TypeError('fetch failed', { cause: Object.assign(new Error(`${syscall ?? ''} ${code}`), { code, ...(syscall ? { syscall } : {}) }) });

  it('recognizes connect-time codes anywhere in the cause chain', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(isConnectFailure(fromFetch(code)), code).toBe(true);
    }
  });

  it('of the OpenSSL codes, only handshake ones count; a bad record on an open connection does not', () => {
    for (const code of ['ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_SSL_UNSUPPORTED_PROTOCOL']) {
      expect(isConnectFailure(fromFetch(code)), code).toBe(true);
    }
    for (const code of ['ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC', 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC', 'ERR_SSL_WRONG_VERSION_NUMBER_X']) {
      expect(isConnectFailure(fromFetch(code)), code).toBe(false);
    }
  });

  it("Node's reset before the TLS handshake counts by its message; any other ECONNRESET does not", () => {
    const beforeHandshake = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });
    expect(isConnectFailure(new TypeError('fetch failed', { cause: beforeHandshake }))).toBe(true);
    expect(isConnectFailure(fromFetch('ECONNRESET'))).toBe(false);
  });

  it('ETIMEDOUT counts only on connect; on an open socket the request may have left', () => {
    expect(isConnectFailure(fromFetch('ETIMEDOUT', 'connect'))).toBe(true);
    expect(isConnectFailure(fromFetch('ETIMEDOUT', 'read'))).toBe(false);
  });

  it('several addresses that all fail on connect (autoSelectFamily) arrive as an AggregateError', () => {
    const attempts = [fromFetch('ENETUNREACH', 'connect').cause, fromFetch('ETIMEDOUT', 'connect').cause];
    expect(isConnectFailure(new TypeError('fetch failed', { cause: Object.assign(new AggregateError(attempts), { code: 'ENETUNREACH' }) }))).toBe(true);
    expect(isConnectFailure(new AggregateError([fromFetch('ETIMEDOUT', 'connect').cause, fromFetch('ECONNRESET', 'read').cause]))).toBe(false);
  });

  it('without evidence, it assumes the request may have left', () => {
    for (const code of ['UND_ERR_SOCKET', 'EPIPE', 'UND_ERR_HEADERS_TIMEOUT']) expect(isConnectFailure(fromFetch(code)), code).toBe(false);
    expect(isConnectFailure(new TypeError('fetch failed'))).toBe(false);
    expect(isConnectFailure(new Anthropic.APIUserAbortError())).toBe(false);
    expect(isConnectFailure(new Anthropic.APIConnectionTimeoutError())).toBe(false);
    expect(isConnectFailure('ECONNREFUSED')).toBe(false);
  });

  it('finds ConnectionNotOpenedError as the SDK wraps it, and that error never says "timeout"', () => {
    const notOpened = new ConnectionNotOpenedError(new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }));
    expect(isConnectFailure(new Anthropic.APIConnectionError({ cause: notOpened }))).toBe(true);
    expect(notOpened.code).toBe(CONNECTION_NOT_OPENED);
    // The SDK treats as a timeout, and strips the cause of, any fetch error that says so in its
    // message or its cause's message. This one has neither.
    expect(String(notOpened)).not.toMatch(/timed? ?out/i);
    expect(Object.hasOwn(notOpened, 'cause')).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('reads retry-after-ms, retry-after in seconds and as an HTTP date', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }), NOW)).toBe(0.25);
    expect(parseRetryAfter(new Headers({ 'retry-after': '30' }), NOW)).toBe(30);
    expect(parseRetryAfter(new Headers({ 'retry-after': new Date(NOW + 12_000).toUTCString() }), NOW)).toBe(12);
    expect(parseRetryAfter(new Headers({ 'retry-after': 'whenever' }), NOW)).toBeNull();
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
  });
});

describe('error classes', () => {
  it('every code used in src/ is in the catalog', () => {
    const sources = ['errors.ts', 'gateway.ts', 'caps.ts', 'config.ts'].map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n');
    // Quoted snake_case words passed as codes: the first argument of super(), ConfigError(), CapError() and the code maps.
    const used = new Set([...sources.matchAll(/(?:super|ConfigError|CapError|responseError|http|noHttp)\('([a-z_]+)'/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(10);
    for (const code of used) expect(Object.keys(ERROR_CODES), code).toContain(code);
  });

  it('ApiError says whether a retry makes sense', () => {
    const failure = (code: ApiErrorCode) => ({ code, status: null, apiType: null, retryAfterSec: null, requestId: null });
    expect(new ApiError(failure('overloaded'), null).retryable).toBe(true);
    expect(new ApiError(failure('timeout'), null).retryable).toBe(true);
    expect(new ApiError(failure('bad_request'), null).retryable).toBe(false);
    expect(new ApiError(failure('cancelled'), null).retryable).toBe(false);
  });

  it('error messages carry codes and statuses, never the API message, which can echo request content', () => {
    const fromApi = Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'echo of the request text' } }, undefined, new Headers());
    const failure = classifyApiError(fromApi, NO_CUT, NOW);
    if (failure === null) throw new Error('expected a classification');
    const error = new ApiError(failure, null, { cause: fromApi });
    expect(error.message).toBe('Claude API call failed (bad_request, 400 invalid_request_error)');
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('echo of the request text');
  });
});
