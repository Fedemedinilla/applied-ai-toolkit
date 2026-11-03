/**
 * Unblinding and aggregation into a results table.
 *
 * Rates come with a 95% Wilson interval, because the counts here are small and
 * a bare percentage hides how small. In the case study, 0 errors in 14 was
 * read as "fixed", and a larger sample later gave 3 in 10. On this table, 0 of
 * 14 reads as 0% to 22%: an error rate of one in five is still inside it.
 *
 * Every row has the same denominator rules. The invention rate counts judged
 * pieces only. A refusal or an empty reply has nothing to judge, so it is
 * counted apart ("no piece") instead of passing as a clean piece with zero
 * lines. A failed call is counted apart too ("failed"), and by default stops
 * aggregation, because failures are not random across variants.
 */
import type { BlindKey, BlindPiece, KeyEntry } from './blind.ts';
import { checkLineCoverage, consensus, JudgedPiece, numberedLines, type Consensus } from './judge.ts';

/** 95% Wilson score interval for k successes in n trials, as fractions. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export type ResultRow = {
  variant: string;
  lang: string;
  /** Pieces judged: the denominator of every rate on the row. */
  pieces: number;
  invented: number;
  inventedCi: [number, number];
  robotic: number;
  offVoice: number;
  /** NaN when nothing was judged. */
  meanQuality: number;
  /** Pieces cut at max_tokens. Judged like the rest, and counted apart. */
  cut: number;
  /** Pieces where the judges split on invented / not invented. */
  split: number;
  /** Refusals and empty replies: nothing to judge, not in the denominator. */
  noPiece: number;
  /** Calls that failed. Only non-zero with `allowMissing`. */
  failed: number;
};

export type AggregateOptions = {
  /**
   * Judges each piece must have. Defaults to the largest count found, so a
   * piece that lost one of three judges is refused instead of being held to a
   * two-judge majority while the rest get three.
   */
  judges?: number | undefined;
  /** Report failed calls and uneven variant totals in the table instead of stopping. */
  allowMissing?: boolean;
};

export class AggregateError extends Error {
  override name = 'AggregateError';
}

const sample = (ids: readonly string[]) => ids.slice(0, 5).join(', ') + (ids.length > 5 ? ', ...' : '');

/**
 * Joins verdicts to the key and groups by variant and language, plus one "all"
 * row per variant. Refuses, rather than silently dropping, anything that would
 * give one variant a different denominator from another: a verdict for an
 * unknown piece, a piece with no verdict or fewer judges than the rest, a
 * judge counted twice, a verdict that does not cover the piece's lines, a key
 * entry with no piece, a failed call, or variants with different row counts.
 */
