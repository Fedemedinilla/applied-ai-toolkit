# Deterministic simulation core

A TypeScript core for a turn-based simulation whose runs replay exactly: the same seed and inputs give the same state, byte for byte, in Node and in a browser. That makes a saved run a small file of inputs, a bug report reproducible from that file, and a balance change something a batch can measure before it ships. The randomness of each step is derived from the seed and the step index, every formula rounds once in integers, and a run is identified by a SHA-256 over canonical JSON. I extracted the patterns from a private game project and rebuilt them around an invented twenty-round dice tournament, so the code can be read without the game. The folder also carries the Claude Code hooks and the read-only reviewer agent that keep an AI coding agent from changing the rules by accident.

## Run it

From the repository root:

```sh
npm ci
npx vitest run deterministic-sim                  # offline, about 2.5 seconds
npm run check                                     # tsc --noEmit, strict
node deterministic-sim/batch.ts --runs 10000      # batch report with the reference policy
node deterministic-sim/batch.ts --runs 1000 --dice 5 --seed-prefix lab --json
```

Node 24 runs the TypeScript sources directly. There is no build step and no dependency: `src/` imports only its own files. [`apps/replay-lab`](../apps/replay-lab/) is the browser front end.

## The example domain

One player, twenty rounds, ten chips to start. Each round is one input:

- `{ kind: 'roll', dice: n }` with n from 1 to 5. Each die costs a chip. The roll scores the sum of the faces times three multipliers. The combination gives pair 1.25, two pairs 1.5, three of a kind 2, full house 2.5, four 3 and five 5. The streak gives 1.0 plus 0.1 per scoring roll in a row, up to 1.5. The house mood drawn for that round gives calm 1.0, cold 0.8 or hot 1.25. Two or more ones in a roll of two or more dice is a bust, which scores nothing and resets the streak.
- `{ kind: 'rest' }` wins four chips, up to twenty, and resets the streak.

After round twenty each chip left is worth one point. Every number above lives in [`src/tournament/rules-v1.ts`](src/tournament/rules-v1.ts); the reducer reads them from there.

## Design decisions

### Randomness

**The state carries no generator.** `advance` builds a fresh `StepRng` from `(seed, state.round)` on every call ([`src/tournament/advance.ts`](src/tournament/advance.ts)). A state is plain JSON with nothing hidden in it. Any state can be advanced without the ones before it, and replay needs no snapshot of generator internals. When the generator lives in the state, every extra draw shifts every later one. A UI that previews a roll by drawing from it, or a refactor that reorders two draws, is enough. The run then diverges from its saved inputs with no error.

**Named streams, seeded from a hash of the triple.** Each step has one generator per stream (`dice`, `house`), seeded from the first 16 bytes of SHA-256 over the canonical JSON of `[seed, step, stream]` ([`src/rng.ts`](src/rng.ts)). Rolling five dice instead of one does not move the house mood; a property test checks that on 200 random runs. Hashing a JSON array keeps the parts apart. A step can be a number or a label such as `"start"`, so a joined string key like `` `${seed}/${step}` `` would give seed `"a/1"` at step 0 and seed `"a"` at step `"1/0"` the same generator; a test pins that case. SHA-256 also removes the collisions of a 32-bit seed hash, where two different seeds can name the same game.

**Every step draws the house, the last one included.** The number of draws from a stream never depends on the input or on another stream's results, so adding a branch to one rule cannot shift the draws of another.

**Rejection sampling for integers.** `x % n` favours the low residues whenever 2^32 is not a multiple of n. `uniformInt` redraws any value at or above the largest multiple of n ([`src/rng.ts`](src/rng.ts)). For a die that rejects 4 values in 2^32. For n = 2^31 + 1 it rejects 2^31 - 1 values, and plain modulo would make the low residues twice as likely. Tests drive it with a scripted source to show the redraw, and a seeded chi-square on 60,000 rolls stays under the 0.1% critical value.

**xoshiro128** checked against the C reference.** The generator is Blackman and Vigna's 32-bit variant, written with `Math.imul` and unsigned shifts only ([`src/xoshiro.ts`](src/xoshiro.ts)). Its first eight outputs from two states equal those of the authors' C code, compiled and run for the test vectors.

