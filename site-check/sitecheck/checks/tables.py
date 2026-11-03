"""The two fixed tables of the report: "Velocidad" and "Correo del dominio".

Velocity rows: LCP, INP, CLS
from EXT-08; TTFB with the control from EXT-20; weight from EXT-21. A cell with
no data says "No se midió: {motivo}", never empty, never an estimate.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..model import Finding


@dataclass
class TableRow:
    what: str  # «Qué se midió» / «Protección»
    value: str  # «Antes · fecha» / «Estado»
    meaning: str  # «Qué significa»


@dataclass
class VelocityTable:
    intro: str  # "Medida en un celular, tres veces, con el valor del medio." or the n-runs variant
    rows: list[TableRow] = field(default_factory=list)
    lab_note: str | None = None  # "El sitio no tiene todavía suficiente tráfico medido por Google; ..."
    attribution: str | None = None  # "Datos de usuarios reales: Chrome UX Report (Google), CC BY 4.0"


@dataclass
class MailAuthTable:
    rows: list[TableRow] = field(default_factory=list)
    not_applicable_note: str | None = None  # "El dominio no recibe correo propio; esta parte no aplica."


LAB_NOTE = "El sitio no tiene todavía suficiente tráfico medido por Google; los valores son de una prueba de laboratorio."
ATTRIBUTION = "Datos de usuarios reales: Chrome UX Report (Google), CC BY 4.0"
NOT_APPLICABLE_NOTE = "El dominio no recibe correo propio; esta parte no aplica."
REASON_NOT_MEASURED = "la medición no se completó"
PAGE_WEIGHT_LIMIT_BYTES = 1_638_400  # the same 1,600 KiB as speed.PAGE_WEIGHT_GOOD_BYTES


def _missing(finding: "Finding | None", fallback: str = REASON_NOT_MEASURED) -> str:
    reason = finding.reason if finding is not None and finding.reason else fallback
    return f"No se midió: {reason}"


def _usable(finding: "Finding | None") -> bool:
    """A finding whose numbers can be shown (measured and not grey)."""
    from ..model import State

    return finding is not None and finding.state not in (State.NO_VERIFICADO, State.NO_APLICA)


# "{dia}" is "el 9/10/2026", or "en esta medición" without a date.
INTRO_FIELD_PAGE = (
    "Las tres primeras filas son de quienes visitaron la página principal desde un celular en los últimos "
    "28 días, según Google; las otras dos se midieron {dia}."
)
INTRO_FIELD_ORIGIN = (
    "Las tres primeras filas son de quienes visitaron el sitio desde un celular en los últimos 28 días, según "
    "Google (no tiene datos de la página principal sola); las otras dos se midieron {dia}."
)


def day_text(run_date: dt.date | None) -> str:
    """'el 9/10/2026', or 'en esta medición' when the date is not known."""
    return f"el {run_date.day}/{run_date.month}/{run_date.year}" if run_date is not None else "en esta medición"


def _intro(ext08: "Finding | None", run_date: dt.date | None = None) -> str:
    # Real-user values are Google's 28-day figures, not the median of the three
    # runs: the intro says where the numbers come from.
    scope = ext08.measured.get("scope") if _usable(ext08) else None
    if scope == "pagina":
        return INTRO_FIELD_PAGE.format(dia=day_text(run_date))
    if scope == "origen":
        return INTRO_FIELD_ORIGIN.format(dia=day_text(run_date))
    valid = (ext08.measured.get("valid_runs") if ext08 is not None else None) or 0
    if valid == 3:
        return "Medida en un celular, tres veces, con el valor del medio."
    if valid == 2:
        return "Medida en un celular dos veces con la herramienta de Google."
    if valid == 1:
        return "Medida en un celular una vez con la herramienta de Google."
    if valid > 3:
        return f"Medida en un celular {valid} veces, con el valor del medio."
    return f"La medición de velocidad de Google no se pudo completar {day_text(run_date)}."


def build_velocity_table(findings: dict[str, "Finding"], run_date: dt.date | None = None) -> VelocityTable:
    """Build the velocity table from EXT-08, EXT-20 and EXT-21 measured values (keys in their docstrings).

    ``run_date`` puts the date in the intro instead of "ese día". Times
    use common.seconds_phrase: one decimal, two near a threshold, and
    "menos de una décima de segundo" instead of "0,0 segundos".
    """
    from .common import cls_vs_threshold, seconds_phrase, weight_vs_threshold

    ext08, ext20, ext21 = findings.get("EXT-08"), findings.get("EXT-20"), findings.get("EXT-21")
    table = VelocityTable(intro=_intro(ext08, run_date))
    m08 = ext08.measured if ext08 is not None else {}
    ok08 = _usable(ext08)
    scope = m08.get("scope") if ok08 else None

    lcp = m08.get("lcp_ms") if ok08 else None
    table.rows.append(
        TableRow(
            "Cuánto tarda en aparecer lo principal de la página",
            seconds_phrase(lcp, 2500) if lcp is not None else _missing(ext08),
            "Google considera bien hasta 2,5 segundos",
        )
    )
    inp = m08.get("inp_ms") if ok08 else None
    if inp is not None:
        inp_value = seconds_phrase(inp, 200)
    elif ok08 and scope == "laboratorio":
        inp_value = "No se midió: la prueba de laboratorio no mide la respuesta al tocar"
    elif ok08:
        inp_value = "No se midió: Google no tiene datos de interacción de este sitio"
    else:
        inp_value = _missing(ext08)
    table.rows.append(TableRow("Cuánto tarda en responder cuando se toca algo", inp_value, "Bien hasta 0,2 segundos"))
    cls = m08.get("cls") if ok08 else None
    table.rows.append(
        TableRow(
            "Cuánto se mueve la página mientras carga",
            cls_vs_threshold(cls) if cls is not None else _missing(ext08),
            "Bien hasta 0,1",
        )
    )

    m20 = ext20.measured if ext20 is not None else {}
    ttfb = m20.get("ttfb_ms_median") if _usable(ext20) else None
    control = m20.get("control_ms_median")
    if ttfb is not None and control is not None:
        meaning = f"Bien hasta 0,8 segundos; un sitio de control medido en el mismo momento dio {seconds_phrase(control, 800)}"
    else:
        meaning = "Bien hasta 0,8 segundos"
    table.rows.append(
        TableRow(
            "Cuánto tarda el servidor en empezar a responder",
            seconds_phrase(ttfb, 800) if ttfb is not None else _missing(ext20),
            meaning,
        )
    )
    m21 = ext21.measured if ext21 is not None else {}
    total = m21.get("total_bytes") if _usable(ext21) else None
    if total is not None:
        weight, limit, _ = weight_vs_threshold(int(total), PAGE_WEIGHT_LIMIT_BYTES)
        table.rows.append(TableRow("Cuánto pesa la página principal", weight, f"Google aconseja no pasar de {limit}"))
    else:
        table.rows.append(TableRow("Cuánto pesa la página principal", _missing(ext21), "Google aconseja no pasar de 1,6 MB"))
    if scope == "laboratorio":
        table.lab_note = LAB_NOTE
    elif scope in ("pagina", "origen"):
        table.attribution = ATTRIBUTION
    return table


def build_mail_auth_table(ext05: "Finding | None") -> MailAuthTable:
    """Build the three-row mail table from EXT-05 measured values."""
    from ..model import State

    table = MailAuthTable()
    if ext05 is not None and ext05.state == State.NO_APLICA:
        shared = (ext05.measured or {}).get("shared_parent")
        table.not_applicable_note = (ext05.reason or NOT_APPLICABLE_NOTE) if shared else NOT_APPLICABLE_NOTE
        return table
    rows_what = (
        "Quién puede enviar en nombre del dominio",
        "Firma de los mensajes",
        "Qué hacer con los mensajes falsos",
    )
    if ext05 is None or ext05.state == State.NO_VERIFICADO or not ext05.measured:
        missing = _missing(ext05)
        table.rows = [TableRow(w, missing, "Se revisa a mano") for w in rows_what]
        return table
    m = ext05.measured
    spf_count = m.get("spf_count") or 0
    spf_all = m.get("spf_all")
    # With DMARC p=reject or quarantine, a fake mail is rejected even without SPF:
    # the row never says "cualquiera puede enviar" next to "los rechaza".
    enforcing = bool(m.get("dmarc_present")) and (m.get("dmarc_p") or "").lower() in ("reject", "quarantine")
    if spf_count == 0:
        spf = (
            TableRow(rows_what[0], "falta", "Sin la lista, los mails reales del dominio pueden caer en spam o ser rechazados")
            if enforcing
            else TableRow(rows_what[0], "falta", "Cualquiera puede enviar mails con el nombre del dominio")
        )
    elif spf_count > 1:
        spf = TableRow(rows_what[0], "incompleta", "Hay más de una lista, y así ninguna vale")
    elif spf_all == "+":
        spf = TableRow(rows_what[0], "incompleta", "Cualquiera puede enviar mails con el nombre del dominio")
    elif spf_all in ("-", "~"):
        spf = TableRow(rows_what[0], "configurada", "Solo los servicios de correo autorizados por el dominio")
    elif spf_all == "redirect":  # RFC 7208 6.1: the provider's record decides
        spf = TableRow(rows_what[0], "configurada: definida por el proveedor", "El proveedor de correo decide quién puede enviar")
    else:
        spf = TableRow(rows_what[0], "incompleta", "La lista no le dice al receptor qué hacer con el resto")
    dkim_found = m.get("dkim_found")
    if dkim_found:
        dkim = TableRow(rows_what[1], "configurada", "Los mensajes llevan una firma que el receptor puede comprobar")
    else:
        dkim = TableRow(rows_what[1], "no se pudo confirmar desde afuera", "Se revisa en el panel de correo")
    if not m.get("dmarc_present"):
        dmarc = TableRow(rows_what[2], "falta", "Hoy nadie le dice a Gmail o a Outlook que rechacen un mail falso")
    else:
        policy = (m.get("dmarc_p") or "").lower()
        if policy == "reject":
            dmarc = TableRow(rows_what[2], "configurada: los rechaza", "Gmail y Outlook rechazan los mails falsos")
        elif policy == "quarantine":
            dmarc = TableRow(rows_what[2], "configurada: los manda a spam", "Gmail y Outlook mandan los mails falsos a spam")
        elif policy == "none":
            dmarc = TableRow(
                rows_what[2],
                "configurada: solo observa",
                "Gmail y Outlook reciben la regla, pero todavía no rechazan los mails falsos",
            )
        else:
            dmarc = TableRow(rows_what[2], "incompleta", "La regla no dice qué hacer con los mails falsos")
    table.rows = [spf, dkim, dmarc]
    return table
