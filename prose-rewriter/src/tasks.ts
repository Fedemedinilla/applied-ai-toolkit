/**
 * The rewriter's four gateway tasks (design 4.10): their model, their effort and the caps a
 * deploy starts with. The caller seeds its gateway's config store with TASK_CONFIGS; the stages
 * name a task and never a model, so the gateway's task config is the only place a model is chosen.
 *
 * Models (D2): plan, edit and style run on claude-fable-5-2; the fact judge runs on
 * claude-sonnet-5-5, a different model from the one that edits (4.6 step 3). Fixed in F6 (design
 * 4.10 step 5) on F6b's fourth real-model run, 2026-11-16 (README, "Measured").
 *
 * Effort is fixed per task, with no hard-case variant, because changing it invalidates the prompt
 * cache (gateway/src/config.ts:10). Every task runs at `medium`, the effort that run measured:
 * the default strategy, 'single', kept the voice in 21 of 23 scored cases with no hard failure.
 * For the three writing tasks it is also the default of Agency-Seeker's Fable 5.2 writer
 * (WRITER_EFFORT in its src/writer/write.ts, whose note says `high` cost US$1.40 per application in
 * its first real run). The judge's `medium` is the effort of evals' own judge (JUDGE_CALL).
 */
import type { CallSettings } from '../../evals/src/index.ts';
import type { GlobalCaps, TaskConfig } from '../../gateway/src/index.ts';

/** Fixed names: a task reaches the ledger, the logs and the spans, so it is never built from the input. */
export const REWRITE_TASKS = ['rewrite.plan', 'rewrite.edit', 'rewrite.style', 'rewrite.judge'] as const;
export type RewriteTask = (typeof REWRITE_TASKS)[number];

export const TASK_CONFIGS: Readonly<Record<RewriteTask, TaskConfig>> = {
  'rewrite.plan': { task: 'rewrite.plan', model: 'claude-fable-5-2', effort: 'medium', hardCaseEffort: null },
  'rewrite.edit': { task: 'rewrite.edit', model: 'claude-fable-5-2', effort: 'medium', hardCaseEffort: null },
  'rewrite.style': { task: 'rewrite.style', model: 'claude-fable-5-2', effort: 'medium', hardCaseEffort: null },
  'rewrite.judge': { task: 'rewrite.judge', model: 'claude-sonnet-5-5', effort: 'medium', hardCaseEffort: null },
};

export function taskConfig(task: RewriteTask): TaskConfig {
  return TASK_CONFIGS[task];
}

/**
 * The caps a deploy starts with, set in F6 (design 4.10 step 5) from F6b's fourth real-model run,
 * 2026-11-16: 33 fictional cases, cost per rewrite measured on the gateway, fact judge included
 * (README, "Measured"). The export keeps its F5a name so the callers that seed a gateway with it
 * do not change; the values are no longer placeholders.
 *
 * - perJobUsd 0.25: above the highest p90 measured, US$0.1412 for the staged strategy on a
 *   follow-up, with room for the retry of a stage reply that cannot be read. The default strategy,
 *   'single', had a p90 of at most US$0.0652.
 * - dailyPerUserUsd 2: at the measured medians, 58 to 153 rewrites a day with 'single'
 *   (US$0.0341 cover letter to US$0.0130 follow-up) or 19 to 47 with 'staged' (US$0.1012
 *   follow-up to US$0.0424 WhatsApp).
 * - monthlyUsd 10: on the same medians, 293 to 769 rewrites a month with 'single' or 98 to 235
 *   with 'staged'.
 *
 * 33 cases is a small sample (D3 is open): the caps are revised when the case set grows.
 */
export const PROVISIONAL_CAPS: GlobalCaps = {
  perJobUsd: 0.25,
  dailyPerUserUsd: 2,
  monthlyUsd: 10,
};

/**
 * The evals call settings that match a task's config, for a runner that takes a ModelClient (the
 * fact judge, judgePiece). gatewayModelClient refuses any other settings, so the label a run is
 * measured under is the config the gateway calls with. No output format: the gateway's text call
 * does not send one.
 */
export function callSettings(task: RewriteTask, maxTokens: number): CallSettings {
  const config = taskConfig(task);
  return { model: config.model, max_tokens: maxTokens, output_config: { effort: config.effort } };
}
