/**
 * rewrite(input, { gateway }) (design 4.11): the stages S0 to S7 of design 4.4, in order, as the
 * 'staged' strategy runs them.
 *
 * 1. S0 and S1 (stages/analyse.ts); S1b returns before any model call.
 * 2. S2 plan and S3 edit (stages/model.ts), then placement, S5 in code and S6 (stages/check.ts)
 *    on S3's edits.
 * 3. Outside `minimo` and unless `skipStyle` is set, S4 style on the text S3's checked edits left
 *    (design 4.4: S3, then S4). stages/compose.ts turns each style edit into an edit of the
 *    original, merged with the S3 edits it touches, so every edit kept quotes the original and is
 *    placed, checked and reverted against the same text; placement, S5 in code and S6 run on the
 *    merged edit, and if it does not stand the S3 edits it held come back.
 * 4. If level 1 findings remain, exactly one extra S3 round with them as a list, through the same
 *    placement, S5 and S6.
 * 5. S5's judge (D10: by default on email, follow-up and cover letter; on WhatsApp in `minimo`
 *    only with `strict`), once on the text the code left, and again only when it reverted
 *    something. It runs after the extra round so the call count stays the one of design 4.10:
 *    S2 + S3 + judge, plus one for S4, one for the extra round and one for the second verdict.
 * 6. S7 assemble: the diff from the accepted edits, the changes, the fact report and the
 *    invariant O ⊆ R ⊆ O ∪ C, lint before and after, the flags, the status and the usage.
 *
 * With RewriteOptions.strategy 'single', the default (DEFAULT_STRATEGY), steps 2 to 4 are one
 * call that plans and edits (stages/model.ts singleStage); its edits go through the same
 * placement, S5 in code and S6, then steps 5 and 6 run as above. No S4 and no extra round: one
 * call, two when its reply cannot be read and is asked for again (below), plus the judge's.
 *
 * A model stage whose reply the gateway cannot read against its schema (ResponseError
 * 'invalid_output') is asked once more; if the second reply cannot be read either, that stage
 * makes no edit (S3 and its extra round need the plan, the extra round needs S3), the text stays
 * as written there, and the result asks for a review with a message. A cap, an API error or any
 * other refusal still fails the rewrite. The extra round keeps its own rule: optional, no retry.
 *
 * Status (design 4.4 and 4.6 step 4):
 * - 'blocked': the rewrite still states a fact outside O ∪ C, or the extra round's edits invented
 *   a fact again: the invention persisted after the extra round;
 * - 'needs-review': the invariant fails otherwise, or a fallback happened: an edit was reverted
 *   for inventing (in code or by the judge), which hands the sentence back as the user wrote it;
 *   or a verdict or a stage's reply could not be read even on the retry, and what it would have
 *   changed is as the user wrote it;
 * - 'ok' otherwise.
 */
