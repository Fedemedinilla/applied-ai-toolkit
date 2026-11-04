/**
 * Range rules for generated content only. The schemas say what any catalogue entry may be; these
 * say what a generated one may be on top of that. Hand-written cards can break the cost curve on
 * purpose (a signature card is allowed to be strong), and a person can write a rivalry that edits
 * two files. A generated candidate cannot do either.
 *
 * Each rule carries the sentence the prompt shows the model (prompt.ts lists RULES), so the prompt
 * and the check come from the same object and cannot drift apart.
 */
import type { CatalogIndex } from './catalog.ts';
import type { Card, EntityName, EntityTypes } from './schemas.ts';

export interface RuleContext {
  /** The catalogue as validated before the run. */
  readonly index: CatalogIndex;
  /** Ids already waiting in `_candidates/` for this entity type. */
  readonly pending: ReadonlySet<string>;
}

export interface Rule<T> {
  readonly id: string;
  /** Shown to the model in the prompt, word for word. */
  readonly text: string;
  /** Null when the candidate passes, otherwise the reason it does not. */
  readonly check: (candidate: T, context: RuleContext) => string | null;
}

/** Budget of a card at a cost: what its stats and effects may add up to. */
export const curveBudget = (cost: number): number => 2 * cost + 1;
/** Fewer than the schema allows: a generated card with four keywords is never a common card. */
export const MAX_GENERATED_KEYWORDS = 2;
export const MIN_DISTINCT_DECK_CARDS = 4;

/** What a card spends of its budget. Exported for the tests and the prompt. */
export function cardSpend(card: Card): number {
  switch (card.body.type) {
    case 'unit':
      return card.body.power + card.body.health;
    case 'relic':
      return 2 * card.body.charges;
    case 'spell':
      return card.body.effects.reduce((sum, e) => sum + (e.kind === 'damage' || e.kind === 'heal' ? e.amount : 2 * e.count), 0);
  }
}

const common = <T extends { readonly id: string; readonly handwritten: boolean }>(): Rule<T>[] => [
  {
    id: 'not-handwritten',
    text: 'Leave "handwritten" out or set it to false. Only a person marks content as hand-written.',
    check: (c) => (c.handwritten ? 'claims to be hand-written' : null),
  },
  {
    id: 'not-pending',
    text: 'Use an id that is not in the catalogue and not in the list of pending candidates.',
    check: (c, { pending }) => (pending.has(c.id) ? `"${c.id}" is already a pending candidate` : null),
  },
];

export const RULES: { readonly [E in EntityName]: readonly Rule<EntityTypes[E]>[] } = {
  keyword: [...common<EntityTypes['keyword']>()],
  faction: [
    ...common<EntityTypes['faction']>(),
    {
      id: 'no-rival',
      text: 'Set "rival" to null. A rivalry is named on both factions, and a candidate may not edit another file.',
      check: (f) => (f.rival === null ? null : 'names a rival, which would need an edit to another faction'),
    },
  ],
  set: [
    ...common<EntityTypes['set']>(),
    {
      id: 'next-release',
      text: 'Give "releaseOrder" a number after every set in the catalogue.',
      check: (s, { index }) => {
        const last = Math.max(0, ...[...index.set.values()].map((x) => x.releaseOrder));
        return s.releaseOrder > last ? null : `release order ${s.releaseOrder} is not after the last set (${last})`;
      },
    },
  ],
  card: [
    ...common<EntityTypes['card']>(),
    {
      id: 'no-legendary',
      text: 'Do not write legendary cards. They are written by hand.',
      check: (c) => (c.rarity === 'legendary' ? 'is legendary' : null),
    },
    {
      id: 'cost-curve',
      text: `Stay on the cost curve: a card's budget is 2 x cost + 1. A unit spends power + health, a relic spends 2 per charge, a spell spends each damage or heal amount plus 2 per card drawn or unit summoned. Tokens are exempt.`,
      check: (c) => {
        if (c.body.type === 'unit' && c.body.token) return null;
        const spend = cardSpend(c);
        const budget = curveBudget(c.cost);
        return spend <= budget ? null : `spends ${spend} and its budget at cost ${c.cost} is ${budget}`;
      },
    },
    {
      id: 'few-keywords',
      text: `Give a card at most ${MAX_GENERATED_KEYWORDS} keywords.`,
      check: (c) => (c.keywords.length <= MAX_GENERATED_KEYWORDS ? null : `has ${c.keywords.length} keywords`),
    },
  ],
  deck: [
    ...common<EntityTypes['deck']>(),
    {
      id: 'distinct-cards',
      text: `Use at least ${MIN_DISTINCT_DECK_CARDS} different cards in a deck.`,
      check: (d) => (d.cards.length >= MIN_DISTINCT_DECK_CARDS ? null : `uses ${d.cards.length} different cards`),
    },
  ],
};

export interface RuleFailure {
  readonly rule: string;
  readonly message: string;
}

export function checkRules<E extends EntityName>(entity: E, candidate: EntityTypes[E], context: RuleContext): RuleFailure[] {
  const rules: readonly Rule<EntityTypes[E]>[] = RULES[entity];
  const failures: RuleFailure[] = [];
  for (const rule of rules) {
    const message = rule.check(candidate, context);
    if (message !== null) failures.push({ rule: rule.id, message });
  }
  return failures;
}
