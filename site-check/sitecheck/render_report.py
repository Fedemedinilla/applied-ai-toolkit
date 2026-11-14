"""report.md and technical-annex.md: the report in the reading order of the colours.

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
technical-annex.md (render_annex), so the report stays short for a non-technical
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
from .i18n import Catalog, catalog
from .model import COLOUR_ORDER, COLOUR_STYLES, PRIORITY_RANK, Colour, State

if TYPE_CHECKING:
    from .checks.header import GoogleSummary, ScoreCell
    from .checks.tables import MailAuthTable, VelocityTable
    from .model import Finding

# Every string of the report frame lives in catalogs/<lang>.json (i18n.py). The
# names below are the Spanish ones, kept for the code and the tests that read them.
_ES = catalog("es")
SIGNATURE = _ES["signature"]
DBL_ANSWERED = frozenset({"listed", "not-listed"})
UNSEEN_KEYS: tuple[str, ...] = ("unseen.users", "unseen.backups", "unseen.components", "unseen.files")
FIXED_UNSEEN: tuple[str, ...] = tuple(_ES[key] for key in UNSEEN_KEYS)

TRANSPARENCY_URL = "https://transparencyreport.google.com/safe-browsing/search?url={domain}"
SPAMHAUS_URL = "https://check.spamhaus.org/results?query={domain}"
SITE_QUERY = "site:{domain} viagra OR casino OR replica"
ICANN_LOOKUP = "https://lookup.icann.org/"

CATEGORY_KEYS: tuple[str, ...] = ("performance", "accessibility", "best-practices", "seo")

# First words that keep their capital letter when a sentence is lowercased.
PROPER_WORDS: frozenset[str] = frozenset(
    {"Google", "WordPress", "PageSpeed", "Spamhaus", "WhatsApp", "Chrome", "Mozilla", "Gmail", "Microsoft"}
)

STEP_COMPROMISED = _ES["step.compromised"]
STEP_FIX = _ES["step.fix"]
STEP_OPTIONAL = _ES["step.optional"]
STEP_KEEP = _ES["step.keep"]
STEP_REPEAT = _ES["step.repeat"]

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
    lang: str = "es"  # --lang: the catalog of the report (i18n.py)


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


def _name(f: "Finding", cat: Catalog) -> str:
    """The name of the check in the report language (the stored Spanish name when the catalog has none)."""
    return cat.strings.get(f"check.{f.id}.name") or f.name_plain


def _about(f: "Finding", cat: Catalog) -> str:
    return cat.strings.get(f"check.{f.id}.about", "")


def _label(colour: Colour, cat: Catalog) -> str:
    return cat[f"colour.{colour.value}.label"]


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


def five_lines(findings: list["Finding"], *, hack_gate: bool = False, cat: Catalog | None = None) -> list[str]:
    """The "En cinco líneas" lines per the rule above (2 to 5 lines).

    Line 5 takes its two actions in the next-step order: the
    first action is always the one of the finding that gives the next-step
    reason, so the report never recommends one thing first and justifies the
    next step with another. Lines 1 to 3 keep the report order.
    """
    cat = cat or _ES
    if cat.by_rule:
        # No sentence of a rule: the first two checks to act on, by name, in the next-step order.
        first = [_name(f, cat) for f in _failures_first(findings, hack_gate)][:2]
        if len(first) == 2:
            return [cat.t("rules.first_two", first=first[0], second=first[1])]
        return [cat.t("rules.first_one", first=first[0])] if first else []
    lines: list[str] = []
    top = _non_green(findings)[:3]
    lines.extend(_found(f) for f in top)
    greens = _greens(findings)
    if greens:
        lines.append(_found(greens[0]))
    actions = [strip_end(lower_first(_action(f))) for f in _failures_first(findings, hack_gate)]
    actions = [a for a in actions if a][:2]
    if len(actions) >= 2:
        lines.append(cat.t("five.first_two", first=actions[0], second=actions[1]))
    elif len(actions) == 1:
        lines.append(cat.t("five.first_one", first=actions[0]))
    return lines


def next_step(
    findings: list["Finding"], hack_gate: bool, *, kind: str = "institución", cat: Catalog | None = None
) -> tuple[str, str]:
    """(paso, razon) per the next-step map of the module docstring."""
    cat = cat or _ES

    def because(f: "Finding") -> str:
        if cat.by_rule:
            return cat.t("rules.reason.fail", name=_name(f, cat))
        return strip_end(lower_first(_found(f)))

    non_green = _non_green(findings)
    if hack_gate:
        # The hack signal first; the same order as line 5.
        ordered = _failures_first(findings, True)
        source = ordered[0] if ordered else None
        reason = because(source) if source else cat["reason.compromised"]
        return cat["step.compromised"], reason
    # The reason is a FALLA (red first, then yellow), never an observation. The
    # same order gives the first action of line 5 (_failures_first).
    failures = [f for f in _failures_first(findings, False) if f.state == State.FALLA and _colour_of(f) in (Colour.ROJO, Colour.AMARILLO)]
    if failures:
        return cat["step.fix"], because(failures[0])
    to_review = sum(1 for f in non_green if _colour_of(f) in (Colour.ROJO, Colour.AMARILLO))
    if to_review:
        return cat["step.fix"], cat.n("reason.review", to_review)
    if non_green:
        from .kinds import of as kind_of

        return (
            cat.t("step.optional", el=cat[f"kind.{kind_of(kind).key}.the"]),
            cat.n("reason.optional", len(non_green)),
        )
    if _greens(findings):
        return cat["step.keep"], cat["reason.keep"]
    return cat["step.repeat"], cat["reason.repeat"]


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------


def what_was_seen(findings: list["Finding"], cat: Catalog | None = None) -> str:
    """The "Qué se miró y qué no" paragraph, naming a blocklist only when it answered.

    Spamhaus answered when EXT-23 measured a verdict "listed" or "not-listed";
    otherwise (no answer, refused under WARP, not queried, shared domain) the
    clause is dropped: the grey fold already says what could not be seen.
    """
    # On a shared domain (Blogger, wixsite.com, a university subdomain) the
    # domain and mail checks are NO_APLICA, so the intro must not claim them.
    cat = cat or _ES
    domain_checks = [f for f in findings if f.id in ("EXT-05", "EXT-13")]
    if domain_checks and all(f.state == State.NO_APLICA for f in domain_checks):
        return cat["seen.shared"] + cat["seen.tail"]
    ext23 = next((f for f in findings if f.id == "EXT-23"), None)
    verdict = None
    if ext23 is not None and ext23.state != State.NO_APLICA and isinstance(ext23.measured, dict):
        verdict = ext23.measured.get("verdict")
    middle = cat["seen.listed"] if verdict in DBL_ANSWERED else cat["seen.no_list"]
    return cat["seen.head"] + middle + cat["seen.tail"]


def _score_text(c: "ScoreCell | None", cat: Catalog) -> str:
    if c is None or c.score is None:
        return cat["google.no_data"]
    # The band label is stored in Spanish with the score; the report by rule prints the shape and the score.
    label = f" ({c.label})" if c.label and not cat.by_rule else ""
    return f"{c.shape} {c.score}{label}".strip()


def _google_section(ctx: ReportContext, cat: Catalog) -> list[str]:
    s = ctx.google_summary
    out = [cat.t("google.heading", date=cat.date(ctx.run_date)), ""]
    sides = ((cat["google.mobile"], s.mobile or {}), (cat["google.desktop"], s.desktop or {}))
    any_score = any(c is not None and c.score is not None for _, side in sides for c in side.values())
    reasons: list[str] = []
    if any_score:
        out.append("| | " + " | ".join(cat[f"google.category.{key}"] for key in CATEGORY_KEYS) + " |")
        out.append("|---|" + "---|" * len(CATEGORY_KEYS))
        for side_name, side in sides:
            cells = []
            for key in CATEGORY_KEYS:
                c = side.get(key)
                cells.append(cell(_score_text(c, cat)))
                if c is not None and c.score is None and c.reason and c.reason not in reasons:
                    reasons.append(c.reason)
            out.append(f"| {side_name} | " + " | ".join(cells) + " |")
        out.append("")
        if cat.by_rule:
            reasons = [cat["google.default_reason"]] if reasons else []  # the stored reasons are Spanish
        for r in reasons:
            out.append(cat.t("google.not_measured", reason=strip_end(r)))
            out.append("")
    else:
        reason = s.reason or next((c.reason for _, side in sides for c in side.values() if c and c.reason), None)
        if cat.by_rule or not reason:
            reason = cat["google.default_reason"]
        out.append(cat.t("google.not_measured", reason=strip_end(reason)))
        out.append("")
    return out


def _counts_line(c: Counts, cat: Catalog) -> str:
    parts = [
        cat.t("counts.red", n=c.rojo),
        cat.t("counts.yellow", n=c.amarillo),
        cat.n("counts.blue", c.azul),
        cat.t("counts.green", n=c.verde),
        cat.n("counts.grey", c.gris),
    ]
    return cat.t("counts.line", head=cat.n("counts.applicable", c.aplicables), parts=" · ".join(parts))


def _row_found(f: "Finding") -> str:
    found = _found(f)
    note = (f.note or "").strip()
    if note and note not in found:
        found = f"{strip_end(found)} ({strip_end(note)})"
    return found


def _result(f: "Finding", cat: Catalog) -> str:
    key = f"rules.result.{f.state.value}"
    return cat.strings.get(key) or cat["rules.result.other"]


def _fix_section(findings: list["Finding"], counts: Counts, cat: Catalog) -> list[str]:
    groups = [(Colour.ROJO, counts.rojo), (Colour.AMARILLO, counts.amarillo), (Colour.AZUL, counts.azul)]
    if not any(n for _, n in groups):
        return []
    out = [cat["fix.heading"], "", cat["fix.intro"], ""]
    ordered = sort_for_report(findings)
    for colour, n in groups:
        if not n:
            continue
        style = COLOUR_STYLES[colour]
        out.append(f"### {style.shape} {_label(colour, cat)} ({n})")
        out.append("")
        out.append(cat["rules.columns"] if cat.by_rule else cat["fix.columns"])
        out.append("|---|---|---|" if cat.by_rule else "|---|---|---|---|")
        for f in ordered:
            if _colour_of(f) != colour:
                continue
            if cat.by_rule:
                out.append(f"| {f.id} · {cell(_name(f, cat))} | {cell(strip_end(_about(f, cat)))} | {_result(f, cat)} |")
                continue
            p = f.phrase_report
            # Table cells carry no final period, whatever the check wrote.
            out.append(
                f"| {cell(strip_end(_row_found(f)))} | {cell(strip_end(p.consequence) if p else '')} | "
                f"{cell(strip_end(p.action) if p else '')} | {cell(strip_end(p.who) if p else '')} |"
            )
        out.append("")
    return out


def _velocity_section(ctx: ReportContext, cat: Catalog) -> list[str]:
    v = ctx.velocity
    out = [cat["speed.heading"], ""]
    if cat.by_rule:
        return out + [cat["rules.tables_note"] if v.rows else cat.t("speed.none", date=cat.date(ctx.run_date)), ""]
    if v.intro:
        out += [v.intro.strip(), ""]
    if v.rows:
        out.append(cat.t("speed.columns", date=cat.date(ctx.run_date)))
        out.append("|---|---|---|")
        for r in v.rows:
            out.append(f"| {cell(r.what)} | {cell(r.value)} | {cell(r.meaning)} |")
        out.append("")
    else:
        out += [cat.t("speed.none", date=cat.date(ctx.run_date)), ""]
    if v.lab_note:
        out += [v.lab_note.strip(), ""]
    if v.attribution:
        out += [v.attribution.strip(), ""]
    return out


def _mail_auth_section(ctx: ReportContext, cat: Catalog) -> list[str]:
    m = ctx.mail_auth
    out = [cat["mail.heading"], ""]
    if cat.by_rule:
        return out + [cat["rules.tables_note"] if m.rows else cat.t("mail.none", date=cat.date(ctx.run_date)), ""]
    if m.rows:
        out.append(cat["mail.columns"])
        out.append("|---|---|---|")
        for r in m.rows:
            out.append(f"| {cell(r.what)} | {cell(r.value)} | {cell(r.meaning)} |")
        out.append("")
    if m.not_applicable_note:
        out += [m.not_applicable_note.strip(), ""]
    if not m.rows and not m.not_applicable_note:
        out += [cat.t("mail.none", date=cat.date(ctx.run_date)), ""]
    return out


def _green_section(findings: list["Finding"], counts: Counts, cat: Catalog) -> list[str]:
    out = [cat["green.heading"], ""]
    if not counts.verde:
        return out + [cat["green.zero"], ""]
    summary = cat.n("green.summary", counts.verde)
    columns = cat["rules.green_columns"] if cat.by_rule else cat["green.columns"]
    out += [f"<details><summary>{summary}</summary>", "", columns, "|---|---|"]
    for f in _greens(findings):
        if cat.by_rule:
            out.append(f"| {f.id} · {cell(_name(f, cat))} | {cell(strip_end(_about(f, cat)))} |")
            continue
        p = f.phrase_report
        out.append(f"| {cell(strip_end(_row_found(f)))} | {cell(strip_end(p.consequence) if p else '')} |")
    return out + ["", "</details>", ""]


def _grey_line(f: "Finding", cat: Catalog) -> str:
    if cat.by_rule:
        return cat.t("rules.grey_line", name=f"{f.id} · {_name(f, cat)}")
    text = ""
    if f.phrase_report and f.phrase_report.found.strip():
        text = f.phrase_report.found.strip()
    elif f.reason:
        text = f.reason.strip()
    else:
        text = cat["grey.default"]
    name = f.name_plain.strip()
    if name.endswith("?"):
        return f"{name} {end_with_period(text[0].upper() + text[1:])}"
    return f"{name}: {end_with_period(lower_first(text))}"


def _manual_checks(findings: list["Finding"], domain: str, cat: Catalog) -> list[str]:
    """The checks a person can make by hand, once each (annex only)."""
    by_id = {f.id: f for f in findings}
    lines: list[str] = []
    ext23 = by_id.get("EXT-23")
    if ext23 is not None and ext23.state not in (State.APROBADO, State.NO_APLICA):
        lines.append(cat.t("manual.google", url=TRANSPARENCY_URL.format(domain=domain)))
        verdict = (ext23.measured or {}).get("verdict") if isinstance(ext23.measured, dict) else None
        if verdict not in ("not-listed", "listed"):
            lines.append(cat.t("manual.spamhaus", url=SPAMHAUS_URL.format(domain=domain)))
    ext24 = by_id.get("EXT-24")
    if ext24 is not None and ext24.state == State.NO_VERIFICADO:
        lines.append(cat.t("manual.site_query", query=SITE_QUERY.format(domain=domain)))
    ext13 = by_id.get("EXT-13")
    if ext13 is not None and ext13.state == State.NO_VERIFICADO:
        where = "nic.ar" if domain.endswith(".ar") else ICANN_LOOKUP
        lines.append(cat.t("manual.domain", where=where))
    vis02 = by_id.get("VIS-02")
    robots_state = (vis02.measured or {}).get("robots_state") if vis02 is not None and isinstance(vis02.measured, dict) else None
    if vis02 is not None and vis02.state == State.NO_VERIFICADO and robots_state in ("4xx", "5xx", "soft-404", "invalid"):
        lines.append(cat["manual.sitemap"])
    return lines


def _grey_section(ctx: ReportContext, counts: Counts, cat: Catalog) -> list[str]:
    """The grey fold counts exactly its bullets; the fixed «never from outside» lines go apart, uncounted."""
    n = counts.gris
    out = [cat["grey.heading"], ""]
    if n:
        out += [f"<details><summary>{cat.n('grey.summary', n)}</summary>", ""]
        for f in sort_for_report(ctx.findings):
            if _colour_of(f) == Colour.GRIS:
                out.append(f"- {cell(_grey_line(f, cat))}")
        out += ["", "</details>", ""]
    else:
        out += [cat["grey.zero"], ""]
    out += [cat["unseen.heading"], ""]
    out += [f"- {cat[key]}" for key in UNSEEN_KEYS]
    out += ["", cat["unseen.closing"], ""]
    return out


def _how_section(ctx: ReportContext, cat: Catalog) -> list[str]:
    # The names of the tools and the conditions are stored as Spanish text: the report by rule leaves them to run.json.
    tools = "" if cat.by_rule else join_es(ctx.tools_used)
    tools_text = cat.t("how.tools", tools=tools) if tools else ("" if cat.by_rule else cat["how.no_tools"])
    window = cat.t("how.window", date=cat.date(ctx.run_date), start=hora(ctx.started_local), end=hora(ctx.finished_local))
    if ctx.conditions.strip() and not cat.by_rule:
        window += f"; {strip_end(ctx.conditions)}"
    if ctx.n_site_requests:
        load = cat.t(
            "how.load",
            requests=cat.n("how.request", ctx.n_site_requests),
            minutes=cat.n("how.minute", max(ctx.site_minutes, 1)),
        )
    else:
        load = cat["how.no_load"]
    return [
        cat["how.heading"],
        "",
        cat.t("how.paragraph", tools=tools_text, window=window, load=load).strip(),
        "",
    ]


def render_annex(ctx: ReportContext) -> str:
    """technical-annex.md: the header and the technical annex of the run."""
    cat = catalog(ctx.lang)
    out = [
        cat.t("annex.title", organisation=ctx.institution, domain=ctx.domain),
        "",
        cat.t("date_line", date=cat.date(ctx.run_date), to=ctx.para),
        "",
    ]
    out += _annex(list(ctx.findings), cat)
    if cat.by_rule:
        out += _measured_values(list(ctx.findings), cat)
    out += _broken_links(list(ctx.findings), cat)
    manual = _manual_checks(list(ctx.findings), ctx.domain, cat)
    if manual:
        out += [cat["manual.heading"], "", cat["manual.intro"], ""]
        out += [f"- {line}" for line in manual]
        out.append("")
    out += ["---", "", _signature(cat), ""]
    return "\n".join(out).rstrip("\n") + "\n"


def _signature(cat: Catalog | None = None) -> str:
    from . import __version__

    return (cat or _ES).t("signature", version=__version__)


def _measured_values(findings: list["Finding"], cat: Catalog) -> list[str]:
    """The report by rule: every number and yes/no a check stored, under its run.json name.

    Each printed value is ``checks[ID].measured.<name>`` of run.json as it is
    stored: the name is printed next to it, so the value needs no other trace.
    Text values are left out: they can carry text of the site or Spanish codes.
    """
    from .runformat import MEASURED_KEYS

    rows: list[str] = []
    for f in sorted(findings, key=lambda x: x.id):
        if not isinstance(f.measured, dict):
            continue
        for key in sorted(f.measured, key=lambda k: MEASURED_KEYS.get(k, k)):
            value = f.measured[key]
            if isinstance(value, bool):
                shown = cat["rules.measured.yes"] if value else cat["rules.measured.no"]
            elif isinstance(value, (int, float)):
                shown = str(value)
            else:
                continue
            rows.append(f"| {f.id} | {MEASURED_KEYS.get(key, key)} | {shown} |")
    if not rows:
        return []
    return [cat["rules.measured.heading"], "", cat["rules.measured.intro"], "", cat["rules.measured.columns"], "|---|---|---|", *rows, ""]


def _broken_links(findings: list["Finding"], cat: Catalog) -> list[str]:
    """The VIS-09 broken addresses (host plus path), when VIS-09 failed and measured them."""
    for f in findings:
        if f.id != "VIS-09" or f.state != State.FALLA or not isinstance(f.measured, dict):
            continue
        addresses = [str(a) for a in (f.measured.get("broken_addresses") or []) if a]
        if addresses:
            return [cat["broken.heading"], "", *[f"- {a}" for a in addresses], ""]
    return []


def _annex(findings: list["Finding"], cat: Catalog) -> list[str]:
    by_state: dict[State, int] = {}
    for f in findings:
        by_state[f.state] = by_state.get(f.state, 0) + 1
    n_ap = by_state.get(State.APROBADO, 0)
    n_aco = by_state.get(State.APROBADO_CON_OBSERVACION, 0)
    n_na = by_state.get(State.NO_APLICA, 0)
    aplicables = len(findings) - n_na
    out = [
        cat["annex.heading"],
        "",
        cat.t(
            "annex.counts", passed=n_ap + n_aco, applicable=aplicables, n_pass=n_ap, n_note=n_aco,
            n_fail=by_state.get(State.FALLA, 0), n_grey=by_state.get(State.NO_VERIFICADO, 0), n_na=n_na,
            total=len(findings),
        ),
        "",
        cat["annex.columns"],
        "|---|---|---|---|",
    ]
    for f in sorted(findings, key=lambda x: x.id):
        colour = _colour_of(f)
        if colour == Colour.OCULTO:
            shown = cat["annex.hidden"]
        else:
            style = COLOUR_STYLES[colour]
            shown = f"{style.shape} {_label(colour, cat)}"
            if f.colour_reason:
                shown += cat.t("annex.adjusted", reason=strip_end(f.colour_reason))
        evidence = ", ".join(f.evidence)
        if len(evidence) > 60:
            evidence = evidence[:57].rstrip(", ") + "..."
        state = cat[f"state.{f.state.value}"] if isinstance(f.state, State) else f.state
        out.append(f"| {f.id} | {state} | {cell(shown)} | {cell(evidence)} |")
    out.append("")
    return out


def render_report(ctx: ReportContext) -> str:
    """The whole report.md text (UTF-8, '\\n' newlines), ready for textlint."""
    cat = catalog(ctx.lang)
    findings = list(ctx.findings)
    counts = count_colours(findings)
    by_id = {f.id: f for f in findings}

    # Without --name the institution is the domain itself, so it is not repeated.
    if ctx.institution.strip().lower() == ctx.domain.lower():
        title = cat.t("title.bare", domain=ctx.domain)
    else:
        title = cat.t("title.named", organisation=ctx.institution, domain=ctx.domain)
    out = [
        title,
        "",
        cat.t("date_line", date=cat.date(ctx.run_date), to=ctx.para),
        "",
    ]
    if cat.by_rule:
        out += [cat["rules.note"], ""]
    out += _google_section(ctx, cat)

    seen = what_was_seen(findings, cat)
    ext08 = by_id.get("EXT-08")
    if ctx.psi_skipped:
        seen += cat["seen.psi_skipped"]
    elif ext08 is not None and ext08.state == State.NO_VERIFICADO:
        seen += cat.t("seen.psi_grey", date=cat.date(ctx.run_date))
    out += [cat["seen.heading"], "", seen, ""]

    out += [cat["five.heading"], "", _counts_line(counts, cat), ""]
    lines = five_lines(findings, hack_gate=ctx.hack_gate, cat=cat)
    # Every numbered line ends with one period, whatever the check wrote.
    out += [f"{i}. {end_with_period(line)}" for i, line in enumerate(lines, start=1)]
    if lines:
        out.append("")

    out += _fix_section(findings, counts, cat)
    out += _velocity_section(ctx, cat)
    out += _mail_auth_section(ctx, cat)
    out += _green_section(findings, counts, cat)
    out += _grey_section(ctx, counts, cat)

    step, reason = next_step(findings, ctx.hack_gate, kind=ctx.kind, cat=cat)
    out += [cat.t("next.line", step=step, reason=end_with_period(reason)), ""]

    out += _how_section(ctx, cat)
    out += ["---", "", _signature(cat), ""]
    return "\n".join(out).rstrip("\n") + "\n"
