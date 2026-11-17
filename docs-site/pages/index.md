# Applied AI Toolkit

The Applied AI Toolkit is the open source toolbox behind the client work of [Federico Medinilla](https://federicomedinilla.com), a software developer in Buenos Aires who runs the studio [KyndredAI](https://kyndredai.com). Its parts put an LLM into an application under a spending cap and measure a prompt change on the real model before it ships. They also check what the model writes before a visitor sees it, and harden the sites and databases around it. Every folder has a README with its design decisions and tests that run offline with no API key, and nine small apps show the pieces working together.

Each page of this site is generated from a file in the [repository](https://github.com/Fedemedinilla/applied-ai-toolkit), and its "Edit page" link opens that file. New here? [Start here](start-here.md) has a two-minute path and a ten-minute path.

## Three tools to read first

### gateway

[gateway](../../gateway/README.md) is the only code in an application allowed to call the Claude API, and each call reserves its worst-case cost before it goes out. Its tests hold the spending caps through a failed ledger insert, a stream cut halfway and concurrent calls near a cap.

```sh
npm install @fedemedinilla/claude-gateway zod
```

The package is prepared but not yet published, as the [root README](../../README.md#packages) says. Until it is, run it from a clone of the repository:

```sh
npm ci
npm test -- gateway   # offline, no API key
```

### evals

[evals](../../evals/README.md) measures a prompt change on the real model before it ships, with a variant runner, blinding, a line-by-line judge, Wilson intervals and a red-team runner.

Measured result: on about 60 pieces per variant, whose briefs were built to provoke invention, the shipped variant invented a fact in 3% against 47% for the old prompt. The [case study](../../evals/CASE-STUDY.md) has the full record.

```sh
npx vitest run evals                  # offline, no API key
node evals/scripts/demo-offline.ts    # whole pipeline with scripted fake models
```

### slop-lint

[slop-lint](../../slop-lint/README.md) flags the patterns that make writing read as generated, in English and Spanish. It has 52 rules, each with its source, and every doc in this repository passes it in CI.

```sh
npm install @fedemedinilla/slop-lint
npx slop-lint letter.txt --lang en
```

This package is not yet published either ([root README](../../README.md#packages)). From a clone:

```sh
node slop-lint/cli.ts slop-lint/fixtures/cover-letters/en-before.txt --lang en
```

## The rest of the toolkit

The sidebar groups the other folders as the root README does: LLM in production, security, data and correctness, then testing, writing, automation and process. The apps come last. Four of them run in the browser as [live demos](https://fedemedinilla.github.io/applied-ai-toolkit/), with no account, and nothing typed in them leaves the device.

The code is under the [MIT license](../../LICENSE). To send a change, read [Contributing](../../CONTRIBUTING.md); to report a vulnerability, read [Security](../../SECURITY.md).
