---
"@fedemedinilla/claude-gateway": minor
"@fedemedinilla/import-fences": minor
---

Export every interface a public function returns or takes, so a project that emits declarations can name the type of a value it infers from the package. The gateway adds `StructuredFormat`, `Validation`, `CapCheck`, `Unpriced`, `UnpricedWindow`, `AttemptKind`, `Cost`, `ApiFailure`, `FailedResponse`, `ContentBlock`, `LogData` and `LogValue`; import-fences adds `Located` and `SarifRegion`. Before, such a project stopped with TS2742 (TS2883 in TypeScript 6).
