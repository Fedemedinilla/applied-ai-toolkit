/**
 * The evals runner's ModelClient (evals/src/model.ts), implemented over the gateway instead of the
 * SDK. The fact judge (evals' judgePiece, design 4.6 step 3) takes a ModelClient; through this one
 * its calls spend under the same caps, ledger and request rules as the rest of the rewriter.
 *
 * This is a copy of gatewayModelClient in apps/writer/evals/model-client.ts:14. A library cannot
 * import apps/ (import-fences/repo.config.ts), and the writer's version is bound to the writer's
 * own task, so the logic is repeated here for the rewriter's tasks. Keep the two in step.
 *
 * The runner passes its call settings on every request. The gateway takes the model and effort
 * from its task config instead, so a request whose settings differ from that config is refused
 * here rather than measured under the wrong label. One addition to the writer's copy: a request
 * that carries an output format is refused too, since the gateway's text call cannot send one and
 * dropping it silently would change what the model is asked for.
 */
import type { ModelClient, ModelReply } from '../../evals/src/index.ts';
import type { Conversation, Gateway } from '../../gateway/src/index.ts';
import { taskConfig, type RewriteTask } from './tasks.ts';

export interface ModelClientOptions {
  readonly task: RewriteTask;
  /** A UUID or null, as the gateway requires: never a name or an address. */
  readonly userId: string | null;
  readonly jobId?: string | null;
  /** A fixed constant of the calling stage, never built from the input. */
  readonly promptVersion: string;
}

export function gatewayModelClient(gateway: Gateway<string>, options: ModelClientOptions): ModelClient {
  const { model, effort } = taskConfig(options.task);
  return {
    async create(request): Promise<ModelReply> {
      if (request.model !== model || request.output_config?.effort !== effort) {
        throw new Error(
          `call settings (${request.model}, ${request.output_config?.effort ?? 'no effort'}) differ from the gateway task ${options.task} (${model}, ${effort})`,
        );
      }
      if (request.output_config?.format != null) throw new Error(`the gateway text call cannot send an output format (task ${options.task})`);
      const last = request.messages.at(-1);
      if (last?.role !== 'user') throw new Error('the conversation must end on a user turn');
      const messages: Conversation = [...request.messages.slice(0, -1), { role: 'user', content: last.content }];
      const result = await gateway.text({
        task: options.task,
        userId: options.userId,
        jobId: options.jobId ?? null,
        promptVersion: options.promptVersion,
        maxTokens: request.max_tokens,
        system: request.system.map((block) => block.text),
        messages,
      });
      const t = result.meta.tokens;
      // The gateway returns only end_turn replies; refusals and cuts throw.
      return {
        text: result.text,
        stopReason: 'end_turn',
        usage: { input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead, cache_creation_input_tokens: t.cacheWrite5m + t.cacheWrite1h },
      };
    },
  };
}
