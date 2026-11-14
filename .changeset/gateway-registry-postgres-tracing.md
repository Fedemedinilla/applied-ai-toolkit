---
'@fedemedinilla/claude-gateway': minor
---

Adapt the gateway to a project through configuration. `createModelRegistry` adds models to the four built-in ones, each with its price, output limit and request surface stated and validated with zod. `createPostgresStores` runs the stores on Postgres over any client with `query(text, params)`, with the reservation made atomically by the new SQL function `reserve_usage`. An optional `observer` receives one span per call, and `otelObserver` maps it to OpenTelemetry with the GenAI attribute names. `UsageStore` gains an optional `reserve`, the in-memory store implements it, and the gateway types take the registry's model ids as a type parameter that defaults to the built-in ones.
