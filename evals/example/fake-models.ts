/**
 * Scripted stand-ins for the model, for the offline demo and the tests.
 *
 * They exercise the plumbing (edits reach the request, blinding hides the
 * variant, verdicts join back to the right variant) and nothing else. A fake
 * writer that "invents" on cue says nothing about how a real model fills a
 * short brief: the case study is the record of a simulated check passing
 * pieces the real model then padded with invented procedures.
 */
import type { ModelClient, ModelReply, ModelRequest } from '../src/model.ts';

const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
export const reply = (text: string, stopReason: string | null = 'end_turn'): ModelReply => ({ text, stopReason, usage });

/** A client that answers with `respond(request)` and keeps every request it got. */
export function recordingClient(respond: (req: ModelRequest) => ModelReply | Promise<ModelReply>): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async create(req) {
      requests.push(req);
      return respond(req);
    },
  };
}

/** The invented line the fake writer adds when the prompt lacks the procedure rule. */
export const FAKE_INVENTION = "We'll call you as soon as it's ready.";

export function fakeWriter() {
  return recordingClient((req) => {
    const rules = req.system[0]?.text ?? '';
    const brief = req.messages.at(-1)?.content ?? '';
    const lines = [`About your note: ${brief.slice(0, 60).replace(/[.!?]+$/, '')}.`, 'Write to us on WhatsApp at 11 0000-0142.'];
    if (!rules.includes('A procedure is a fact too')) lines.push(FAKE_INVENTION);
    lines.push('Nora, Taller Rayo');
    return reply(lines.join('\n'));
  });
}

/** Marks the fake invention as invented and every other line as no-claim. */
export function fakeJudge() {
  return recordingClient((req) => {
    const body = req.messages[0]?.content ?? '';
    const numbered = body
      .split('\n')
      .map((l) => /^(\d+)\. (.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null);
    const lines = numbered.map((m) => ({
      line: Number(m[1]),
      support: m[2] === FAKE_INVENTION ? 'invented' : 'no-claim',
      note: m[2] === FAKE_INVENTION ? 'callback procedure not in the sheet' : '',
    }));
    const invented = lines.some((l) => l.support === 'invented');
    return reply(JSON.stringify({ lines, voice: 'on', robotic: false, quality: invented ? 2 : 4, note: '' }));
  });
}
