"""The findings data model: states, colours, priorities, Finding, CheckSpec.

The states are Spanish and kept verbatim in datos.json and in the technical
annex. A passive check produces five of them: APROBADO, APROBADO_CON_OBSERVACION,
FALLA, NO_APLICA, NO_VERIFICADO. CORREGIDO and RIESGO_ACEPTADO belong to a
follow-up with access to the site and are never produced here.

Report text in a Finding (``phrase_report``, ``reason``, ``note``) is Spanish,
formal usted, no voseo, no dashes U+2013/U+2014, never "certificado"
(textlint.py enforces it).
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .htmlextract import PageFacts
    from .observations import Observations


class State(StrEnum):
    APROBADO = "APROBADO"
    APROBADO_CON_OBSERVACION = "APROBADO_CON_OBSERVACION"
    FALLA = "FALLA"
    NO_APLICA = "NO_APLICA"
    NO_VERIFICADO = "NO_VERIFICADO"
    CORREGIDO = "CORREGIDO"  # never produced by this script
    RIESGO_ACEPTADO = "RIESGO_ACEPTADO"  # never produced by this script


class Module(StrEnum):
    """Prefix of the ID; drives the colour table."""

    EXT = "EXT"
    VIS = "VIS"


class Priority(StrEnum):
    CRITICA = "Crítica"
    ALTA = "Alta"
    MEDIA = "Media"
    BAJA = "Baja"


PRIORITY_RANK: dict[Priority, int] = {
    Priority.CRITICA: 0,
    Priority.ALTA: 1,
    Priority.MEDIA: 2,
    Priority.BAJA: 3,
}


class Colour(StrEnum):
    ROJO = "rojo"
    AMARILLO = "amarillo"
    AZUL = "azul"
    VERDE = "verde"
    GRIS = "gris"
    OCULTO = "oculto"  # NO_APLICA: not shown, not counted


@dataclass(frozen=True)
class ColourStyle:
    """Shape, label and tokens of a colour. The colour never goes alone."""

    colour: Colour
    shape: str
    label: str  # client label, Spanish
    token: str
    shape_hex: str
    text_hex: str


COLOUR_STYLES: dict[Colour, ColourStyle] = {
    Colour.ROJO: ColourStyle(Colour.ROJO, "▲", "Arreglar ya", "--estado-rojo", "#FF3333", "#CC0000"),
    Colour.AMARILLO: ColourStyle(Colour.AMARILLO, "■", "Revisar", "--estado-amarillo", "#FFAA33", "#C33300"),
    Colour.AZUL: ColourStyle(Colour.AZUL, "◆", "Mejora opcional", "--estado-azul", "#2962FF", "#0D47A1"),
    Colour.VERDE: ColourStyle(Colour.VERDE, "●", "Bien", "--estado-verde", "#00CC66", "#008800"),
    Colour.GRIS: ColourStyle(Colour.GRIS, "○", "No se pudo ver", "--estado-gris", "#9E9E9E", "#707070"),
    Colour.OCULTO: ColourStyle(Colour.OCULTO, "", "", "", "", ""),
}

# Reading order of the report.
COLOUR_ORDER: tuple[Colour, ...] = (Colour.ROJO, Colour.AMARILLO, Colour.AZUL, Colour.VERDE, Colour.GRIS)


class ColourException(StrEnum):
    """Documented exceptions to the colour table, set by the evaluator, applied by colours.py."""

    LAB_ONLY_PASS = "ext08-solo-laboratorio"  # EXT-08 lab-only pass is Verde (no field data to contradict it)
    SITEWIDE_NOINDEX = "vis01-sitio-entero"  # VIS-01 home noindex is Rojo: the whole site leaves Google
    # A contact path that does not work is Amarillo, not "Mejora opcional":
    # visitors who try to write or call lose the way in.
    WHATSAPP_BROKEN = "vis18-numero-mal-escrito"  # VIS-18 FALLA is Amarillo
    MAIL_BOUNCES = "vis21-correo-rebota"  # VIS-21 FALLA is Amarillo


@dataclass
class ReportPhrase:
    """The informe row of a finding.

    Non-green rows use all four columns of "Lo que conviene arreglar":
    found = «Qué se encontró», consequence = «Qué puede pasar si queda así»,
    action = «Qué se hace», who = «Quién». Green rows use found = «Qué» and
    consequence = «Por qué importa» (action and who empty). Grey rows use
    found only (the sentence after "{nombre_llano}: ").
    """

    found: str
    consequence: str = ""
    action: str = ""
    who: str = ""


@dataclass
class Finding:
    """The result of one check. Built by an evaluator, completed by gate.py and colours.py."""

    id: str  # "EXT-08", "VIS-16", ...
    name_plain: str  # nombre_llano, Spanish
    module: Module
    priority: Priority
    state: State
    measured: dict[str, Any] = field(default_factory=dict)  # JSON-ready raw values (numbers, not text)
    evidence: list[str] = field(default_factory=list)  # artifact names under evidencia/
    reason: str | None = None  # Spanish motivo: NO_VERIFICADO / NO_APLICA / observation
    note: str | None = None  # Spanish extra note shown in the report row
    # A note for the operator only (datos.json "nota_interna"); never printed
    # in the report: "no se indicó --name", "the rounded figure equals the
    # threshold"...
    internal_note: str | None = None
    phrase_report: ReportPhrase | None = None
    hack_signal: bool = False  # EXT-23 abuse codes, EXT-24 positive: the report leads with it
    colour_exception: ColourException | None = None
    trace: dict[str, str] = field(default_factory=dict)  # "{lcp_s}" -> "checks[EXT-08].measured.lcp_ms"
    # Filled after evaluation:
    evidence_ok: bool = False  # gate.py
    gate_note: str | None = None  # gate.py, English, why it downgraded
    colour_derived: Colour | None = None  # colours.py, from the table
    colour: Colour | None = None  # colours.py, final (after exceptions and --overrides)
    colour_reason: str | None = None  # colours.py, Spanish motivo of an exception/override

    @property
    def shape(self) -> str:
        """Shape of the final colour (empty for NO_APLICA)."""
        return COLOUR_STYLES[self.colour].shape if self.colour else ""

    @property
    def label(self) -> str:
        """Client label of the final colour (empty for NO_APLICA)."""
        return COLOUR_STYLES[self.colour].label if self.colour else ""

    def to_datos(self) -> dict[str, Any]:
        """Serialize for datos.json "checks".

        Keys: id, nombre_llano, modulo, prioridad, estado, color_derivado,
        color_final, motivo_ajuste, mediciones, evidencia, evidencia_ok,
        motivo_no_verificado, nota, nota_interna, senal_hackeo, frase_informe_llena{que_se_encontro,
        que_puede_pasar, que_se_hace, quien}, trazas, nota_compuerta.

        Also (needed by --rerender to recolour without evaluating again):
        motivo (the reason whatever the state; motivo_no_verificado carries it
        only for NO_VERIFICADO and NO_APLICA), excepcion_color, forma, rotulo.
        """
        pr = self.phrase_report
        return {
            "id": self.id,
            "nombre_llano": self.name_plain,
            "modulo": self.module.value,
            "prioridad": self.priority.value,
            "estado": self.state.value,
            "color_derivado": self.colour_derived.value if self.colour_derived else None,
            "color_final": self.colour.value if self.colour else None,
            "motivo_ajuste": self.colour_reason,
            "excepcion_color": self.colour_exception.value if self.colour_exception else None,
            "forma": self.shape,
            "rotulo": self.label,
            "mediciones": _json_ready(self.measured),
            "evidencia": list(self.evidence),
            "evidencia_ok": self.evidence_ok,
            "motivo": self.reason,
            "motivo_no_verificado": self.reason if self.state in (State.NO_VERIFICADO, State.NO_APLICA) else None,
            "nota": self.note,
            "nota_interna": self.internal_note,
            "senal_hackeo": self.hack_signal,
            "frase_informe_llena": (
                {
                    "que_se_encontro": pr.found,
                    "que_puede_pasar": pr.consequence,
                    "que_se_hace": pr.action,
                    "quien": pr.who,
                }
                if pr is not None
                else None
            ),
            "trazas": dict(self.trace),
            "nota_compuerta": self.gate_note,
        }

    @classmethod
    def from_datos(cls, d: Mapping[str, Any]) -> "Finding":
        """Inverse of to_datos (used by --rerender)."""

        def colour_or_none(value: Any) -> Colour | None:
            return Colour(value) if value else None

        pr_d = d.get("frase_informe_llena")
        phrase_report = (
            ReportPhrase(
                found=pr_d.get("que_se_encontro") or "",
                consequence=pr_d.get("que_puede_pasar") or "",
                action=pr_d.get("que_se_hace") or "",
                who=pr_d.get("quien") or "",
            )
            if isinstance(pr_d, Mapping)
            else None
        )
        reason = d.get("motivo")
        if reason is None:
            reason = d.get("motivo_no_verificado")
        exc = d.get("excepcion_color")
        return cls(
            id=str(d["id"]),
            name_plain=str(d.get("nombre_llano") or ""),
            module=Module(d["modulo"]),
            priority=Priority(d["prioridad"]),
            state=State(d["estado"]),
            measured=dict(d.get("mediciones") or {}),
            evidence=list(d.get("evidencia") or []),
            reason=reason,
            note=d.get("nota"),
            internal_note=d.get("nota_interna"),
            phrase_report=phrase_report,
            hack_signal=bool(d.get("senal_hackeo", False)),
            colour_exception=ColourException(exc) if exc else None,
            trace=dict(d.get("trazas") or {}),
            evidence_ok=bool(d.get("evidencia_ok", False)),
            gate_note=d.get("nota_compuerta"),
            colour_derived=colour_or_none(d.get("color_derivado")),
            colour=colour_or_none(d.get("color_final")),
            colour_reason=d.get("motivo_ajuste"),
        )


def _json_ready(value: Any) -> Any:
    """A copy of ``value`` that json.dumps accepts (tuples to lists, sets sorted, dates to ISO)."""
    if isinstance(value, Mapping):
        return {str(k): _json_ready(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_ready(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return sorted(_json_ready(v) for v in value)
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    if isinstance(value, StrEnum):
        return value.value
    return value


@dataclass(frozen=True)
class EvalContext:
    """What an evaluator needs besides Observations."""

    run_date: dt.date  # local date (UTC-3) of the run
    institution: str | None  # --name
    kind: str  # --kind, default "institución"
    artifacts_written: Mapping[str, bool]
    pages: Mapping[str, "PageFacts | None"]  # "home", "interna", "formulario", "hreflang:<code>"


Evaluator = Callable[["Observations", EvalContext], Finding]


@dataclass(frozen=True)
class CheckSpec:
    """One registry entry: the static facts of a check plus its evaluator."""

    id: str
    name_plain: str
    module: Module
    priority: Priority
    evaluate: Evaluator
    speed: bool = False  # EXT-08, EXT-18..21: FALLA is always Amarillo
    html_derived: bool = False  # a FALLA must pass the HTML evidence gate
