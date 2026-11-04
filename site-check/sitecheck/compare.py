"""Before/after comparison of two stored runs: ``site_check.py --compare BEFORE AFTER``.

It reads two ``datos.json`` files and writes ``comparacion.md`` and
``comparacion.json`` into the AFTER run folder. It makes no request and reads
no clock: the same two files always give the same bytes.

The protocol it enforces (the rule each part prevents breaking):

* Same tool, same page, same conditions. ``comparability_problems`` lists every
  difference that would make a number move for a reason other than the site:
  another domain or measured page, another site-check version (other rules),
  another Lighthouse major version (other scoring), another number of PageSpeed
  runs asked or valid (another median), PageSpeed on in one run and off in the
  other, Observatory asked in one run only, another request budget or kind of
  organisation, a run cut by an anti-bot check, a home that did not answer, or
  an AFTER run that is not later than BEFORE. A key a run does not record is a
  reason too, never a match. Any of them refuses the whole comparison (exit 5)
  and nothing is written.
* Three runs and the median. With PageSpeed on, each run needs an odd count of
  valid mobile runs, three or more, so that one run is the middle one.
* Field and lab never mixed. Real-user rows (Chrome UX Report, 28 days) read
  EXT-08 ``lcp_ms``, ``inp_ms`` and ``cls`` only when ``scope`` is "pagina" or
  "origen"; a lab-only run stores its lab LCP in ``lcp_ms`` with scope
  "laboratorio", and that value is never shown as field data. A side without
  field data says "sin datos de campo" and the row is not compared. Page and
  origin data are not compared with each other either.
* Medians, as the run stored them: the mobile score is the one of the run with
  the median lab LCP, the mobile lab LCP is that median, and the desktop score
  is a single run, labelled as such.
* The control: the server time is compared only when EXT-20 had a valid
  control in both runs (the check is not grey), and the control medians are
  printed next to it so a change in the instrument shows.
* Changes worked out from the printed cells, so "2,9 | 3,0" never reads
  "sin cambio" and "2,9 | 2,9" never reads "0,1 más".
* Cache declared per row: Lighthouse loads the page with an empty browser
  cache; the server time comes from three plain requests that carry no cache
  of their own.
* Passed over applicable per module, never over the catalogue: NO_APLICA is
  left out of the denominator, NO_VERIFICADO stays in it and never counts as
  passed.

The report text goes through textlint like informe.md; a problem is exit 4,
with the files written and the problems listed, as in a run.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from collections.abc import Callable
from typing import IO, Any

from . import __version__, fmt
from .checks.common import UNDER_A_TENTH
from .exitcodes import ExitCode
from .model import COLOUR_STYLES, Colour
from .outputs import DATOS, dumps_datos, read_datos, write_text
from .render_report import number_word
from .textlint import lint_text

REPORT = "comparacion.md"
DATA = "comparacion.json"
COMPARISON_SCHEMA = 1
FIELD_WINDOW_DAYS = 28  # Chrome UX Report: the 28 days before the measurement
FIELD_SCOPES = frozenset({"pagina", "origen"})
PASSED_STATES = frozenset({"APROBADO", "CORREGIDO"})
# Better to worse; grey and hidden are outside the scale.
COLOUR_RANK: dict[str, int] = {"verde": 3, "azul": 2, "amarillo": 1, "rojo": 0}
MODULE_NAMES: tuple[tuple[str, str], ...] = (
    ("EXT", "Seguridad y velocidad vistas desde afuera (EXT)"),
    ("VIS", "Visibilidad, accesibilidad y contacto (VIS)"),
)

LAB_CONDITION = "Prueba de laboratorio de Google, con la caché del navegador vacía"
SERVER_CONDITION = (
    "Tres pedidos seguidos a la página principal, sin caché propia, desde Buenos Aires; "
    "el sitio de control se midió en el mismo momento"
)
NO_FIELD = "sin datos de campo"
# The field rows as the summary names them.
FIELD_SUMMARY: dict[str, str] = {
    "campo_lcp": "lo principal de la página",
    "campo_inp": "la respuesta cuando se toca algo",
    "campo_cls": "cuánto se mueve la página mientras carga",
}
NOT_MEASURED = "no se midió"
NOT_COMPARED = "no se compara"
NO_CHANGE = "sin cambio"


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StoredRun:
    """One datos.json, with the parts the comparison reads."""

    folder: Path
    datos: dict[str, Any]
    meta: dict[str, Any]
    checks: dict[str, dict[str, Any]]
    started: dt.datetime | None

    @property
    def date(self) -> dt.date | None:
        return fmt.local_date(self.started) if self.started is not None else None

    def check(self, check_id: str) -> dict[str, Any]:
        return self.checks.get(check_id) or {}

    def measured(self, check_id: str) -> dict[str, Any]:
        value = self.check(check_id).get("mediciones")
        return value if isinstance(value, dict) else {}


def _parse_moment(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=dt.timezone.utc)


def load_run(path: Path) -> StoredRun:
    """A run folder (holding datos.json) or a datos.json path. ValueError when unreadable."""
    path = Path(path)
    source = path / DATOS if path.is_dir() else path
    datos = read_datos(source)
    meta = datos.get("meta") if isinstance(datos.get("meta"), dict) else {}
    checks = {str(c.get("id")): c for c in datos.get("checks") or [] if isinstance(c, dict) and c.get("id")}
    started = _parse_moment(meta.get("inicio_utc")) or _parse_moment(meta.get("inicio_local"))
    return StoredRun(folder=source.parent, datos=datos, meta=meta, checks=checks, started=started)


# ---------------------------------------------------------------------------
# Comparability (English: printed on the console)
# ---------------------------------------------------------------------------


def _lighthouse_major(version: Any) -> str | None:
    if not isinstance(version, str) or not version.strip():
        return None
    return version.strip().split(".", 1)[0]


def _psi_runs(run: StoredRun) -> dict[str, Any]:
    value = run.meta.get("corridas_psi")
    return value if isinstance(value, dict) else {}


# The meta keys every comparable run must record, with what each one pins down.
IDENTITY_KEYS: tuple[tuple[str, str], ...] = (
    ("dominio", "the domain"),
    ("url_canonica", "the measured page (meta.url_canonica)"),
    ("version_script", "the site-check version (other rules)"),
    ("modo_prueba", "test mode"),
    ("sin_pagespeed", "PageSpeed on or off (--no-pagespeed)"),
    ("max_pedidos", "the request budget (--max-requests)"),
    ("tipo", "the kind of organisation (--kind)"),
)
# Keys that may be null in a valid run (no inner page linked), compared as stored.
OPTIONAL_KEYS: tuple[tuple[str, str], ...] = (("url_interna", "the inner page read (meta.url_interna)"),)
MIN_VALID_PSI_RUNS = 3  # the protocol: three mobile runs and the median


def _psi_problems(label: str, runs: dict[str, Any], lighthouse: Any) -> list[str]:
    """What a run with PageSpeed on lacks for a median comparison."""
    problems: list[str] = []
    for key in ("pedidas", "validas"):
        value = runs.get(key)
        if isinstance(value, bool) or not isinstance(value, int):
            problems.append(f"the {label} run does not record {key} in meta.corridas_psi")
    if not isinstance(runs.get("computadora_valida"), bool):
        problems.append(f"the {label} run does not record computadora_valida in meta.corridas_psi")
    valid = runs.get("validas")
    if isinstance(valid, int) and not isinstance(valid, bool):
        if valid < MIN_VALID_PSI_RUNS:
            problems.append(
                f"the {label} run has {valid} valid mobile PageSpeed runs; the comparison takes the median "
                f"of at least {MIN_VALID_PSI_RUNS}"
            )
        elif valid % 2 == 0:
            problems.append(
                f"the {label} run has {valid} valid mobile PageSpeed runs, an even count with no middle run"
            )
    if _lighthouse_major(lighthouse) is None:
        problems.append(f"the {label} run does not record the Lighthouse version (meta.version_lighthouse)")
    return problems


def comparability_problems(before: StoredRun, after: StoredRun) -> list[str]:
    """Every reason the two runs cannot be compared; empty when they can.

    A key missing from a run is a reason of its own: a truncated or hand-made
    datos.json must not pass the identity checks because None equals None.
    """
    problems: list[str] = []
    runs = (("BEFORE", before), ("AFTER", after))
    for label, run in runs:
        code = (run.datos.get("salida") or {}).get("codigo")
        if not run.checks:
            problems.append(f"the {label} run has no checks (it ended with exit {code}); measure again")
        if run.meta.get("portada_no_respondio"):
            problems.append(f"the home did not answer in the {label} run, so its checks did not see the site")
        if run.meta.get("sitio_cortado"):
            problems.append(f"an anti-bot check cut the {label} run, so part of the site was not read")
        if run.started is None:
            problems.append(f"the {label} run has no start time (meta.inicio_utc)")

    def differs_values(what: str, a: Any, b: Any) -> None:
        if a != b:
            problems.append(f"{what} differs: {a!r} before, {b!r} after")

    def differs_meta(key: str, what: str) -> None:
        missing = [label for label, run in runs if run.meta.get(key) is None]
        for label in missing:
            problems.append(f"the {label} run does not record {what}")
        if not missing:
            differs_values(what, before.meta[key], after.meta[key])

    for key, what in IDENTITY_KEYS:
        differs_meta(key, what)
    for key, what in OPTIONAL_KEYS:
        differs_values(what, before.meta.get(key), after.meta.get(key))
    differs_values(
        "MDN Observatory asked (--observatory)",
        bool((before.meta.get("alcance") or {}).get("observatory")),
        bool((after.meta.get("alcance") or {}).get("observatory")),
    )

    psi_on = [run.meta.get("sin_pagespeed") is False for _, run in runs]
    if all(psi_on):
        psi = [_psi_problems(label, _psi_runs(run), run.meta.get("version_lighthouse")) for label, run in runs]
        problems += [p for side in psi for p in side]
        if not any(psi):
            runs_b, runs_a = _psi_runs(before), _psi_runs(after)
            for key, what in (
                ("pedidas", "the mobile PageSpeed runs asked (--psi-runs)"),
                ("validas", "the valid mobile PageSpeed runs (the median is taken over them)"),
                ("computadora_valida", "whether the desktop PageSpeed run was valid"),
            ):
                differs_values(what, runs_b[key], runs_a[key])
            lh_b, lh_a = before.meta["version_lighthouse"], after.meta["version_lighthouse"]
            if _lighthouse_major(lh_b) != _lighthouse_major(lh_a):
                problems.append(
                    f"the Lighthouse major version differs (other scoring): {lh_b!r} before, {lh_a!r} after"
                )
    if before.started is not None and after.started is not None and after.started <= before.started:
        problems.append("the AFTER run is not later than the BEFORE run; pass the older run first")
    return problems


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------


@dataclass
class Cell:
    value: Any  # the raw stored value, or None
    text: str  # what the report prints
    trace: str | None  # where the value lives in that run's datos.json


@dataclass
class Row:
    key: str
    group: str  # "campo", "laboratorio", "servidor", "seguridad", "correo"
    label: str
    before: Cell
    after: Cell
    change: str
    compared: bool
    reason: str | None = None  # Spanish, when not compared
    meaning: str = ""

    def to_datos(self) -> dict[str, Any]:
        def cell(c: Cell) -> dict[str, Any]:
            return {"valor": c.value, "texto": c.text, "traza": c.trace}

        return {
            "clave": self.key,
            "grupo": self.group,
            "que": self.label,
            "antes": cell(self.before),
            "despues": cell(self.after),
            "cambio": self.change,
            "comparada": self.compared,
            "motivo": self.reason,
            "significa": self.meaning,
        }


@dataclass(frozen=True)
class Scale:
    """How a stored number prints, and how its change is worked out from the printed cells."""

    number: Callable[[float], str]  # the stored value as printed digits: 2949 ms -> "2,9"
    decimals: int
    unit: str = ""  # printed after the number and after the change
    zero_text: str | None = None  # printed instead of a zero (seconds: "menos de una décima")

    def cell(self, value: float) -> str:
        digits = self.number(value)
        if self.zero_text is not None and _digits_value(digits) == 0:
            return self.zero_text
        return f"{digits} {self.unit}" if self.unit else digits

    def change(self, before: float, after: float) -> str:
        """The difference of the two printed numbers, so the column never contradicts its cells.

        2949 ms and 2951 ms print "2,9" and "3,0", so the change is 0,1 more; 2860 and
        2940 both print "2,9", so there is no change, whatever the raw difference.
        """
        diff = _digits_value(self.number(after)) - _digits_value(self.number(before))
        if diff == 0:
            return NO_CHANGE
        shown = fmt.decimal_es(abs(diff), self.decimals)
        suffix = f" {self.unit}" if self.unit else ""
        return f"{shown}{suffix} {'menos' if diff < 0 else 'más'}"


def _digits_value(digits: str) -> Decimal:
    """'2,9' -> 2.9; '12.345' -> 12345 (fmt.decimal_es writes a dot every three digits above 10.000)."""
    return Decimal(digits.replace(".", "").replace(",", "."))


SECONDS_1 = Scale(fmt.ms_to_s, 1, "segundos", UNDER_A_TENTH)
SECONDS_2 = Scale(lambda ms: fmt.decimal_es(Decimal(repr(float(ms))) / 1000, 2), 2, "segundos", UNDER_A_TENTH)
CLS = Scale(fmt.cls_es, 2)
MEGABYTES = Scale(lambda n: fmt.bytes_to_mb(int(n)), 1, "MB")
WHOLE = Scale(lambda v: fmt.decimal_es(v, 0), 0)
POINTS = Scale(lambda v: fmt.decimal_es(v, 0), 0, "puntos")


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _grey_reason(run: StoredRun, check_id: str) -> str | None:
    check = run.check(check_id)
    if check.get("estado") == "NO_VERIFICADO":
        reason = check.get("motivo_no_verificado") or check.get("motivo")
        return str(reason) if reason else "la medición no se completó"
    return None


def _numeric_row(
    key: str,
    label: str,
    group: str,
    before: StoredRun,
    after: StoredRun,
    check_id: str,
    measure: str,
    scale: Scale,
    meaning: str = "",
) -> Row:
    """A row read from checks[check_id].mediciones[measure] on both sides."""
    trace = f"checks[{check_id}].measured.{measure}"
    cells: list[Cell] = []
    reasons: list[str] = []
    for run in (before, after):
        raw = run.measured(check_id).get(measure)
        value = _num(raw)
        if value is None:
            cells.append(Cell(None, NOT_MEASURED, None))
            reason = _grey_reason(run, check_id)
            if reason:
                reasons.append(reason)
        else:
            cells.append(Cell(raw, scale.cell(value), trace))
    if cells[0].value is None or cells[1].value is None:
        reason = "; ".join(dict.fromkeys(reasons)) or "falta la medición en una de las dos fechas"
        return Row(key, group, label, cells[0], cells[1], NOT_COMPARED, False, reason, meaning)
    change = scale.change(float(cells[0].value), float(cells[1].value))
    return Row(key, group, label, cells[0], cells[1], change, True, None, meaning)


def _field_scope(run: StoredRun) -> str | None:
    scope = run.measured("EXT-08").get("scope")
    return scope if scope in FIELD_SCOPES else None


def _field_rows(before: StoredRun, after: StoredRun) -> list[Row]:
    specs = (
        ("campo_lcp", "Cuánto tarda en aparecer lo principal de la página", "lcp_ms", SECONDS_1,
         "Google considera bien hasta 2,5 segundos"),
        ("campo_inp", "Cuánto tarda en responder cuando se toca algo", "inp_ms", SECONDS_2, "Bien hasta 0,2 segundos"),
        ("campo_cls", "Cuánto se mueve la página mientras carga", "cls", CLS, "Bien hasta 0,1"),
    )
    scope_b, scope_a = _field_scope(before), _field_scope(after)
    rows: list[Row] = []
    for key, label, measure, scale, meaning in specs:
        trace = f"checks[EXT-08].measured.{measure}"
        cells: list[Cell] = []
        for run, scope in ((before, scope_b), (after, scope_a)):
            raw = run.measured("EXT-08").get(measure) if scope is not None else None
            value = _num(raw)
            if value is None:
                cells.append(Cell(None, NO_FIELD, None))
            else:
                cells.append(Cell(raw, scale.cell(value), trace))
        if cells[0].value is None or cells[1].value is None:
            reason = "Google no tiene datos de usuarios reales en una de las dos fechas; no se reemplazan por la prueba de laboratorio"
            rows.append(Row(key, "campo", label, cells[0], cells[1], NOT_COMPARED, False, reason, meaning))
        elif scope_b != scope_a:
            reason = "una medición es de la página principal y la otra de todo el sitio"
            rows.append(Row(key, "campo", label, cells[0], cells[1], NOT_COMPARED, False, reason, meaning))
        else:
            change = scale.change(float(cells[0].value), float(cells[1].value))
            rows.append(Row(key, "campo", label, cells[0], cells[1], change, True, None, meaning))
    return rows


def field_condition(before: StoredRun, after: StoredRun) -> str:
    """Who the real-user rows describe: the home page, the whole site, or each date's own scope."""
    window = f"en los {FIELD_WINDOW_DAYS} días anteriores a cada medición, según Google"
    scopes = {s for s in (_field_scope(before), _field_scope(after)) if s is not None}
    if scopes == {"pagina"}:
        return f"Quienes visitaron la página principal desde un celular, {window}"
    if scopes == {"origen"}:
        return (f"Quienes visitaron cualquier página del sitio desde un celular, {window}. Google no tiene "
                "suficientes visitas de la página principal sola y da los datos de todo el sitio")
    if scopes:
        return (f"Quienes visitaron el sitio desde un celular, {window}. En una fecha los datos son de la "
                "página principal y en la otra de todo el sitio, y por eso no se comparan")
    return f"Quienes visitan el sitio desde un celular, {window}"


