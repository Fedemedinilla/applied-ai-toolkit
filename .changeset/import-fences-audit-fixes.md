---
'@fedemedinilla/import-fences': patch
---

Report lines the way git and editors count them: a U+2028 or U+2029 inside a string no longer shifts every later line, and a leading BOM no longer adds a column on line 1.
