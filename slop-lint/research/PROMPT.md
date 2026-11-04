# Research brief

The slop-lint rules come from a deep-research report that Federico Medinilla commissioned in October 2026 and then curated. The report covers cover-letter writing and the style of generated text in Spanish and English. This note replaces the original brief, which is not reproduced here.

## What the report covers

- A taxonomy of the signs of generated text in Spanish and English, by layer (lexicon, sentence structure, rhetoric, format, content), with evidence of how each sign changed across model generations.
- The craft side: clarity, concision, information order, rhythm and register, drawn from normative and style sources in both languages (RAE and ASALE, Williams, Pinker, plain-language standards).
- Grammar and typography errors a careful writer fixes on sight, each with how to detect it, its regex if one exists, known false positives and the normative source.
- What recruiters say about cover letters, with marketing surveys labeled as such.
- Measurement: readability formulas, sentence-length variation, lexical diversity, and the documented bias of AI detectors against second-language writers.
- Evidence standards: every claim dated and tagged as measured, normative, reported, consensus or the researcher's own synthesis.

## Where the rules live

The report itself is not in this repository. [`src/rules.ts`](../src/rules.ts) keeps only the rules this linter implements, each with the report's id, evidence tag and source, and a `deviation` field where the rule departs from the report.
