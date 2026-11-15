---
'@fedemedinilla/claude-gateway': patch
---

Start the cap day at the first local instant of the date where the clocks skip midnight (Santiago, Havana), instead of 23:00 the day before.

Require an ISO 8601 date-time with an offset for a registry price's `validFrom`, so the memory store and Postgres agree on when it comes into force.
