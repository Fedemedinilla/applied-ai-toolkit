"""The kinds of organisation of --kind: a closed set, each with its phrases written in full.

Spanish nouns carry gender, so a template such as "del {tipo}" only agrees with
masculine nouns ("del empresa", "del escuela" are wrong). Every variant is
written in full, never assembled word by word: each kind carries its own
article forms and the people who use the site ("las familias" for schools, "los
clientes" for a company). VIS-17 (inscripciones) applies only to the
educational kinds.

A value outside the set is exit 2 in the CLI. --rerender on a datos.json with
another value falls back to the neutral "institución".
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class Kind:
    key: str  # the --kind value as stored in datos.json
    el: str  # "el colegio" / "la escuela"
    del_: str  # "del colegio" / "de la escuela"
    El: str  # "El colegio" / "La escuela" (start of a sentence)
    audience: str  # "las familias" / "los clientes" (third person plural)
    Audience: str  # "Las familias" / "Los clientes"
    elegir: str  # "al elegir colegio" / "al decidir una compra"
    educational: bool  # VIS-17 (inscripciones) applies


KINDS: dict[str, Kind] = {
    "colegio": Kind("colegio", "el colegio", "del colegio", "El colegio", "las familias", "Las familias", "al elegir colegio", True),
    "escuela": Kind("escuela", "la escuela", "de la escuela", "La escuela", "las familias", "Las familias", "al elegir escuela", True),
    "instituto": Kind("instituto", "el instituto", "del instituto", "El instituto", "las familias", "Las familias", "al elegir instituto", True),
    "jardín": Kind("jardín", "el jardín", "del jardín", "El jardín", "las familias", "Las familias", "al elegir jardín", True),
    "empresa": Kind("empresa", "la empresa", "de la empresa", "La empresa", "los clientes", "Los clientes", "al decidir una compra", False),
    "institución": Kind(
        "institución",
        "la institución",
        "de la institución",
        "La institución",
        "quienes visitan el sitio",
        "Quienes visitan el sitio",
        "al decidir acercarse",
        False,
    ),
}
DEFAULT_KIND = "institución"
FALLBACK_KIND = "institución"


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", (text or "").strip().lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


_BY_FOLDED: dict[str, str] = {_fold(k): k for k in KINDS}


def normalize_kind(value: str | None) -> str | None:
    """The key of KINDS for a --kind value (case and accents ignored), or None when it is not one."""
    if value is None:
        return None
    return _BY_FOLDED.get(_fold(value))


def of(value: str | None) -> Kind:
    """The Kind of ``value``; the default when empty, the neutral "institución" when unknown."""
    if not value:
        return KINDS[DEFAULT_KIND]
    key = normalize_kind(value)
    return KINDS[key] if key is not None else KINDS[FALLBACK_KIND]
