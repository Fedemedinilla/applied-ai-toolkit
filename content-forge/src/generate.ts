/**
 * One generate run: ask the model for N candidates of one entity type, judge each one, write the
 * accepted ones to `_candidates/` and a report of the run.
 *
 * A candidate is judged in three stages, and every problem of every stage is recorded:
 *
 *   schema      the entity's zod schema, the same one the catalogue is validated with
 *   rules       the range rules for generated content (rules.ts)
 *   references  the catalogue validator over the catalogue plus the candidates accepted so far
 *               plus this one
 *
 * The catalogue must be valid before the run starts. That is what makes the third stage
 * attributable: any problem in "catalogue + accepted + candidate" is caused by the candidate, even
 * when it is reported on another entity (a set pushed past its size).
 */
import { join } from 'node:path';
import { checkCatalog, emptyRaw, issuesToProblems, type CatalogIndex, type Problem, type RawCatalog } from './catalog.ts';
import { candidatePath, idOf, loadCandidates, loadCatalog, reportsDir, writeJsonNew } from './files.ts';
import { ForgeError } from './errors.ts';
import { EFFORT, MAX_TOKENS, ResponseError, TASK, type Gateway } from './model.ts';
import { batchSchema, catalogueBlock, instructions, MAX_BRIEF, MAX_COUNT, PROMPT_VERSIONS, userMessage } from './prompt.ts';
import { RunReport, type Rejection, type Stage } from './report.ts';
import { checkRules } from './rules.ts';
import { ENTITY_NAMES, SCHEMAS, type EntityName, type EntityTypes } from './schemas.ts';

export interface GenerateOptions {
  readonly dir: string;
  readonly entity: EntityName;
  readonly count: number;
  readonly brief?: string | null;
}

export interface GenerateDeps {
  readonly gateway: Gateway;
  readonly now: () => Date;
  /** The gateway's job id, a UUID. Defaults to crypto.randomUUID. */
  readonly newJobId?: () => string;
}

/** Loads the catalogue and refuses to go on unless every file and every reference is valid. */
export async function validCatalog(dir: string): Promise<{ raw: RawCatalog; index: CatalogIndex }> {
  const loaded = await loadCatalog(dir);
  const checked = checkCatalog(loaded.raw);
  const problems = [...loaded.problems, ...(checked.ok ? [] : checked.problems)];
  if (problems.length > 0 || !checked.ok) throw new ForgeError('catalog_invalid', 'The catalogue is not valid', problems);
  return { raw: loaded.raw, index: checked.index };
}

const runId = (now: Date, entity: EntityName): string => `${now.toISOString().replace(/[:.]/g, '-')}-${entity}`;

/** Candidates are numbered from 1 in messages; the report's `index` is the 0-based array position. */
const label = (i: number, value: unknown): string => {
  const id = idOf(value);
  return id === null ? `candidate ${i + 1}` : `candidate ${i + 1} (${id})`;
};

export interface Verdict<E extends EntityName> {
  readonly accepted: EntityTypes[E] | null;
  readonly problems: readonly (Problem & { readonly stage: Stage; readonly rule?: string })[];
}

/** Judges one candidate against the catalogue and the candidates accepted before it. */
export function judge<E extends EntityName>(
  entity: E,
  value: unknown,
  where: string,
  base: { readonly raw: RawCatalog; readonly index: CatalogIndex; readonly pending: ReadonlySet<string> },
  acceptedSoFar: readonly EntityTypes[E][],
): Verdict<E> {
  const parsed = SCHEMAS[entity].safeParse(value);
  if (!parsed.success) {
    return { accepted: null, problems: issuesToProblems(where, parsed.error.issues).map((p) => ({ ...p, stage: 'schema' as const })) };
  }
  const candidate = parsed.data;
  const problems: Verdict<E>['problems'][number][] = checkRules(entity, candidate, { index: base.index, pending: base.pending }).map((f) => ({
    where,
    path: '',
    message: f.message,
    stage: 'rules' as const,
    rule: f.rule,
  }));

  const merged = emptyRaw();
  for (const name of ENTITY_NAMES) merged[name].push(...base.raw[name]);
  merged[entity].push(...acceptedSoFar.map((a, i) => ({ source: `accepted ${i}`, value: a })), { source: where, value: candidate });
  const checked = checkCatalog(merged);
  if (!checked.ok) {
    // The cross-reference checks name an entity as "card/<id>". When that is this candidate, use
    // its label, so every stage names it the same way. Not when its id was a duplicate: then
    // "card/<id>" is the other entry, the one that kept the id.
    const own = `${entity}/${candidate.id}`;
    const duplicate = checked.problems.some((p) => p.where === where && p.path === 'id');
    problems.push(...checked.problems.map((p) => ({ ...p, where: p.where === own && !duplicate ? where : p.where, stage: 'references' as const })));
  }
  return { accepted: problems.length === 0 ? candidate : null, problems };
}

