/**
 * The catalogue of a fictional collectible card game, as zod schemas. These are the only
 * definition of the data: the TypeScript types come from z.infer, the JSON schema sent to the
 * model comes from z.toJSONSchema, and the validator, the generator and promote all parse with
 * them. A field that is not here cannot reach the catalogue.
 *
 * Every object is strict, so a misspelled or invented field is an error instead of a silently
 * dropped key. Nested defaults use prefault: an absent `limits` is parsed as `{}`, which then gets
 * its own field defaults, so the output always has the full object.
 *
 * Rules that hold for one entity on its own are here, as refinements. Rules that need another
 * entity (a card's set exists, a token is summoned by some card) are in catalog.ts. Rules that
 * apply only to generated content (the cost curve) are in rules.ts.
 */
import { z } from 'zod';

/** kebab-case, starting with a letter: the id is also the file name. */
export const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const Id = z.string().min(2).max(48).regex(ID_PATTERN);
const Name = z.string().trim().min(2).max(40);

/**
 * True for an entity written by a person. promote never overwrites such a file, and a generated
 * candidate may not claim it (rules.ts).
 */
const Handwritten = z.boolean().default(false);

export const MAX_COST = 10;
export const MAX_KEYWORDS_PER_CARD = 4;
export const MAX_EFFECTS_PER_SPELL = 3;
export const MAX_COPIES = 3;
/** A starter deck holds exactly this many cards, copies included. */
export const DECK_SIZE = 12;

/** A word with a reminder text, printed on cards ("Guard", "Echo 2"). */
export const Keyword = z
  .strictObject({
    id: Id,
    name: Name,
    timing: z.enum(['static', 'on-play', 'on-death', 'start-of-turn']),
    /** A keyword that takes a number is printed with it ("Echo 2") and its reminder says X. */
    takesValue: z.boolean(),
    reminder: z.string().trim().min(10).max(160),
    handwritten: Handwritten,
  })
  .refine((k) => k.takesValue === /\bX\b/.test(k.reminder), {
    path: ['reminder'],
    message: 'a keyword that takes a value says X in its reminder, and one that does not never does',
  });

/** A faction can name one rival, and the rival must name it back (catalog.ts). */
export const Faction = z
  .strictObject({
    id: Id,
    name: Name,
    motto: z.string().trim().min(4).max(80),
    rival: Id.nullable(),
    handwritten: Handwritten,
  })
  .refine((f) => f.rival !== f.id, { path: ['rival'], message: 'a faction cannot be its own rival' });

/** A release of cards. The catalogue may not hold more cards in a set than its size. */
export const CardSet = z.strictObject({
  id: Id,
  name: Name,
  code: z.string().regex(/^[A-Z]{3}$/),
  releaseOrder: z.int().min(1).max(99),
  size: z.int().min(1).max(300),
  handwritten: Handwritten,
});

export const Effect = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('damage'), amount: z.int().min(1).max(10) }),
  z.strictObject({ kind: z.literal('heal'), amount: z.int().min(1).max(10) }),
  z.strictObject({ kind: z.literal('draw'), count: z.int().min(1).max(3) }),
  /** Puts copies of a token unit into play. The target must be a card with `token: true`. */
  z.strictObject({ kind: z.literal('summon'), card: Id, count: z.int().min(1).max(3) }),
]);

export const CardBody = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('unit'),
    power: z.int().min(0).max(12),
    health: z.int().min(1).max(12),
    /** Tokens only enter play through a summon effect. They are never in a deck. */
    token: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal('spell'),
    target: z.enum(['unit', 'player', 'any', 'none']),
    effects: z.array(Effect).min(1).max(MAX_EFFECTS_PER_SPELL),
  }),
  z.strictObject({ type: z.literal('relic'), charges: z.int().min(1).max(5) }),
]);

export const Rarity = z.enum(['common', 'uncommon', 'rare', 'legendary']);