export function aggregate(
  pieces: readonly BlindPiece[],
  key: BlindKey,
  verdicts: readonly unknown[],
  opts: AggregateOptions = {},
): ResultRow[] {
  const pieceById = new Map(pieces.map((p) => [p.id, p]));
  for (const p of pieces) {
    const entry = key[p.id];
    if (!entry) throw new AggregateError(`piece ${p.id} is not in the key`);
    if (entry.withheld) throw new AggregateError(`piece ${p.id} is marked ${entry.withheld} in the key but was given to the judge`);
  }
  const lost = Object.entries(key)
    .filter(([id, e]) => !e.withheld && !pieceById.has(id))
    .map(([id]) => id);
  if (lost.length) throw new AggregateError(`${lost.length} key entr(ies) have no piece: ${sample(lost)}`);

  const byId = new Map<string, JudgedPiece[]>();
  verdicts.forEach((raw, i) => {
    const parsed = JudgedPiece.safeParse(raw);
    if (!parsed.success) throw new AggregateError(`verdict ${i + 1} has the wrong shape: ${parsed.error.issues[0]?.message}`);
    const v = parsed.data;
    const p = pieceById.get(v.id);
    if (!p) throw new AggregateError(`verdict for unknown piece ${v.id}`);
    checkLineCoverage(v, numberedLines(p.text).length);
    const list = byId.get(v.id) ?? [];
    if (list.some((x) => x.judge === v.judge)) throw new AggregateError(`piece ${v.id} has two verdicts from judge ${v.judge}`);
    list.push(v);
    byId.set(v.id, list);
  });

  const unjudged = pieces.filter((p) => !byId.has(p.id)).map((p) => p.id);
  if (unjudged.length) throw new AggregateError(`${unjudged.length} piece(s) have no verdict: ${sample(unjudged)}`);
  const judges = opts.judges ?? Math.max(0, ...[...byId.values()].map((l) => l.length));
  const short = pieces.filter((p) => byId.get(p.id)!.length !== judges).map((p) => `${p.id} (${byId.get(p.id)!.length})`);
  if (short.length) throw new AggregateError(`${short.length} piece(s) do not have ${judges} judge(s): ${sample(short)}`);

  const entries = Object.entries(key);
  const failed = entries.filter(([, e]) => e.withheld === 'failed');
  if (!opts.allowMissing) {
    if (failed.length) {
      throw new AggregateError(`${failed.length} call(s) failed in the run (${sample(failed.map(([, e]) => `${e.variant} ${e.lang} ${e.case} #${e.sample}`))}); rerun, or pass allowMissing to report them`);
    }
    const perVariant = new Map<string, number>();
    for (const [, e] of entries) perVariant.set(e.variant, (perVariant.get(e.variant) ?? 0) + 1);
    if (new Set(perVariant.values()).size > 1) {
      const counts = [...perVariant].map(([v, n]) => `${v} ${n}`).join(', ');
      throw new AggregateError(`variants have different row counts (${counts}): the run was cut or mixed; pass allowMissing to report anyway`);
    }
  }

  type Item = { entry: KeyEntry; c?: Consensus };
  const groups = new Map<string, { variant: string; lang: string; items: Item[] }>();
  const add = (variant: string, lang: string, item: Item) => {
    const k = `${variant}\0${lang}`;
    const g = groups.get(k) ?? { variant, lang, items: [] };
    g.items.push(item);
    groups.set(k, g);
  };
  for (const [id, entry] of entries) {
    const item: Item = entry.withheld ? { entry } : { entry, c: consensus(byId.get(id)!) };
    add(entry.variant, entry.lang, item);
    add(entry.variant, 'all', item);
  }

  const rows: ResultRow[] = [];
  for (const g of groups.values()) {
    const judged = g.items.filter((i): i is Required<Item> => i.c !== undefined);
    const n = judged.length;
    const count = (f: (c: Consensus) => boolean) => judged.filter((i) => f(i.c)).length;
    const invented = count((c) => c.invented);
    rows.push({
      variant: g.variant,
      lang: g.lang,
      pieces: n,
      invented,
      inventedCi: wilson(invented, n),
      robotic: count((c) => c.robotic),
      offVoice: count((c) => c.offVoice),
      meanQuality: n ? judged.reduce((s, i) => s + i.c.quality, 0) / n : NaN,
      cut: judged.filter((i) => i.entry.stop === 'max_tokens').length,
      split: count((c) => !c.unanimous),
      noPiece: g.items.filter((i) => i.entry.withheld === 'refusal' || i.entry.withheld === 'empty').length,
      failed: g.items.filter((i) => i.entry.withheld === 'failed').length,
    });
  }
  return rows.sort((a, b) => a.variant.localeCompare(b.variant) || langOrder(a.lang) - langOrder(b.lang) || a.lang.localeCompare(b.lang));
}

const langOrder = (l: string) => (l === 'all' ? 1 : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function toMarkdown(rows: readonly ResultRow[], what: Record<string, string> = {}): string {
  const head = '| variant | lang | judged | invented | 95% CI | robotic | off voice | quality | cut | split | no piece | failed |';
  const rule = '|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|';
  const body = rows.map((r) =>
    [
      r.variant,
      r.lang,
      r.pieces,
      r.pieces ? `${r.invented} (${pct(r.invented / r.pieces)})` : '-',
      r.pieces ? `${pct(r.inventedCi[0])} to ${pct(r.inventedCi[1])}` : '-',
      r.robotic,
      r.offVoice,
      r.pieces ? r.meanQuality.toFixed(1) : '-',
      r.cut,
      r.split,
      r.noPiece,
      r.failed,
    ].join(' | '),
  );
  const legend = Object.entries(what).map(([id, w]) => `- ${id}: ${w}`);
  return [head, rule, ...body.map((b) => `| ${b} |`), ...(legend.length ? ['', ...legend] : [])].join('\n');
}