def _score_row(key: str, label: str, side: str, before: StoredRun, after: StoredRun, meaning: str) -> Row:
    trace = f"encabezado.{side}.performance.puntaje"
    cells: list[Cell] = []
    reasons: list[str] = []
    for run in (before, after):
        cell = ((run.datos.get("encabezado") or {}).get(side) or {}).get("performance") or {}
        score = cell.get("puntaje")
        if isinstance(score, int) and not isinstance(score, bool):
            cells.append(Cell(score, f"{cell.get('forma', '')} {score} ({cell.get('rotulo', '')})".strip(), trace))
        else:
            cells.append(Cell(None, NOT_MEASURED, None))
            if cell.get("motivo"):
                reasons.append(str(cell["motivo"]))
    if cells[0].value is None or cells[1].value is None:
        reason = "; ".join(dict.fromkeys(reasons)) or "falta el puntaje en una de las dos fechas"
        return Row(key, "laboratorio", label, cells[0], cells[1], NOT_COMPARED, False, reason, meaning)
    change = POINTS.change(float(cells[0].value), float(cells[1].value))
    return Row(key, "laboratorio", label, cells[0], cells[1], change, True, None, meaning)


def _lab_rows(before: StoredRun, after: StoredRun) -> list[Row]:
    # comparability_problems has made sure both runs have the same odd count, three or more.
    valid = _psi_runs(after).get("validas")
    median = isinstance(valid, int) and not isinstance(valid, bool) and valid >= MIN_VALID_PSI_RUNS
    score_label = "Puntaje de rendimiento en celular"
    lcp_label = "Cuánto tarda en aparecer lo principal, en celular"
    if median:
        score_label += f" (corrida del medio de {number_word(valid)})"
        lcp_label += f" (valor del medio de {number_word(valid)})"
    return [
        _score_row("lab_puntaje_celular", score_label, "celular", before, after,
                   "De 0 a 100; Google considera bien desde 90"),
        _numeric_row("lab_lcp_celular", lcp_label, "laboratorio", before, after, "EXT-08", "lab_lcp_ms_median",
                     SECONDS_1, "Google considera bien hasta 2,5 segundos"),
        _score_row("lab_puntaje_computadora", "Puntaje de rendimiento en computadora (una corrida)", "computadora",
                   before, after, "De 0 a 100; Google considera bien desde 90"),
        _numeric_row("peso_total", "Cuánto pesa la página principal", "laboratorio", before, after, "EXT-21",
                     "total_bytes", MEGABYTES, "Google aconseja no pasar de 1,6 MB"),
        _numeric_row("peso_terceros", "Cuánto de ese peso llega de servicios externos", "laboratorio", before, after,
                     "EXT-21", "third_party_bytes", MEGABYTES,
                     "Lo que cargan videos, mapas, chats y estadísticas de otras empresas"),
    ]


