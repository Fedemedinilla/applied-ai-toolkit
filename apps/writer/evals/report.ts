// Offline: prints the results table of a writer eval run.
//
//   node apps/writer/evals/report.ts rows.jsonl
//
// Then lists each unsupported specific by case, for reading by hand.

import { existsSync } from 'node:fs';
import { readJsonl } from '../../../evals/src/index.ts';
import type { EvalFailure, EvalRow } from '../../../evals/src/index.ts';
import { loadConfig } from '../server/config.ts';
import { scoreRows, toMarkdown } from './score.ts';

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.error('usage: node apps/writer/evals/report.ts <rows.jsonl>');
  process.exit(2);
}
const rows = scoreRows(loadConfig(), readJsonl<EvalRow | EvalFailure>(path));
console.log(toMarkdown(rows));
for (const r of rows) for (const e of r.examples) console.log(`- ${r.variant} ${e}`);
