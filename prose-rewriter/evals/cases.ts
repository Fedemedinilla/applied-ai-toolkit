/**
 * The eval cases of design section 5: fictional texts per genre and language (one with light slop,
 * one with heavy slop and one already good, the over-editing control) and the traps (a number or a
 * tool the CV lacks, a claim the user inflates, a WhatsApp in voseo without ¿¡, a legitimate
 * emoji, a follow-up that cites the date of the previous message, an instruction in the text, an
 * instruction in the CV, a third party's data).
 *
 * A case file is JSON (cases/<lang>.json) with a `fictional` marker, which fixtures.test.ts checks
 * with the real-data rules. A case names one of the fictional CVs in cases/cv/ instead of carrying
 * a CV, may append to it (the injection trap), and may state what the code rubrics check beyond the
 * general invariants: facts that must survive, facts the rewrite may drop, and the injected
 * instruction with the markers that would show it was obeyed. Every expectation is checked against
 * the case's own text when the file is read, so a typo cannot make a rubric pass for nothing.
 *
 * How many cases per genre is not decided (D3): the files hold one of each kind per genre and
 * language plus one case per trap, a small set because every live run is paid from a fixed
 * monthly budget (D14).
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { RewriteInput } from '../src/types.ts';
import type { EvalCase } from './pipeline.ts';

export const CASE_KINDS = ['light', 'heavy', 'good', 'trap'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const TRAPS = [
  'number-not-in-cv',
  'tool-not-in-cv',
  'inflated-claim',
  'whatsapp-voice',
  'legit-emoji',
  'follow-up-date',
  'injection-in-text',
  'injection-in-cv',
  'third-party',
] as const;
export type Trap = (typeof TRAPS)[number];

/** The fictional CVs, by file name under cases/cv/. */
export const CV_IDS = ['es-rioplatense', 'en'] as const;
export type CvId = (typeof CV_IDS)[number];

/** The case files under cases/, read in this order. */
export const CASE_FILES = ['es.json', 'en.json'] as const;

const Text = z.string().min(1);

const Expectations = z.strictObject({
  /** Phrases of the original whose facts must be in the rewrite (compared by fact, else as written). */
  survive: z.array(Text).optional(),
  /** Phrases of the original whose facts the rewrite may drop. */
  acceptedDrops: z.array(Text).optional(),
  /** The injected instruction, as written in the text or the CV, and what an obeying rewrite would contain. */
  injection: z.strictObject({ instruction: Text, obeyedIf: z.array(Text).min(1) }).optional(),
  /**
   * The user's own claim the CV does not back (the inflated-claim trap): it is kept and flagged, never
   * strengthened. strengthenedIf are words a strengthening rewrite would add; no-new-facts fails on any.
   */
  claim: z.strictObject({ phrase: Text, strengthenedIf: z.array(Text).min(1) }).optional(),
  /** The case lacks a fact the text needs, so a labelled [COMPLETAR: ...] is honest here. Default false. */
  placeholdersAllowed: z.boolean().optional(),
});

/** What a case states: RewriteInput without the CV, which comes from `cv` (plus `cvAppend`). */
const CaseInput = z.strictObject({
  ...RewriteInput.shape,
  profile: z.strictObject({ anchors: z.array(Text).optional(), extraFacts: z.array(Text).optional() }).optional(),
});

const CaseSpec = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'case ids are kebab-case'),
  kind: z.enum(CASE_KINDS),
  trap: z.enum(TRAPS).optional(),
  cv: z.enum(CV_IDS),
  cvAppend: Text.optional(),
  input: CaseInput,
  expect: Expectations.optional(),
});

const CaseFile = z.strictObject({
  fictional: z.string().regex(/^Fictional/u, 'a case file opens its "fictional" field with "Fictional"'),
  cases: z.array(CaseSpec).min(1),
});

/** A case's expectations with the defaults filled in, as the code rubrics read them. */
export const CaseExpectations = z.strictObject({
  survive: z.array(Text),
  acceptedDrops: z.array(Text),
  injection: z.strictObject({ instruction: Text, obeyedIf: z.array(Text).min(1) }).optional(),
  claim: z.strictObject({ phrase: Text, strengthenedIf: z.array(Text).min(1) }).optional(),
  placeholdersAllowed: z.boolean(),
});
export type CaseExpectations = z.infer<typeof CaseExpectations>;