def _server_rows(before: StoredRun, after: StoredRun) -> list[Row]:
    site = _numeric_row("ttfb", "Cuánto tarda el servidor en empezar a responder (valor del medio de tres)", "servidor",
                        before, after, "EXT-20", "ttfb_ms_median", SECONDS_1, "Bien hasta 0,8 segundos")
    control = _numeric_row("ttfb_control", "Sitio de control medido en el mismo momento (valor del medio de tres)",
                           "servidor", before, after, "EXT-20", "control_ms_median", SECONDS_1,
                           "Si cambia mucho, cambió la conexión y no el sitio")
    if site.compared:
        greys = [r for r in (_grey_reason(before, "EXT-20"), _grey_reason(after, "EXT-20")) if r]
        if greys:
            site.compared, site.change = False, NOT_COMPARED
            site.reason = "sin un control válido en las dos fechas: " + "; ".join(dict.fromkeys(greys))
    return [site, control]


def _security_rows(before: StoredRun, after: StoredRun) -> list[Row]:
    rows: list[Row] = []
    cells: list[Cell] = []
    for run in (before, after):
        m = run.measured("EXT-01")
        n, missing = _num(m.get("n_protections")), _num(m.get("n_missing"))
        if n is None:
            cells.append(Cell(None, NOT_MEASURED, "checks[EXT-01].measured.n_protections"))
        else:
            total = int(n) + int(missing or 0)
            cells.append(Cell(int(n), f"{int(n)} de {total}", "checks[EXT-01].measured.n_protections"))
    label = "Protecciones que el servidor le pide al navegador"
    meaning = "Seis protecciones que ofrecen los navegadores"
    if cells[0].value is None or cells[1].value is None:
        reason = "; ".join(r for r in (_grey_reason(before, "EXT-01"), _grey_reason(after, "EXT-01")) if r) or (
            "falta la medición en una de las dos fechas")
        rows.append(Row("protecciones", "seguridad", label, cells[0], cells[1], NOT_COMPARED, False, reason, meaning))
    else:
        change = WHOLE.change(float(cells[0].value), float(cells[1].value))
        rows.append(Row("protecciones", "seguridad", label, cells[0], cells[1], change, True, None, meaning))
    grades = [run.measured("EXT-01").get("observatory_grade") for run in (before, after)]
    if any(grades):
        trace = "checks[EXT-01].measured.observatory_grade"
        gc = [Cell(g, str(g) if g else NOT_MEASURED, trace) for g in grades]
        ok = all(grades)
        change = (NO_CHANGE if grades[0] == grades[1] else f"de {grades[0]} a {grades[1]}") if ok else NOT_COMPARED
        rows.append(Row("nota_observatory", "seguridad", "Nota de las protecciones según MDN Observatory", gc[0], gc[1],
                        change, ok, None if ok else "la nota falta en una de las dos fechas", "De A+ a F"))
    return rows