import { ResponseError } from '../../gateway/src/index.ts';
import { diffHunks, renderEdits, tidyDeletions } from './edits.ts';
import { factInvariant, factReport, type Fact } from './facts.ts';
import { restoreData } from './injection.ts';
import { gatewayModelClient } from './model-client.ts';
import { editProblem } from './outputs.ts';
import { judgeRuns, REWRITE_JUDGE_PROMPT_VERSION } from './rubric.ts';
import { analyse, earlyExit, lintAs, prepare, type Analysis } from './stages/analyse.ts';
import { composeStyle, currentText, restoreMerged } from './stages/compose.ts';
import { checkFacts, judgeStage, liveEdits, paragraphUnits, place, recheckDrops, relintAndVoice, rendered, type Proposal } from './stages/check.ts';
import { editStage, extraEditStage, metered, planStage, sentenceAt, singleStage, STAGE_ATTEMPTS, styleStage, type ModelStages, type Remaining, type Usage } from './stages/model.ts';
import { Change, DEFAULT_STRATEGY, RewriteInput, RewriteResult, type Edit, type Flag, type RewriteOptions } from './types.ts';

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
  /** A stage's reply, asked for once more when it cannot be read; null when the retry cannot be read either. */
  let unread = false;
  const readable = async <T>(stage: () => Promise<T>): Promise<T | null> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await stage();
      } catch (error) {
        if (!(error instanceof ResponseError && error.code === 'invalid_output')) throw error;
        if (attempt === STAGE_ATTEMPTS) {
          unread = true;
          return null;
        }
      }
    }
  };
  const check = (fresh: Proposal[]): void => {
    place(a, units, proposals, fresh.filter((p) => p.status === 'live'));
    checkFacts(a, units, proposals, fresh);
    relintAndVoice(a, units, proposals, fresh);
    // S6 may have reverted the edit that kept a dropped fact in the text.
    recheckDrops(a, units, proposals);
  };

  /** S2, S3 and its checks, S4 and the extra round; true when the extra round invented a fact again. */
  const staged = async (): Promise<boolean> => {
    const plan = await readable(() => planStage(m, a.lint.findings));
    const first = plan === null ? null : await readable(() => editStage(m, plan));
    const round1 = propose(first?.edits ?? [], 'edit', 1);
    check(round1);
    if (a.mode !== 'minimo' && options.skipStyle !== true) {
      const current = currentText(a, units, proposals);
      const styled = await readable(() => styleStage(m, current.sentences.filter((s) => s.text.trim() !== '')));
      const composed = propose(styled ?? [], 'style', 1);
      composeStyle(a, units, proposals, current, composed);
      check(composed);
      const back = restoreMerged(proposals, composed);
      if (back.length > 0) check(back);
    }

    const remaining = remainingLevelOne(a, rendered(a, units, proposals), liveEdits(a, units, proposals));
    if (remaining.length > 0 && first !== null) {
      // History in the model's own words; the proposals hold the same edits with data tags restored.
      // An edit merged into a style edit is applied, inside it.
      const notApplied = first.edits.filter((_, i) => round1[i]?.status !== 'live' && round1[i]?.mergedInto === undefined);
      const round2 = propose(await extraEditStage(m, first, remaining, notApplied), 'edit', 2);
      // An extra-round edit with the sentence and quote of a live edit replaces it; if the new one
      // is not applied, the old one is placed and checked again.
      const replaced = new Map<Proposal, Proposal>();
      // A style edit replaced because it held the quoted S3 edit: the other S3 edits it held.
      const released = new Map<Proposal, Proposal[]>();
      for (const p2 of round2) {
        // Or a style edit holding it: the model quotes its own S3 edit, which a style edit merged.
        const quote = p2.edit.before.normalize('NFC');
        const holds = (q: Proposal): boolean => q.before === quote || proposals.some((h) => h.mergedInto === q.id && h.before === quote);
        const p1 = proposals.find((q) => q.status === 'live' && q.round === 1 && q.edit.sentenceId === p2.edit.sentenceId && holds(q));
        if (p2.status !== 'live' || p1 === undefined) continue;
        p1.status = 'reverted';
        p1.reason = `replaced by ${p2.id} in the extra round`;
        replaced.set(p1, p2);
        if (p1.before === quote) continue;
        // The new edit replaces one S3 edit inside the style edit; the others passed every check and
        // stand again on their own, as the extra round was told (they were not in its not-applied list).
        const held = proposals.filter((h) => h.mergedInto === p1.id);
        for (const h of held) {
          delete h.mergedInto;
          if (h.before === quote) h.reason = `replaced by ${p2.id} in the extra round`;
          else {
            h.status = 'live';
            delete h.reason;
          }
        }
        released.set(p1, held);
      }
      const freed = [...released.values()].flat().filter((h) => h.status === 'live');
      if (freed.length > 0) check(freed);
      check(round2);
      const back = [...replaced].filter(([, p2]) => p2.status !== 'live').map(([p1]) => p1);
      for (const p1 of back) {
        // The style edit comes back whole: the S3 edits it held step aside into it again.
        for (const h of released.get(p1) ?? []) {
          h.status = 'reverted';
          h.reason = `merged into ${p1.id}`;
          h.mergedInto = p1.id;
        }
        p1.status = 'live';
        delete p1.reason;
      }
      if (back.length > 0) check(back);
      const again = restoreMerged(proposals, back);
      if (again.length > 0) check(again);
      return round2.some((p) => p.check?.status === 'reverted' && p.check.reason === 'invented');
    }
    return false;
  };

  let extraInvented = false;
  if ((options.strategy ?? DEFAULT_STRATEGY) === 'single') {
    // S2 and S3 in one call; its edits go through the same placement, S5 in code and S6. No S4 and
    // no extra round: the strategy is one call (two with the retry of an unreadable reply) plus the judge's.
    check(propose((await readable(() => singleStage(m, a.lint.findings))) ?? [], 'edit', 1));
  } else extraInvented = await staged();

  let judged = { fellBack: false, reverted: 0, unread: false, flags: [] as Flag[] };
  if (judgeRuns(a.input)) {
    // Always over the metered gateway: the judge's calls pass the same caps and the same ledger.
    const client = gatewayModelClient(gateway, { task: 'rewrite.judge', userId, jobId, promptVersion: REWRITE_JUDGE_PROMPT_VERSION });
    judged = await judgeStage(a, units, proposals, client);
  }

  // A composed edit reverted where nothing checks again what it held (the judge, or a drop the
  // extra round's checks took back) leaves its S3 edits out: put back now, they would be text no
  // check read alone. They say so instead of naming an edit that is not applied.
  for (const p of proposals) {
    const holder = proposals.find((q) => q.id === p.mergedInto);
    if (holder === undefined || holder.status === 'live') continue;
    p.reason = `held in ${holder.id}, which was reverted; not put back, since the checks after it did not read it alone`;
    delete p.mergedInto;
  }

  return assemble(a, units, proposals, { usage, extraInvented, judged, unread });
}

