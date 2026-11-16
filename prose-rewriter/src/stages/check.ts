/**
 * The checks after the model (design 4.4 and 4.6), over edits that all quote the original text:
 *
 * - placement: applyEdits places every live edit and the new ones together, so a new edit that
 *   overlaps a live one, touches a keep[] phrase or quotes text that is not there is refused in
 *   code before anything else looks at it;
 * - S5 in code: checkEdit() per edit, which reverts an edit that invents, loses, changes or
 *   reorders a fact;
 * - S6: relint and voice, per new edit, last made first: an edit is reverted when the text with it
 *   has more level 1 findings, or a voice trait the writer does not use, than the text without it.
 *   keep[] is enforced at placement (applyEdits' 'keep' refusal), which is stricter than a revert;
 * - S5 the judge: evals' judgeWith with the rewriter's rubric, once on the text the code checks
 *   left, and once more only when its verdict reverted something (design 4.10, "el rejuicio").
 *
 * In `reescritura` an edit may cover a paragraph: the unit an edit quotes from runs from its
 * sentence to the end of its line in the same part (paragraphUnits).
 */
import { judgeWith } from '../../../evals/src/index.ts';
import { applyEdits, renderEdits, type AppliedEdit, type Sentence, type TextRange } from '../edits.ts';
import { checkEdit, type EditCheck } from '../facts.ts';
import { factSheet, planReverts, rewritePiece, rewriteRubric, type RevertPlan } from '../rubric.ts';
import type { Edit, Flag, JudgeClient } from '../types.ts';
import { voiceViolations } from '../voice.ts';
import { lintAs, type Analysis } from './analyse.ts';

/** One edit a model proposed, with what happened to it. `id` orders them: e1, e2, ... as made. */
export interface Proposal {
  readonly id: string;
  readonly edit: Edit;
  readonly stage: 'edit' | 'style';
  /** 1 for S3 and S4, 2 for S3's extra round. */
  readonly round: 1 | 2;
  status: 'live' | 'reverted' | 'refused';
  /** Where the quote sat in the original, once placed; a quote that is not there has none. */
  span?: TextRange;
  /** The quote and replacement as placed, in NFC. */
  before?: string;
  after?: string;
  /** Why it was refused or reverted. */
  reason?: string;
  /** checkEdit's verdict: invented and lost facts, and the keys of an accepted drop. */
  check?: EditCheck;
}

/**
 * The units edits quote from, as Sentence objects applyEdits accepts: the sentences themselves, or
 * in `reescritura` each sentence through the end of its line within its part, so an edit with that
 * sentenceId may reword the rest of the paragraph.
 */
export function paragraphUnits(text: string, sentences: readonly Sentence[]): Sentence[] {
  return sentences.map((s, i) => {
    let end = s.end;
    for (const next of sentences.slice(i + 1)) {
      if (next.part !== s.part || text.slice(end, next.start).includes('\n')) break;
      end = next.end;
    }
    return { ...s, end, text: text.slice(s.start, end) };
  });
}

/** The live proposals as applyEdits placed them, with their own ids, in the order made. */
export function liveEdits(a: Analysis, units: readonly Sentence[], proposals: readonly Proposal[]): AppliedEdit[] {
  const live = proposals.filter((p) => p.status === 'live');
  const placed = applyEdits(a.text, units, live.map((p) => p.edit), { ...(a.input.keep === undefined ? {} : { keep: a.input.keep }), idPrefix: '#' });
  if (placed.rejected.length > 0) throw new Error('a live edit no longer places');
  const byIndex = new Map(live.map((p, i) => [`#${i + 1}`, p.id]));
  return placed.accepted.map((e) => ({ ...e, id: byIndex.get(e.id) ?? e.id }));
}

/** The text the live proposals produce. */
export function rendered(a: Analysis, units: readonly Sentence[], proposals: readonly Proposal[]): string {
  return renderEdits(a.text, liveEdits(a, units, proposals));
}

/**
 * Places the new proposals after the live ones; those applyEdits refuses are marked 'refused'
 * with its message. The rest become live.
 */
export function place(a: Analysis, units: readonly Sentence[], proposals: readonly Proposal[], fresh: readonly Proposal[]): void {
  const live = proposals.filter((p) => p.status === 'live' && !fresh.includes(p));
  const all = [...live, ...fresh];
  const placed = applyEdits(a.text, units, all.map((p) => p.edit), { ...(a.input.keep === undefined ? {} : { keep: a.input.keep }), idPrefix: '#' });
  const at = (id: string): Proposal | undefined => all[Number(id.slice(1)) - 1];
  for (const r of placed.rejected) {
    const p = at(r.id);
    if (p === undefined || !fresh.includes(p)) throw new Error('a live edit no longer places');
    p.status = 'refused';
    p.reason = r.message;
    if (r.span !== undefined) p.span = r.span;
    p.before = r.edit.before.normalize('NFC');
    p.after = r.edit.after.normalize('NFC');
  }
  for (const e of placed.accepted) {
    const p = at(e.id);
    if (p === undefined || !fresh.includes(p)) continue;
    p.status = 'live';
    p.span = e.span;
    p.before = e.before;
    p.after = e.after;
  }
}

