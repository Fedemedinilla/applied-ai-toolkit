/**
 * Public entry of csp-build-guard: what a script that runs the guard itself needs, and nothing
 * else. The helpers the checks share (site walking, glob matching, HTML scanning) stay internal,
 * so they can change without a breaking release.
 */
export { runGuard, type RunOptions } from './run.ts';
export { ConfigError, configSchema, loadConfig, parseConfig, type GuardConfig, type GuardConfigInput } from './config.ts';
export { formatReport } from './report.ts';
export { toSarif, type SarifLog, type SarifOptions, type SarifRegion, type SarifResult } from './sarif.ts';
export { InputError } from './site.ts';
export type { CheckId, CheckResult, Failure, GuardReport, Status } from './types.ts';
