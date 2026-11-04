// Parses one sentence per line and prints one JSON object per line.
//
//   echo "vendí 3 docenas a 12 mil la docena" | node amount-parser/cli.ts
//   node amount-parser/cli.ts "gasté 20 lucas" "vendí 5 tortas a 8000"
//
// Sentences come from the arguments when there are any, otherwise from stdin. Exit code 0 always:
// "no amount" and "ask" are answers, not errors.

import { parseAmount } from './src/index.ts';

function describe(sentence: string): string {
  // The same keys every time, so a typed reader of the stream sees one shape.
  const r = parseAmount(sentence);
  if (r === null) {
    return JSON.stringify({
      input: sentence,
      value: null,
      ambiguous: false,
      reason: null,
      approximate: false,
      quantity: null,
      unitPrice: null,
      literal: null,
      source: null,
      spans: [],
    });
  }
  return JSON.stringify({
    input: sentence,
    value: r.value,
    ambiguous: r.ambiguous,
    reason: r.reason ?? null,
    approximate: r.approximate,
    quantity: r.quantity,
    unitPrice: r.unitPrice,
    literal: r.literal,
    source: r.source,
    spans: r.spans,
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const args = process.argv.slice(2);
if (args.includes('--help') || (args.length === 0 && process.stdin.isTTY)) {
  console.log('usage: node amount-parser/cli.ts "sentence" ...   or   echo "sentence" | node amount-parser/cli.ts');
} else {
  const sentences = args.length ? args : (await readStdin()).split(/\r?\n/u).filter((line) => line.trim() !== '');
  for (const sentence of sentences) console.log(describe(sentence));
}