/**
 * S5 in code: checkEdit() on each new live proposal, inside its unit of the original. The other
 * sentences that unit covers count as gone while it is checked, so a drop is only accepted when
 * the fact stays outside the reworded paragraph.
 */
export function checkFacts(a: Analysis, units: readonly Sentence[], fresh: readonly Proposal[]): void {
  for (const p of fresh) {
    if (p.status !== 'live' || p.before === undefined || p.after === undefined) continue;
    const unit = units.find((u) => u.id === p.edit.sentenceId);
    if (unit === undefined) continue;
    const sentences = a.sentences.map((s) => (s.id === unit.id ? unit.text : s.start >= unit.start && s.end <= unit.end ? '' : s.text));
    const check = checkEdit({ ...p.edit, before: p.before, after: p.after }, {
      O: a.text,
      C: a.sources,
      sentences,
      ...a.extractOptions,
    });
    p.check = check;
    if (check.status === 'reverted') {
      p.status = 'reverted';
      p.reason = `facts: ${check.message}`;
    }
  }
}

const levelOne = (a: Analysis, text: string): string[] =>
  lintAs(a.input, text)
    .findings.filter((f) => f.level === 1)
    .map((f) => f.ruleId);

/** The items of `after` beyond the count `before` has of each. */
function surplus(before: readonly string[], after: readonly string[]): string[] {
  const left = [...before];
  return after.filter((x) => {
    const i = left.indexOf(x);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

/** S6, on the new live proposals, last made first, each against the live set as it stands. */
export function relintAndVoice(a: Analysis, units: readonly Sentence[], proposals: readonly Proposal[], fresh: readonly Proposal[]): void {
  const context = { genre: a.input.genre, lang: a.input.lang };
  for (const p of [...fresh].reverse()) {
    if (p.status !== 'live') continue;
    const withIt = rendered(a, units, proposals);
    p.status = 'reverted';
    const without = rendered(a, units, proposals);
    const addedRules = surplus(levelOne(a, without), levelOne(a, withIt));
    const had = new Set(voiceViolations(a.text, without, context).map((v) => v.kind));
    const voice = voiceViolations(a.text, withIt, context).filter((v) => !had.has(v.kind));
    if (addedRules.length > 0) p.reason = `relint: adds the level 1 finding ${[...new Set(addedRules)].join(', ')}`;
    else if (voice.length > 0) p.reason = `voice: ${voice.map((v) => v.message).join(' ')}`;
    else p.status = 'live';
  }
}

/** What the judge did to the proposals and the flags it left. */
export interface JudgeOutcome {
  /** A line was still invented on the second verdict and fell back to the original. */
  readonly fellBack: boolean;
  /** Edits the judge reverted. */
  readonly reverted: number;
  readonly flags: Flag[];
}

/**
 * S5 the judge (design 4.6 step 3). The first verdict reverts the edits touching an invented line,
 * last made first; when it reverted any, a second verdict on what is left reverts the edits still
 * touching an invented line, and those lines fall back to the original with a flag. An invented
 * line no edit touches is the user's own claim: flagged, never changed (D7).
 */
export async function judgeStage(a: Analysis, units: readonly Sentence[], proposals: readonly Proposal[], client: JudgeClient): Promise<JudgeOutcome> {
  const sheet = factSheet({ ...a.input.profile, recipient: a.input.recipient });
  const order = proposals.map((p) => p.id);
  const round = async (kind: 'first' | 'final'): Promise<RevertPlan> => {
    const edits = liveEdits(a, units, proposals);
    const rewritten = renderEdits(a.text, edits);
    const verdict = await judgeWith(rewriteRubric, client, rewritePiece({ original: a.text, rewritten, lang: a.input.lang }), sheet);
    const plan = planReverts({ original: a.text, rewritten, lang: a.input.lang, verdict, edits, order: order.filter((id) => edits.some((e) => e.id === id)), round: kind });
    for (const id of plan.revert) {
      const p = proposals.find((x) => x.id === id);
      if (p === undefined) continue;
      p.status = 'reverted';
      p.reason = kind === 'first' ? 'judge: the sentence claimed something the CV and the text do not back' : 'judge: still invented on the second verdict; back to the original';
    }
    return plan;
  };
  const first = await round('first');
  if (first.revert.length === 0) return { fellBack: false, reverted: 0, flags: first.userClaims.map((c) => c.flag) };
  const final = await round('final');
  return {
    fellBack: final.fallback.length > 0,
    reverted: first.revert.length + final.revert.length,
    flags: [...final.userClaims.map((c) => c.flag), ...final.fallback.map((f) => f.flag)],
  };
}
