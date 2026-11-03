/**
 * What the gateway reads from its stores before calling, validated with zod. Stores return
 * `unknown` on purpose: a database row or RPC result is an external boundary, and generated types
 * cannot say which models the gateway supports or that a sum can come back null.
 */
import { z } from 'zod';
import { ConfigError, RequestError, type ConfigErrorCode } from './errors.ts';
import { EFFORTS, SUPPORTED_MODELS } from './models.ts';

/** Model and effort for one task. Effort stays fixed per task because changing it invalidates the prompt cache. */
export const TaskConfig = z.object({
  task: z.string().min(1),
  model: z.enum(SUPPORTED_MODELS),
  effort: z.enum(EFFORTS),
  /** Effort for inputs the caller flags as hard. Null: the task has no variant. */
  hardCaseEffort: z.enum(EFFORTS).nullable(),
});
export type TaskConfig = z.infer<typeof TaskConfig>;

/**
 * Model and effort carried by the request instead of read from the task config: a job that froze
 * its config when it started, or an eval run that tries another model without touching production.
 */
export const CallConfig = z.strictObject({ model: z.enum(SUPPORTED_MODELS), effort: z.enum(EFFORTS) });
export type CallConfig = z.infer<typeof CallConfig>;

export const GlobalCaps = z.object({
  perJobUsd: z.number().positive(),
  dailyPerUserUsd: z.number().positive(),
  monthlyUsd: z.number().positive(),
});
export type GlobalCaps = z.infer<typeof GlobalCaps>;

/** An account's own caps. Null: only the global cap applies. They can lower a global cap, never raise it. */
export const AccountCaps = z.object({
  perJobUsd: z.number().positive().nullable(),
  dailyPerUserUsd: z.number().positive().nullable(),
});
export type AccountCaps = z.infer<typeof AccountCaps>;

const count = z.int().nonnegative();
const sum = z.number().nonnegative();

/**
 * Usage totals for the caps (the SQL function usage_for_caps). Without a user the userDay* fields
 * are null, and without a job the job* fields are null. A *BoundUsd is also null when there are
 * unpriced rows and no price is in force at all; the gateway never reads such a null as zero.
 */
export const UsageTotals = z.object({
  userDayUsd: sum.nullable(),
  userDayUnpriced: count.nullable(),
  userDayBoundUsd: sum.nullable(),
  monthUsd: sum,
  monthUnpriced: count,
  monthBoundUsd: sum.nullable(),
  jobUsd: sum.nullable(),
  jobUnpriced: count.nullable(),
  jobBoundUsd: sum.nullable(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

/** Issue paths and codes, never values. */
function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.code}`).join(', ');
}

function parse<S extends z.ZodType>(schema: S, value: unknown, code: ConfigErrorCode, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ConfigError(code, `${what} fails its schema (${describeIssues(result.error)})`, { cause: result.error });
}

/** Config carried by the request is part of the request: if it is wrong, the request is malformed. */
export function parseCallConfig(value: unknown): CallConfig {
  const result = CallConfig.safeParse(value);
  if (result.success) return result.data;
  throw new RequestError(`Malformed request: config fails its schema (${describeIssues(result.error)})`, { cause: result.error });
}

export function parseTaskConfig(row: unknown, task: string): TaskConfig {
  if (row === null) throw new ConfigError('invalid_config', `No task config for ${task}`);
  const config = parse(TaskConfig, row, 'invalid_config', `task config of ${task}`);
  if (config.task !== task) throw new ConfigError('invalid_config', `Asked for the config of ${task} and got ${config.task}`);
  return config;
}

export function parseGlobalCaps(row: unknown): GlobalCaps {
  if (row === null) throw new ConfigError('invalid_config', 'No global caps row');
  return parse(GlobalCaps, row, 'invalid_config', 'global caps');
}

export function parseAccountCaps(row: unknown, userId: string): AccountCaps {
  if (row === null) throw new ConfigError('unknown_account', `User ${userId} has no account caps row`);
  return parse(AccountCaps, row, 'invalid_config', `account caps of user ${userId}`);
}

export function parseUsageTotals(value: unknown): UsageTotals {
  return parse(UsageTotals, value, 'invalid_usage_totals', 'usage totals');
}
