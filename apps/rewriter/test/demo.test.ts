// The demo's recordings: real rewrites from the model, of fictional eval cases. Each one must still
// be a valid RewriteResult, its input must be the eval case it names, and the page must rebuild
// the recorded rewrite from the original and the applied changes. The set must cover what the
// page has to show.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RewriteInput, RewriteResult } from '../../../prose-rewriter/src/index.ts';
import { buildExamples, CHOSEN, FICTIONAL } from '../scripts/demo-examples.ts';
import { asDemoSet } from '../src/demo.ts';
import { appliedIds, recompose } from '../src/recompose.ts';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const raw = read('../demo/examples.json') as { fictional: string; recorded: string; examples: Array<{ id: string; cv: string; input: Record<string, unknown>; result: unknown }> };
const set = asDemoSet(raw);
type EvalCase = { id: string; cv: string; input: Record<string, unknown> };
const cases = [read('../../../prose-rewriter/evals/cases/es.json'), read('../../../prose-rewriter/evals/cases/en.json')].flatMap((file) => (file as { cases: EvalCase[] }).cases);
const cvs: Record<string, string> = {
  'es-rioplatense': readFileSync(new URL('../../../prose-rewriter/evals/cases/cv/es-rioplatense.md', import.meta.url), 'utf8'),
  en: readFileSync(new URL('../../../prose-rewriter/evals/cases/cv/en.md', import.meta.url), 'utf8'),
};

describe('demo/examples.json', () => {
  it('is marked as fiction and has the shape the page reads', () => {
    expect(raw.fictional).toBe(FICTIONAL);
    expect(raw.recorded).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(set).not.toBeNull();
    expect(set?.examples.map((e) => e.id)).toEqual(CHOSEN.map((c) => c.id));
  });

  it.each(raw.examples.map((e) => [e.id, e] as const))('%s still parses as a RewriteResult', (_, example) => {
    const parsed = RewriteResult.safeParse(example.result);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
  });

  it.each(raw.examples.map((e) => [e.id, e] as const))('%s has the input of its eval case, with a fictional CV', (id, example) => {
    const c = cases.find((x) => x.id === id);
    expect(c).toBeDefined();
    const { mode: _mode, ...input } = example.input;
    const { mode: _caseMode, ...caseInput } = c?.input ?? {};
    expect(input).toEqual(caseInput);
    expect(example.cv).toBe(c?.cv);
    expect(cvs[example.cv]).toMatch(/^<!-- Fictional/u);
    expect(RewriteInput.safeParse({ ...example.input, profile: { cvMarkdown: cvs[example.cv] } }).success).toBe(true);
  });

  it.each(set?.examples.map((e) => [e.id, e] as const) ?? [])('%s: the page rebuilds the recorded rewrite, and the original with every change reverted', (_, example) => {
    const original = example.input.text.normalize('NFC');
    const all = recompose(original, example.result.changes, appliedIds(example.result.changes));
    expect(all.ok && all.text).toBe(example.result.rewritten);
    const none = recompose(original, example.result.changes, new Set());
    expect(none.ok && none.text).toBe(original);
  });

  it('covers both languages, every genre, a heavy rewrite, a text left alone, an injection, a review and reverted changes', () => {
    const examples = set?.examples ?? [];
    expect(new Set(examples.map((e) => e.input.lang))).toEqual(new Set(['es', 'en']));
    expect(new Set(examples.map((e) => e.input.genre))).toEqual(new Set(['cover-letter', 'email', 'follow-up', 'whatsapp']));
    expect(examples.some((e) => e.result.changes.length >= 8)).toBe(true);
    expect(examples.some((e) => e.result.changes.length === 0 && e.result.rewritten === e.input.text)).toBe(true);
    expect(examples.some((e) => e.result.flags.some((f) => f.kind === 'injection'))).toBe(true);
    expect(examples.some((e) => e.result.status === 'needs-review')).toBe(true);
    expect(examples.some((e) => e.result.changes.some((c) => c.status === 'reverted'))).toBe(true);
    expect(examples.some((e) => e.result.facts.fromCv.length > 0)).toBe(true);
    expect(examples.some((e) => e.input.recipient?.previousMessage !== undefined)).toBe(true);
  });

  it('shows an injection that was not followed: the rewrite signs as the original did', () => {
    const e = set?.examples.find((x) => x.id === 'es-trap-injection-in-text');
    expect(e?.result.rewritten.trimEnd().endsWith('Saludos,\nValeria')).toBe(true);
    expect(e?.result.rewritten).not.toMatch(/Gerente de Tecnología\s*$/u);
  });

  it('is what the script builds from the same records: input from the case, result unchanged', () => {
    const pieces = raw.examples.map((e) => ({ case: e.id, mode: String(e.input['mode']), variant: 'single-guarded', result: e.result as Record<string, unknown> & { usage: unknown } }));
    expect(buildExamples(pieces, cases, raw.recorded)).toEqual(raw);
  });
});

describe('asDemoSet', () => {
  it('refuses a set without the fiction marker, an empty set and a broken result', () => {
    expect(asDemoSet({ ...raw, fictional: 'Real data' })).toBeNull();
    expect(asDemoSet({ ...raw, examples: [] })).toBeNull();
    const [first] = raw.examples;
    expect(asDemoSet({ ...raw, examples: [{ ...first, result: { ...(first?.result as object), status: 'fine' } }] })).toBeNull();
    expect(asDemoSet({ ...raw, examples: [{ ...first, input: { ...first?.input, genre: 'memo' } }] })).toBeNull();
    expect(asDemoSet(null)).toBeNull();
  });
});