### Arithmetic

**Integers, per-mille, one rounding.** Multipliers are per-mille (1000 is x1.0) and a formula with several factors goes through `applyPermille` or `mulDiv` once ([`src/fixed.ts`](src/fixed.ts)). The product is exact (BigInt) and the only rounding is the final division, with the mode named at the call (`floor`, `ceil`, `trunc`, `half-up`, `half-even`). Flooring after each factor loses up to one unit per step, always downward. A roll of 11 with a pair, a streak of one and a cold house scores 12 with one floor and 11 with three; the test keeps that case. The source this was ported from rounded twice in some of its formulas.

**Exact past 2^53.** A double cannot hold 2^53 + 1, so `Math.floor(3 * 107 * 28059810762433 / 3)` comes out one too low. `mulDiv` gets the right answer, and only the result has to be a safe integer. A property test compares `divRound` with an independent BigInt reference over the whole safe range for all five modes.

**A missing value throws.** `lookup(table, i, 'what')` throws a RangeError that names the table, and the purity test refuses `?? <number>` and `|| <number>` anywhere in `src/`. The source used a numeric fallback on a table lookup, so an index past the end silently took a value that looked like a rule.

### Runs and hashes

**Canonical JSON, then SHA-256.** `inputsHash` and `stateHash` hash the canonical JSON of the record or the state ([`src/canonical.ts`](src/canonical.ts)). Its keys are sorted by UTF-16 code unit as in RFC 8785, with no whitespace and ECMAScript number formatting. It throws, with the path, on `undefined`, `NaN`, holes, cycles and anything that is not a plain object, because `JSON.stringify` drops or rewrites those without a word. The source hashed `JSON.stringify` output with 32-bit FNV-1a. The same inputs then hashed differently when an object was built with its keys in another order, a file parsed from disk for example. With 32 bits, the birthday bound puts a 50% chance of some collision at about 77,000 runs.

**Strict input shapes.** `checkInput` accepts `{ kind: 'rest' }` and `{ kind: 'roll', dice }` and nothing else. An extra key would change the hash without changing the game, so two hashes would name one run.

**Seal and verify.** `sealRun` adds the inputs hash and the final state hash to a record; `verifyRun` parses an untrusted value, replays it and compares both ([`src/tournament/replay.ts`](src/tournament/replay.ts)). An edited input fails the first. A run that replays to a different state, under changed rules or on an engine that drifted, fails the second. A file with no hashes reports `null` for both, not `false` and not `true`.

**Rulesets are versioned data.** A state names its ruleset, `rulesFor` refuses an unknown one, and `rules-v1.ts` is deep-frozen. A rules change goes into a new file with a new version string. The six runs in [`test/golden/runs.json`](test/golden/runs.json) must keep replaying to their sealed hashes.

### Purity, checked

**The syntax tree, not lines of text.** [`test/purity.test.ts`](test/purity.test.ts) parses every file in `src/` with the TypeScript compiler. It allows `Math` only as a direct access to an integer-safe member (`floor`, `max`, `imul` and a few more), so `Math.random`, `Math.pow`, the float transcendentals, an alias such as `const M = Math` and a computed `Math['random']` all fail. It also fails on `**`, `Date`, `performance`, timers, `crypto`, `process`, DOM globals, `fetch`, `structuredClone`, `Intl` and the `toLocale*` and `localeCompare` methods, `import()`, `eval` and `Function`, any import that is not a relative path or that leaves `src/`, fallback numbers, `any`, `as unknown as` and `@ts-` directives. The source matched regular expressions against lines. That flagged `**` inside a string or a comment, and it missed a call split across two lines. The test also runs the scanner on 34 snippets it must catch and 8 it must leave alone.

**Batches are integers too.** `runBatch` reports min, max, nearest-rank percentiles, the mean times 100 rounded half to even, and a histogram. A float mean would be hashed with all its digits and printed rounded, so two reports could show the same figure under different hashes. With integers the hash covers exactly what is shown. The report is a function of its options, and `reportHash` makes that checkable. The 1,000-run reference batch below gave report hash `872e88eea3451bb8...` in Node 24 and in a Web Worker in headless Chromium.

## Batch figures