/**
 * Runs one generation. A response the model gave but that cannot be used at all (not JSON, cut by
 * max_tokens, a refusal) is a failed run of this prompt version: it gets a report with no accepted
 * candidate, so the pass rate counts it. Any other gateway failure (a cap, the network, a 5xx) says
 * nothing about the prompt; it is thrown and no report is written.
 */
export async function generate(options: GenerateOptions, deps: GenerateDeps): Promise<RunReport> {
  const { dir, entity, count } = options;
  const brief = options.brief ?? null;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new ForgeError('bad_request', `--count must be a whole number from 1 to ${MAX_COUNT}`);
  }
  if (brief !== null && brief.length > MAX_BRIEF) throw new ForgeError('bad_request', `--brief is limited to ${MAX_BRIEF} characters`);

  const { raw, index } = await validCatalog(dir);
  // A pending file whose name is not its id, or that is not JSON, would hide an id from the
  // pending check and make a write fail after the paid call. Refused before the call instead.
  const pendingFiles = await loadCandidates(dir, entity);
  if (pendingFiles.problems.length > 0) throw new ForgeError('refused', 'The pending candidates have problems; fix or remove them first', pendingFiles.problems);
  const pending = new Set(pendingFiles.raw[entity].flatMap((e) => {
    const pendingId = idOf(e.value);
    return pendingId === null ? [] : [pendingId];
  }));

  const now = deps.now();
  const id = runId(now, entity);
  const jobId = (deps.newJobId ?? (() => crypto.randomUUID()))();
  const promptVersion = PROMPT_VERSIONS[entity];
  const base = {
    run: id,
    jobId,
    entity,
    promptVersion,
    createdAt: now.toISOString(),
    requested: count,
  };

  let candidates: unknown[];
  let meta: { model: string; costUsd: number | null; usageId: string };
  try {
    const result = await deps.gateway.structured(batchSchema(entity, count), {
      task: TASK,
      userId: null,
      jobId,
      promptVersion,
      maxTokens: MAX_TOKENS,
      system: [instructions(entity), catalogueBlock(entity, index, pending)],
      messages: [{ role: 'user', content: userMessage(entity, count, brief) }],
    });
    candidates = result.data.candidates;
    meta = { model: result.meta.modelResponded, costUsd: result.meta.costUsd, usageId: result.meta.usageId };
  } catch (error) {
    if (!(error instanceof ResponseError)) throw error;
    const report = RunReport.parse({
      ...base,
      model: error.modelResponded,
      costUsd: error.costUsd,
      usageId: error.usageId,
      effort: EFFORT,
      failure: error.code,
      returned: 0,
      ignored: 0,
      accepted: [],
      unwritten: [],
      passRate: 0,
      rejections: [],
    });
    await writeJsonNew(join(reportsDir(dir), `${id}.json`), report);
    return report;
  }

  const considered = candidates.slice(0, count);
  const accepted: EntityTypes[typeof entity][] = [];
  const rejections: Rejection[] = [];
  considered.forEach((value, i) => {
    const where = label(i, value);
    const verdict = judge(entity, value, where, { raw, index, pending }, accepted);
    if (verdict.accepted) accepted.push(verdict.accepted);
    else rejections.push({ index: i, id: idOf(value), problems: [...verdict.problems] });
  });

  // The call is paid for by now, so a failed write is recorded in the report instead of thrown:
  // the report, and with it the cost, must reach the disk either way.
  const unwritten: { id: string; error: string }[] = [];
  for (const a of accepted) {
    try {
      await writeJsonNew(candidatePath(dir, entity, a.id), a);
    } catch (error) {
      unwritten.push({ id: a.id, error: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'write_failed' });
    }
  }

  const report = RunReport.parse({
    ...base,
    model: meta.model,
    costUsd: meta.costUsd,
    usageId: meta.usageId,
    effort: EFFORT,
    failure: null,
    returned: candidates.length,
    ignored: Math.max(0, candidates.length - count),
    accepted: accepted.map((a) => a.id),
    unwritten,
    passRate: accepted.length / count,
    rejections,
  });
  await writeJsonNew(join(reportsDir(dir), `${id}.json`), report);
  return report;
}
