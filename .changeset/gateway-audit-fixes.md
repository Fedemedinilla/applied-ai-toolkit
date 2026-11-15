---
'@fedemedinilla/claude-gateway': patch
---

Start the cap day at the first local instant of the date where the clocks skip midnight (Santiago, Havana), instead of 23:00 the day before.

Require an ISO 8601 date-time with an offset for a registry price's `validFrom`, so the memory store and Postgres agree on when it comes into force.

Say in `ReservationError` that the reservation may be in the ledger, open at its worst case, when an attempt reached the store before failing.

Reject a timeout above 2,147,483,647 ms at startup and per request. Node fires a longer `setTimeout` after 1 ms, which made every call time out.
