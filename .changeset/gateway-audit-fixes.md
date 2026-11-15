---
'@fedemedinilla/claude-gateway': patch
---

Start the cap day at the first local instant of the date where the clocks skip midnight (Santiago, Havana), instead of 23:00 the day before.

Require an ISO 8601 date-time with an offset for a registry price's `validFrom`, so the memory store and Postgres agree on when it comes into force.

Say in `ReservationError` that the reservation may be in the ledger, open at its worst case, when an attempt reached the store before failing.

Reject a timeout above 2,147,483,647 ms at startup and per request. Node fires a longer `setTimeout` after 1 ms, which made every call time out.

End a span's `durationMs` before the observer's own price read, so tracing no longer adds that read to the measured call.

Refuse zero prices in `model_prices` (`> 0` checks, renamed `model_prices_*_positive`) and in `PriceRow`, and suggest only `SELECT` on `model_prices` for the application role. A zero row in force priced every call at nothing and switched the caps off. Existing databases need the new checks applied by a migration.

Leave unmeasured token attributes out of a cut call's span instead of reporting them as zero, and mark the span `incomplete: true`.