`node deterministic-sim/batch.ts --runs 10000 --dice <n>`, seeds `batch-0` to `batch-9999`, ruleset dice-1. The policy rolls n dice whenever the chips allow and rests otherwise; n = 3 is the reference policy.

| Policy | Score p10 | p50 | p90 | Mean | Max | Mean busts |
|---|---|---|---|---|---|---|
| roll-1 | 61 | 74 | 86 | 73.66 | 112 | 0.00 |
| roll-2 | 98 | 115 | 132 | 114.87 | 164 | 0.41 |
| roll-3 | 121 | 146 | 171 | 145.68 | 223 | 0.88 |
| roll-4 | 141 | 180 | 221 | 180.38 | 312 | 1.44 |
| roll-5 | 161 | 219 | 283 | 221.06 | 430 | 1.96 |

More dice raise the median and widen the spread. In this ruleset nothing makes a cautious policy pay. That is a balance finding about dice-1, not a claim about the best play. The report also has a chips-left line, which is the same in every run of a fixed-dice policy, since chips depend only on the inputs; it is there for policies that react to the dice.

## Keeping an AI coding agent off the rules

[`.claude/`](.claude/) holds a Claude Code configuration for working on this folder with an agent. It applies when the folder is opened as the project root.

- **[`hooks/guard-protected-paths.ts`](.claude/hooks/guard-protected-paths.ts)** (PreToolUse on Edit, Write, MultiEdit, NotebookEdit and Bash) blocks an edit to a published ruleset (`src/**/rules-v*.ts`), the golden runs, the purity test, `.claude/` itself, and any JSON file marked `"handwritten": true`. The patterns are in [`protected-paths.json`](.claude/protected-paths.json), which the guard also protects, so the agent cannot unprotect a file by editing the list. The override is the variable `DSIM_ALLOW_PROTECTED=1`, set by a person when starting the session. The source used a marker file in `.claude/`, which the agent could create with one shell command. A guard that cannot parse its input or its config, or gets input that is not a tool call, refuses the edit. Shell commands are matched by a heuristic. A write (the target of a redirect, or an argument of `sed -i`, `mv`, `cp`, `rm` and similar) whose path resolves to a protected file, relative or absolute, is refused, and so is `rm`, `mv` or `git checkout` on a folder that holds one. A command that only reads a protected file passes, and so does a redirect to another file. `2>&1` is not a write, so `npx vitest run src 2>&1 | tail` is not blocked. On macOS and Windows paths are compared without case. That stops mistakes; a determined command can still get through.
- **[`hooks/related-tests.ts`](.claude/hooks/related-tests.ts)** (PostToolUse) runs `vitest related` for an edited file under `src/` or `test/`. On a failure it exits 2 with the last 60 lines of output, which Claude Code shows to the agent. The source exited 0 either way, so the agent never saw a failing test until it ran the suite itself.
- **[`agents/core-reviewer.md`](.claude/agents/core-reviewer.md)** is a subagent with Read, Grep and Glob only. It reviews a change to `src/` against eight rules (streams, state, rounding, missing values, purity, versioning, hashing, tests) and ends with APPROVE, APPROVE WITH NITS or REQUEST CHANGES.

`test/hooks.test.ts` runs the guard as Claude Code runs it, JSON on stdin and the exit code checked, and tests both hooks' decisions as functions.

## What the tests cover

