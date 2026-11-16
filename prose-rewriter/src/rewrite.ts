/**
 * rewrite(input, { gateway }) (design 4.11): the stages S0 to S7 of design 4.4, in order.
 *
 * 1. S0 and S1 (stages/analyse.ts); S1b returns before any model call.
 * 2. S2 plan, S3 edit and, outside `minimo`, S4 style (stages/model.ts). Every edit quotes the
 *    original text, so all of them are placed, checked and reverted against the same text.
 * 3. Placement, S5 in code and S6 (stages/check.ts) on the edits of S3 and S4.
 * 4. If level 1 findings remain, exactly one extra S3 round with them as a list, through the same
 *    placement, S5 and S6.
 * 5. S5's judge (D10: by default on email, follow-up and cover letter; on WhatsApp in `minimo`
 *    only with `strict`), once on the text the code left, and again only when it reverted
 *    something. It runs after the extra round so the call count stays the one of design 4.10:
 *    S2 + S3 + judge, plus one for S4, one for the extra round and one for the second verdict.
 * 6. S7 assemble: the diff from the accepted edits, the changes, the fact report and the
 *    invariant O ⊆ R ⊆ O ∪ C, lint before and after, the flags, the status and the usage.
 *
 * Status (design 4.4 and 4.6 step 4):
 * - 'blocked': the rewrite still states a fact outside O ∪ C, or the extra round's edits invented
 *   a fact again: the invention persisted after the extra round;
 * - 'needs-review': the invariant fails otherwise, or a fallback happened: an edit was reverted
 *   for inventing (in code or by the judge), which hands the sentence back as the user wrote it;
 * - 'ok' otherwise.
 */
import { diffHunks } from './edits.ts';
import { factInvariant, factReport, type Fact } from './facts.ts';
import { restoreData } from './injection.ts';
import { gatewayModelClient } from './model-client.ts';
import { editProblem } from './outputs.ts';
import { judgeRuns, REWRITE_JUDGE_PROMPT_VERSION } from './rubric.ts';
import { analyse, earlyExit, lintAs, prepare, type Analysis } from './stages/analyse.ts';
import { checkFacts, judgeStage, liveEdits, paragraphUnits, place, relintAndVoice, rendered, type Proposal } from './stages/check.ts';
import { editStage, extraEditStage, metered, meteredJudge, planStage, sentenceAt, styleStage, type ModelStages, type Remaining, type Usage } from './stages/model.ts';
import { Change, RewriteInput, RewriteResult, type Edit, type Flag, type RewriteOptions } from './types.ts';

const EMPTY_REFS = { principles: [], sources: [], examples: [] } as const;

export async function rewrite(raw: RewriteInput, options: RewriteOptions): Promise<RewriteResult> {
  const a = analyse(prepare(RewriteInput.parse(raw)));
  const early = earlyExit(a);
  if (early !== null) return early;

  const usage: Usage = { calls: 0, costUsd: 0 };
  const gateway = metered(options.gateway, usage);
  const userId = options.userId ?? null;
  const jobId = options.jobId ?? null;
  const m: ModelStages = { gateway, prompt: { input: a.input, register: a.register, refs: options.refs ?? EMPTY_REFS }, userId, jobId };
  const units = a.mode === 'reescritura' ? paragraphUnits(a.text, a.sentences) : a.sentences;

  const proposals: Proposal[] = [];
  const propose = (edits: readonly Edit[], stage: Proposal['stage'], round: Proposal['round']): Proposal[] => {
    // Ids count across the stages in the order made: planReverts reverts last made first.
    const fresh = edits.map((raw, i): Proposal => {
      // The model saw the data through wrapData(), so a quote of a neutralized tag comes back as one.
      const edit = { ...raw, before: restoreData(raw.before), after: restoreData(raw.after) };
      const id = `e${proposals.length + i + 1}`;
      const problem = editProblem(edit);
      if (problem === null) return { id, edit, stage, round, status: 'live' };
      return { id, edit, stage, round, status: 'refused', reason: `schema: ${problem}`, before: edit.before.normalize('NFC'), after: edit.after.normalize('NFC') };
    });
    proposals.push(...fresh);
    return fresh;
  };
  const check = (fresh: Proposal[]): void => {
    place(a, units, proposals, fresh.filter((p) => p.status === 'live'));
    checkFacts(a, units, proposals, fresh);
    relintAndVoice(a, units, proposals, fresh);
  };

  const plan = await planStage(m, a.lint.findings);
  const first = await editStage(m, plan);
  const round1 = propose(first.edits, 'edit', 1);
  const styled = a.mode === 'minimo' ? null : await styleStage(m);
  check([...round1, ...propose(styled ?? [], 'style', 1)]);

  let extraInvented = false;
  const remaining = remainingLevelOne(a, rendered(a, units, proposals), liveEdits(a, units, proposals));
  if (remaining.length > 0) {
    const round2 = propose(await extraEditStage(m, first, remaining), 'edit', 2);
    check(round2);
    extraInvented = round2.some((p) => p.check?.status === 'reverted' && p.check.reason === 'invented');
  }

  let judged = { fellBack: false, reverted: 0, flags: [] as Flag[] };
  if (judgeRuns(a.input)) {
    const client =
      options.judge === undefined
        ? gatewayModelClient(gateway, { task: 'rewrite.judge', userId, jobId, promptVersion: REWRITE_JUDGE_PROMPT_VERSION })
        : meteredJudge(options.judge, usage);
    judged = await judgeStage(a, units, proposals, client);
  }

  return assemble(a, units, proposals, { usage, extraInvented, judged });
}

