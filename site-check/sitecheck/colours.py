"""Colour mapping: a fixed table, a short list of documented exceptions, then --overrides.

The colour is DERIVED, never chosen by eye. Order in code:

1. state first:
   APROBADO, CORREGIDO -> Verde; NO_VERIFICADO -> Gris; NO_APLICA -> Oculto
   (not shown, not counted); RIESGO_ACEPTADO -> Amarillo (never produced);
2. FALLA: module VIS -> Azul; the speed set (EXT-08, EXT-18, EXT-19, EXT-20,
   EXT-21) -> Amarillo; else priority Crítica/Alta -> Rojo, Media/Baja -> Amarillo
   (security modules EXT, INT, SEG, COM);
3. APROBADO_CON_OBSERVACION: Crítica/Alta -> Amarillo; Media/Baja -> Azul.

Documented exceptions (Finding.colour_exception, set by the evaluator):

* EXT-08 with lab data only and below the thresholds
  (APROBADO_CON_OBSERVACION) -> Verde, motivo "prueba de laboratorio; Google no
  tiene datos de usuarios reales de este sitio";
* VIS-01 FALLA because the HOME carries noindex (meta robots/googlebot
  or X-Robots-Tag) -> Rojo, motivo "el sitio entero pide no aparecer en Google".
* VIS-18 FALLA (a WhatsApp number badly written) and VIS-21 FALLA (a
  published address whose domain cannot receive mail) -> Amarillo ("Revisar"):
  a contact path that does not work must not read as "Mejora opcional".

Then the --overrides file ({ID: {"color": "...", "motivo": "..."}}), whose motivo
is mandatory. datos.json keeps color_derivado (table), color_final and the
motivo. New IDs follow the same table: VIS-16..19 FALLA -> Azul; EXT-25 (Media)
FALLA -> Amarillo.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .model import Colour, ColourException, Finding, Module, Priority, State

SPEED_IDS: frozenset[str] = frozenset({"EXT-08", "EXT-18", "EXT-19", "EXT-20", "EXT-21"})
EXCEPTION_RULES: dict[ColourException, tuple[str, State, Colour, str]] = {
    # exception -> (check id, required state, colour, Spanish motivo)
    ColourException.LAB_ONLY_PASS: (
        "EXT-08",
        State.APROBADO_CON_OBSERVACION,
        Colour.VERDE,
        "prueba de laboratorio; Google no tiene datos de usuarios reales de este sitio",
    ),
    ColourException.SITEWIDE_NOINDEX: (
        "VIS-01",
        State.FALLA,
        Colour.ROJO,
        "el sitio entero pide no aparecer en Google",
    ),
    ColourException.WHATSAPP_BROKEN: (
        "VIS-18",
        State.FALLA,
        Colour.AMARILLO,
        "un camino de contacto que no anda; al tocar el enlace no se abre el chat",
    ),
    ColourException.MAIL_BOUNCES: (
        "VIS-21",
        State.FALLA,
        Colour.AMARILLO,
        "un camino de contacto que no anda; lo que escriben a esa dirección rebota",
    ),
}


@dataclass(frozen=True)
class ColourOverride:
    colour: Colour
    motivo: str  # Spanish, mandatory


HIGH_PRIORITIES: frozenset[Priority] = frozenset({Priority.CRITICA, Priority.ALTA})
OVERRIDE_COLOURS: frozenset[Colour] = frozenset({Colour.ROJO, Colour.AMARILLO, Colour.AZUL, Colour.VERDE, Colour.GRIS})


def derive_colour(check_id: str, module: Module, state: State, priority: Priority) -> Colour:
    """The pure table (steps 1 to 3 above), without exceptions."""
    if state in (State.APROBADO, State.CORREGIDO):
        return Colour.VERDE
    if state == State.NO_VERIFICADO:
        return Colour.GRIS
    if state == State.NO_APLICA:
        return Colour.OCULTO
    if state == State.RIESGO_ACEPTADO:
        return Colour.AMARILLO
    if state == State.FALLA:
        if module == Module.VIS:
            return Colour.AZUL
        if check_id in SPEED_IDS:
            return Colour.AMARILLO
        # Security modules (EXT, INT, SEG, COM); any other prefix follows the same rule.
        return Colour.ROJO if priority in HIGH_PRIORITIES else Colour.AMARILLO
    if state == State.APROBADO_CON_OBSERVACION:
        return Colour.AMARILLO if priority in HIGH_PRIORITIES else Colour.AZUL
    raise ValueError(f"unknown state {state!r}")


def exception_colour(finding: Finding) -> tuple[Colour, str] | None:
    """(colour, motivo) when finding.colour_exception applies to its id and state, else None.

    An exception whose id or state does not match EXCEPTION_RULES is ignored
    (and the mismatch is a bug worth a gate_note).
    """
    exc = finding.colour_exception
    if exc is None:
        return None
    rule = EXCEPTION_RULES.get(exc)
    if rule is None:
        return None
    check_id, required_state, colour, motivo = rule
    if finding.id != check_id or finding.state != required_state:
        return None
    return colour, motivo


def load_overrides(path: Path) -> dict[str, ColourOverride]:
    """Read the --overrides JSON. ValueError (-> exit 2) on unknown colour, unknown ID or missing motivo."""
    import json

    from . import registry  # local import: registry imports the checks package

    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise ValueError(f"cannot read the adjustments file: {exc.strerror or exc}") from None
    except json.JSONDecodeError as exc:
        raise ValueError(f"the adjustments file is not valid JSON: {exc.msg} (line {exc.lineno})") from None
    if not isinstance(data, dict):
        raise ValueError("the adjustments file must be a JSON object {ID: {color, motivo}}")
    known = registry.by_id()
    out: dict[str, ColourOverride] = {}
    for check_id, entry in data.items():
        if check_id not in known:
            raise ValueError(f"unknown check ID in adjustments: {check_id!r}")
        if not isinstance(entry, dict):
            raise ValueError(f"{check_id}: expected an object with 'color' and 'motivo'")
        colour_name = str(entry.get("color") or "").strip().lower()
        try:
            colour = Colour(colour_name)
        except ValueError:
            raise ValueError(f"{check_id}: unknown colour {entry.get('color')!r}") from None
        if colour not in OVERRIDE_COLOURS:
            raise ValueError(f"{check_id}: colour {colour_name!r} cannot be set by hand")
        motivo = entry.get("motivo")
        if not isinstance(motivo, str) or not motivo.strip():
            raise ValueError(f"{check_id}: the 'motivo' is mandatory")
        out[check_id] = ColourOverride(colour, motivo.strip())
    return out


def _add_note(finding: Finding, note: str) -> None:
    finding.gate_note = f"{finding.gate_note}; {note}" if finding.gate_note else note


def colour_finding(finding: Finding, overrides: dict[str, ColourOverride] | None = None) -> Finding:
    """Set colour_derived, colour and colour_reason on ``finding`` (in place) and return it.

    NO_APLICA always ends Oculto (an override cannot show it). An override can
    never turn a NO_VERIFICADO into Verde.
    """
    derived = derive_colour(finding.id, finding.module, finding.state, finding.priority)
    finding.colour_derived = derived
    finding.colour = derived
    finding.colour_reason = None
    if finding.state == State.NO_APLICA:
        return finding
    exc = exception_colour(finding)
    if exc is not None:
        finding.colour, finding.colour_reason = exc
    elif finding.colour_exception is not None:
        _add_note(finding, f"colour exception {finding.colour_exception.value} ignored: it does not match {finding.id} {finding.state.value}")
    override = (overrides or {}).get(finding.id)
    if override is not None:
        if finding.state == State.NO_VERIFICADO and override.colour == Colour.VERDE:
            _add_note(finding, "adjustment to green ignored: a grey can never become green")
        elif override.colour not in OVERRIDE_COLOURS:
            _add_note(finding, f"adjustment colour {override.colour.value} ignored")
        else:
            finding.colour = override.colour
            finding.colour_reason = override.motivo
    return finding
