"""Evaluators: one function per check, Observations + EvalContext -> Finding.

Every evaluator is pure (no network, no clock other than ctx.run_date, no file
access), never raises for missing data (missing data is NO_VERIFICADO or
NO_APLICA with a Spanish reason), and fills: state, measured (raw numbers),
evidence (artifact names), reason/note, phrase_report and, for every number a
sentence prints, a trace entry to its measurement. Singular and plural are
written in full per variant, never assembled.

Modules: speed (EXT-08, 18, 19, 20, 21), seo (VIS-01..08, VIS-14),
linkcheck (VIS-09), a11y (VIS-10..13), contact (VIS-15, VIS-18, VIS-21),
content (VIS-16, VIS-17, VIS-19, EXT-24), legacy (VIS-20), security (EXT-01,
02, 07, 09, 13, 16, 17, 23, 25), mailauth (EXT-05), header (Resumen de Google, not a check),
tables (velocity and mail tables of the report), common (shared helpers).
"""
