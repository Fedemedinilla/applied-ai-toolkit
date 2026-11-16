/**
 * A scripted gateway for the rewriter's tests: the real gateway (createGateway) over its own
 * in-memory stores, seeded with the rewriter's task configs, and a fake fetch that answers each
 * call from a script per task, in order. Caps, the ledger, config lookup and request validation
 * all run as in production; only the API is fake. Nothing goes to the network.
 *
 * gateway/test/helpers/ has a richer fake API, but a library may reach another library only
 * through its public entry (import-fences/repo.config.ts), so the few message shapes needed here
 * are built locally. Every id, cap and token count is a fixture.
 *
 * A reply is taken from its task's script when the call starts, so concurrent calls of one task
 * get their replies in call order. A call the gateway refuses before it reaches the fake API (a
 * malformed request, a cap) puts its reply back at the front of its task's script, so the reply
 * goes to the next call of that task and assertDone() still sees it as unused if none comes. A
 * call to a task with no reply left throws UnscriptedCallError before the gateway runs, and
 * assertDone() fails while any reply is unused.
 *
 * A `data` reply answers only a structured call (structured, structuredStream) and a `text` reply
 * only a text call: a stage that asks for text where it should ask for a schema-checked object, or
 * the other way round, fails with ScriptMismatchError instead of passing on a reply turned to JSON.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  BUILT_IN_MODELS,
  createClaudeClient,
  createGateway,
  createMemoryStores,
  type Clock,
  type Gateway,
  type GatewayRequest,
  type GlobalCaps,
  type MemoryStores,
  type TaskConfig,
} from '../../gateway/src/index.ts';
import { PROVISIONAL_CAPS, TASK_CONFIGS } from '../src/tasks.ts';

export const USER = '00000000-0000-4000-8000-0000000000f1';
/** After the registry's prices take effect (2026-11-03). */
export const NOW = new Date('2026-11-16T15:00:00.000Z');

export interface ScriptedReply {
  /** A structured reply: sent as JSON text, which the gateway parses with the call's schema. */
  readonly data?: unknown;
  /** A text reply, used as is. Exactly one of data and text. */
  readonly text?: string;
  readonly usage?: { readonly input?: number; readonly output?: number };
}

export type Script = Readonly<Record<string, readonly ScriptedReply[]>>;

export interface RecordedCall {
  readonly operation: 'structured' | 'structuredStream' | 'text';
  readonly task: string;
  readonly request: GatewayRequest<string>;
  /** The body that reached the fake API, or null when the gateway refused the call before sending it. */
  sent: Record<string, unknown> | null;
}

export interface ScriptedGateway {
  readonly gateway: Gateway;
  readonly stores: MemoryStores;
  /** Every call, in the order it was made, including the ones the gateway refused. */
  readonly calls: RecordedCall[];
  /** Throws if any task still has unused replies. */
  assertDone(): void;
}

export interface ScriptedOptions {
  readonly caps?: GlobalCaps;
  readonly tasks?: readonly TaskConfig[];
}

export class UnscriptedCallError extends Error {
  constructor(task: string, operation: string) {
    super(`unscripted gateway call: ${operation} for task ${task} has no reply left in the script`);
    this.name = 'UnscriptedCallError';
  }
}

export class ScriptMismatchError extends Error {
  constructor(task: string, operation: string, kind: 'data' | 'text') {
    super(`script mismatch: the next reply for task ${task} is a ${kind} reply, which cannot answer a ${operation} call`);
    this.name = 'ScriptMismatchError';
  }
}

interface Current {
  readonly record: RecordedCall;
  readonly reply: ScriptedReply;
}

function replyText(reply: ScriptedReply): string {
  if ((reply.data === undefined) === (reply.text === undefined)) throw new Error('a scripted reply needs exactly one of data and text');
  return reply.text ?? JSON.stringify(reply.data);
}

function message(model: unknown, reply: ScriptedReply) {
  return {
    id: 'msg_scripted',
    container: null,
    content: [{ type: 'text', text: replyText(reply), citations: null }],
    context_management: null,
    diagnostics: null,
    model,
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: reply.usage?.input ?? 0,
      iterations: null,
      output_tokens: reply.usage?.output ?? 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: null,
    },
  };
}

