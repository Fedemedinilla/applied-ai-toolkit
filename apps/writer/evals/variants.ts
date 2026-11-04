// What the [COMPLETAR] rule buys. V0 is the prompt as it ships, rule included. NC removes the rule
// and the one line in the category block that names the marker, leaving the facts rule ("every
// date, time, place ... must appear in SCHOOL or the brief") as the only guard against invention.
//
// The other mentions of [COMPLETAR] stay: the role signatures that carry one, and the turn line
// for revisions. The variant measures the rule, not the marker's existence.

import type { Edit, Variant } from '../../../evals/src/index.ts';
import { BLOCK, COMPLETAR_RULE } from '../server/prompt.ts';
import type { Lang } from './target.ts';

const noRule: Edit[] = [
  { block: BLOCK.rules, find: `${COMPLETAR_RULE}\n\n`, replace: '' },
  // Only categories with a required call to action have this clause; optional covers the rest.
  { block: BLOCK.category, find: "; if the brief gives no link, write [COMPLETAR: enlace].", replace: '.', optional: true },
];

export const VARIANTS: Variant<Lang>[] = [
  { id: 'V0', what: 'production prompt, with the [COMPLETAR] rule', edits: () => [] },
  { id: 'NC', what: 'no [COMPLETAR] rule: missing facts are left to the facts rule alone', edits: () => noRule },
];
