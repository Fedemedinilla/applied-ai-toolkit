"""The report language: one catalog of strings per language, chosen with --lang.

``catalogs/es.json`` and ``catalogs/en.json`` hold every string render_report
prints that is not the text of a rule. Both have exactly the same keys, and
each key the same placeholders (tests/test_i18n.py), so a string added to one
language cannot be forgotten in the other.

What a catalog does NOT hold: the sentences the 37 rules write (what was
found, what can happen, what to do, who does it), the reasons of a grey check
and the rows of the speed and mail tables. Those are written in full in the
evaluators, in Spanish, and stored in run.json as they were printed. That is
why the two languages have different layouts (the ``layout`` key):

* ``sentences`` (es, the default): the report prints the stored sentences.
* ``rules`` (en): the report states each rule's result with the fixed name
  and description of the rule from the catalog (``check.<ID>.name`` and
  ``check.<ID>.about``), prints no sentence of a rule, and lists the stored
  numbers in the annex under their run.json names.

Spanish is the default because it is what the tool printed before --lang
existed: without the option, a report is byte for byte what it was.
"""

from __future__ import annotations

import datetime as dt
import json
from functools import lru_cache
from pathlib import Path
from string import Formatter

LANGS: tuple[str, ...] = ("es", "en")
DEFAULT_LANG = "es"
CATALOG_DIR = Path(__file__).resolve().parent / "catalogs"


class Catalog:
    """The strings of one language."""

    def __init__(self, lang: str, strings: dict[str, str]) -> None:
        self.lang = lang
        self.strings = strings

    def __getitem__(self, key: str) -> str:
        return self.strings[key]

    def t(self, key: str, **params: object) -> str:
        """The string of ``key`` with its placeholders filled."""
        return self.strings[key].format(**params)

    def n(self, key: str, n: int, **params: object) -> str:
        """The singular (``key.one``) or plural (``key.other``) string for ``n``, with {n} filled."""
        return self.t(f"{key}.{'one' if n == 1 else 'other'}", n=n, **params)

    def date(self, day: dt.date) -> str:
        return self.t("date", d=day.day, m=day.month, y=day.year)

    def join(self, items: list[str]) -> str:
        """'a', 'a and b', 'a, b and c' with the conjunction of the language."""
        items = [i for i in items if i]
        if len(items) <= 1:
            return "".join(items)
        return ", ".join(items[:-1]) + self.strings["list.and"] + items[-1]

    @property
    def by_rule(self) -> bool:
        """True when the report states each rule with its catalog text instead of the stored sentences."""
        return self.strings["layout"] == "rules"


def placeholders(text: str) -> set[str]:
    """The placeholder names of a catalog string."""
    return {name for _, name, _, _ in Formatter().parse(text) if name}


@lru_cache(maxsize=None)
def catalog(lang: str = DEFAULT_LANG) -> Catalog:
    """The catalog of ``lang``; ValueError for a language that has none."""
    if lang not in LANGS:
        raise ValueError(f"no report language {lang!r}; the report is written in: {', '.join(LANGS)}")
    data = json.loads((CATALOG_DIR / f"{lang}.json").read_text(encoding="utf-8"))
    return Catalog(lang, {str(k): str(v) for k, v in data.items()})


def normalize_lang(value: object) -> str:
    """``value`` when it names a report language, else the default (a run stored before --lang has none)."""
    return value if isinstance(value, str) and value in LANGS else DEFAULT_LANG
