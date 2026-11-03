"""Control of every text a reader of the report gets.

Applied to informe.md and anexo-tecnico.md before the run ends. Any issue makes
the run end with exit 4 (TEXT_CONTROL); the files stay, and the issues are
printed and stored in datos.json salida.control_texto. Rules:

* forbidden words (accent- and case-insensitive, whole words): FORBIDDEN_WORDS.
  "certificado" is out because a non-technical reader takes it for a legal
  document; "inseguro" and "pendiente" because they alarm without saying what
  to do;
* voseo forms: VOSEO_WORDS (curated list, case-insensitive but accent-SENSITIVE,
  whole words: "mirá" is voseo, "mira" is not; a generic "-ás/-és" rule would
  hit "más", "después", "inglés"). The report uses the formal "usted";
* dashes U+2014 and U+2013 anywhere;
* unfilled placeholders: PLACEHOLDER_RE ("{lcp_s}", "{institucion}");
* e-mail addresses (outputs.foreign_emails), except the run's institutional
  role addresses that VIS-21 names (``allowed_emails``: the organisation's own
  published contact);
* any secret (Redactor.contains_secret);
* U+FFFD replacement characters ("caracter-roto"): site text decoded with the
  wrong charset never reaches a reader;
* Markdown link syntax ``[texto](...)`` and HTML tags other than the report's own
  <details>/<summary> ("enlace-o-etiqueta"): text taken from the site can never
  turn into a link or a tracking pixel in whatever renders the report.

A forbidden word inside the organisation's own name or title (rare) also fails:
a person fixes it by hand, which is the safe outcome.

Excerpts never carry a secret (scrubbed by the Redactor) nor an e-mail address
(replaced by "[correo]"), because they are printed and stored in datos.json.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .outputs import EMAIL_MASK, EMAIL_RE, foreign_emails

if TYPE_CHECKING:
    from .credentials import Redactor

FORBIDDEN_WORDS: tuple[str, ...] = (
    "certificado",
    "certificados",
    "pendiente",
    "pendientes",
    "insecure",
    "inseguro",
    "insegura",
    "inseguros",
    "inseguras",
)
VOSEO_WORDS: tuple[str, ...] = (
    "vos",
    "sos",
    "tenés",
    "podés",
    "querés",
    "sabés",
    "hacés",
    "decís",
    "necesitás",
    "preferís",
    "tenes",
    "podes",
    "queres",
    "mirá",
    "fijate",
    "fijáte",
    "escribime",
    "avisame",
    "contame",
    "decime",
    "mandame",
    "llamame",
    "hacé",
    "andá",
    "vení",
    "entrá",
    "probá",
    "usá",
    "respondé",
    "escribí",
    "contestá",
    "mandá",
    "avisá",
    "decí",
    "pasá",
    "che",
)
DASHES: tuple[str, ...] = ("\u2014", "\u2013")
PLACEHOLDER_RE = re.compile(r"\{[a-z_][a-z0-9_]*\}")
REPLACEMENT_CHAR = "\ufffd"
# A Markdown link, or an HTML tag that is not one of the report's own folds.
LINK_OR_TAG_RE = re.compile(r"\[[^\]\n]*\]\([^)\n]*\)|<(?!/?(?:details|summary)>)/?[A-Za-z!][^>\n]*>")

EXCERPT_LEN = 60
_WORD_RE = re.compile(r"\w+")


@dataclass(frozen=True)
class LintIssue:
    file: str  # file name, not a full path
    line: int  # 1-based
    rule: str  # "palabra-prohibida", "voseo", "raya", "marcador", "correo", "clave"
    excerpt: str  # at most 60 chars around the hit, secrets redacted

    def to_datos(self) -> dict[str, object]:
        """JSON-ready form for datos.json salida.control_texto."""
        return {"archivo": self.file, "linea": self.line, "regla": self.rule, "extracto": self.excerpt}


def _fold(text: str) -> str:
    """Lowercase without accents (for the forbidden-word rule)."""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


_FORBIDDEN_FOLDED: frozenset[str] = frozenset(_fold(w) for w in FORBIDDEN_WORDS)
_VOSEO_SET: frozenset[str] = frozenset(unicodedata.normalize("NFC", w.lower()) for w in VOSEO_WORDS)


def _excerpt(line: str, start: int, end: int) -> str:
    """At most EXCERPT_LEN characters of ``line`` around [start, end)."""
    if len(line) <= EXCERPT_LEN:
        return line.strip()
    middle = (start + end) // 2
    lo = max(0, min(middle - EXCERPT_LEN // 2, len(line) - EXCERPT_LEN))
    return line[lo : lo + EXCERPT_LEN].strip()


def _mask_emails(text: str) -> str:
    return EMAIL_RE.sub(EMAIL_MASK, text)


def lint_text(
    text: str, *, name: str, redactor: "Redactor | None" = None, allowed_emails: frozenset[str] = frozenset()
) -> list[LintIssue]:
    """All issues of one client text, in line order (``allowed_emails``: outputs.allowed_email_forms)."""
    found: list[tuple[int, int, str, str]] = []  # (line, column, rule, excerpt)
    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        line = unicodedata.normalize("NFC", raw_line)
        safe = redactor.scrub(line) if redactor is not None else line
        safe = _mask_emails(safe)

        def add(rule: str, start: int, end: int) -> None:
            found.append((lineno, start, rule, _excerpt(safe, start, end)))

        for m in _WORD_RE.finditer(line):
            word = m.group(0)
            if _fold(word) in _FORBIDDEN_FOLDED:
                add("palabra-prohibida", m.start(), m.end())
            elif word.lower() in _VOSEO_SET:
                add("voseo", m.start(), m.end())
        for dash in DASHES:
            for m in re.finditer(re.escape(dash), line):
                add("raya", m.start(), m.end())
        for m in PLACEHOLDER_RE.finditer(line):
            add("marcador", m.start(), m.end())
        pos = line.find(REPLACEMENT_CHAR)
        if pos >= 0:
            add("caracter-roto", pos, pos + 1)
        for m in LINK_OR_TAG_RE.finditer(line):
            add("enlace-o-etiqueta", m.start(), m.end())
        foreign = set(foreign_emails(line, allowed_emails))
        for m in EMAIL_RE.finditer(line):
            if m.group(0) in foreign:
                add("correo", m.start(), m.end())
        if redactor is not None and redactor.contains_secret(line):
            pos = safe.find(redactor.REPLACEMENT)
            add("clave", max(pos, 0), max(pos, 0) + len(redactor.REPLACEMENT))
    found.sort(key=lambda item: (item[0], item[1]))
    return [LintIssue(file=name, line=ln, rule=rule, excerpt=exc) for ln, _, rule, exc in found]


def lint_files(
    paths: list[Path], *, redactor: "Redactor | None" = None, allowed_emails: frozenset[str] = frozenset()
) -> list[LintIssue]:
    """lint_text over files that exist (UTF-8)."""
    issues: list[LintIssue] = []
    for path in paths:
        path = Path(path)
        if not path.is_file():
            continue
        text = path.read_bytes().decode("utf-8", errors="replace")
        issues.extend(lint_text(text, name=path.name, redactor=redactor, allowed_emails=allowed_emails))
    return issues
