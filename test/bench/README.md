# Benchmarks

Six benches over four folders, run with `vitest bench`, and a script that compares a run with a committed baseline and exits non-zero when a bench got slower beyond a tolerance. The benches are not part of `npm test`: they take about 15 seconds and their numbers depend on the machine.

## Run it

From the repository root:

```sh
npm run bench            # runs every *.bench.ts, writes reports/bench/result.json
npm run bench:compare    # compares that result with test/bench/baseline.json; exit 1 on a regression
npm run bench:baseline   # records the last run as the new baseline (commit the file)
```

`npm run bench:compare -- --tolerance 0.3` changes the tolerance, and `--result` and `--baseline` take other files. The weekly workflow `.github/workflows/quality.yml` runs the first two commands and uploads `reports/bench/` as an artifact.

## The benches

| Bench | File | One iteration |
| --- | --- | --- |
| `amount-parser/parse-corpus` | `amount-parser/test/parse.bench.ts` | `parseAmount` over the 194 corpus phrases |
| `safe-markdown/render-long-reply` | `safe-markdown/test/render.bench.ts` | `renderMarkdown` of a reply of about 19,000 characters with lists, tables, code and links |
| `slop-lint/lint-long-en` | `slop-lint/test/lint.bench.ts` | `lint` of an English document of about 29,000 characters |
| `slop-lint/lint-long-es` | `slop-lint/test/lint.bench.ts` | `lint` of a Spanish document of about 33,000 characters |
| `gateway/concurrent-50-under-cap` | `gateway/test/concurrency.bench.ts` | 50 concurrent calls through the gateway against the fake wire, all settled |
| `gateway/concurrent-50-at-cap` | `gateway/test/concurrency.bench.ts` | 50 concurrent calls at the daily cap, all refused before any request |

Each bench also asserts that the timed work was done. The gateway benches check the ledger after every burst: the cap held, no reservation stayed open and the recorded spend is the expected one. A burst that breaks the cap fails the bench whatever its speed.

## How a run is compared

Milliseconds from one machine say nothing on another, so the baseline does not store them as the thing to compare. Before each bench file, in the same worker process, `calibration.setup.ts` times a fixed calibration loop (`calibration.ts`): string building, Unicode normalization, a global regex, a `Map` and `split` and `join`, 101 rounds after a warm-up of 40, median kept. Each bench is then stored as a ratio:

```
ratio = median time of the bench / median time of the calibration loop in the same process
```

`compare` reads only the ratios. A bench passes while its ratio is at most the baseline ratio times `1 + tolerance`. The default tolerance is 0.5, so a bench fails when it is more than 50% slower than the baseline in calibration units. A bench that is in the baseline and did not run also fails, so deleting a bench cannot hide a regression. A bench much faster than the baseline, or one the baseline does not have, passes with a note to record a new baseline.

The result file keeps the milliseconds, the sample count and the machine (Node version, platform, CPU model, core count) for the reader. The comparison ignores them.

## Baseline

Measured on 2026-11-14, Node 24.22.1 on Linux x64, 4 cores of a shared cloud container (Intel Xeon at 2.30 GHz). Median of one iteration, and the ratio to the calibration loop:

| Bench | Median | Ratio |
| --- | --- | --- |
| `amount-parser/parse-corpus` | 3.30 ms | 0.733 |
| `gateway/concurrent-50-at-cap` | 9.86 ms | 2.119 |
| `gateway/concurrent-50-under-cap` | 17.13 ms | 3.679 |
| `safe-markdown/render-long-reply` | 0.62 ms | 0.134 |
| `slop-lint/lint-long-en` | 17.92 ms | 3.875 |
| `slop-lint/lint-long-es` | 13.67 ms | 2.956 |

These are numbers of one machine on one day. On another machine expect other milliseconds and, within the limits below, similar ratios.

## Limits of the method

- **The ratio is not machine-independent, only less machine-dependent.** One loop cannot stand for every workload. A CPU with a larger cache, another memory speed or another V8 version changes the benches and the calibration by different factors. Across 4 runs on the baseline machine the ratios moved by up to 14% around their mean; across machines the spread is unknown until someone measures it. The 50% tolerance is set for that uncertainty.
- **It catches large regressions only.** A change that makes a bench 20% slower passes. The comparison is a tripwire for an accidental quadratic loop or a regex that backtracks. To measure a small change, run the bench before and after on the same quiet machine and read the milliseconds.
- **The gateway benches are the least stable.** They are asynchronous and allocate more than the others (50 requests through the SDK client per iteration), so the garbage collector and the event loop weigh more than in the calibration loop.
- **Noise on shared runners.** Another process on the same cores slows a bench and not the calibration measured seconds earlier, or the other way round. A failed comparison on CI is a reason to run it again before reading the code.
- **Node version.** The baseline is for Node 24. A new V8 can move a ratio in either direction with no change in the repository; record a new baseline after upgrading.
- **The calibration loop is frozen.** Changing it invalidates every stored ratio. `CALIBRATION_VERSION` is stored in each result, `compare` refuses two results with different versions, and a test pins the loop's checksum.
- **One bench file per folder.** The calibration is stored per top-level folder; a second bench file in the same folder would overwrite it with its own.

## Layout

```
calibration.ts         the calibration loop and its timing
calibration.setup.ts   Vitest setup file: times the loop in each bench file's process
compare.ts             the result format, buildResult, compare, formatComparison
cli.ts                 clean, collect and compare over the files in reports/bench/
compare.test.ts        tests of the comparison, the loop and the CLI exit codes (part of npm test)
baseline.json          the committed baseline
```