| File | Covers |
|---|---|
| `test/xoshiro.test.ts` | Outputs against the C reference for two states, the unsigned range, state round trip, the all-zero and out-of-range states refused |
| `test/rng.test.ts` | Rejection with a scripted source (n = 6, n just above 2^31), n = 1, chi-square on six faces, seed and step kept apart, stream independence, draw counts, range, chance and weighted pick |
| `test/sha256.test.ts` | FIPS 180-4 examples, node:crypto at every length from 0 to 200 bytes and on 300 random inputs, UTF-8 equal to TextEncoder on 500 strings with lone surrogates |
| `test/canonical.test.ts` | Sorted keys, code-unit order, key order independence and round trip as properties, a `__proto__` key kept as data, -0, every refusal with its path, cycles |
| `test/fixed.test.ts` | Each rounding mode, a property against a BigInt reference over the safe range, the 2^53 + 1 case, one floor against three, too many multipliers, `lookup` |
| `test/advance.test.ts` | Start, cost, the scoring formula against the logged factors, streak cap, bust, a cold house flooring to 0, rest cap, the end bonus, an unaffordable roll leaving the state as it was, ten malformed inputs, `canApply` agreeing with `advance` on them, combinations, a frozen ruleset |
| `test/replay.test.ts` | Replay and prefixes, the inputs hash under key reordering, the state hash over the log, record parsing, seal and verify with an edited input, a wrong state hash, no hashes, an illegal input |
| `test/properties.test.ts` | fast-check, 200 runs each: replay byte-identical, prefixes, no mutation of deep-frozen arguments, bounds after every step, score equal to the logged points, house independent of the dice |
| `test/batch.test.ts` | Integer summaries and percentiles, negative bins, a batch equal to itself by hash, counts, `summarize` equal to `runBatch`, spread by policy, run-count bounds |
| `test/golden.test.ts` | Six sealed runs, two of them full 20-round games, still replay to their hashes |
| `test/purity.test.ts` | Every file in `src/` against the rules above; 34 violations the scanner must catch and 8 clean snippets it must pass |
| `test/hooks.test.ts` | Glob matching, protected and unprotected paths, the handwritten marker in edits and in shell writes, the override, the Bash heuristic with absolute paths, `2>&1`, redirects elsewhere and folder removal, case folding, input that is not a tool call, the guard as a process, the related-tests command |

183 tests, offline, no key.

## Changes from the source

The source is a private game; only patterns came over. The domain, its names and its numbers are new.

- Seeds come from SHA-256 over canonical JSON of `[seed, step, stream]`, not 32-bit FNV-1a over a joined string.
- The run hash is SHA-256 over canonical JSON, not 32-bit FNV-1a over `JSON.stringify`.
- Multiplicative formulas round once; the source floored between factors in some of them.
- No fallback numbers. Missing entries throw, and the purity test enforces it.
- The purity test walks the syntax tree and forbids every non-relative import, instead of matching lines against a list of frameworks.
- The guard's override is an environment variable instead of a file, the guard protects its own config and refuses when its input cannot be read, and the test hook reports failures to the agent.

## Layout

```
src/
  xoshiro.ts         xoshiro128** generator
  rng.ts             stream seeding, rejection sampling, StepRng
  sha256.ts          synchronous SHA-256 and UTF-8
  canonical.ts       canonical JSON
  fixed.ts           divRound, mulDiv, applyPermille, clamp, lookup
  batch.ts           playOut, distribution, runBatch, reportHash
  tournament/
    types.ts         State, Input, LogEntry
    rules.ts         the Ruleset type, deepFreeze
    rules-v1.ts      ruleset dice-1 (protected)
    rulesets.ts      the registry by version
    advance.ts       start, advance, checkInput, canApply, comboOf, heatPermille
    replay.ts        replay, hashes, parse, seal, verify
    policy.ts        fixed-dice policies
  index.ts           public entry
batch.ts             the terminal batch runner
test/                Vitest suites, golden runs (protected)
.claude/             hooks, their config, the reviewer agent
```

## Limits

- **The hashes detect changes, not forgery.** Anyone can edit a run file and recompute both hashes. They show that a file was changed or that the rules moved under it. Trusting a reported score means replaying its inputs on a machine you control, which `verifyRun` does in one call; signing files would need a key this folder does not have.
- **Hashing costs time.** Each stream of each step runs one SHA-256, so a 21-step run computes 42. On this machine 10,000 runs took 4.8 seconds in Node 24 and 1,000 runs took 363 to 542 ms in a Chromium worker. A faster mixer would do for seeding; SHA-256 was kept so one primitive covers seeding and hashing.
- **One player, one ruleset.** There is no opponent, no hidden information and no dice-2 yet. The versioning path is tested only by refusing unknown versions.
- **Canonical JSON covers a subset.** No BigInt, no Date, no Map. That is enough for states and records, which are plain JSON by design.
- **The reference policy is a baseline, not a solver.** It ignores the house mood and the round number.
- **The hooks are guard rails.** The Bash check is a heuristic, and the hooks only run when Claude Code opens this folder as the project. In this repository CI runs the purity and golden tests on every push to `main` and every pull request either way.