/** The server-sent events of the API for one text message, as the SDK's stream reads them. */
function sse(msg: ReturnType<typeof message>): string {
  const [block] = msg.content;
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block?.text ?? '' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        context_management: null,
        delta: { stop_reason: msg.stop_reason, stop_sequence: null, stop_details: null, container: null },
        usage: {
          input_tokens: msg.usage.input_tokens,
          output_tokens: msg.usage.output_tokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: null,
          iterations: null,
          output_tokens_details: null,
          server_tool_use: null,
          fallback_credit: null,
        },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** A clock that moves a quarter second each time it is read, from NOW. */
function steppingClock(): Clock {
  let now = NOW.getTime();
  let mono = 0;
  return {
    now: () => new Date((now += 250) - 250),
    monotonicMs: () => (mono += 250) - 250,
  };
}

export function scriptedGateway(script: Script, options: ScriptedOptions = {}): ScriptedGateway {
  const queues = new Map(Object.entries(script).map(([task, replies]) => [task, [...replies]]));
  const calls: RecordedCall[] = [];
  const current = new AsyncLocalStorage<Current>();
  const clock = steppingClock();
  const stores = createMemoryStores({
    tasks: options.tasks ?? Object.values(TASK_CONFIGS),
    globalCaps: { ...(options.caps ?? PROVISIONAL_CAPS) },
    accounts: { [USER]: { perJobUsd: null, dailyPerUserUsd: null } },
    prices: BUILT_IN_MODELS.map(({ id, price }) => ({ model: id, ...price })),
    clock,
  });

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = current.getStore();
    if (call === undefined) throw new Error('the scripted API got a request from outside a gateway call');
    if (call.record.sent !== null) throw new Error(`the scripted API got a second request for one ${call.record.task} call`);
    const body = JSON.parse(await new Request(input, init).text()) as Record<string, unknown>;
    call.record.sent = body;
    const msg = message(body['model'], call.reply);
    if (body['stream'] === true) return new Response(sse(msg), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_scripted' } });
    return new Response(JSON.stringify(msg), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_scripted' } });
  };

  const inner = createGateway({
    client: createClaudeClient({ apiKey: 'sk-scripted', timeoutMs: 60_000, fetch }),
    clock,
    timeZone: 'UTC',
    timeoutMs: 60_000,
    config: stores.config,
    usage: stores.usage,
    prices: stores.prices,
    notices: { log: () => undefined },
    failures: { log: () => undefined },
  });

  /** Takes the task's next reply for this call; `settled` gives it back if the call never reached the API. */
  function enter<R>(operation: RecordedCall['operation'], request: GatewayRequest<string>, run: () => R): { result: R; settled: (done: Promise<unknown>) => void } {
    const queue = queues.get(request.task);
    const reply = queue?.[0];
    if (queue === undefined || reply === undefined) throw new UnscriptedCallError(request.task, operation);
    replyText(reply);
    const kind = reply.data === undefined ? 'text' : 'data';
    if ((kind === 'text') !== (operation === 'text')) throw new ScriptMismatchError(request.task, operation, kind);
    queue.shift();
    const record: RecordedCall = { operation, task: request.task, request, sent: null };
    calls.push(record);
    const giveBack = () => {
      if (record.sent === null) queue.unshift(reply);
    };
    try {
      const result = current.run({ record, reply }, run);
      return { result, settled: (done) => void done.catch(giveBack) };
    } catch (error) {
      giveBack();
      throw error;
    }
  }

  async function call<R>(operation: 'structured' | 'text', request: GatewayRequest<string>, run: () => Promise<R>): Promise<R> {
    const { result, settled } = enter(operation, request, run);
    settled(result);
    return result;
  }

  const gateway: Gateway = {
    structured: (schema, request) => call('structured', request, () => inner.structured(schema, request)),
    structuredStream: (schema, request) => {
      try {
        const { result, settled } = enter('structuredStream', request, () => inner.structuredStream(schema, request));
        settled(result.final);
        return result;
      } catch (error) {
        const final = Promise.reject(error);
        final.catch(() => undefined);
        return { started: Promise.resolve(), final };
      }
    },
    text: (request) => call('text', request, () => inner.text(request)),
  };

  return {
    gateway,
    stores,
    calls,
    assertDone() {
      const left = [...queues].filter(([, replies]) => replies.length > 0).map(([task, replies]) => `${task}: ${replies.length}`);
      if (left.length > 0) throw new Error(`scripted replies left unused (${left.join(', ')})`);
    },
  };
}