/** The level 1 findings of the rewrite, each with the sentence of the original it sits in. */
function remainingLevelOne(a: Analysis, rewritten: string, live: ReturnType<typeof liveEdits>): Remaining[] {
  // A position of the rewrite in the original's coordinates: undo the shift of the edits before it.
  const toOriginal = (position: number): number =>
    position - live.filter((e) => e.newSpan.end <= position).reduce((shift, e) => shift + e.after.length - e.before.length, 0);
  return lintAs(a.input, rewritten)
    .findings.filter((f) => f.level === 1)
    .map((finding) => ({ finding, sentenceId: sentenceAt(a.sentences, toOriginal(finding.start)) }));
}

interface Outcome {
  readonly usage: Usage;
  readonly extraInvented: boolean;
  readonly judged: { readonly fellBack: boolean; readonly reverted: number; readonly flags: readonly Flag[] };
}

const MISSING = { es: (f: Fact) => `El texto reescrito perdió «${f.text}».`, en: (f: Fact) => `The rewrite lost "${f.text}".` } as const;
const EXTRA = { es: 'Revisá el texto: dice algo que no está ni en tu texto ni en tu CV', en: 'Check the text: it says something neither your text nor your CV states' } as const;

/** S7. */
function assemble(a: Analysis, units: Parameters<typeof liveEdits>[1], proposals: readonly Proposal[], outcome: Outcome): RewriteResult {
  const live = liveEdits(a, units, proposals);
  const rewritten = rendered(a, units, proposals);
  const drops = proposals.flatMap((p) => (p.status === 'live' && p.check?.status === 'accepted' ? p.check.dropped.map((f) => f.key) : []));
  const invariant = factInvariant(a.text, rewritten, a.sources, drops, a.extractOptions);
  const invented = proposals.some((p) => p.check?.status === 'reverted' && p.check.reason === 'invented');
  const status =
    invariant.extra.length > 0 || outcome.extraInvented
      ? 'blocked'
      : !invariant.holds || invented || outcome.judged.reverted > 0 || outcome.judged.fellBack
        ? 'needs-review'
        : 'ok';
  const changes: Change[] = proposals.map((p) => {
    const e = p.edit;
    // An edit code could not place points at the sentence it named (nowhere, if there is none).
    const unit = units.find((u) => u.id === e.sentenceId);
    return Change.parse({
      id: p.id,
      span: p.span ?? (unit === undefined ? { start: 0, end: 0 } : { start: unit.start, end: unit.end }),
      before: p.before ?? e.before.normalize('NFC'),
      after: p.after ?? e.after.normalize('NFC'),
      reason: e.reason,
      ...(e.ruleId === undefined ? {} : { ruleId: e.ruleId }),
      ...(e.principleId === undefined ? {} : { principleId: e.principleId }),
      stage: p.stage,
      status: p.status === 'live' ? 'applied' : 'reverted',
      ...(p.status === 'live' || p.reason === undefined ? {} : { revertReason: p.reason }),
    });
  });
  const lang = a.input.lang;
  const flags: Flag[] = [...a.flags, ...outcome.judged.flags, ...invariant.missing.map((f): Flag => ({ kind: 'missing-fact', message: MISSING[lang](f) }))];
  return RewriteResult.parse({
    rewritten,
    diff: diffHunks(a.text, live),
    changes,
    facts: factReport(a.text, rewritten, a.sources, a.extractOptions),
    lint: { before: a.lint, after: lintAs(a.input, rewritten) },
    flags,
    status,
    usage: { calls: outcome.usage.calls, costUsd: outcome.usage.costUsd },
    ...(invariant.extra.length > 0 ? { message: EXTRA[lang] } : {}),
  });
}