# How strong each stored mail value is (checks/tables.py), to say which way a row moved.
# "no se pudo confirmar desde afuera" is not on the scale: DKIM cannot be seen from outside.
MAIL_RANK: dict[str, int] = {
    "falta": 0,
    "incompleta": 1,
    "configurada: solo observa": 2,
    "configurada": 3,
    "configurada: definida por el proveedor": 3,
    "configurada: los manda a spam": 3,
    "configurada: los rechaza": 4,
}


def _mail_change(before: str, after: str) -> str:
    if before == after:
        return NO_CHANGE
    if before == "falta":
        return "se agregó"
    if after == "falta":
        return "se quitó"
    if before in MAIL_RANK and after in MAIL_RANK and MAIL_RANK[before] != MAIL_RANK[after]:
        return "mejoró" if MAIL_RANK[after] > MAIL_RANK[before] else "empeoró"
    return "cambió"


def _mail_rows(before: StoredRun, after: StoredRun) -> list[Row]:
    def rows_of(run: StoredRun) -> dict[str, tuple[int, Any]]:
        """Row label -> (its index in that run's own filas, its stored value)."""
        section = ((run.datos.get("tablas") or {}).get("correo") or {}).get("filas") or []
        out: dict[str, tuple[int, Any]] = {}
        for i, r in enumerate(section):
            if isinstance(r, dict) and r.get("que") and str(r["que"]) not in out:
                out[str(r["que"])] = (i, r.get("valor"))
        return out

    def cell(entry: tuple[int, Any] | None) -> Cell:
        if entry is None or not isinstance(entry[1], str) or not entry[1]:
            return Cell(None, NOT_MEASURED, None)
        return Cell(entry[1], entry[1], f"tablas.correo.filas[{entry[0]}].valor")

    rb, ra = rows_of(before), rows_of(after)
    out: list[Row] = []
    for n, label in enumerate(dict.fromkeys([*rb, *ra])):
        cb, ca = cell(rb.get(label)), cell(ra.get(label))
        if cb.value is None or ca.value is None:
            out.append(Row(f"correo_{n}", "correo", label, cb, ca, NOT_COMPARED, False, "falta en una de las dos fechas"))
        else:
            out.append(Row(f"correo_{n}", "correo", label, cb, ca, _mail_change(cb.value, ca.value), True))
    return out


