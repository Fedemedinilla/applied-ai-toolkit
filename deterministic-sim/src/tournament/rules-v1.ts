/**
 * Ruleset dice-1. Published: do not edit. A change goes into rules-v2.ts with a new version string,
 * registered in rulesets.ts, and the runs saved under dice-1 keep replaying under this file.
 */

import { deepFreeze, type Ruleset } from './rules.ts';

export const RULES_V1: Ruleset = deepFreeze({
  version: 'dice-1',
  rounds: 20,
  startChips: 10,
  maxChips: 20,
  maxDice: 5,
  faces: 6,
  restChips: 4,
  maxStreak: 5,
  heatPerStreak: 100,
  bustOnes: 2,
  combos: {
    single: 1000,
    none: 1000,
    pair: 1250,
    'two-pair': 1500,
    triple: 2000,
    'full-house': 2500,
    four: 3000,
    five: 5000,
  },
  houses: [
    { name: 'calm', weight: 6, permille: 1000 },
    { name: 'cold', weight: 2, permille: 800 },
    { name: 'hot', weight: 2, permille: 1250 },
  ],
  pointsPerChipLeft: 1,
});
