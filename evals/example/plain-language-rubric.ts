/**
 * A sample judge rubric for a task with no fact sheet: does a customer-facing
 * text use only words its reader knows? The reference is a list of trade
 * words the reader is known to understand. The README prints this file as its
 * full example of the rubric interface, and a test keeps the two identical.
 */
import { z } from 'zod';
import { JudgeError, type JudgeRubric } from '../src/rubric.ts';

const Verdict = z.strictObject({
  sentences: z.array(z.strictObject({ sentence: z.number().int().min(1), jargon: z.array(z.string()) })),
  note: z.string(),
});

/** The units the judge has to account for: one per sentence. */
const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

export const plainLanguage: JudgeRubric<z.infer<typeof Verdict>> = {
  kind: 'judge',
  name: 'plain-language',
  version: '1',
  instructions: `You read short texts a small business sends to its customers. For every numbered sentence, list each trade word or abbreviation a customer would have to look up. A word in KNOWN WORDS is never jargon. Copy each term exactly as written. A sentence with none gets an empty list.`,
  call: {
    model: 'claude-opus-5-5',
    max_tokens: 2000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            sentences: {
              type: 'array',
              items: {
                type: 'object',
                properties: { sentence: { type: 'integer' }, jargon: { type: 'array', items: { type: 'string' } } },
                required: ['sentence', 'jargon'],
                additionalProperties: false,
              },
            },
            note: { type: 'string' },
          },
          required: ['sentences', 'note'],
          additionalProperties: false,
        },
      },
    },
  },
  verdict: Verdict,
  prompt: (piece, knownWords) =>
    ['KNOWN WORDS', knownWords, '', 'TEXT', ...sentences(piece.text).map((s, i) => `${i + 1}. ${s}`)].join('\n'),
  complete(verdict, piece) {
    const seen = verdict.sentences.map((s) => s.sentence).sort((a, b) => a - b);
    const expected = sentences(piece.text).map((_, i) => i + 1);
    if (seen.join(',') !== expected.join(',')) {
      throw new JudgeError(`judge covered sentences [${seen.join(',')}], expected 1..${expected.length} once each`);
    }
  },
  reduce(verdict) {
    const terms = verdict.sentences.flatMap((s) => s.jargon);
    return { pass: terms.length === 0, metrics: { jargon_terms: terms.length } };
  },
  describe: (verdict) =>
    verdict.sentences
      .filter((s) => s.jargon.length > 0)
      .map((s) => `sentence ${s.sentence}: ${s.jargon.join(', ')}`)
      .join('; '),
};