# ---------------------------------------------------------------------------
# Checks: counts per module and colour transitions
# ---------------------------------------------------------------------------


def _colour(check: dict[str, Any]) -> str:
    if not check:
        return "ausente"
    if check.get("estado") == "NO_APLICA":
        return Colour.OCULTO.value
    return str(check.get("color_final") or Colour.GRIS.value)  # never coloured: shown as grey, never green


def _colour_text(colour: str) -> str:
    if colour == Colour.OCULTO.value:
        return "no aplica"
    if colour == "ausente":
        return "no estaba en esa medición"
    try:
        style = COLOUR_STYLES[Colour(colour)]
    except (ValueError, KeyError):
        return colour
    return f"{style.shape} {style.label}"


def module_counts(run: StoredRun) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    for module, _ in (*MODULE_NAMES, ("TOTAL", "")):
        counts[module] = {"aprobados": 0, "con_observacion": 0, "sin_verificar": 0, "aplicables": 0}
    for check in run.checks.values():
        state = check.get("estado")
        if state == "NO_APLICA":
            continue
        for module in (str(check.get("modulo")), "TOTAL"):
            bucket = counts.setdefault(module, {"aprobados": 0, "con_observacion": 0, "sin_verificar": 0, "aplicables": 0})
            bucket["aplicables"] += 1
            if state in PASSED_STATES:
                bucket["aprobados"] += 1
            elif state == "APROBADO_CON_OBSERVACION":
                bucket["con_observacion"] += 1
            elif state == "NO_VERIFICADO":
                bucket["sin_verificar"] += 1
    return counts


