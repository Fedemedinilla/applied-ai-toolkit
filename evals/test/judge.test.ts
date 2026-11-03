import { describe, expect, it } from 'vitest';
import { recordingClient, reply } from '../example/fake-models.ts';
import type { BlindPiece } from '../src/blind.ts';
import { consensus, JudgeError, judgePiece, judgeRequest, LineSupport, numberedLines, parseVerdict, Verdict, VERDICT_JSON_SCHEMA, type JudgedPiece } from '../src/judge.ts';

const piece: BlindPiece = {
  id: 'abc123',
  case: 'reply-electric',
  lang: 'en',
  now: '2026-03-04T12:00:00.000Z',
  brief: 'Someone asks if we repair electric bikes.',
  text: "Tune-ups are $18,000. We don't do electric bikes.\nNora, Taller Rayo",
};

const verdictJson = (supports: string[], extra: Partial<Verdict> = {}) =>
  JSON.stringify({
    lines: supports.map((support, i) => ({ line: i + 1, support, note: '' })),
    voice: 'on',
    robotic: false,
    quality: 4,
    note: '',
    ...extra,
  });

describe('numberedLines', () => {
  it('splits on line breaks and sentence ends', () => {
    expect(numberedLines(piece.text)).toEqual(['Tune-ups are $18,000.', "We don't do electric bikes.", 'Nora, Taller Rayo']);
  });
  it('does not split inside a number', () => {
    expect(numberedLines('Brakes are $9.000 por rueda. Listo.')).toEqual(['Brakes are $9.000 por rueda.', 'Listo.']);
  });
});

describe('judgeRequest', () => {
  it('numbers the lines and carries the sheet and brief, nothing about the variant', () => {
    const req = judgeRequest(piece, 'FACTS: tune-up $18,000');
    const body = req.messages[0]!.content;
    expect(body).toContain('FACT SHEET\nFACTS: tune-up $18,000');
    expect(body).toContain('PIECE (3 lines)\n1. Tune-ups are $18,000.\n2. We don\'t do electric bikes.\n3. Nora, Taller Rayo');
    expect(body).not.toContain(piece.id);
    expect(req.output_config?.format?.type).toBe('json_schema');
  });
});

describe('parseVerdict', () => {
  it('accepts a verdict that covers every line once', () => {
    const v = parseVerdict(verdictJson(['fact-sheet', 'invented', 'no-claim']), 3);
    expect(v.lines[1]!.support).toBe('invented');
  });
  it('rejects a skipped line, a repeated line and an extra line', () => {
    expect(() => parseVerdict(verdictJson(['fact-sheet', 'no-claim']), 3)).toThrow(/expected 1..3/);
    const repeated = JSON.stringify({ ...JSON.parse(verdictJson(['no-claim', 'no-claim', 'no-claim'])), lines: [1, 1, 3].map((line) => ({ line, support: 'no-claim', note: '' })) });
    expect(() => parseVerdict(repeated, 3)).toThrow(JudgeError);
    expect(() => parseVerdict(verdictJson(['no-claim', 'no-claim', 'no-claim', 'no-claim']), 3)).toThrow(JudgeError);
  });
  it('rejects quality out of range, unknown fields and non-JSON', () => {
    expect(() => parseVerdict(verdictJson(['no-claim'], { quality: 6 }), 1)).toThrow(/wrong shape/);
    expect(() => parseVerdict(JSON.stringify({ ...JSON.parse(verdictJson(['no-claim'])), variant: 'V4' }), 1)).toThrow(/wrong shape/);
    expect(() => parseVerdict('Sure! Here is my verdict', 1)).toThrow(/not JSON/);
  });
});

describe('the two schemas agree', () => {
  const item = Verdict.shape.lines.element;

  it('on keys and required fields, at the top level and for each line', () => {
    expect([...VERDICT_JSON_SCHEMA.required].sort()).toEqual(Object.keys(Verdict.shape).sort());
    expect(Object.keys(VERDICT_JSON_SCHEMA.properties).sort()).toEqual(Object.keys(Verdict.shape).sort());
    const items = VERDICT_JSON_SCHEMA.properties.lines.items;
    expect([...items.required].sort()).toEqual(Object.keys(item.shape).sort());
    expect(Object.keys(items.properties).sort()).toEqual(Object.keys(item.shape).sort());
  });

  it('on closed objects: both reject unknown keys', () => {
    expect(VERDICT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(VERDICT_JSON_SCHEMA.properties.lines.items.additionalProperties).toBe(false);
    expect(Verdict.safeParse({ ...JSON.parse(verdictJson([])), extra: 1 }).success).toBe(false);
    expect(item.safeParse({ line: 1, support: 'no-claim', note: '', extra: 1 }).success).toBe(false);
  });

  it('on labels and the quality range', () => {
    expect(VERDICT_JSON_SCHEMA.properties.lines.items.properties.support.enum).toEqual(LineSupport.options);
    expect(VERDICT_JSON_SCHEMA.properties.voice.enum).toEqual(Verdict.shape.voice.options);
    for (const q of VERDICT_JSON_SCHEMA.properties.quality.enum) expect(Verdict.shape.quality.safeParse(q).success).toBe(true);
    for (const q of [0, 6, 2.5]) expect(Verdict.shape.quality.safeParse(q).success).toBe(false);
  });
});

describe('judgePiece', () => {
  it('returns the parsed verdict with the piece id and judge number', async () => {
    const client = recordingClient(() => reply(verdictJson(['fact-sheet', 'invented', 'no-claim'], { quality: 2 })));
    const v = await judgePiece(client, piece, 'sheet', 2);
    expect(v).toMatchObject({ id: 'abc123', judge: 2, quality: 2 });
  });
  it('refuses a cut judge reply instead of parsing half of it', async () => {
    const client = recordingClient(() => reply('{"lines": [', 'max_tokens'));
    await expect(judgePiece(client, piece, 'sheet')).rejects.toThrow(/max_tokens/);
  });
  it('refuses a judge refusal, even when its text happens to parse', async () => {
    const client = recordingClient(() => reply(verdictJson(['no-claim', 'no-claim', 'no-claim']), 'refusal'));
    await expect(judgePiece(client, piece, 'sheet')).rejects.toThrow(/refusal on abc123/);
  });
});

describe('consensus', () => {
  const v = (judge: number, invented: boolean, quality: number, robotic = false): JudgedPiece => ({
    id: 'p1',
    judge,
    lines: [{ line: 1, support: invented ? 'invented' : 'fact-sheet', note: '' }],
    voice: 'on',
    robotic,
    quality,
    note: '',
  });

  it('flags a piece on a strict majority and takes the median quality', () => {
    expect(consensus([v(1, true, 2), v(2, true, 2), v(3, false, 4)])).toMatchObject({ invented: true, quality: 2, unanimous: false, judges: 3 });
    expect(consensus([v(1, true, 2), v(2, false, 4)])).toMatchObject({ invented: false, quality: 3, unanimous: false });
    expect(consensus([v(1, false, 5, true)])).toMatchObject({ invented: false, robotic: true, unanimous: true });
  });
  it('refuses to combine verdicts of different pieces', () => {
    expect(() => consensus([v(1, true, 2), { ...v(2, true, 2), id: 'p2' }])).toThrow();
  });
});
