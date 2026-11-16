/**
 * rewrite(input, { gateway }) (design 4.11): the stages S0 to S7 of design 4.4, in order. The
 * deterministic analysis (stages/analyse.ts) runs first; the early exit of S1b returns before any
 * model call.
 */
import { analyse, earlyExit, prepare } from './stages/analyse.ts';
import { RewriteInput, type RewriteOptions, type RewriteResult } from './types.ts';

export async function rewrite(raw: RewriteInput, _options: RewriteOptions): Promise<RewriteResult> {
  const analysis = analyse(prepare(RewriteInput.parse(raw)));
  const early = earlyExit(analysis);
  if (early !== null) return early;
  // The model stages S2 to S7 are wired in the next step of F5b.
  throw new Error('the model stages S2 to S7 are not wired yet');
}
