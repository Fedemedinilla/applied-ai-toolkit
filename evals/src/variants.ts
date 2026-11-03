/**
 * Prompt variants as checked exact-text edits on the production system blocks.
 *
 * A variant is never a second copy of the prompt. It is a list of edits applied
 * to whatever the product sends today, so the baseline (V0, no edits) is the
 * production prompt by construction, and a variant differs from it only where
 * its edits say.
 *
 * Every edit must hit exactly once. An edit that matches nothing would run the
 * baseline under the variant's name; one that matches twice would change more
 * than the variant claims. Either way the comparison is of something else, so
 * both stop the run before a single call is paid for.
 */
import type { SystemBlock } from './model.ts';

export type Edit = {
  /** Index of the system block to edit. Targets export names for these. */
  block: number;
  /** A literal string, or a RegExp when the edit needs capture groups. */
  find: string | RegExp;
  replace: string;
  /**
   * May match nothing (for example, text that exists in one language only).
   * It still may not match twice.
   */
  optional?: boolean;
};

export type Variant<L extends string = string> = {
  id: string;
  /** One line: what this variant changes and why. Goes into the results. */
  what: string;
  edits: (lang: L) => Edit[];
};

export class VariantError extends Error {
  override name = 'VariantError';
}

/** How many times `find` occurs in `text`. Overlapping matches are not counted. */
export function countMatches(text: string, find: string | RegExp): number {
  if (typeof find === 'string') {
    if (find === '') throw new VariantError('an edit with an empty find string matches everywhere');
    return text.split(find).length - 1;
  }
  const flags = find.flags.includes('g') ? find.flags : find.flags + 'g';
  return [...text.matchAll(new RegExp(find.source, flags))].length;
}

/**
 * Returns new blocks with every edit applied; the input is not touched, and
 * every other field of a block (`cache_control` included) is kept as it was.
 *
 * A string `find` is replaced literally, replacement included: passed as a
 * plain string, `String.prototype.replace` would read `$&` or `$1` inside the
 * new prompt text as patterns, and a rule that quotes a price like "$1,200"
 * would come out mangled. Only a RegExp `find` gets `$1` substitution, because
 * only there is it asked for.
 */
export function applyEdits(system: readonly SystemBlock[], edits: readonly Edit[]): SystemBlock[] {
  const blocks = system.map((b) => ({ ...b }));
  for (const e of edits) {
    const target = blocks[e.block];
    if (!target) throw new VariantError(`edit on block ${e.block}: the prompt has ${blocks.length} blocks`);
    const hits = countMatches(target.text, e.find);
    if (e.optional && hits === 0) continue;
    if (hits !== 1) {
      throw new VariantError(`edit ${describe(e.find)} on block ${e.block}: ${hits} matches, expected exactly 1`);
    }
    const text =
      typeof e.find === 'string'
        ? target.text.replace(e.find, () => e.replace)
        : target.text.replace(new RegExp(e.find.source, e.find.flags.replace('g', '')), e.replace);
    blocks[e.block] = { ...target, text };
  }
  return blocks;
}

function describe(find: string | RegExp): string {
  const s = typeof find === 'string' ? JSON.stringify(find) : String(find);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}
