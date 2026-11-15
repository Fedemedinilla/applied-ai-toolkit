/**
 * Pins the groundedness judge: the exact request sent for one fixture piece,
 * and the verdicts it accepts and refuses.
 *
 * The fixture file was written from the judge as it stood before rubrics
 * became pluggable (commit 51503bf), so this test is the proof that the
 * built-in `groundedness` rubric sends the same bytes as the judge the case
 * study was measured with. A change to the rubric text, the labels, the call
 * settings or the layout of the message fails here. If the change is meant,
 * it is a new rubric version, and the fixture is regenerated on purpose:
 *
 *   UPDATE_PIN=1 npx vitest run evals/test/groundedness-pin.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgeSheet } from '../example/business.ts';
import { recordingClient, reply } from '../example/fake-models.ts';
import type { BlindPiece } from '../src/blind.ts';
import { judgePiece, judgeRequest } from '../src/judge.ts';

const FIXTURE = new URL('./fixtures/groundedness-request.json', import.meta.url);

const piece: BlindPiece = {
  id: 'k3m9pq',
  case: 'email-closed-pickup',
  lang: 'en',
  now: '2026-03-04T12:00:00.000Z',
  brief: 'We are closed next Thursday for a family matter.',
  text: [
    'Subject: Closed next Thursday',
    'Hi,',
    "We're closed on Thursday 12 March for a family matter. We open again on Friday at 9 am!",
    "Bikes left before then stay safe in the shop, and we'll call you when yours is ready.",
    'Is a $18,000 tune-up what you need? Write to us on WhatsApp at 11 0000-0142.',
    'Nora, Taller Rayo',
  ].join('\n'),
};
const sheet = judgeSheet('en', new Date(piece.now));

describe('the groundedness judge request is pinned', () => {
  it('sends byte for byte the request stored in the fixture', () => {
    const actual = JSON.stringify(judgeRequest(piece, sheet), null, 1) + '\n';
    if (process.env.UPDATE_PIN === '1') writeFileSync(FIXTURE, actual);
    expect(actual).toBe(readFileSync(FIXTURE, 'utf8'));
  });

  it('judgePiece sends that same request to the client', async () => {
    const lines = [1, 2, 3, 4, 5, 6, 7, 8].map((line) => ({ line, support: 'no-claim', note: '' }));
    const client = recordingClient(() => reply(JSON.stringify({ lines, voice: 'on', robotic: false, quality: 4, note: '' })));
    const verdict = await judgePiece(client, piece, sheet, 2);
    expect(JSON.stringify(client.requests[0], null, 1) + '\n').toBe(readFileSync(FIXTURE, 'utf8'));
    expect(verdict).toEqual({ id: 'k3m9pq', judge: 2, lines, voice: 'on', robotic: false, quality: 4, note: '' });
  });

  it('keeps the wording of every refusal', async () => {
    const answer = (text: string, stop = 'end_turn') => judgePiece(recordingClient(() => reply(text, stop)), piece, sheet);
    const seven = JSON.stringify({ lines: [1, 2, 3, 4, 5, 6, 7].map((line) => ({ line, support: 'no-claim', note: '' })), voice: 'on', robotic: false, quality: 4, note: '' });
    await expect(answer(seven)).rejects.toThrow('judge covered lines [1,2,3,4,5,6,7], expected 1..8 once each');
    await expect(answer('nope')).rejects.toThrow('judge reply is not JSON');
    await expect(answer('{}')).rejects.toThrow(/^judge reply has the wrong shape: /);
    await expect(answer(seven, 'max_tokens')).rejects.toThrow('judge stopped with max_tokens on k3m9pq');
    await expect(answer(seven, 'refusal')).rejects.toThrow('judge stopped with refusal on k3m9pq');
  });
});
