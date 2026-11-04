# Design decisions

Each decision lists the options that were on the table, what each one costs, and the one taken. A
later session reads this before reopening the question. The entry below is a fictional example of
the shape.

## D-7. Name of the app's API key variable

Context. The app calls the model with its own key. Agent sessions that work on the repository carry
the agent's key in `ANTHROPIC_API_KEY`, the name the SDK reads by default.

| Option | What it costs |
|---|---|
| A. The SDK's default name, `ANTHROPIC_API_KEY` | The agent's key and the app's key become one variable. Whichever is set wins, and a test or a local run can spend on the wrong account without an error. |
| B. A name of its own, `APP_ANTHROPIC_KEY`, passed to the client explicitly | One line in the env module, and the key has to be passed in every place the client is built. |

Taken: B. Enforced by `crossingNames` in the test environment helper, which fails when an app
variable falls under an isolated prefix.

Revisit if the app stops calling the model directly.
