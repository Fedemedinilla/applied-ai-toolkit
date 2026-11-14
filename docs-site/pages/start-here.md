# Start here

Two reading paths from the [root README](../../README.md#where-to-start), and the commands to run the code yourself.

## Two minutes

1. Open the [Caja live demo](https://fedemedinilla.github.io/applied-ai-toolkit/caja/) and type "vendí 5 tortas a 8000". It is an offline cash book, and it asks a question when the amount has two readings.
2. Read the [evals case study](../../evals/CASE-STUDY.md): one prompt change measured on the real model before it shipped.

## Ten minutes

1. Read [gateway](../../gateway/README.md), the only code here allowed to call the Claude API.
2. Read [chat-widget](../../apps/chat-widget/README.md), a multi-tenant chat backend that calls it. Its server code is in [server/widget-api.ts](../../apps/chat-widget/server/widget-api.ts).

## Run it

The repository needs Node 24. It runs the TypeScript sources directly, so there is no build step. From a clone:

```sh
npm ci                        # exact versions from package-lock.json
npm test                      # Vitest suites of every TypeScript folder, offline, no API key
npx vitest run gateway        # one folder at a time
```

[Contributing](../../CONTRIBUTING.md#run-everything) lists the other commands, among them the Python and PHP suites, the app builds and the docs lint.
