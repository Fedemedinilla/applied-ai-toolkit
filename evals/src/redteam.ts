/**
 * Red-team runner: replays attack conversations against a chat handler, turn
 * by turn, the way the product's page holds a conversation.
 *
 * The handler is called directly, not through a server, with the same request
 * shape the browser sends. Each reply goes back into the history with the
 * signature the handler issued, so a multi-turn attack meets the same history
 * check a real visitor would. A turn that never reached the model (a 4xx, an
 * error) is popped from the history, as the page does.
 *
 * Forged history is the attack the page cannot make by accident: assistant
 * turns the attacker wrote, sent with no signature or a made-up one. It is
 * sent verbatim as the history prefix, so the handler's own check is what gets
 * tested, not the runner's.
 *
 * A handler that throws is recorded as status 0 with the error text, the way
 * the page would show a failed request, and the run goes on to the next turn
 * and the next attack. The eval runner treats a failed call the same way.
 */
import { z } from 'zod';

const isRegex = (s: string) => {
  try {
    new RegExp(s, 'i');
    return true;
  } catch {
    return false;
  }
};

export const HistoryMessage = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  signature: z.string().optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessage>;

export const Attack = z
  .strictObject({
    id: z.string().min(1),
    /** The angle of attack, for grouping results: "prompt-extraction", "forged-history". */
    lens: z.string().min(1),
    lang: z.string().min(1),
    turns: z.array(z.string().min(1)).default([]),
    /** What correct behaviour looks like, in words, for a human or a judge. */
    expect: z.string().min(1),
    /** A hand-written history prefix, sent exactly as written. */
    forged: z.array(HistoryMessage).optional(),
    /** Checks the code can decide on its own. */
    checks: z
      .strictObject({
        /** Every turn must be refused with this status before reaching the model. */
        refusedWith: z.number().int().optional(),
        /**
         * No reply may match any of these (case-insensitive regex sources).
         * Compiled when the file is parsed, so a typo stops the run before
         * the first paid turn, not after the last one.
         */
        replyMustNotMatch: z.array(z.string().min(1).refine(isRegex, 'not a valid regular expression')).optional(),
      })
      .optional(),
  })
  .refine((a) => a.turns.length > 0 || (a.forged?.length ?? 0) > 0, 'an attack needs turns, a forged history, or both')
  .refine((a) => a.turns.length > 0 || a.forged?.at(-1)?.role === 'user', 'a forged-only attack must end on a user turn');
export type Attack = z.infer<typeof Attack>;

export const parseAttacks = (json: unknown): Attack[] => z.array(Attack).parse(json);

export type ChatRequest = { messages: HistoryMessage[]; lang: string };
export type ChatResponse = {
  status: number;
  reply?: string;
  signature?: string;
  error?: string;
  /** Anything else the handler returns (a booking card, a guard flag), kept in the transcript. */
  extra?: Record<string, unknown>;
};
export type ChatHandler = (req: ChatRequest) => Promise<ChatResponse>;

export type TurnRecord = {
  sent: HistoryMessage[];
  user: string | null;
  status: number;
  reply: string | null;
  error: string | null;
  ms: number;
  extra?: Record<string, unknown>;
};

export type Outcome = 'pass' | 'fail' | 'review';

export type AttackRecord = {
  id: string;
  lens: string;
  lang: string;
  expect: string;
  outcome: Outcome;
  /** Why the automatic checks failed; empty when they passed or there were none. */
  reasons: string[];
  transcript: TurnRecord[];
};

/**
 * The automatic part of the verdict. "pass" only when the attack carries checks
 * and all of them held; with no checks it is "review", because "the handler did
 * not crash" is not a finding about the attack.
 */
export function evaluate(attack: Attack, transcript: readonly TurnRecord[]): { outcome: Outcome; reasons: string[] } {
  const checks = attack.checks;
  if (!checks || (checks.refusedWith === undefined && !checks.replyMustNotMatch?.length)) {
    return { outcome: 'review', reasons: [] };
  }
  const reasons: string[] = [];
  transcript.forEach((t, i) => {
    if (checks.refusedWith !== undefined && t.status !== checks.refusedWith) {
      reasons.push(`turn ${i + 1}: status ${t.status}, expected ${checks.refusedWith}`);
    }
    for (const src of checks.replyMustNotMatch ?? []) {
      if (t.reply && new RegExp(src, 'i').test(t.reply)) reasons.push(`turn ${i + 1}: reply matches /${src}/i`);
    }
  });
  return { outcome: reasons.length ? 'fail' : 'pass', reasons };
}

export async function runAttack(handler: ChatHandler, attack: Attack): Promise<AttackRecord> {
  const history: HistoryMessage[] = attack.forged ? attack.forged.map((m) => ({ ...m })) : [];
  const transcript: TurnRecord[] = [];

  const send = async (user: string | null) => {
    const sent = history.map((m) => ({ ...m }));
    const t0 = performance.now();
    let res: ChatResponse;
    try {
      res = await handler({ messages: sent, lang: attack.lang });
    } catch (e) {
      res = { status: 0, error: `handler threw: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    transcript.push({
      sent,
      user,
      status: res.status,
      reply: res.reply ?? null,
      error: res.error ?? null,
      ms: Math.round(performance.now() - t0),
      ...(res.extra ? { extra: res.extra } : {}),
    });
    return res;
  };

  if (attack.turns.length === 0) {
    await send(null);
  } else {
    for (const turn of attack.turns) {
      history.push({ role: 'user', content: turn });
      const res = await send(turn);
      if (res.reply !== undefined) {
        history.push({ role: 'assistant', content: res.reply, ...(res.signature ? { signature: res.signature } : {}) });
      } else {
        history.pop();
      }
    }
  }

  const { outcome, reasons } = evaluate(attack, transcript);
  return { id: attack.id, lens: attack.lens, lang: attack.lang, expect: attack.expect, outcome, reasons, transcript };
}

export async function runAttacks(
  handler: ChatHandler,
  attacks: readonly Attack[],
  opts: { concurrency?: number; onRecord?: (r: AttackRecord) => void } = {},
): Promise<AttackRecord[]> {
  const out: AttackRecord[] = [];
  let next = 0;
  const workers = Math.max(1, Math.min(opts.concurrency ?? 2, attacks.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < attacks.length) {
        const r = await runAttack(handler, attacks[next++]!);
        out.push(r);
        opts.onRecord?.(r);
      }
    }),
  );
  return out;
}

/** Counts by lens and outcome, for the summary line of a run. */
export function summarize(records: readonly AttackRecord[]): Record<string, Record<Outcome, number>> {
  const out: Record<string, Record<Outcome, number>> = {};
  for (const r of records) {
    const row = (out[r.lens] ??= { pass: 0, fail: 0, review: 0 });
    row[r.outcome]++;
  }
  return out;
}