/** The level 1 findings of the rewrite, each with the sentence of the original it sits in. */
function remainingLevelOne(a: Analysis, rewritten: string, live: ReturnType<typeof liveEdits>): Remaining[] {
  // A position of the rewrite in the original's coordinates: undo the shift of the edits before it.
  // A position inside an edit's new text maps to that edit's sentence.
  const toOriginal = (position: number): number =>
    position - live.filter((e) => e.newSpan.end <= position).reduce((shift, e) => shift + e.after.length - e.before.length, 0);
  return lintAs(a.input, rewritten)
    .findings.filter((f) => f.level === 1)
    .map((finding) => {
      const inside = live.find((e) => e.newSpan.start <= finding.start && finding.start < e.newSpan.end);
      if (inside !== undefined) return { finding, sentenceId: inside.edit.sentenceId, insideEdit: true };
      return { finding, sentenceId: sentenceAt(a.sentences, toOriginal(finding.start)), insideEdit: false };
    });
}

interface Outcome {
  readonly usage: Usage;
  readonly extraInvented: boolean;
  /** A model stage's reply could not be read even on the retry. */
  readonly unread: boolean;
  readonly judged: { readonly fellBack: boolean; readonly reverted: number; readonly unread: boolean; readonly flags: readonly Flag[] };
}

const MISSING = { es: (f: Fact) => `El texto reescrito perdió «${f.text}».`, en: (f: Fact) => `The rewrite lost "${f.text}".` } as const;
const UNREAD_STAGE = {
  es: 'No pude leer la respuesta de uno de los pasos, ni al pedirla de nuevo. Lo que ese paso iba a cambiar quedó como lo escribiste.',
  en: 'I could not read the reply of one of the steps, even when I asked again. What that step would have changed is as you wrote it.',
} as const;
const EXTRA = { es: 'Revisá el texto: dice algo que no está ni en tu texto ni en tu CV', en: 'Check the text: it says something neither your text nor your CV states' } as const;

/** S7. */
function assemble(a: Analysis, units: Parameters<typeof liveEdits>[1], proposals: readonly Proposal[], outcome: Outcome): RewriteResult {
  // The shipped text never keeps the space a deleted sentence leaves behind (tidyDeletions); the
  // diff holds the widened hunks, while each change keeps the quote the model wrote.
  const live = tidyDeletions(a.text, liveEdits(a, units, proposals));
  const rewritten = renderEdits(a.text, live);
  const drops = proposals.flatMap((p) => (p.status === 'live' && p.check?.status === 'accepted' ? p.check.dropped.map((f) => f.key) : []));
  const invariant = factInvariant(a.text, rewritten, a.sources, drops, a.extractOptions);
  const invented = proposals.some((p) => p.check?.status === 'reverted' && p.check.reason === 'invented');
  const status =
    invariant.extra.length > 0 || outcome.extraInvented
      ? 'blocked'
      : !invariant.holds || invented || outcome.judged.reverted > 0 || outcome.judged.fellBack || outcome.judged.unread || outcome.unread
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
    ...(invariant.extra.length > 0 ? { message: EXTRA[lang] } : outcome.unread ? { message: UNREAD_STAGE[lang] } : {}),
  });
}
