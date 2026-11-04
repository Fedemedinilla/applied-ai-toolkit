import type { Ruleset } from './rules.ts';
import { RULES_V1 } from './rules-v1.ts';

/** Every published ruleset, by version. Old versions stay, so old runs still replay. */
const RULESETS: ReadonlyMap<string, Ruleset> = new Map([[RULES_V1.version, RULES_V1]]);

export const CURRENT_RULESET = RULES_V1.version;

export class UnknownRulesetError extends Error {
  constructor(version: string) {
    super(`unknown ruleset "${version}"`);
    this.name = 'UnknownRulesetError';
  }
}

export function rulesFor(version: string): Ruleset {
  const rules = RULESETS.get(version);
  if (!rules) throw new UnknownRulesetError(version);
  return rules;
}

export function rulesetVersions(): string[] {
  return [...RULESETS.keys()];
}
