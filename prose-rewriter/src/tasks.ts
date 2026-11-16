/**
 * The rewriter's four gateway tasks (design 4.10): their model, their effort and the caps a
 * deploy starts with. The caller seeds its gateway's config store with TASK_CONFIGS; the stages
 * name a task and never a model, so the gateway's task config is the only place a model is chosen.
 *
 * Models (D2): plan, edit and style run on claude-fable-5-2; the fact judge runs on
 * claude-sonnet-5-5, a different model from the one that edits (4.6 step 3).
 *
 * Effort is fixed per task, with no hard-case variant, because changing it invalidates the prompt
 * cache (gateway/src/config.ts:10). The levels are a starting point: the design leaves the effort
 * to the evals gate (D2). The three writing tasks take `high`, the effort Agency-Seeker set for its
 * Fable 5.2 writer; the judge takes `medium`, the effort of evals' own judge (JUDGE_CALL).
 */
import type { CallSettings } from '../../evals/src/index.ts';
import type { GlobalCaps, TaskConfig } from '../../gateway/src/index.ts';

/** Fixed names: a task reaches the ledger, the logs and the spans, so it is never built from the input. */
export const REWRITE_TASKS = ['rewrite.plan', 'rewrite.edit', 'rewrite.style', 'rewrite.judge'] as const;
export type RewriteTask = (typeof REWRITE_TASKS)[number];

export const TASK_CONFIGS: Readonly<Record<RewriteTask, TaskConfig>> = {
  'rewrite.plan': { task: 'rewrite.plan', model: 'claude-fable-5-2', effort: 'high', hardCaseEffort: null },
  'rewrite.edit': { task: 'rewrite.edit', model: 'claude-fable-5-2', effort: 'high', hardCaseEffort: null },
  'rewrite.style': { task: 'rewrite.style', model: 'claude-fable-5-2', effort: 'high', hardCaseEffort: null },
  'rewrite.judge': { task: 'rewrite.judge', model: 'claude-sonnet-5-5', effort: 'medium', hardCaseEffort: null },
};

export function taskConfig(task: RewriteTask): TaskConfig {
  return TASK_CONFIGS[task];
}

/**
 * PROVISIONAL. These caps are placeholders, not measurements: no rewrite has been run against the
 * real model yet. Phase F6 measures the cost per rewrite (median and p90 by genre and mode, design
 * 4.10 step 4) and sets the real values from it (step 5). Until then they are kept low on purpose,
 * as a guard against a loop, and say nothing about what a rewrite costs.
 */
export const PROVISIONAL_CAPS: GlobalCaps = {
  perJobUsd: 0.5,
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
