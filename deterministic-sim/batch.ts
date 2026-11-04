/**
 * Batch runner for the terminal. Plays N runs with a fixed-dice policy and prints the
 * distributions and the report hash.
 *
 *   node deterministic-sim/batch.ts [--runs 10000] [--dice 3] [--seed-prefix batch] [--json]
 *
 * The same arguments print the same report on any machine; the hash on the last line says so in
 * one line.
 */

import { parseArgs } from 'node:util';
import { fixedDicePolicy, reportHash, runBatch, type Distribution } from './src/index.ts';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '10000' },
    dice: { type: 'string', default: '3' },
    'seed-prefix': { type: 'string', default: 'batch' },
    json: { type: 'boolean', default: false },
  },
});

function integer(name: string, text: string): number {
  const n = Number(text);
  if (!Number.isInteger(n)) {
    console.error(`--${name} must be an integer, got "${text}"`);
    process.exit(2);
  }
  return n;
}

const started = performance.now();
const report = runBatch({
  runs: integer('runs', values.runs),
  seedPrefix: values['seed-prefix'],
  policy: fixedDicePolicy(integer('dice', values.dice)),
});
const elapsed = performance.now() - started;

if (values.json) {
  console.log(JSON.stringify({ report, reportHash: reportHash(report) }, null, 2));
} else {
  const mean = (d: Distribution): string => (d.mean100 / 100).toFixed(2);
  const line = (label: string, d: Distribution): string =>
    `${label.padEnd(11)} min ${d.min}  p10 ${d.p10}  p50 ${d.p50}  p90 ${d.p90}  max ${d.max}  mean ${mean(d)}`;
  console.log(`${report.runs} runs, policy ${report.policy}, ruleset ${report.rulesetVersion}, seeds ${report.seedPrefix}-0 ...`);
  console.log(line('score', report.score));
  console.log(line('busts', report.busts));
  console.log(line('chips left', report.chipsLeft));
  const { start, width, counts } = report.score.histogram;
  const peak = Math.max(...counts);
  console.log('\nscore histogram');
  counts.forEach((count, i) => {
    const lo = start + i * width;
    const bar = '#'.repeat(peak === 0 ? 0 : Math.round((count / peak) * 40));
    console.log(`${String(lo).padStart(4)}-${String(lo + width - 1).padEnd(4)} ${String(count).padStart(6)} ${bar}`);
  });
  console.log(`\nreport hash ${reportHash(report)}  (${elapsed.toFixed(0)} ms)`);
}
