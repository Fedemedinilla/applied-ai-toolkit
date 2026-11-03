import Anthropic from '@anthropic-ai/sdk';
import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_API_URL, createClaudeClient } from '../src/client.ts';
import { ConnectionNotOpenedError, isConnectFailure, SetupError } from '../src/errors.ts';
import { connectTimesOut, errorResponse, fakeApi, fakeMessage, hangs, jsonResponse } from './helpers/fake-claude.ts';

const ping = (client: Anthropic) => client.beta.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe('createClaudeClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('takes neither the URL, the credential nor the log level from the environment', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9/some-proxy');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-the-environment');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token-from-the-environment');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    const { client, requests } = fakeApi([() => jsonResponse(fakeMessage())]);

    expect(client.baseURL).toBe(CLAUDE_API_URL);
    expect(client.logLevel).toBe('warn');
    await ping(client);
    expect(requests[0]?.url.startsWith(`${CLAUDE_API_URL}/v1/messages`)).toBe(true);
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-fake');
    expect(requests[0]?.headers.has('x-api-key')).toBe(false);
  });

  it('maxRetries 0: a 529 is a single request (the SDK default would make 3)', async () => {
    const { client, requests } = fakeApi([() => errorResponse(529, 'overloaded_error'), () => jsonResponse(fakeMessage())]);
    expect(client.maxRetries).toBe(0);
    await expect(ping(client)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('sets an explicit timeout and sends the 1.x API version', async () => {
    const { client, requests } = fakeApi([() => jsonResponse(fakeMessage())], { timeoutMs: 123_000 });
    expect(client.timeout).toBe(123_000);
    await ping(client);
    expect(requests[0]?.headers.get('anthropic-version')).toBe('2026-10-21');
  });

  describe("the client's fetch keeps the evidence that the connection never opened", () => {
    it('a connect timeout arrives as APIConnectionError wrapping ConnectionNotOpenedError, not as a request timeout', async () => {
      const { client } = fakeApi([connectTimesOut]);
      const error = await settle(ping(client));
      // Without the wrapper, the SDK throws APIConnectionTimeoutError with no cause, because of the word "Timeout".
      expect(error).not.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
      expect(error).toBeInstanceOf(Anthropic.APIConnectionError);
      const cause = error instanceof Error ? error.cause : null;
      expect(cause).toBeInstanceOf(ConnectionNotOpenedError);
      expect(cause).toMatchObject({ original: { message: 'fetch failed', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } } });
    });

    it('failures on an open connection stay as the SDK reports them: missing headers are a timeout', async () => {
      const { client } = fakeApi([hangs], { timeoutMs: 20 });
      const error = await settle(ping(client));
      expect(error).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
      expect(isConnectFailure(error)).toBe(false);
    });
  });

  describe("with Node's real fetch against a local port", () => {
    async function server(onConnect: (socket: Socket) => void): Promise<{ readonly url: string; close(): void }> {
      const tcp = createServer(onConnect);
      await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
      const address = tcp.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      return { url: `https://127.0.0.1:${address.port}`, close: () => void tcp.close() };
    }

    async function errorAgainst(onConnect: (socket: Socket) => void): Promise<unknown> {
      const { url, close } = await server(onConnect);
      try {
        return await settle(ping(createClaudeClient({ apiKey: 'sk-fake', timeoutMs: 5000, baseURL: url })));
      } finally {
        close();
      }
    }

    // The TLS handshake never finished, so the request was not sent.
    it.each([
      ['a port that does not speak TLS (ERR_SSL_WRONG_VERSION_NUMBER)', (socket: Socket) => socket.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n')],
      // A TLS handshake_failure alert (40), as sent by a server with no cipher in common.
      ['a handshake alert from the server', (socket: Socket) => socket.end(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]))],
      ['a server that closes before the handshake ends', (socket: Socket) => socket.destroy()],
    ])('%s: the connection never opened', async (_name, onConnect) => {
      const error = await errorAgainst(onConnect);
      expect(error).toBeInstanceOf(Anthropic.APIConnectionError);
      expect(error instanceof Error ? error.cause : null).toBeInstanceOf(ConnectionNotOpenedError);
      expect(isConnectFailure(error)).toBe(true);
    });
  });

  it('refuses to build with an empty key or a timeout that is not a positive integer', () => {
    expect(() => createClaudeClient({ apiKey: ' ', timeoutMs: 1000 })).toThrow(SetupError);
    expect(() => createClaudeClient({ apiKey: 'sk', timeoutMs: 0 })).toThrow(SetupError);
    expect(() => createClaudeClient({ apiKey: 'sk', timeoutMs: 1.5 })).toThrow(SetupError);
  });
});