@dataclass
class Transition:
    check_id: str
    name: str
    before: str
    after: str
    kind: str  # "mejoro", "empeoro", "otro"

    def to_datos(self) -> dict[str, str]:
        return {"id": self.check_id, "nombre": self.name, "antes": self.before, "despues": self.after, "tipo": self.kind}


def colour_transitions(before: StoredRun, after: StoredRun) -> list[Transition]:
    out: list[Transition] = []
    for check_id in [*before.checks, *(i for i in after.checks if i not in before.checks)]:
        b, a = before.check(check_id), after.check(check_id)
        cb, ca = _colour(b), _colour(a)
        if cb == ca:
            continue
        if cb in COLOUR_RANK and ca in COLOUR_RANK:
            kind = "mejoro" if COLOUR_RANK[ca] > COLOUR_RANK[cb] else "empeoro"
        else:
            kind = "otro"
        name = str((a or b).get("nombre_llano") or check_id)
        out.append(Transition(check_id, name, cb, ca, kind))
    # Worst starting colour first, then the catalogue order.
    order = {c.value: i for i, c in enumerate((Colour.ROJO, Colour.AMARILLO, Colour.AZUL, Colour.VERDE, Colour.GRIS, Colour.OCULTO))}
    return sorted(out, key=lambda t: order.get(t.before, 99))


def still_open(after: StoredRun) -> list[dict[str, str]]:
    """Checks of the AFTER run that are not green and apply, worst first."""
    order = {"rojo": 0, "amarillo": 1, "azul": 2, "gris": 3}
    rows = []
    for check_id, check in after.checks.items():
        colour = _colour(check)
        if colour not in order:
            continue
        phrase = check.get("frase_informe_llena") or {}
        found = phrase.get("que_se_encontro") if isinstance(phrase, dict) else None
        if colour == "gris":
            found = check.get("motivo_no_verificado") or found
        rows.append({"id": check_id, "nombre": str(check.get("nombre_llano") or check_id), "color": colour,
                     "que_se_encontro": str(found or "").rstrip(".")})
    return sorted(rows, key=lambda r: order[r["color"]])


# ---------------------------------------------------------------------------
# The comparison
# ---------------------------------------------------------------------------


@dataclass
class Comparison:
    before: StoredRun
    after: StoredRun
    rows: list[Row] = field(default_factory=list)
    counts_before: dict[str, dict[str, int]] = field(default_factory=dict)
    counts_after: dict[str, dict[str, int]] = field(default_factory=dict)
    transitions: list[Transition] = field(default_factory=list)
    open_after: list[dict[str, str]] = field(default_factory=list)

    @property
    def days_between(self) -> int:
        assert self.before.date is not None and self.after.date is not None
        return (self.after.date - self.before.date).days

    def rows_of(self, group: str) -> list[Row]:
        return [r for r in self.rows if r.group == group]


def build_comparison(before: StoredRun, after: StoredRun) -> Comparison:
    """The comparison of two comparable runs (call comparability_problems first)."""
    comp = Comparison(before, after)
    comp.rows = [
        *_field_rows(before, after),
        *_lab_rows(before, after),
        *_server_rows(before, after),
        *_security_rows(before, after),
        *_mail_rows(before, after),
    ]
    comp.counts_before, comp.counts_after = module_counts(before), module_counts(after)
    comp.transitions = colour_transitions(before, after)
    comp.open_after = still_open(after)
    return comp


# ---------------------------------------------------------------------------
# Rendering (Spanish, formal "usted", like informe.md)
# ---------------------------------------------------------------------------


def _cell(text: str) -> str:
    return text.replace("|", "/").replace("\n", " ")


def _table(rows: list[Row], date_b: str, date_a: str, *, meaning: bool = True) -> list[str]:
    head = f"| Qué se midió | Antes · {date_b} | Después · {date_a} | Cambio |" + (" Qué significa |" if meaning else "")
    sep = "|---|---|---|---|" + ("---|" if meaning else "")
    lines = [head, sep]
    for r in rows:
        change = r.change if r.compared else f"{NOT_COMPARED}: {r.reason}"
        line = f"| {_cell(r.label)} | {_cell(r.before.text)} | {_cell(r.after.text)} | {_cell(change)} |"
        if meaning:
            line += f" {_cell(r.meaning)} |"
        lines.append(line)
    return lines


def _passed_text(c: dict[str, int]) -> str:
    return f"{c['aprobados']} de {c['aplicables']} aplicables"


