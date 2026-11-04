// The evals runner's ModelClient (evals/src/model.ts), implemented over the gateway instead of the
// SDK. A live eval run then spends through the same cap, ledger and request rules as the product,
// and the SDK keeps a single importer.
//
// The runner passes the target's call settings on every request. The gateway takes the model and
// effort from its task config instead, so a request whose settings differ from that config is
// refused here rather than measured under the wrong label.

import type { ModelClient, ModelReply } from '../../../evals/src/index.ts';
import type { Conversation, Gateway } from '../../../gateway/src/index.ts';
import { EFFORT, MODEL, TASK } from '../server/model.ts';
import { PROMPT_VERSION } from '../server/prompt.ts';

export function gatewayModelClient(gateway: Gateway): ModelClient {
  return {
    async create(request): Promise<ModelReply> {
      if (request.model !== MODEL || request.output_config?.effort !== EFFORT) {
        throw new Error(`eval call settings (${request.model}, ${request.output_config?.effort ?? 'no effort'}) differ from the gateway task (${MODEL}, ${EFFORT})`);
      }
      const last = request.messages.at(-1);
      if (last?.role !== 'user') throw new Error('the conversation must end on a user turn');
      const messages: Conversation = [...request.messages.slice(0, -1), { role: 'user', content: last.content }];
      const result = await gateway.text({
        task: TASK,
        userId: null,
        promptVersion: `${PROMPT_VERSION}+eval`,
        maxTokens: request.max_tokens,
        system: request.system.map((block) => block.text),
        messages,
      });
      const t = result.meta.tokens;
      // The gateway returns only end_turn replies; refusals and cuts throw and become failure rows.
      return {
        text: result.text,
        stopReason: 'end_turn',
        usage: { input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead, cache_creation_input_tokens: t.cacheWrite5m + t.cacheWrite1h },
      };
    },
  };
}
