"""informe.md and anexo-tecnico.md: the report in the reading order of the colours.

Layout:

  **{institucion} · Estado del sitio {dominio}**  (without --name: **Estado del sitio {dominio}**)
  Fecha: {fecha_dmy} · Para: {para}
  Resumen de Google (table mobile/desktop, shapes and scores, missing reason)
  ## Qué se miró y qué no      (+ the EXT-08 NO_VERIFICADO sentence when it applies)
  ## En cinco líneas           (counts with denominator, lines 1-5 rule below)
  ## Lo que conviene arreglar  (▲ Arreglar ya, ■ Revisar, ◆ Mejora opcional;
                                an empty group is omitted entirely, and the
                                whole section when the three are empty)
  ## Velocidad                 (VelocityTable)
  ## Correo del dominio        (MailAuthTable)
  ## Lo que está bien          (<details> "● N cosas bien", folded)
  ## Lo que no se pudo ver desde afuera (<details> "○ N cosas que no se pudieron ver":
                                one "{nombre_llano}: {motivo}" bullet per grey, so N
                                is the number of bullets; then, unfolded and with
                                no count, the 4 fixed lines of what only access
                                to the site shows)
  **Próximo paso recomendado:** {paso}, porque {razon}.
  ## Cómo se midió             (tools that answered, date and local time window,
                                "Se hicieron N pedidos a su sitio en M minutos")

The technical annex (counts by state; ID | ESTADO verbatim | shape label |
evidence; the broken link addresses; the manual checks) is a file of its own,
anexo-tecnico.md (render_annex), so the report stays short for a non-technical
reader.

Every manual check (the Transparency Report and Spamhaus links, the site:
query, nic.ar or the ICANN lookup, the sitemap search) is written ONCE, in the
annex, under "## Comprobaciones a mano". The grey fold counts exactly its
bullets. Speed sentences carry the date, never "ese día".

Five lines rule: lines 1-3 are the «Qué se encontró» of the first three
non-green, non-grey findings ordered by colour (rojo, amarillo, azul), then
priority (Crítica > Alta > Media > Baja), then ID; line 4 is the «Qué» of the
highest-priority green; line 5 "Lo primero: {qué se hace 1}; después, {qué se
hace 2}." with the first letter of each action lowercased (unless the first word
is a name such as Google or WordPress, or an acronym). The two actions of line 5
follow the next-step order: hack signals (with the hack gate), red FALLA,
yellow FALLA, then the rest in report order, so the first action is the one of
the finding that gives the next-step reason. Missing lines are omitted, never
left blank.

"Qué se miró y qué no" names the Spamhaus list only when it answered; with no
list answered the clause is dropped. Singular and plural are written in full:
"● 1 cosa bien" / "● 8 cosas bien", "○ 1 cosa que no se pudo ver" / "○ 3 cosas
que no se pudieron ver".

Next step: hack gate -> STEP_COMPROMISED; any red or yellow FALLA ->
STEP_FIX; only blues -> STEP_OPTIONAL (kinds.py words); all green except
greys -> STEP_KEEP; nothing measured at all (every applicable check grey,
e.g. exit 3) -> STEP_REPEAT. The reason is the «Qué se encontró» of the first
red FALLA, else of the first yellow FALLA; an observation never gives the
reason. With no red or yellow FALLA the reason is neutral and counted: "hay 2
puntos para revisar", "hay 3 mejoras opcionales".
Denominator: aplicables = findings with state != NO_APLICA.
Markdown cells escape "|" and newlines in site-derived text.

Dates are formatted here with private helpers (d/m/aaaa and HH:MM in Buenos
Aires time), the same rules as fmt.fecha_dmy and fmt.hora, so rendering never
depends on the clock module.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .fmt import ART
from .model import COLOUR_ORDER, COLOUR_STYLES, PRIORITY_RANK, Colour, State

if TYPE_CHECKING:
    from .checks.header import GoogleSummary, ScoreCell
    from .checks.tables import MailAuthTable, VelocityTable
    from .model import Finding

# The footer of both files. No author line and no contact address: the report
# says how it was made.
SIGNATURE = "Informe generado con site-check {version}, sin inteligencia artificial: la misma medición da siempre este texto."

# "Qué se miró y qué no" names only the blocklist that answered: Google's list
# is never queried and Spamhaus can refuse queries from public resolvers, so a
# fixed "listas de sitios peligrosos" would contradict the grey fold.
WHAT_WAS_SEEN_HEAD = "Se revisó lo que cualquier persona puede ver desde afuera: cómo responde el sitio, cómo carga en un celular"
WHAT_WAS_SEEN_LISTED = ", cómo está configurado el dominio y el correo, y si el dominio figura en la lista de bloqueo de Spamhaus."
WHAT_WAS_SEEN_NO_LIST = " y cómo está configurado el dominio y el correo."
WHAT_WAS_SEEN_SHARED = "Se revisó lo que cualquier persona puede ver desde afuera: cómo responde el sitio y cómo carga en un celular."
WHAT_WAS_SEEN_TAIL = (
    " No se entró al panel ni al hosting, así que lo que pasa adentro (usuarios, copias de seguridad, componentes "
    "instalados) no está en este informe."
)
DBL_ANSWERED = frozenset({"listed", "not-listed"})
PSI_GREY_SENTENCE = " La medición de velocidad de Google no se pudo completar el {fecha} y se repite aparte."
PSI_SKIPPED_SENTENCE = " La medición de velocidad de Google no se hizo en esta corrida."

FIXED_UNSEEN: tuple[str, ...] = (
    "Usuarios y cuentas del panel.",
    "Copias de seguridad y si restauran.",
    "Componentes instalados y sus versiones.",
    "Archivos y base de datos.",
)
UNSEEN_HEADING = "### Lo que solo se ve con acceso al sitio"
UNSEEN_CLOSING = "Eso solo se revisa con acceso autorizado al sitio."
# VIS-09: the broken addresses live in the annex only (a path may carry a name).
BROKEN_LINKS_HEADING = "## Enlaces de la página principal que llevan a páginas que no existen"
MANUAL_HEADING = "## Comprobaciones a mano"
MANUAL_INTRO = "Lo que este chequeo no consulta y se puede mirar a mano:"

TRANSPARENCY_URL = "https://transparencyreport.google.com/safe-browsing/search?url={domain}"
SPAMHAUS_URL = "https://check.spamhaus.org/results?query={domain}"
SITE_QUERY = "site:{domain} viagra OR casino OR replica"
ICANN_LOOKUP = "https://lookup.icann.org/"

CATEGORY_COLUMNS: tuple[tuple[str, str], ...] = (
    ("performance", "Rendimiento"),
    ("accessibility", "Accesibilidad"),
    ("best-practices", "Buenas prácticas"),
    ("seo", "SEO"),
)

# First words that keep their capital letter when a sentence is lowercased.
PROPER_WORDS: frozenset[str] = frozenset(
    {"Google", "WordPress", "PageSpeed", "Spamhaus", "WhatsApp", "Chrome", "Mozilla", "Gmail", "Microsoft"}
)

STEP_COMPROMISED = "Revisar el sitio a fondo, con acceso autorizado, antes de cualquier otro cambio"
STEP_FIX = "Corregir primero lo marcado para arreglar ya y para revisar"
STEP_OPTIONAL = "Las mejoras opcionales, si {el} quiere mejorar cómo se ve y se encuentra"
STEP_KEEP = "Mantener el sitio como está y repetir este chequeo de vez en cuando"
STEP_REPEAT = "Repetir el chequeo"

_NUMBER_WORDS = {1: "una", 2: "dos", 3: "tres", 4: "cuatro", 5: "cinco"}


@dataclass
class Counts:
    rojo: int = 0
    amarillo: int = 0
    azul: int = 0
    verde: int = 0
    gris: int = 0
    no_aplica: int = 0

    @property
    def aplicables(self) -> int:
        return self.rojo + self.amarillo + self.azul + self.verde + self.gris

    def by_colour(self, colour: Colour) -> int:
        return int(getattr(self, colour.value, 0))


@dataclass
class ReportContext:
    institution: str  # --name, else the registrable domain
    domain: str
    run_date: dt.date
    para: str
    started_local: dt.datetime
    finished_local: dt.datetime
    findings: list["Finding"]
    google_summary: "GoogleSummary"
    velocity: "VelocityTable"
    mail_auth: "MailAuthTable"
    hack_gate: bool
    n_site_requests: int
    site_minutes: int
    tools_used: list[str] = field(default_factory=list)  # plain Spanish names of the tools that answered
    # Added by OUT (optional):
    kind: str = "institución"  # --kind, for the "only blues" next step
    conditions: str = ""  # measurement conditions after the time window ("celular, tres corridas...")
    psi_skipped: bool = False  # --no-pagespeed: the EXT-08 sentence says it was not run


# ---------------------------------------------------------------------------
# Small formatting helpers (shared with the pipeline)
# ---------------------------------------------------------------------------


def fecha_dmy(day: dt.date) -> str:
    """8/10/2026 (no leading zeros)."""
    return f"{day.day}/{day.month}/{day.year}"


def hora(moment: dt.datetime) -> str:
    """14:05 in ART (24 h, zero-padded minutes)."""
    local = moment.astimezone(ART) if moment.tzinfo else moment
    return f"{local.hour}:{local.minute:02d}"


def cell(text: object) -> str:
    """Escape a value for a Markdown table cell."""
    s = "" if text is None else str(text)
    s = s.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    return s.replace("|", "\\|").strip()


def lower_first(sentence: str) -> str:
    """Lowercase the first letter, unless the first word is a name or an acronym."""
    s = (sentence or "").strip()
    if not s:
        return s
    first = s.split(None, 1)[0].strip("¿¡\"'«(")
    if first in PROPER_WORDS:
        return s
    if len(first) > 1 and (first.isupper() or any(ch.isupper() for ch in first[1:])):
        return s  # DMARC, SPF, WordPress-like camel case
    return s[0].lower() + s[1:]


def strip_end(sentence: str) -> str:
    """Drop trailing spaces and a final period (to embed the sentence in another one)."""
    s = (sentence or "").strip()
    while s.endswith("."):
        s = s[:-1].rstrip()
    return s


def end_with_period(sentence: str) -> str:
    s = (sentence or "").strip()
    if not s:
        return s
    return s if s[-1] in ".!?…" else s + "."


def join_es(items: list[str]) -> str:
    """'a', 'a y b', 'a, b y c'."""
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " y " + items[-1]


def plural(n: int, singular: str, plural_form: str) -> str:
    return f"{n} {singular if n == 1 else plural_form}"


def number_word(n: int) -> str:
    return _NUMBER_WORDS.get(n, str(n))


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


def _colour_of(f: "Finding") -> Colour:
    if f.state == State.NO_APLICA or f.colour == Colour.OCULTO:
        return Colour.OCULTO
    if f.colour is None:
        return Colour.GRIS  # never coloured: shown as not verified, never as green
    return f.colour


def count_colours(findings: list["Finding"]) -> Counts:
    """Counts by final colour; NO_APLICA counted apart."""
    counts = Counts()
    for f in findings:
        colour = _colour_of(f)
        if colour == Colour.OCULTO:
            counts.no_aplica += 1
        else:
            setattr(counts, colour.value, getattr(counts, colour.value) + 1)
    return counts


def _sort_key(f: "Finding") -> tuple[int, int, str]:
    colour = _colour_of(f)
    colour_rank = COLOUR_ORDER.index(colour) if colour in COLOUR_ORDER else len(COLOUR_ORDER)
    return (colour_rank, PRIORITY_RANK.get(f.priority, len(PRIORITY_RANK)), f.id)


def sort_for_report(findings: list["Finding"]) -> list["Finding"]:
    """Colour order, then priority, then ID."""
    return sorted(findings, key=_sort_key)


def _found(f: "Finding") -> str:
    if f.phrase_report and f.phrase_report.found.strip():
        return f.phrase_report.found.strip()
    return f.name_plain


def _action(f: "Finding") -> str:
    return f.phrase_report.action.strip() if f.phrase_report else ""


def _non_green(findings: list["Finding"]) -> list["Finding"]:
    return [f for f in sort_for_report(findings) if _colour_of(f) in (Colour.ROJO, Colour.AMARILLO, Colour.AZUL)]


def _greens(findings: list["Finding"]) -> list["Finding"]:
    return [f for f in sort_for_report(findings) if _colour_of(f) == Colour.VERDE]


def _failures_first(findings: list["Finding"], hack_gate: bool) -> list["Finding"]:
    """Non-green findings in the order that decides the next step and line 5.

    With the hack gate, the hack signals first; then red FALLA, then yellow
    FALLA; then every other non-green finding in report order. Inside each group
    the report order (colour, priority, ID) is kept.
    """
    non_green = _non_green(findings)
    hack = [f for f in sort_for_report(findings) if f.hack_signal] if hack_gate else []
    red = [f for f in non_green if f.state == State.FALLA and _colour_of(f) == Colour.ROJO]
    yellow = [f for f in non_green if f.state == State.FALLA and _colour_of(f) == Colour.AMARILLO]
    ordered: list["Finding"] = []
    seen: set[int] = set()
    for f in [*hack, *red, *yellow, *non_green]:
        if id(f) not in seen:  # identity: two findings may compare equal field by field
            seen.add(id(f))
            ordered.append(f)
    return ordered


def five_lines(findings: list["Finding"], *, hack_gate: bool = False) -> list[str]:
    """The "En cinco líneas" lines per the rule above (2 to 5 lines).

    Line 5 takes its two actions in the next-step order: the
    first action is always the one of the finding that gives the next-step
    reason, so the report never recommends one thing first and justifies the
    next step with another. Lines 1 to 3 keep the report order.
    """
    lines: list[str] = []
    top = _non_green(findings)[:3]
    lines.extend(_found(f) for f in top)
    greens = _greens(findings)
    if greens:
        lines.append(_found(greens[0]))
    actions = [strip_end(lower_first(_action(f))) for f in _failures_first(findings, hack_gate)]
    actions = [a for a in actions if a][:2]
    if len(actions) >= 2:
        lines.append(f"Lo primero: {actions[0]}; después, {actions[1]}.")
    elif len(actions) == 1:
        lines.append(f"Lo primero: {actions[0]}.")
    return lines


def next_step(findings: list["Finding"], hack_gate: bool, *, kind: str = "institución") -> tuple[str, str]:
    """(paso, razon) per the next-step map of the module docstring."""
    non_green = _non_green(findings)
    if hack_gate:
        # The hack signal first; the same order as line 5.
        ordered = _failures_first(findings, True)
        source = ordered[0] if ordered else None
        reason = strip_end(lower_first(_found(source))) if source else "hay señales de que el sitio fue intervenido"
        return STEP_COMPROMISED, reason
    # The reason is a FALLA (red first, then yellow), never an observation. The
    # same order gives the first action of line 5 (_failures_first).
    failures = [f for f in _failures_first(findings, False) if f.state == State.FALLA and _colour_of(f) in (Colour.ROJO, Colour.AMARILLO)]
    if failures:
        return STEP_FIX, strip_end(lower_first(_found(failures[0])))
    to_review = sum(1 for f in non_green if _colour_of(f) in (Colour.ROJO, Colour.AMARILLO))
    if to_review:
        return STEP_FIX, f"hay {plural(to_review, 'punto para revisar', 'puntos para revisar')}"
    if non_green:
        from .kinds import of as kind_of

        return (
            STEP_OPTIONAL.format(el=kind_of(kind).el),
            f"hay {plural(len(non_green), 'mejora opcional', 'mejoras opcionales')}",
        )
    if _greens(findings):
        return STEP_KEEP, "todo lo que se pudo medir desde afuera está bien"
    return STEP_REPEAT, "no se pudo medir casi nada desde afuera en esta medición"


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------


def what_was_seen(findings: list["Finding"]) -> str:
    """The "Qué se miró y qué no" paragraph, naming a blocklist only when it answered.

    Spamhaus answered when EXT-23 measured a verdict "listed" or "not-listed";
    otherwise (no answer, refused under WARP, not queried, shared domain) the
    clause is dropped: the grey fold already says what could not be seen.
    """
    # On a shared domain (Blogger, wixsite.com, a university subdomain) the
    # domain and mail checks are NO_APLICA, so the intro must not claim them.
    domain_checks = [f for f in findings if f.id in ("EXT-05", "EXT-13")]
    if domain_checks and all(f.state == State.NO_APLICA for f in domain_checks):
        return WHAT_WAS_SEEN_SHARED + WHAT_WAS_SEEN_TAIL
    ext23 = next((f for f in findings if f.id == "EXT-23"), None)
    verdict = None
    if ext23 is not None and ext23.state != State.NO_APLICA and isinstance(ext23.measured, dict):
        verdict = ext23.measured.get("verdict")
    middle = WHAT_WAS_SEEN_LISTED if verdict in DBL_ANSWERED else WHAT_WAS_SEEN_NO_LIST
    return WHAT_WAS_SEEN_HEAD + middle + WHAT_WAS_SEEN_TAIL


def _score_text(c: "ScoreCell | None") -> str:
    if c is None or c.score is None:
        return "○ sin dato"
    label = f" ({c.label})" if c.label else ""
    return f"{c.shape} {c.score}{label}".strip()


def _google_section(ctx: ReportContext) -> list[str]:
    s = ctx.google_summary
    out = [f"**Resumen de Google** (PageSpeed, {fecha_dmy(ctx.run_date)}; puntaje de 0 a 100)", ""]
    sides = (("Celular", s.mobile or {}), ("Computadora", s.desktop or {}))
    any_score = any(c is not None and c.score is not None for _, side in sides for c in side.values())
    reasons: list[str] = []
    if any_score:
        out.append("| | " + " | ".join(name for _, name in CATEGORY_COLUMNS) + " |")
        out.append("|---|" + "---|" * len(CATEGORY_COLUMNS))
        for side_name, side in sides:
            cells = []
            for key, _ in CATEGORY_COLUMNS:
                c = side.get(key)
                cells.append(cell(_score_text(c)))
                if c is not None and c.score is None and c.reason and c.reason not in reasons:
                    reasons.append(c.reason)
            out.append(f"| {side_name} | " + " | ".join(cells) + " |")
        out.append("")
        for r in reasons:
            out.append(f"○ No se pudo medir: {strip_end(r)}.")
            out.append("")
    else:
        reason = s.reason or next((c.reason for _, side in sides for c in side.values() if c and c.reason), None)
        reason = reason or "la herramienta de velocidad de Google no dio resultados"
        out.append(f"○ No se pudo medir: {strip_end(reason)}.")
        out.append("")
    return out


def _counts_line(c: Counts) -> str:
    head = plural(c.aplicables, "chequeo aplicable", "chequeos aplicables")
    parts = [
        f"▲ {c.rojo} para arreglar ya",
        f"■ {c.amarillo} para revisar",
        f"◆ {plural(c.azul, 'mejora opcional', 'mejoras opcionales')}",
        f"● {c.verde} bien",
        f"○ {c.gris} {'que no se pudo ver' if c.gris == 1 else 'que no se pudieron ver'}",
    ]
    return f"**{head}:** " + " · ".join(parts) + "."


def _row_found(f: "Finding") -> str:
    found = _found(f)
    note = (f.note or "").strip()
    if note and note not in found:
        found = f"{strip_end(found)} ({strip_end(note)})"
    return found


def _fix_section(findings: list["Finding"], counts: Counts) -> list[str]:
    groups = [(Colour.ROJO, counts.rojo), (Colour.AMARILLO, counts.amarillo), (Colour.AZUL, counts.azul)]
    if not any(n for _, n in groups):
        return []
    out = ["## Lo que conviene arreglar", "", "Ordenado por lo que más riesgo trae si se deja como está.", ""]
    ordered = sort_for_report(findings)
    for colour, n in groups:
        if not n:
            continue
        style = COLOUR_STYLES[colour]
        out.append(f"### {style.shape} {style.label} ({n})")
        out.append("")
        out.append("| Qué se encontró | Qué puede pasar si queda así | Qué se hace | Quién |")
        out.append("|---|---|---|---|")
        for f in ordered:
            if _colour_of(f) != colour:
                continue
            p = f.phrase_report
            # Table cells carry no final period, whatever the check wrote.
            out.append(
                f"| {cell(strip_end(_row_found(f)))} | {cell(strip_end(p.consequence) if p else '')} | "
                f"{cell(strip_end(p.action) if p else '')} | {cell(strip_end(p.who) if p else '')} |"
            )
        out.append("")
    return out


def _velocity_section(ctx: ReportContext) -> list[str]:
    v = ctx.velocity
    out = ["## Velocidad", ""]
    if v.intro:
        out += [v.intro.strip(), ""]
    if v.rows:
        out.append(f"| Qué se midió | Antes · {fecha_dmy(ctx.run_date)} | Qué significa |")
        out.append("|---|---|---|")
        for r in v.rows:
            out.append(f"| {cell(r.what)} | {cell(r.value)} | {cell(r.meaning)} |")
        out.append("")
    else:
        out += [f"No se midió la velocidad el {fecha_dmy(ctx.run_date)}.", ""]
    if v.lab_note:
        out += [v.lab_note.strip(), ""]
    if v.attribution:
        out += [v.attribution.strip(), ""]
    return out


def _mail_auth_section(ctx: ReportContext) -> list[str]:
    m = ctx.mail_auth
    out = ["## Correo del dominio", ""]
    if m.rows:
        out.append("| Protección | Estado | Qué significa |")
        out.append("|---|---|---|")
        for r in m.rows:
            out.append(f"| {cell(r.what)} | {cell(r.value)} | {cell(r.meaning)} |")
        out.append("")
    if m.not_applicable_note:
        out += [m.not_applicable_note.strip(), ""]
    if not m.rows and not m.not_applicable_note:
        out += [f"No se pudo leer la configuración del correo del dominio el {fecha_dmy(ctx.run_date)}.", ""]
    return out


def _green_section(findings: list["Finding"], counts: Counts) -> list[str]:
    out = ["## Lo que está bien", ""]
    if not counts.verde:
        return out + ["● 0 cosas bien en esta medición.", ""]
    summary = "● 1 cosa bien" if counts.verde == 1 else f"● {counts.verde} cosas bien"
    out += [f"<details><summary>{summary}</summary>", "", "| Qué | Por qué importa |", "|---|---|"]
    for f in _greens(findings):
        p = f.phrase_report
        out.append(f"| {cell(strip_end(_row_found(f)))} | {cell(strip_end(p.consequence) if p else '')} |")
    return out + ["", "</details>", ""]


def _grey_line(f: "Finding") -> str:
    text = ""
    if f.phrase_report and f.phrase_report.found.strip():
        text = f.phrase_report.found.strip()
    elif f.reason:
        text = f.reason.strip()
    else:
        text = "no se pudo medir"
    name = f.name_plain.strip()
    if name.endswith("?"):
        return f"{name} {end_with_period(text[0].upper() + text[1:])}"
    return f"{name}: {end_with_period(lower_first(text))}"


def _manual_checks(findings: list["Finding"], domain: str) -> list[str]:
    """The checks a person can make by hand, once each (annex only)."""
    by_id = {f.id: f for f in findings}
    lines: list[str] = []
    ext23 = by_id.get("EXT-23")
    if ext23 is not None and ext23.state not in (State.APROBADO, State.NO_APLICA):
        lines.append(f"Lista de sitios peligrosos de Google: {TRANSPARENCY_URL.format(domain=domain)}")
        verdict = (ext23.measured or {}).get("verdict") if isinstance(ext23.measured, dict) else None
        if verdict not in ("not-listed", "listed"):
            lines.append(f"Lista de bloqueo de Spamhaus: {SPAMHAUS_URL.format(domain=domain)}")
    ext24 = by_id.get("EXT-24")
    if ext24 is not None and ext24.state == State.NO_VERIFICADO:
        lines.append(f"Páginas ajenas en Google: buscar «{SITE_QUERY.format(domain=domain)}».")
    ext13 = by_id.get("EXT-13")
    if ext13 is not None and ext13.state == State.NO_VERIFICADO:
        where = "nic.ar" if domain.endswith(".ar") else ICANN_LOOKUP
        lines.append(f"Vencimiento del dominio: {where}")
    vis02 = by_id.get("VIS-02")
    robots_state = (vis02.measured or {}).get("robots_state") if vis02 is not None and isinstance(vis02.measured, dict) else None
    if vis02 is not None and vis02.state == State.NO_VERIFICADO and robots_state in ("4xx", "5xx", "soft-404", "invalid"):
        lines.append("Mapa del sitio: robots.txt no se pudo usar y la herramienta no lo buscó en otras direcciones; se busca a mano.")
    return lines


def _grey_section(ctx: ReportContext, counts: Counts) -> list[str]:
    """The grey fold counts exactly its bullets; the fixed «never from outside» lines go apart, uncounted."""
    n = counts.gris
    out = ["## Lo que no se pudo ver desde afuera", ""]
    if n:
        summary = "○ 1 cosa que no se pudo ver" if n == 1 else f"○ {n} cosas que no se pudieron ver"
        out += [f"<details><summary>{summary}</summary>", ""]
        for f in sort_for_report(ctx.findings):
            if _colour_of(f) == Colour.GRIS:
                out.append(f"- {cell(_grey_line(f))}")
        out += ["", "</details>", ""]
    else:
        out += ["○ 0 cosas que no se pudieron ver en esta medición.", ""]
    out += [UNSEEN_HEADING, ""]
    out += [f"- {line}" for line in FIXED_UNSEEN]
    out += ["", UNSEEN_CLOSING, ""]
    return out


def _how_section(ctx: ReportContext) -> list[str]:
    tools = join_es(ctx.tools_used)
    tools_text = f"Herramientas: {tools}." if tools else "Herramientas: ninguna respondió."
    window = (
        f"Condiciones: {fecha_dmy(ctx.run_date)}, de {hora(ctx.started_local)} a {hora(ctx.finished_local)}, "
        "desde Buenos Aires"
    )
    if ctx.conditions.strip():
        window += f"; {strip_end(ctx.conditions)}"
    requests = plural(ctx.n_site_requests, "pedido", "pedidos")
    minutes = plural(max(ctx.site_minutes, 1), "minuto", "minutos")
    if ctx.n_site_requests:
        load = f" Se hicieron {requests} a su sitio en {minutes}, de a uno por vez y con pausas."
    else:
        load = " No se hizo ningún pedido a su sitio."
    return [
        "## Cómo se midió",
        "",
        f"{tools_text} {window}.{load} Las mediciones y las salidas completas quedan a disposición, "
        "y el anexo técnico con el estado de cada chequeo va aparte.",
        "",
    ]


def render_annex(ctx: ReportContext) -> str:
    """anexo-tecnico.md: the header and the technical annex of the run."""
    out = [
        f"**{ctx.institution} · Anexo técnico del estado del sitio {ctx.domain}**",
        "",
        f"Fecha: {fecha_dmy(ctx.run_date)} · Para: {ctx.para}",
        "",
    ]
    out += _annex(list(ctx.findings))
    out += _broken_links(list(ctx.findings))
    manual = _manual_checks(list(ctx.findings), ctx.domain)
    if manual:
        out += [MANUAL_HEADING, "", MANUAL_INTRO, ""]
        out += [f"- {line}" for line in manual]
        out.append("")
    out += ["---", "", _signature(), ""]
    return "\n".join(out).rstrip("\n") + "\n"


def _signature() -> str:
    from . import __version__

    return SIGNATURE.format(version=__version__)


def _broken_links(findings: list["Finding"]) -> list[str]:
    """The VIS-09 broken addresses (host plus path), when VIS-09 failed and measured them."""
    for f in findings:
        if f.id != "VIS-09" or f.state != State.FALLA or not isinstance(f.measured, dict):
            continue
        addresses = [str(a) for a in (f.measured.get("broken_addresses") or []) if a]
        if addresses:
            return [BROKEN_LINKS_HEADING, "", *[f"- {a}" for a in addresses], ""]
    return []


def _annex(findings: list["Finding"]) -> list[str]:
    by_state: dict[State, int] = {}
    for f in findings:
        by_state[f.state] = by_state.get(f.state, 0) + 1
    n_ap = by_state.get(State.APROBADO, 0)
    n_aco = by_state.get(State.APROBADO_CON_OBSERVACION, 0)
    n_na = by_state.get(State.NO_APLICA, 0)
    aplicables = len(findings) - n_na
    out = [
        "## Anexo técnico",
        "",
        f"Chequeos aprobados sobre aplicables: {n_ap + n_aco} de {aplicables} ({n_ap} APROBADO, "
        f"{n_aco} APROBADO_CON_OBSERVACION). FALLA: {by_state.get(State.FALLA, 0)}. "
        f"NO_VERIFICADO: {by_state.get(State.NO_VERIFICADO, 0)}. NO_APLICA: {n_na}. Total: {len(findings)}.",
        "",
        "| ID | Estado | Color | Evidencia (recortada) |",
        "|---|---|---|---|",
    ]
    for f in sorted(findings, key=lambda x: x.id):
        colour = _colour_of(f)
        if colour == Colour.OCULTO:
            shown = "no se muestra"
        else:
            style = COLOUR_STYLES[colour]
            shown = f"{style.shape} {style.label}"
            if f.colour_reason:
                shown += f" (color ajustado: {strip_end(f.colour_reason)})"
        evidence = ", ".join(f.evidence)
        if len(evidence) > 60:
            evidence = evidence[:57].rstrip(", ") + "..."
        out.append(f"| {f.id} | {f.state.value if isinstance(f.state, State) else f.state} | {cell(shown)} | {cell(evidence)} |")
    out.append("")
    return out


def render_report(ctx: ReportContext) -> str:
    """The whole informe.md text (UTF-8, '\\n' newlines), ready for textlint."""
    findings = list(ctx.findings)
    counts = count_colours(findings)
    by_id = {f.id: f for f in findings}

    # Without --name the institution is the domain itself, so it is not repeated.
    if ctx.institution.strip().lower() == ctx.domain.lower():
        title = f"**Estado del sitio {ctx.domain}**"
    else:
        title = f"**{ctx.institution} · Estado del sitio {ctx.domain}**"
    out = [
        title,
        "",
        f"Fecha: {fecha_dmy(ctx.run_date)} · Para: {ctx.para}",
        "",
    ]
    out += _google_section(ctx)

    seen = what_was_seen(findings)
    ext08 = by_id.get("EXT-08")
    if ctx.psi_skipped:
        seen += PSI_SKIPPED_SENTENCE
    elif ext08 is not None and ext08.state == State.NO_VERIFICADO:
        seen += PSI_GREY_SENTENCE.format(fecha=fecha_dmy(ctx.run_date))
    out += ["## Qué se miró y qué no", "", seen, ""]

    out += ["## En cinco líneas", "", _counts_line(counts), ""]
    lines = five_lines(findings, hack_gate=ctx.hack_gate)
    # Every numbered line ends with one period, whatever the check wrote.
    out += [f"{i}. {end_with_period(line)}" for i, line in enumerate(lines, start=1)]
    if lines:
        out.append("")

    out += _fix_section(findings, counts)
    out += _velocity_section(ctx)
    out += _mail_auth_section(ctx)
    out += _green_section(findings, counts)
    out += _grey_section(ctx, counts)

    step, reason = next_step(findings, ctx.hack_gate, kind=ctx.kind)
    out += [f"**Próximo paso recomendado:** {step}, porque {end_with_period(reason)}", ""]

    out += _how_section(ctx)
    out += ["---", "", _signature(), ""]
    return "\n".join(out).rstrip("\n") + "\n"
