// F6a: the eval harness of prose-rewriter/evals/, offline, over the scripted gateway.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Example, LANGS, Principle, Source } from '../../style-refs/src/index.ts';
import type { PromptRefs } from '../src/prompt.ts';
import { rewrite } from '../src/rewrite.ts';
import { judgeLines } from '../src/rubric.ts';
import type { RewriteInput } from '../src/types.ts';
import { scriptedGateway } from './scripted-gateway.ts';

const ROOT = new URL('../../', import.meta.url);
const CV_ES = readFileSync(new URL('prose-rewriter/evals/cases/cv/es-rioplatense.md', ROOT), 'utf8');
const json = (file: string): unknown[] => JSON.parse(readFileSync(new URL(file, ROOT), 'utf8')) as unknown[];
const REFS: PromptRefs = {
  sources: json('style-refs/sources.json').map((s) => Source.parse(s)),
  principles: LANGS.flatMap((lang) => json(`style-refs/principles/${lang}.json`).map((p) => Principle.parse(p))),
  examples: LANGS.flatMap((lang) => json(`style-refs/examples/${lang}.json`).map((e) => Example.parse(e))),
};

/** Fictional mail: greeting line 0, body 1 to 4, signature 5 and 6; two LEX-01 findings in sentence 2. */
const MAIL = 'Hola Marta,\nEspero que estés bien. Quería comentarte que me apasiona potenciar sinergias. El sitio de la panadería ya carga en 1,6 s. ¿Lo vemos el jueves?\nSaludos,\nValeria';
const SINERGIAS = 'Quería comentarte que me apasiona potenciar sinergias.';
const FIXED = 'Quería contarte que el sitio está listo.';

const mail = (text: string): RewriteInput => ({ text, genre: 'email', lang: 'es', variety: 'rioplatense', profile: { cvMarkdown: CV_ES } });
const plan = (...sentenceIds: number[]) => ({ data: { items: sentenceIds.map((sentenceId) => ({ sentenceId, action: 'remove-formula', reason: 'set phrase', ruleId: 'LEX-01' })) } });
const edits = (...list: Array<{ sentenceId: number; before: string; after: string; principleId?: string }>) => ({
  data: { edits: list.map((e) => ({ reason: 'fix', ...e })) },
});
/** The fact judge's reply over the lines of `rewritten`, nothing invented. */
const factVerdict = (rewritten: string) => ({
  text: JSON.stringify({ lines: judgeLines(rewritten, 'es').map((l) => ({ line: l.line, support: 'no-claim', note: '' })), note: '' }),
});
const tasksOf = (s: { calls: readonly { task: string }[] }) => s.calls.map((c) => c.task);

describe('rewrite() options for the eval variants', () => {
  it('skips S4 when skipStyle is set, and still runs it by default', async () => {
    const expected = MAIL.replace(SINERGIAS, FIXED);
    const skipped = scriptedGateway({ 'rewrite.plan': [plan(2)], 'rewrite.edit': [edits({ sentenceId: 2, before: SINERGIAS, after: FIXED })], 'rewrite.judge': [factVerdict(expected)] });
    const result = await rewrite(mail(MAIL), { gateway: skipped.gateway, refs: REFS, skipStyle: true });
    skipped.assertDone();
    expect(tasksOf(skipped)).toEqual(['rewrite.plan', 'rewrite.edit', 'rewrite.judge']);
    expect(result.rewritten).toBe(expected);

    const full = scriptedGateway({
      'rewrite.plan': [plan(2)],
      'rewrite.edit': [edits({ sentenceId: 2, before: SINERGIAS, after: FIXED })],
      'rewrite.style': [edits()],
      'rewrite.judge': [factVerdict(expected)],
    });
    await rewrite(mail(MAIL), { gateway: full.gateway, refs: REFS, skipStyle: false });
    full.assertDone();
    expect(tasksOf(full)).toEqual(['rewrite.plan', 'rewrite.edit', 'rewrite.style', 'rewrite.judge']);
  });
});
