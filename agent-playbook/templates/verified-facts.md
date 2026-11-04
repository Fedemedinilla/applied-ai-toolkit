# Verified facts

What the stack's APIs do, each fact checked in the installed package or the official documentation.
An agent asked to use an API that is not here verifies it first and adds an entry. When an entry and
the code disagree, the code wins and the entry is corrected.

## Anthropic SDK

### The client reads its base URL and log level from the environment even when given a key

- Fact. `new Anthropic({ apiKey })` still takes `baseURL` from `ANTHROPIC_BASE_URL` and `logLevel`
  from `ANTHROPIC_LOG`. A test that builds a client with a placeholder key inside an agent session
  would send its requests to the session's proxy.
- Checked in `@anthropic-ai/sdk` 1.1.0, the installed package, on 2026-11-04.
- Source. `agent-playbook/test/test-env.test.ts`, "the Anthropic SDK and the session environment",
  which builds the client with the variables set and again with them removed.
- Used by `src/test-env.ts`, which keeps the `ANTHROPIC_` prefix out of the test suite.
