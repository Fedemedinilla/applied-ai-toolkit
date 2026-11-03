/**
 * Sample variants against the fictional writer's prompt. They mirror the four
 * that were measured in the case study, rewritten for this business.
 *
 * Workflow: V0 is the prompt as it ships. A variant is a list of edits that
 * turns V0 into a proposal. Run both, judge blind, and if the variant wins,
 * change the product, check with --dump that the new V0 equals the old
 * variant byte for byte, and delete the variant. Once shipped, its edits no
 * longer match and the exactly-once check would stop every run, which is the
 * reminder to delete it.
 */
import type { Edit, Variant } from '../src/variants.ts';
import { BLOCK, type Lang } from './business.ts';

/** V1: no word floor. "Between 35 and 60 words." becomes "Up to 60 words." */
const noFloor: Edit[] = [{ block: BLOCK.business, find: /Between (\d+) and (\d+) words\./, replace: 'Up to $2 words.' }];

const INVENT_LINE = '- Never invent a person, a channel, a promotion or a policy because it is normally true of a bike shop.';

/**
 * V2: procedures, yes/no answers and tone examples, spelled out as facts or
 * not-facts. "When someone will call" is in the procedure line here, so the
 * callback clause that the case study lists under V4 is already part of V2.
 */
const factRules: Edit[] = [
  {
    block: BLOCK.rules,
    find: INVENT_LINE,
    replace: [
      INVENT_LINE,
      '- A procedure is a fact too: how to drop off or pick up a bike, who to ask, what happens to a repair already in the shop, when someone will call. If it is not in FACTS or the brief, you do not write it.',
      '- Whether this business has, sells or does something is a fact too. If FACTS does not mention it, do not say yes and do not say no: say what IS loaded, or point at a channel in FACTS.',
      '- The examples inside TONE show how the business phrases things. They are not facts about it.',
    ].join('\n'),
  },
];

/**
 * V4 adds this on top of V3: without it, V3 answered unknowns like a bot
 * reading its own data. (The case study's V4 also made a callback time a
 * fact; here V2 carries that.)
 */
const talksAsItself: Edit[] = [
  {
    block: BLOCK.rules,
    find: '- If the brief needs a fact that is not loaded,',
    replace:
      '- When the brief asks something you do not know, the business still talks as itself. It never says it does not know, cannot confirm or has no information: it answers the part that IS loaded and hands the rest to a channel in FACTS as an ordinary next step.\n- If the brief needs a fact that is not loaded,',
  },
];

export const VARIANTS: Variant<Lang>[] = [
  { id: 'V0', what: 'production prompt, unchanged', edits: () => [] },
  { id: 'V1', what: 'no word floor', edits: () => noFloor },
  { id: 'V2', what: 'procedures and yes/no answers are facts', edits: () => factRules },
  { id: 'V3', what: 'V1 + V2', edits: () => [...noFloor, ...factRules] },
  { id: 'V4', what: 'V3 + the business talks as itself when it does not know', edits: () => [...noFloor, ...factRules, ...talksAsItself] },
];