def _list_es(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " y " + items[-1]


def render_comparison(comp: Comparison) -> str:
    b, a = comp.before, comp.after
    assert b.date is not None and a.date is not None
    date_b, date_a = fmt.fecha_dmy(b.date), fmt.fecha_dmy(a.date)
    domain = str(a.meta.get("dominio") or "")
    institution = str(a.meta.get("institucion") or domain)
    para = str(a.meta.get("para") or "")
    out: list[str] = [f"**{institution} · Antes y después del sitio {domain}**", ""]
    out.append(f"Antes: {date_b} · Después: {date_a}" + (f" · Para: {para}" if para else ""))
    out += ["", "## Qué se comparó", ""]
    out.append(
        f"Se midió el sitio dos veces desde afuera, el {date_b} y el {date_a}, con la misma versión de "
        "site-check, la misma página y las mismas opciones. Cada número de este documento sale de lo que se "
        "guardó en esas dos mediciones; para escribirlo no se volvió a medir nada. Lo que no se pudo medir en "
        "una de las dos fechas se dice con su motivo y no se compara."
    )

    total_b, total_a = comp.counts_before["TOTAL"], comp.counts_after["TOTAL"]
    better = [t for t in comp.transitions if t.kind == "mejoro"]
    worse = [t for t in comp.transitions if t.kind == "empeoro"]
    summary: list[str] = [f"Chequeos aprobados: {_passed_text(total_b)} antes, {_passed_text(total_a)} después."]
    if better or worse:
        parts = []
        if better:
            parts.append(f"{len(better)} {'chequeo mejoró' if len(better) == 1 else 'chequeos mejoraron'}")
        if worse:
            parts.append(f"{len(worse)} {'chequeo empeoró' if len(worse) == 1 else 'chequeos empeoraron'}")
        summary.append(f"{_list_es(parts).capitalize()} de color" + ("." if worse else "; ninguno empeoró."))
    else:
        summary.append("Ningún chequeo cambió de color entre las dos fechas.")
    field_ok = [r for r in comp.rows_of("campo") if r.compared]
    if field_ok:
        phrases = [f"{FIELD_SUMMARY[r.key]} pasó de {r.before.text} a {r.after.text}" for r in field_ok]
        line = f"Para quienes visitan el sitio desde un celular, {_list_es(phrases)}."
        if len(field_ok) < len(comp.rows_of("campo")):
            line += " El resto de los datos de usuarios reales falta en una de las dos fechas y no se compara."
        summary.append(line)
    else:
        summary.append("Google no tiene datos de usuarios reales en las dos fechas, así que la velocidad se compara "
                       "solo con la prueba de laboratorio.")
    still = [r for r in comp.open_after if r["color"] in ("rojo", "amarillo")]
    if still:
        summary.append(f"{'Queda 1 chequeo' if len(still) == 1 else f'Quedan {len(still)} chequeos'} para arreglar "
                       "ya o revisar; la lista completa está al final.")
    else:
        summary.append("No queda nada marcado para arreglar ya ni para revisar.")
    out += ["", "## En pocas líneas", ""]
    out += [f"{n}. {line}" for n, line in enumerate(summary, start=1)]

    out += ["", "## Velocidad", "", "### Datos de usuarios reales", "", field_condition(b, a) + ".", ""]
    out += _table(comp.rows_of("campo"), date_b, date_a)
    if comp.days_between < FIELD_WINDOW_DAYS:
        out += ["", f"Entre las dos mediciones pasaron {comp.days_between} días, menos que los 28 que cubre Google: "
                    "los datos del después todavía incluyen visitas de antes del cambio."]
    out += ["", "### Prueba de laboratorio", "", LAB_CONDITION + ".", ""]
    out += _table(comp.rows_of("laboratorio"), date_b, date_a)
    out += ["", "### Servidor", "", SERVER_CONDITION + ".", ""]
    out += _table(comp.rows_of("servidor"), date_b, date_a)

    out += ["", "## Protecciones y correo del dominio", ""]
    out += _table(comp.rows_of("seguridad"), date_b, date_a)
    out += ["", "| Protección del correo | Antes · " + date_b + " | Después · " + date_a + " | Cambio |", "|---|---|---|---|"]
    for r in comp.rows_of("correo"):
        change = r.change if r.compared else f"{NOT_COMPARED}: {r.reason}"
        out.append(f"| {_cell(r.label)} | {_cell(r.before.text)} | {_cell(r.after.text)} | {_cell(change)} |")

    out += ["", "## Chequeos aprobados", "",
            "Aprobados sobre los que aplican al sitio. Un chequeo que no se pudo ver cuenta entre los que aplican "
            "y nunca como aprobado.", "",
            f"| Parte | Antes · {date_b} | Después · {date_a} |", "|---|---|---|"]
    for module, name in (*MODULE_NAMES, ("TOTAL", "Total")):
        cb, ca = comp.counts_before.get(module), comp.counts_after.get(module)
        if cb is None or ca is None:
            continue
        out.append(f"| {name} | {_passed_text(cb)} | {_passed_text(ca)} |")

    out += ["", "## Qué cambió de color", ""]
    if not comp.transitions:
        out.append("Ningún chequeo cambió de color.")
    for kind, title in (("mejoro", "Mejoraron"), ("empeoro", "Empeoraron"), ("otro", "Otros cambios")):
        group = [t for t in comp.transitions if t.kind == kind]
        if not group:
            continue
        out += [f"### {title} ({len(group)})", "", f"| Chequeo | Antes · {date_b} | Después · {date_a} |", "|---|---|---|"]
        for t in group:
            out.append(f"| {_cell(t.name)} | {_colour_text(t.before)} | {_colour_text(t.after)} |")
        out.append("")
    if comp.transitions and not worse:
        out += ["Ningún chequeo empeoró.", ""]
    if out[-1] != "":
        out.append("")

    out += ["## Lo que queda", ""]
    if not comp.open_after:
        out.append(f"Todos los chequeos que aplican están bien el {date_a}.")
    else:
        out += [f"Lo que el {date_a} no está bien, ordenado por color: primero lo que hay que arreglar ya y al final lo que no se pudo ver.", "",
                "| Chequeo | Estado | Qué se encontró |", "|---|---|---|"]
        for r in comp.open_after:
            out.append(f"| {_cell(r['nombre'])} | {_colour_text(r['color'])} | {_cell(r['que_se_encontro'])} |")

    out += ["", "## Cómo se comparó"]
    how: list[str] = []
    tools_b = [str(t) for t in b.meta.get("herramientas") or []]
    tools_a = [str(t) for t in a.meta.get("herramientas") or []]
    if tools_b == tools_a:
        how.append(f"Herramientas, las mismas en las dos fechas: {_list_es(tools_a)}.")
    else:
        how.append(f"Herramientas que respondieron el {date_b}: {_list_es(tools_b)}. El {date_a}: {_list_es(tools_a)}.")
    cond_b, cond_a = str(b.meta.get("condiciones") or ""), str(a.meta.get("condiciones") or "")
    if cond_b == cond_a:
        how.append(f"Condiciones, las mismas en las dos fechas: {cond_a}.")
    else:
        how.append(f"Condiciones del {date_b}: {cond_b}. Del {date_a}: {cond_a}.")
    lh_b, lh_a = b.meta.get("version_lighthouse"), a.meta.get("version_lighthouse")
    if lh_b and lh_a:
        if lh_b == lh_a:
            how.append(f"Prueba de laboratorio de Google: Lighthouse {lh_a} en las dos fechas.")
        else:
            how.append(f"Prueba de laboratorio de Google: Lighthouse {lh_b} antes y {lh_a} después, la misma versión principal.")
    how.append(
        "La prueba de laboratorio carga la página con la caché del navegador vacía. Los datos de usuarios reales "
        "son de Google y no se mezclan con la prueba de laboratorio: si faltan en una fecha, la fila dice "
        "sin datos de campo y no se compara."
    )
    for paragraph in how:
        out += ["", paragraph]
    out += ["", "---", "",
            f"Comparación generada con site-check {__version__} a partir de los datos guardados de las dos mediciones, "
            "sin inteligencia artificial: los mismos dos archivos dan siempre este texto."]
    return "\n".join(out) + "\n"


def comparison_to_datos(comp: Comparison, issues: list[dict[str, Any]], code: ExitCode) -> dict[str, Any]:
    def side(run: StoredRun, counts: dict[str, dict[str, int]]) -> dict[str, Any]:
        return {
            "dominio": run.meta.get("dominio"),
            "url_canonica": run.meta.get("url_canonica"),
            "inicio_utc": run.meta.get("inicio_utc"),
            "version_script": run.meta.get("version_script"),
            "version_lighthouse": run.meta.get("version_lighthouse"),
            "corridas_psi": run.meta.get("corridas_psi"),
            "condiciones": run.meta.get("condiciones"),
            "herramientas": run.meta.get("herramientas"),
            "por_modulo": counts,
        }

    return {
        "schema_version": COMPARISON_SCHEMA,
        "version_script": __version__,
        "antes": side(comp.before, comp.counts_before),
        "despues": side(comp.after, comp.counts_after),
        "dias_entre_mediciones": comp.days_between,
        "filas": [r.to_datos() for r in comp.rows],
        "transiciones": [t.to_datos() for t in comp.transitions],
        "quedan": comp.open_after,
        "salida": {"codigo": int(code), "nombre": code.name, "control_texto": issues},
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run_compare(before_path: Path, after_path: Path, *, stdout: IO[str], stderr: IO[str]) -> ExitCode:
    """Load, check, compare, write. Returns the exit code."""
    try:
        before, after = load_run(before_path), load_run(after_path)
    except ValueError as exc:
        print(f"Usage error: --compare: {exc}", file=stderr)
        return ExitCode.USAGE
    if before.folder.resolve() == after.folder.resolve():
        print("Usage error: --compare needs two different runs", file=stderr)
        return ExitCode.USAGE
    problems = comparability_problems(before, after)
    if problems:
        print("The two runs cannot be compared, so nothing was written:", file=stderr)
        for problem in problems:
            print(f"  - {problem}", file=stderr)
        print("Measure again with the same options, or compare runs taken with the same ones.", file=stderr)
        return ExitCode.NOT_COMPARABLE

    comp = build_comparison(before, after)
    text = render_comparison(comp)
    issues = [i.to_datos() for i in lint_text(text, name=REPORT)]
    code = ExitCode.TEXT_CONTROL if issues else ExitCode.OK
    write_text(after.folder / REPORT, text)
    write_text(after.folder / DATA, dumps_datos(comparison_to_datos(comp, issues, code)))
    for issue in issues:
        print(f"Text control: {issue['archivo']}:{issue['linea']} {issue['regla']}: {issue['extracto']}", file=stderr)
    total_b, total_a = comp.counts_before["TOTAL"], comp.counts_after["TOTAL"]
    print(f"site-check compare {after.meta.get('dominio')}: exit {int(code)}.", file=stdout)
    print(f"Report: {after.folder / REPORT}", file=stdout)
    print(f"Checks passed: {total_b['aprobados']}/{total_b['aplicables']} before, "
          f"{total_a['aprobados']}/{total_a['aplicables']} after; {len(comp.transitions)} colour changes.", file=stdout)
    not_compared = [r.key for r in comp.rows if not r.compared]
    if not_compared:
        print(f"Rows not compared (reason in the report): {', '.join(not_compared)}.", file=stdout)
    return code
