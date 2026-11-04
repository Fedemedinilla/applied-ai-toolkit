// Opt-in: runs a few fictional sentences through the real handler and the real API, then through
// the verdict, and prints what the model read and which flags the code raised. Not part of the
// test suite. Without the key it prints how to run it and exits before any call.
//
//   ANTHROPIC_API_KEY=sk-ant-... node apps/caja/server/live-check.ts
//
// Five calls, each bounded by max_tokens 2000 and counted against the handler's monthly cap.

import { isReading, verdict } from '../src/verdict.ts';
import { apiKeyFromEnv } from './env.ts';
import { createHandlerFromEnv } from './index.ts';
import { CAP_TIME_ZONE } from './model.ts';
import { dayIn } from './handler.ts';

const SENTENCES = [
  'ayer pagué la luz 45 lucas',
  'vendí 3 docenas a 12 mil la docena',
  'vendí 5 tortas a 8000',
  'harina 20 mil',
  'el martes cobré un encargo de cumpleaños, 38 mil',
];

if (apiKeyFromEnv() === null) {
  console.log('Set ANTHROPIC_API_KEY to run it: ANTHROPIC_API_KEY=sk-ant-... node apps/caja/server/live-check.ts');
  process.exit(0);
}

const handler = createHandlerFromEnv();
const today = dayIn(new Date(), CAP_TIME_ZONE) ?? '';

for (const sentence of SENTENCES) {
  const res = await handler(
    new Request('http://127.0.0.1/api/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sentence, today, timezone: CAP_TIME_ZONE }),
    }),
  );
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || !isReading(body['reading'])) {
    console.log(JSON.stringify({ sentence, status: res.status, body }));
    continue;
  }
  const v = verdict(sentence, body['reading'], today);
  console.log(JSON.stringify({ sentence, reading: body['reading'], amount: v.amount, category: v.category, date: v.date, flags: v.flags }));
}
