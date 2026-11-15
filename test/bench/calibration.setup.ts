// Vitest setup file of the benchmark run (vitest.bench.config.ts). It runs in each benchmark
// file's worker process before the file itself: it times the calibration loop there and writes
// the result next to that folder's bench results, as reports/bench/raw/<folder>/calibration.json.
// A bench is then compared against the calibration of its own process, taken seconds before it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { expect } from 'vitest';
import { calibrate } from './calibration.ts';

const testPath = expect.getState().testPath;
if (testPath === undefined) throw new Error('calibration.setup.ts: no test path; it only runs as a Vitest setup file');
const folder = relative(process.cwd(), testPath).split(sep)[0];
if (folder === undefined || folder === '' || folder.startsWith('..')) throw new Error(`calibration.setup.ts: ${testPath} is outside the repository root`);

const out = resolve('reports/bench/raw', folder, 'calibration.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(calibrate(), null, 2)}\n`);