export const Card = z
  .strictObject({
    id: Id,
    name: Name,
    set: Id,
    /** Null for a neutral card, which any deck may hold. */
    faction: Id.nullable(),
    rarity: Rarity,
    cost: z.int().min(0).max(MAX_COST),
    keywords: z
      .array(z.strictObject({ keyword: Id, value: z.int().min(1).max(5).nullable() }))
      .max(MAX_KEYWORDS_PER_CARD),
    text: z.string().trim().max(200),
    body: CardBody,
    limits: z
      .strictObject({
        maxCopies: z.int().min(1).max(MAX_COPIES).default(MAX_COPIES),
        banned: z.boolean().default(false),
      })
      .prefault({}),
    handwritten: Handwritten,
  })
  .superRefine((card, ctx) => {
    const seen = new Set<string>();
    card.keywords.forEach((k, i) => {
      if (seen.has(k.keyword)) ctx.addIssue({ code: 'custom', path: ['keywords', i, 'keyword'], message: `keyword "${k.keyword}" is listed twice` });
      seen.add(k.keyword);
    });
    if (card.rarity === 'legendary' && card.limits.maxCopies !== 1) {
      ctx.addIssue({ code: 'custom', path: ['limits', 'maxCopies'], message: 'a legendary card allows one copy' });
    }
    if (card.body.type === 'unit' && card.body.token) {
      if (card.rarity !== 'common') ctx.addIssue({ code: 'custom', path: ['rarity'], message: 'a token is common' });
      if (card.cost !== 0) ctx.addIssue({ code: 'custom', path: ['cost'], message: 'a token costs 0' });
    }
    if (card.body.type === 'spell' && card.body.target === 'none' && card.body.effects.some((e) => e.kind === 'damage' || e.kind === 'heal')) {
      ctx.addIssue({ code: 'custom', path: ['body', 'target'], message: 'damage and heal need a target' });
    }
  });

/** A preconstructed deck of one faction. Neutral cards are allowed. */
export const Deck = z
  .strictObject({
    id: Id,
    name: Name,
    faction: Id,
    cards: z.array(z.strictObject({ card: Id, copies: z.int().min(1).max(MAX_COPIES) })).min(1).max(DECK_SIZE),
    handwritten: Handwritten,
  })
  .superRefine((deck, ctx) => {
    const total = deck.cards.reduce((sum, c) => sum + c.copies, 0);
    if (total !== DECK_SIZE) ctx.addIssue({ code: 'custom', path: ['cards'], message: `a deck holds ${DECK_SIZE} cards and this one holds ${total}` });
    const seen = new Set<string>();
    deck.cards.forEach((c, i) => {
      if (seen.has(c.card)) ctx.addIssue({ code: 'custom', path: ['cards', i, 'card'], message: `card "${c.card}" is listed twice; raise its copies instead` });
      seen.add(c.card);
    });
  });

export type Keyword = z.infer<typeof Keyword>;
export type Faction = z.infer<typeof Faction>;
export type CardSet = z.infer<typeof CardSet>;
export type Effect = z.infer<typeof Effect>;
export type CardBody = z.infer<typeof CardBody>;
export type Card = z.infer<typeof Card>;
export type Deck = z.infer<typeof Deck>;

/**
 * The entity types, each with its folder in the catalogue. The order is the order the validator
 * reports them in.
 */
export const ENTITIES = {
  keyword: { schema: Keyword, folder: 'keywords' },
  faction: { schema: Faction, folder: 'factions' },
  set: { schema: CardSet, folder: 'sets' },
  card: { schema: Card, folder: 'cards' },
  deck: { schema: Deck, folder: 'decks' },
} as const;

export type EntityName = keyof typeof ENTITIES;
export const ENTITY_NAMES = ['keyword', 'faction', 'set', 'card', 'deck'] as const satisfies readonly EntityName[];

export interface EntityTypes {
  keyword: Keyword;
  faction: Faction;
  set: CardSet;
  card: Card;
  deck: Deck;
}

/** Each entity's schema, typed by its output, so generic code gets the right type back. */
export const SCHEMAS: { readonly [E in EntityName]: z.ZodType<EntityTypes[E]> } = {
  keyword: Keyword,
  faction: Faction,
  set: CardSet,
  card: Card,
  deck: Deck,
};

export function isEntityName(value: string): value is EntityName {
  return Object.hasOwn(ENTITIES, value);
}
