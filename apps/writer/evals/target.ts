// The writer as a target for the evals runner (evals/src/runner.ts). The system blocks are the
// product's own, built by server/prompt.ts at the draft step, so V0 is what ships by construction.
//
// One difference from the product, on purpose: the runner sends one user message, so the brief
// and the chosen title travel together, each in the tag the product puts it in. The titles turn
// is skipped; the eval measures the draft.

import type { CallSettings, SystemBlock } from '../../../evals/src/index.ts';
import type { WriterTarget } from '../../../evals/src/index.ts';
import type { Category, Role, WriterConfig } from '../src/config-schema.ts';
import { wrapUserTurn } from '../server/handler.ts';
import { EFFORT, MAX_TOKENS, MODEL } from '../server/model.ts';
import { buildSystem, todayLine } from '../server/prompt.ts';
import { chooseTitleMessage } from '../src/protocol.ts';

export type Lang = 'es';
export const LANGS: readonly Lang[] = ['es'];

export interface WriterEvalCase {
  readonly id: string;
  readonly role: string;
  readonly category: string;
  readonly title: string;
  readonly brief: string;
  /** complete: the brief has every fact the piece needs. gaps: it leaves out facts the piece needs. */
  readonly probe: 'complete' | 'gaps';
  /** What a careful writer would have to ask for. For the reader of the results; not scored. */
  readonly missing: readonly string[];
}

/** The product's call settings, from the file the gateway setup reads them from. */
export const WRITER_CALL: CallSettings = { model: MODEL, max_tokens: MAX_TOKENS, output_config: { effort: EFFORT } };

export function lookup(config: WriterConfig, c: WriterEvalCase): { role: Role; category: Category } {
  const role = config.catalog.roles.find((r) => r.id === c.role);
  const category = config.catalog.categories.find((x) => x.id === c.category);
  if (!role || !category) throw new Error(`case ${c.id}: unknown role or category`);
  if (!category.roles.includes(role.id)) throw new Error(`case ${c.id}: ${role.id} does not write ${category.id}`);
  return { role, category };
}

/** The one user message: the brief, then the chosen title, as the product wraps them. */
export const userMessage = (c: WriterEvalCase): string => `${wrapUserTurn(c.brief, 0)}\n\n${wrapUserTurn(chooseTitleMessage(c.title), 1)}`;

/**
 * Everything a draft may state: the school's facts, the brief, the chosen title and the date.
 * The examples are not in it: a date or a time copied from an example is invented.
 */
export function factSheet(config: WriterConfig, c: WriterEvalCase, now: Date): string {
  return [...config.school.facts, c.title, c.brief, lookup(config, c).role.signature, todayLine(now, config.school.timeZone)].join('\n');
}

export function createWriterTarget(config: WriterConfig): WriterTarget<WriterEvalCase, Lang> {
  return {
    call: WRITER_CALL,
    system(c, _lang, now): SystemBlock[] {
      const { role, category } = lookup(config, c);
      return buildSystem(config, role, category, 'draft', now).map((text) => ({ type: 'text', text }));
    },
    brief: (c) => userMessage(c),
    factSheet: (c, _lang, now) => factSheet(config, c, now),
  };
}