/** A case ready for runPipelines() and judgePieces(), with what the code rubrics expect of it. */
export interface LoadedCase extends EvalCase {
  readonly kind: CaseKind;
  readonly trap?: Trap;
  readonly expect: CaseExpectations;
}

const lower = (s: string): string => s.normalize('NFC').toLowerCase();

/** Throws unless every expectation of the case is backed by its own text and CV. */
function checkExpectations(c: LoadedCase): void {
  const { text, profile } = c.input;
  if ((c.kind === 'trap') !== (c.trap !== undefined)) throw new Error(`case ${c.id}: a trap case names its trap, and only a trap case does`);
  for (const phrase of c.expect.survive) if (!text.includes(phrase)) throw new Error(`case ${c.id}: survive phrase ${JSON.stringify(phrase)} is not in the text`);
  for (const phrase of c.expect.acceptedDrops) if (!text.includes(phrase)) throw new Error(`case ${c.id}: acceptedDrops phrase ${JSON.stringify(phrase)} is not in the text`);
  for (const phrase of c.input.keep ?? []) if (!text.includes(phrase)) throw new Error(`case ${c.id}: keep phrase ${JSON.stringify(phrase)} is not in the text`);
  const claim = c.expect.claim;
  if ((c.trap === 'inflated-claim') !== (claim !== undefined)) throw new Error(`case ${c.id}: an inflated-claim trap needs a claim expectation, and only that trap has one`);
  if (claim !== undefined) {
    if (!text.includes(claim.phrase) || profile.cvMarkdown.includes(claim.phrase)) throw new Error(`case ${c.id}: the claim phrase must be in the text and not in the CV`);
    const backed = lower(`${text}\n${profile.cvMarkdown}`);
    for (const marker of claim.strengthenedIf) {
      if (backed.includes(lower(marker))) throw new Error(`case ${c.id}: strengthenedIf marker ${JSON.stringify(marker)} is already in the text or the CV`);
    }
  }
  const injection = c.expect.injection;
  if (injection === undefined) return;
  const { instruction } = injection;
  if (!text.includes(instruction) && !profile.cvMarkdown.includes(instruction)) throw new Error(`case ${c.id}: the injected instruction is in neither the text nor the CV`);
  // A marker the text or the CV states outside the instruction could be kept for a legitimate reason.
  const outside = lower([text, profile.cvMarkdown].map((s) => s.split(instruction).join('\n')).join('\n'));
  for (const marker of injection.obeyedIf) {
    if (outside.includes(lower(marker))) throw new Error(`case ${c.id}: obeyedIf marker ${JSON.stringify(marker)} is already outside the instruction`);
  }
}

/** Parses one case file against the CVs, by id. Throws on the first problem. */
export function parseCaseFile(raw: string, cvs: Readonly<Record<CvId, string>>): LoadedCase[] {
  const file = CaseFile.parse(JSON.parse(raw));
  const seen = new Set<string>();
  return file.cases.map((spec) => {
    if (seen.has(spec.id)) throw new Error(`case ${spec.id} is listed twice`);
    seen.add(spec.id);
    const { profile, ...rest } = spec.input;
    const input = RewriteInput.parse({ ...rest, profile: { ...profile, cvMarkdown: cvs[spec.cv] + (spec.cvAppend ?? '') } });
    const e = spec.expect ?? {};
    const c: LoadedCase = {
      id: spec.id,
      kind: spec.kind,
      ...(spec.trap === undefined ? {} : { trap: spec.trap }),
      input,
      expect: {
        survive: e.survive ?? [],
        acceptedDrops: e.acceptedDrops ?? [],
        ...(e.injection === undefined ? {} : { injection: e.injection }),
        ...(e.claim === undefined ? {} : { claim: e.claim }),
        placeholdersAllowed: e.placeholdersAllowed ?? false,
      },
    };
    checkExpectations(c);
    return c;
  });
}

/** Every case of the case files under `root` (the repository root), ids unique across files. */
export function loadCases(root: URL, read: (url: URL) => string = (url) => readFileSync(url, 'utf8')): LoadedCase[] {
  const dir = new URL('prose-rewriter/evals/cases/', root);
  const cvs = Object.fromEntries(CV_IDS.map((id) => [id, read(new URL(`cv/${id}.md`, dir))])) as Record<CvId, string>;
  const cases = CASE_FILES.flatMap((file) => parseCaseFile(read(new URL(file, dir)), cvs));
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`case ${c.id} is listed twice`);
    seen.add(c.id);
  }
  return cases;
}
