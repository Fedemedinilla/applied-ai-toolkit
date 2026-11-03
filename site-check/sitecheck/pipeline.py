"""The run, end to end: from a RunConfig to the files of the run folder and an exit code.

Steps:
 0. configuration that can fail before any request: --overrides (colours.load_overrides),
    the registrable domain D of the URL, --inner-page/--form-page on D -> exit 2;
 1. exclusion list on the input host and D (exclusions.load): a match -> exit 10
    with ZERO requests and no folder created; an unreadable line -> exit 2;
 1b. evidence retention (outputs.prune_old_evidence): the evidencia/ folders of
    run folders more than 30 days old under the output root, and nothing else;
 2. dedupe warning (exclusions.prior_runs);
 3. run folder (outputs.create_run_dir) and services (services.build_services);
    --no-pagespeed swaps the PSI and CrUX clients for stubs that never send;
 4. collect (collect.collect) with the exclusion callback for the canonical host;
    ScopeError -> abort, write datos.json with what exists, exit 50 (only a
    request the tool itself built; a redirect the site issues to a denied path
    is refused without raising);
    home_unreachable -> every check that needs the site NO_VERIFICADO (the ones
    measured without it, SITE_INDEPENDENT_CHECKS, keep their result), exit 3;
    the reason says why (moved to another domain and where, a login page, the
    anti-bot check, "bajar el ritmo", an inconclusive TLS check);
 5. evaluate (evaluate.evaluate_all) with EvalContext(run_date, institution, kind,
    artifacts_written, pages) and the --overrides colours;
 6. render informe.md and anexo-tecnico.md; 00-tiempo.txt;
 7. text control (textlint.lint_files) and output sweeps (outputs.sweep_secrets,
    outputs.foreign_emails); a problem is exit 4 and is listed in datos.json;
 8. datos.json last (it records the exit code and the control issues); e-mail
    addresses and the key are masked in it before writing (either counts as a
    control failure);
 9. print a short summary on stdout (folder, counts, outcome) and return.

--rerender: steps 5 (recolour only), 6, 7 and 8 from an existing datos.json.
No Services are built, no request is made, the evidence folder is read-only and
00-tiempo.txt is kept. A report file whose text changes is kept as
"<name>-anterior-<n><ext>" before being replaced: nothing edited by hand is lost.
The same datos.json always renders the same report: that is the determinism
the tests pin down.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import platform
import re
import ssl
import sys
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, TYPE_CHECKING, Any

from . import SCHEMA_VERSION, __version__, fmt, outputs
from .exitcodes import DESCRIPTION, ExitCode, OutcomeFlags, resolve
from .fmt import ART

if TYPE_CHECKING:
    from .checks.header import GoogleSummary
    from .checks.tables import MailAuthTable, VelocityTable
    from .config import RunConfig
    from .credentials import Redactor
    from .model import Finding
    from .observations import Observations
    from .services import Services

REASON_HOME_DOWN = "la página principal no respondió y la corrida se detuvo"
REASON_HOME_CHALLENGE = "la verificación anti-bot del hosting frenó la corrida"
REASON_HOME_THROTTLE = "el sitio pidió bajar el ritmo y la corrida se detuvo"
REASON_HOME_PRIVATE = "la página principal lleva a una pantalla de acceso privado (inicio de sesión) y la corrida se detuvo"
REASON_HOME_TLS = (
    "la conexión segura de la página principal no se pudo comprobar desde esta computadora y la corrida se detuvo; "
    "se revisa en un navegador"
)
REASON_HOME_MOVED = "la dirección redirige a {target}, que es otro dominio; hay que volver a medir con esa dirección"

# A wrapper home (gate.home_wrapper): for the operator (console, datos.json),
# never a report sentence. What it is, then what to measure instead. The tool
# measures only home pages without a path (cli.py): a target with a path is
# checked in a browser.
WRAPPER_WHAT: dict[str, str] = {
    "meta-refresh": "la página principal redirige a {target} con una etiqueta meta refresh",
    "js-redirect": "la página principal redirige a {target} con un script",
    "frameset": "la página principal muestra {target} dentro de un marco (frameset)",
    "iframe": "la página principal muestra {target} dentro de un marco (iframe)",
}
WRAPPER_SPA = (
    "la página principal llega casi vacía ({n} caracteres de texto y ningún enlace al sitio): el contenido lo arma "
    "un programa en el navegador y esta medición no lo ejecuta"
)
WRAPPER_FRAME_NO_TARGET = "la página principal muestra otra página dentro de un marco"
WRAPPER_MEASURE = "hay que volver a medir con esa dirección"
WRAPPER_OTHER_DOMAIN = "es otro dominio; hay que volver a medir con esa dirección"
WRAPPER_PATH = (
    "la herramienta mide solo páginas principales sin ruta (como {root}), así que esa dirección se revisa en un navegador"
)
WRAPPER_IN_BROWSER = "el sitio se revisa en un navegador"
WRAPPER_TODO_MEASURE = (
    "Measure again with {target}, the page the visitor sees. This run describes only the page in between: do not "
    "hand out this report."
)
WRAPPER_TODO_BROWSER = (
    "Check {what} in a browser. This run describes only the page in between: do not hand out this report."
)
WRAPPER_TODO_SPA = (
    "Check the site in a browser. This run describes only what arrives before the browser builds the page: do not "
    "hand out this report."
)

# Exit 3 keeps what does not depend on reading the home:
# PageSpeed (its own load), the domain's DNS, RDAP and DBL, and the TLS probe.
SITE_INDEPENDENT_CHECKS: frozenset[str] = frozenset({"EXT-08", "EXT-21", "EXT-05", "EXT-13", "EXT-23", "EXT-07"})
REASON_PSI_SKIPPED = "la medición de velocidad no se pidió en esta corrida"
REASON_SUMMARY_UNREADABLE = "el resumen de Google no se pudo releer de datos.json"

_CONSOLE_CONTROL_RE = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")

TOOL_PSI = "la herramienta de velocidad de Google (PageSpeed)"
TOOL_CRUX = "los datos de usuarios reales de Chrome (Google)"
TOOL_SITE = "la lectura de las respuestas del servidor"
TOOL_DNS = "la consulta del DNS del dominio"
TOOL_RDAP = "la consulta pública del registro del dominio"
TOOL_DBL = "la lista de bloqueo de Spamhaus"
TOOL_WP = "la lista pública de versiones de WordPress"
TOOL_OBSERVATORY = "la prueba de cabeceras de Mozilla"


@dataclass
class RunOutcome:
    exit_code: ExitCode
    run_dir: Path | None = None
    datos_path: Path | None = None
    messages: list[str] = field(default_factory=list)  # what was printed, for tests


# ---------------------------------------------------------------------------
# Console and run state
# ---------------------------------------------------------------------------


class _Console:
    def __init__(self, out: IO[str] | None, err: IO[str] | None) -> None:
        self.out = out if out is not None else sys.stdout
        self.err = err if err is not None else sys.stderr
        self.messages: list[str] = []
        self.redactor: "Redactor | None" = None

    def _clean(self, text: str) -> str:
        # Terminal control characters (ESC, BEL, C1...) from site text never reach
        # the console; newlines and tabs stay.
        text = _CONSOLE_CONTROL_RE.sub("?", str(text))
        if self.redactor is not None:
            try:
                return self.redactor.scrub(text)
            except Exception:  # noqa: BLE001 - printing must never fail the run
                return text
        return text

    def say(self, text: str) -> None:
        text = self._clean(text)
        print(text, file=self.out, flush=True)
        self.messages.append(text)

    def warn(self, text: str) -> None:
        text = self._clean(text)
        print(text, file=self.err, flush=True)
        self.messages.append(text)

    def progress(self, text: str) -> None:
        print(f"  {self._clean(text)}", file=self.err, flush=True)


@dataclass
class _State:
    config: "RunConfig"
    started: dt.datetime
    domain: str | None = None
    input_host: str | None = None
    paths: outputs.RunPaths | None = None
    services: "Services | None" = None
    obs: "Observations | None" = None
    excluded_entry: str | None = None
    canonical_entry: str | None = None
    prior: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    datos_written: bool = False


def _now_utc() -> dt.datetime:
    return fmt.now_utc()


def _iso_utc(moment: dt.datetime) -> str:
    return moment.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def _iso_local(moment: dt.datetime) -> str:
    return moment.astimezone(ART).isoformat(timespec="seconds")


def _safe(fn: Callable[[], Any], default: Any, errors: list[str], what: str) -> Any:
    """Call an accessor of another module; a failure is recorded, never fatal."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{what}: {type(exc).__name__}: {exc}")
        return default


def _scrub(redactor: "Redactor | None", text: str) -> str:
    if redactor is None:
        return text
    try:
        return redactor.scrub(text)
    except Exception:  # noqa: BLE001
        return text


# ---------------------------------------------------------------------------
# --no-pagespeed: stubs that never send a request
# ---------------------------------------------------------------------------


class _SkippedPsi:
    """Stands in for psi.PsiClient when --no-pagespeed is given."""

    def __init__(self, key_present: bool) -> None:
        self.key_present = key_present

    def run_once(self, url: str, strategy: str, n: int) -> Any:
        from .psi import PsiRun

        return PsiRun(strategy=strategy, n=n, ok=False, error="skipped-option")

    def run_series(self, url: str, runs: int = 3, stop: Any = None) -> Any:
        from .psi import PsiSeries

        return PsiSeries(status="omitido", reason=REASON_PSI_SKIPPED, key_present=self.key_present)


class _SkippedCrux:
    """Stands in for crux.CruxClient when --no-pagespeed is given."""

    def field_for(self, page_url: str, origin: str) -> None:
        return None


def _disable_psi(services: "Services") -> None:
    key_present = bool(getattr(getattr(services, "key", None), "present", False))
    services.psi = _SkippedPsi(key_present)  # type: ignore[assignment]
    services.crux = _SkippedCrux()  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Derived facts for the report and datos.json
# ---------------------------------------------------------------------------


def _tools_used(obs: "Observations") -> list[str]:
    tools: list[str] = []
    psi = obs.psi
    if psi is not None:
        valid = [r for r in (getattr(psi, "mobile", None) or []) if getattr(r, "ok", False)]
        desktop_ok = bool(getattr(getattr(psi, "desktop", None), "ok", False))
        field_from_psi = getattr(getattr(psi, "field_data", None), "source", "") == "psi"
        if valid or desktop_ok or field_from_psi:
            tools.append(TOOL_PSI)
    if obs.crux_field is not None and getattr(obs.crux_field, "source", "") == "crux":
        tools.append(TOOL_CRUX)
    home_resp = obs.home.response if obs.home is not None else None
    if home_resp is not None and home_resp.status is not None and not home_resp.challenge:
        tools.append(TOOL_SITE)
    if obs.dns is not None and getattr(obs.dns, "site", None) is not None:
        tools.append(TOOL_DNS)
    if obs.rdap is not None and getattr(obs.rdap, "expiration", None):
        tools.append(TOOL_RDAP)
    verdict = str(getattr(obs.dbl, "verdict", "") or "")
    if verdict in ("listed", "not-listed"):
        tools.append(TOOL_DBL)
    if obs.wp_status is not None and getattr(obs.wp_status, "fetched", False):
        tools.append(TOOL_WP)
    if obs.observatory is not None and not getattr(obs.observatory, "error", None):
        tools.append(TOOL_OBSERVATORY)
    return tools


def _conditions(obs: "Observations") -> str:
    from .render_report import number_word

    parts: list[str] = []
    psi = obs.psi
    valid = len([r for r in (getattr(psi, "mobile", None) or []) if getattr(r, "ok", False)]) if psi else 0
    desktop_ok = bool(psi is not None and getattr(getattr(psi, "desktop", None), "ok", False))
    if valid:
        if valid == 1:
            mobile = "celular, una corrida"
        else:
            how = "con el valor del medio" if valid % 2 == 1 else "con el menor de los dos valores del medio"
            mobile = f"celular, {number_word(valid)} corridas {how}"
        parts.append(mobile + (", y computadora, una corrida" if desktop_ok else ""))
    elif desktop_ok:
        parts.append("computadora, una corrida")
    site = [s for s in obs.ttfb.site if s.ttfb_ms is not None]
    control = [s for s in obs.ttfb.control if s.ttfb_ms is not None]
    if site:
        times = "una vez" if len(site) == 1 else f"{number_word(len(site))} veces"
        text = f"tiempo del servidor medido {times}"
        if control:
            text += ", con un sitio de control en el mismo momento"
        parts.append(text)
    return "; ".join(parts)


def _site_minutes(services: "Services", errors: list[str]) -> int:
    window = _safe(services.log.site_window, (None, None), errors, "requestlog.site_window")
    first, last = window if isinstance(window, tuple) and len(window) == 2 else (None, None)
    if not first or not last:
        return 0
    try:
        seconds = (dt.datetime.fromisoformat(last) - dt.datetime.fromisoformat(first)).total_seconds()
    except (TypeError, ValueError):
        return 0
    return max(1, int((max(seconds, 0.0) + 30) // 60))


def _psi_facts(obs: "Observations | None", config: "RunConfig") -> tuple[dict[str, Any], str | None]:
    psi = obs.psi if obs is not None else None
    mobile = list(getattr(psi, "mobile", None) or []) if psi is not None else []
    valid = [r for r in mobile if getattr(r, "ok", False)]
    desktop = getattr(psi, "desktop", None) if psi is not None else None
    runs = {
        "pedidas": config.psi_runs if config.psi_enabled else 0,
        "validas": len(valid),
        "computadora_valida": bool(getattr(desktop, "ok", False)),
        "estado": getattr(psi, "status", None) if psi is not None else None,
    }
    version = None
    for run in [getattr(psi, "median_run", None), *valid, desktop]:
        version = getattr(run, "lighthouse_version", None) if run is not None else None
        if version:
            break
    return runs, version


def _event_to_datos(event: Any) -> Any:
    if dataclasses.is_dataclass(event) and not isinstance(event, type):
        return dataclasses.asdict(event)
    return str(event)


def _sanitize_raw(obj: Any) -> Any:
    """Raw diagnostic data (URL lists, error lines): e-mails and phone-like digit runs masked.

    Expected content there (a refused mailto: link, a wa.me/549... link), so the
    masking is silent; e-mails anywhere else in datos.json are a control failure.
    Every string also goes through artifacts.mask_personal_data, so an
    /author/<user>/ path never reaches meta.alcance.
    """
    from .artifacts import mask_personal_data

    masked, _ = outputs.mask_foreign_emails(obj)
    masked = outputs.mask_long_digit_runs(masked)

    def walk(value: Any) -> Any:
        if isinstance(value, str):
            return mask_personal_data(value)
        if isinstance(value, dict):
            return {k: walk(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [walk(v) for v in value]
        return value

    return walk(masked)


def _runtime_versions() -> dict[str, str]:
    """The interpreter and library versions recorded in datos.json (meta)."""
    import pyexpat

    return {
        "version_python": platform.python_version(),
        "version_openssl": ssl.OPENSSL_VERSION,
        "version_expat": pyexpat.EXPAT_VERSION,
    }


def _build_meta(state: _State, finished: dt.datetime, extra: dict[str, Any]) -> dict[str, Any]:
    from .httpclient import USER_AGENT

    config, obs, services = state.config, state.obs, state.services
    errors = state.errors
    psi_runs, lh_version = _psi_facts(obs, config)
    meta: dict[str, Any] = {
        "version_script": __version__,
        **_runtime_versions(),
        "url_entrada": config.url,
        "dominio": state.domain,
        "url_canonica": obs.canonical_url if obs is not None else None,
        "url_interna": obs.interna.url if obs is not None and obs.interna is not None else None,
        "origen_interna": obs.interna_source if obs is not None else None,
        "institucion": config.institution,
        "tipo": config.kind,
        "tipo_explicito": config.kind_explicit,
        "para": config.para,
        "inicio_utc": _iso_utc(state.started),
        "fin_utc": _iso_utc(finished),
        "inicio_local": _iso_local(state.started),
        "fin_local": _iso_local(finished),
        "user_agent": USER_AGENT,
        "pedidos": _safe(services.log.counts, {}, errors, "requestlog.counts") if services else {},
        "eventos_desafio": _sanitize_raw([_event_to_datos(e) for e in obs.challenge_events]) if obs is not None else [],
        "sitio_cortado": bool(obs.blocked) if obs is not None else False,
        "tope_agotado": bool(obs.budget_exhausted) if obs is not None else False,
        "clave": _safe(services.key.as_datos, None, errors, "credentials.as_datos") if services else None,
        "corridas_psi": psi_runs,
        "version_lighthouse": lh_version,
        "alcance": _sanitize_raw(_safe(services.guard.describe, {}, errors, "scope.describe")) if services else {},
        "corridas_previas": list(state.prior),
        "excluido": state.excluded_entry or state.canonical_entry,
        "modo_prueba": config.test_mode,
        "portada_no_respondio": bool(obs.home_unreachable) if obs is not None else False,
        "sin_pagespeed": not config.psi_enabled,
        "pausa_segundos": config.pace_seconds,
        "max_pedidos": config.site_budget,
        "omitidos": _sanitize_raw(
            [{"proposito": s.purpose, "url": s.url, "motivo": s.reason} for s in obs.skipped] if obs is not None else []
        ),
    }
    meta.update(extra)
    redactor = services.redactor if services is not None else None
    collected = list(obs.errors) if obs is not None else []
    meta["errores"] = _sanitize_raw([_scrub(redactor, e) for e in [*collected, *errors]])
    return meta


def _tables_to_datos(velocity: "VelocityTable", mail_auth: "MailAuthTable") -> dict[str, Any]:
    def rows(table: Any) -> list[dict[str, str]]:
        return [{"que": r.what, "valor": r.value, "significa": r.meaning} for r in table.rows]

    return {
        "velocidad": {
            "intro": velocity.intro,
            "filas": rows(velocity),
            "nota_laboratorio": velocity.lab_note,
            "atribucion": velocity.attribution,
        },
        "correo": {"filas": rows(mail_auth), "nota_no_aplica": mail_auth.not_applicable_note},
    }


def _tables_from_datos(tablas: Any) -> tuple["VelocityTable", "MailAuthTable"]:
    from .checks.tables import MailAuthTable, TableRow, VelocityTable

    tablas = tablas if isinstance(tablas, dict) else {}
    vel = tablas.get("velocidad") if isinstance(tablas.get("velocidad"), dict) else {}
    mail = tablas.get("correo") if isinstance(tablas.get("correo"), dict) else {}

    def rows(section: dict[str, Any]) -> list[Any]:
        out = []
        for r in section.get("filas") or []:
            if isinstance(r, dict):
                out.append(TableRow(str(r.get("que", "")), str(r.get("valor", "")), str(r.get("significa", ""))))
        return out

    return (
        VelocityTable(
            intro=str(vel.get("intro") or ""),
            rows=rows(vel),
            lab_note=vel.get("nota_laboratorio"),
            attribution=vel.get("atribucion"),
        ),
        MailAuthTable(rows=rows(mail), not_applicable_note=mail.get("nota_no_aplica")),
    )


_SIDE_KEYS = (("mobile", "celular", "movil", "móvil"), ("desktop", "computadora", "escritorio"))
_CATEGORY_ALIASES = {
    "performance": "performance",
    "rendimiento": "performance",
    "accessibility": "accessibility",
    "accesibilidad": "accessibility",
    "best-practices": "best-practices",
    "best_practices": "best-practices",
    "buenas-practicas": "best-practices",
    "buenas_practicas": "best-practices",
    "buenas prácticas": "best-practices",
    "seo": "seo",
}


def _summary_from_datos(enc: Any) -> "GoogleSummary":
    """Rebuild the report header from datos.json "encabezado" (GoogleSummary.to_datos) for --rerender.

    Tolerant on purpose: GoogleSummary has no from_datos in the contract, so
    English (dataclass) and Spanish key spellings are both read.
    """
    from .checks.header import BANDS, MISSING_SHAPE, GoogleSummary, ScoreCell

    if not isinstance(enc, dict):
        return GoogleSummary(reason=REASON_SUMMARY_UNREADABLE)

    def band(score: int) -> tuple[str, str]:
        for lo, hi, shape, label in BANDS:
            if lo <= score <= hi:
                return shape, label
        return "", ""

    def to_cell(value: Any) -> Any:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            shape, label = band(int(value))
            return ScoreCell(int(value), shape, label)
        if not isinstance(value, dict):
            return None
        score = value.get("score", value.get("puntaje"))
        score = int(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else None
        shape = value.get("shape") or value.get("forma") or ""
        label = value.get("label") or value.get("rotulo") or value.get("rótulo") or ""
        reason = value.get("reason") or value.get("motivo")
        if score is not None and not shape:
            shape, label = band(score)
        if score is None and not shape:
            shape = MISSING_SHAPE
        return ScoreCell(score, str(shape), str(label), reason)

    sides: list[dict[str, Any]] = []
    for names in _SIDE_KEYS:
        raw = next((enc[n] for n in names if isinstance(enc.get(n), dict)), {})
        side: dict[str, Any] = {}
        for key, value in raw.items():
            cat = _CATEGORY_ALIASES.get(str(key).lower())
            c = to_cell(value)
            if cat and c is not None:
                side[cat] = c
        sides.append(side)
    reason = enc.get("reason") or enc.get("motivo")
    if not sides[0] and not sides[1] and not reason:
        reason = REASON_SUMMARY_UNREADABLE
    return GoogleSummary(mobile=sides[0], desktop=sides[1], reason=reason)


def _resumen(findings: list["Finding"]) -> dict[str, Any]:
    from .render_report import count_colours

    counts = count_colours(findings)
    by_state: dict[str, int] = {}
    for f in findings:
        key = str(f.state)
        by_state[key] = by_state.get(key, 0) + 1
    return {
        "por_color": {
            "rojo": counts.rojo,
            "amarillo": counts.amarillo,
            "azul": counts.azul,
            "verde": counts.verde,
            "gris": counts.gris,
        },
        "aplicables": counts.aplicables,
        "no_aplica": counts.no_aplica,
        "total": len(findings),
        "por_estado": by_state,
    }


def _findings_to_datos(findings: list["Finding"], errors: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for f in findings:
        try:
            out.append(f.to_datos())
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{f.id}: to_datos failed: {type(exc).__name__}: {exc}")
            out.append({"id": f.id, "estado": str(f.state), "color_final": str(f.colour) if f.colour else None})
    return out


# ---------------------------------------------------------------------------
# Finding helpers
# ---------------------------------------------------------------------------


def _force_unverified(findings: list["Finding"], reason: str, keep: frozenset[str] = frozenset()) -> None:
    """Exit 3: every applicable check becomes NO_VERIFICADO with the run's reason.

    The checks in ``keep`` (measured without the home: PageSpeed, DNS, RDAP,
    DBL, TLS) keep their evaluation, so the report never shows a measured
    number next to "no se pudo medir".
    """
    from .colours import colour_finding
    from .model import ReportPhrase, State

    for f in findings:
        if f.state == State.NO_APLICA or f.id in keep:
            continue
        f.state = State.NO_VERIFICADO
        f.reason = reason
        f.colour_exception = None
        f.phrase_report = ReportPhrase(found=reason)
        colour_finding(f, None)


def _grey_findings(reason: str) -> list["Finding"]:
    """Every registry check as NO_VERIFICADO (exit 3 when evaluation itself failed)."""
    from . import registry
    from .colours import colour_finding
    from .model import Finding, ReportPhrase, State

    out = []
    for spec in registry.all_specs():
        f = Finding(
            id=spec.id,
            name_plain=spec.name_plain,
            module=spec.module,
            priority=spec.priority,
            state=State.NO_VERIFICADO,
            reason=reason,
            phrase_report=ReportPhrase(found=reason),
        )
        colour_finding(f, None)
        out.append(f)
    return out


# ---------------------------------------------------------------------------
# Rendering, control and datos.json (shared by run and rerender)
# ---------------------------------------------------------------------------


@dataclass
class _Rendered:
    issues: list[Any] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)


def _preserve(path: Path, new_text: str | None) -> None:
    """--rerender: keep a changed or obsolete report file as <stem>-anterior-<n><suffix>."""
    if not path.exists():
        return
    if new_text is not None:
        current = path.read_bytes().decode("utf-8", errors="replace")
        if current == new_text.replace("\r\n", "\n") or current == new_text + "\n":
            return
    n = 1
    while True:
        target = path.with_name(f"{path.stem}-anterior-{n}{path.suffix}")
        if not target.exists():
            path.rename(target)
            return
        n += 1


CUT_NOTE_GREY = "La medición del sitio se cortó a mitad de camino ({cause}): quedaron en gris por eso {ids}."
CUT_NOTE_NONE = "La medición del sitio se cortó a mitad de camino ({cause}); ningún chequeo quedó en gris por eso."
CUT_CAUSE_ANTIBOT = "la verificación anti-bot del hosting"
CUT_CAUSE_THROTTLE = "el sitio pidió bajar el ritmo"


def _cut_note(cut: bool, findings: list["Finding"], throttle: bool | None = None) -> str | None:
    """One Spanish line for the operator when the host was cut mid-run: which checks it greyed.

    ``throttle`` None (a --rerender) reads the cause from the grey reasons.
    """
    if not cut:
        return None
    from .checks.common import REASON_ANTIBOT, REASON_THROTTLE
    from .model import State
    from .render_report import join_es

    greys = [
        f for f in findings
        if f.state == State.NO_VERIFICADO and f.reason and (REASON_ANTIBOT in f.reason or REASON_THROTTLE in f.reason)
    ]
    if throttle is None:
        throttle = any(REASON_THROTTLE in (f.reason or "") for f in greys)
    cause = CUT_CAUSE_THROTTLE if throttle else CUT_CAUSE_ANTIBOT
    ids = [f.id for f in greys]
    return CUT_NOTE_GREY.format(cause=cause, ids=join_es(ids)) if ids else CUT_NOTE_NONE.format(cause=cause)


def _write_client_files(paths: outputs.RunPaths, report_text: str, annex_text: str, *, rerender: bool) -> None:
    for path, text in ((paths.informe, report_text), (paths.anexo, annex_text)):
        if rerender:
            _preserve(path, text)
        outputs.write_text(path, text)


def _allowed_emails(findings: list["Finding"]) -> frozenset[str]:
    """The run's institutional role addresses (VIS-21), in the forms the e-mail control finds."""
    from .checks.contact import institutional_addresses

    return outputs.allowed_email_forms(institutional_addresses(findings))


def _control(
    paths: outputs.RunPaths, redactor: "Redactor | None", *, sweep: bool, allowed_emails: frozenset[str] = frozenset()
) -> _Rendered:
    from .textlint import LintIssue, lint_files

    result = _Rendered()
    result.issues = lint_files(paths.client_files(), redactor=redactor, allowed_emails=allowed_emails)
    if sweep and redactor is not None:
        for leaked in outputs.sweep_secrets(paths.root, redactor):
            rel = leaked.relative_to(paths.root).as_posix()
            result.issues.append(LintIssue(file=rel, line=0, rule="clave", excerpt="file deleted: it contained the key"))
            result.deleted.append(rel)
    return result


def _finalize_datos(
    datos: dict[str, Any], redactor: "Redactor | None", allowed_emails: frozenset[str] = frozenset()
) -> tuple[dict[str, Any], list[str]]:
    """Mask foreign e-mails (and the key) in datos.json; return the problems found (English).

    ``allowed_emails``: the run's institutional role addresses (_allowed_emails), never masked.
    """
    problems: list[str] = []
    masked, emails = outputs.mask_foreign_emails(datos, allowed_emails)
    if emails:
        problems.append(f"{len(emails)} foreign e-mail address(es) masked in datos.json")
    if redactor is not None:
        try:
            if redactor.contains_secret(outputs.dumps_datos(masked)):
                masked = redactor.scrub_json(masked)
                problems.append("a secret was scrubbed from datos.json")
        except Exception:  # noqa: BLE001
            pass
    return masked, problems


def _datos_issue(problem: str) -> dict[str, Any]:
    rule = "clave" if "secret" in problem else "correo"
    return {"archivo": outputs.DATOS, "linea": 0, "regla": rule, "extracto": problem}


def _summary_lines(
    domain: str,
    paths: outputs.RunPaths | None,
    findings: list["Finding"],
    hack_reasons: list[str],
    code: ExitCode,
    clave: Any,
    notes: list[str | None] | None = None,
) -> list[str]:
    """The console summary; ``notes`` (Spanish, for the operator) go last: the mid-run cut, a rejected key."""
    from .render_report import count_colours

    lines = [f"site-check {domain}: exit {int(code)} ({DESCRIPTION.get(code, code.name)})."]
    if paths is not None:
        lines.append(f"Folder: {paths.root}")
        if findings:
            lines.append(f"Report: {paths.informe}")
    if findings:
        c = count_colours(findings)
        lines.append(
            f"{c.aplicables} applicable checks: ▲ {c.rojo} · ■ {c.amarillo} · ◆ {c.azul} · ● {c.verde} · ○ {c.gris} "
            f"(not applicable: {c.no_aplica})."
        )
    if hack_reasons:
        lines.append("Warning: signs that the site was compromised (" + "; ".join(hack_reasons) + ").")
    if clave is not None:
        # datos.json keeps the Spanish value; the console says it in English.
        shown = {"presente": "present", "ausente": "absent"}.get(str(clave), str(clave))
        lines.append(f"PageSpeed key: {shown}.")
    for note in notes or []:
        if note:
            lines.append(f"Note: {note}" + ("" if note.endswith(".") else "."))
    return lines


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------


def run(
    config: "RunConfig",
    *,
    services_factory: Callable[..., "Services"] | None = None,
    sleeper: Callable[[float], None] = time.sleep,
    stdout: IO[str] | None = None,
    stderr: IO[str] | None = None,
) -> RunOutcome:
    """Execute steps 0 to 9. ``services_factory`` defaults to services.build_services
    (tests inject fakes). Never lets an exception escape except KeyboardInterrupt;
    uncaught errors become ExitCode.UNEXPECTED with a redacted message."""
    con = _Console(stdout, stderr)
    state = _State(config=config, started=_now_utc())
    try:
        return _run(state, con, services_factory, sleeper)
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001
        return _unexpected(state, con, exc)


def _usage(con: _Console, message: str) -> RunOutcome:
    con.warn(f"Usage error: {message}")
    return RunOutcome(ExitCode.USAGE, messages=con.messages)


def _run(
    state: _State,
    con: _Console,
    services_factory: Callable[..., "Services"] | None,
    sleeper: Callable[[float], None],
) -> RunOutcome:
    from . import exclusions
    from .domains import host_of, is_same_site, site_domain

    config = state.config

    # 0. Everything that can fail before any request.
    overrides = None
    if config.overrides is not None:
        from .colours import load_overrides

        try:
            overrides = load_overrides(config.overrides)
        except (ValueError, OSError) as exc:
            return _usage(con, f"--overrides could not be used: {exc}")
    try:
        state.input_host = host_of(config.url)
        state.domain = site_domain(state.input_host)  # the site's own domain, not its platform's
    except ValueError as exc:
        return _usage(con, f"the URL has no valid domain: {exc}")
    for option, url in (("--inner-page", config.interna), ("--form-page", config.form_page)):
        if url and not is_same_site(url, state.domain):
            return _usage(con, f"{option} must be on {state.domain}")

    # 1. The exclusion list, before any request. A line that cannot be read
    # stops the run: the list never fails open.
    lst = exclusions.load([config.exclude, config.out_root / exclusions.EXCLUDE_FILE])
    if lst.problems:
        return _usage(con, lst.problems_message())
    state.excluded_entry = lst.match(state.input_host) or lst.match(state.domain)
    if state.excluded_entry:
        con.say(
            f"{state.domain} is on the exclusion list ({state.excluded_entry}): no request was made "
            f"and no folder was created. Exit {int(ExitCode.EXCLUDED)}."
        )
        return RunOutcome(ExitCode.EXCLUDED, messages=con.messages)

    # 1b. Evidence retention: the evidencia/ folders of runs more than 30 days
    # old, and nothing else, before measuring.
    run_date = state.started.astimezone(ART).date()
    pruned = outputs.prune_old_evidence(config.out_root, run_date)
    con.warn(outputs.prune_message(pruned))

    # 2. Dedupe.
    state.prior = exclusions.prior_runs(config.out_root, state.domain)
    if state.prior:
        con.warn(f"Note: {state.domain} already has runs: {', '.join(state.prior)}.")
    if not config.institution:
        con.warn("Note: no --name; the report names the domain and VIS-04 does not check the name in the title.")

    # 3. Folder and services.
    state.paths = paths = outputs.create_run_dir(config.out_root, state.domain, run_date)
    if services_factory is None:
        from .services import build_services as services_factory
    try:
        services = services_factory(config, paths.evidencia, sleeper=sleeper)
    except ValueError as exc:
        _remove_if_empty(paths)
        state.paths = None
        return _usage(con, f"invalid configuration: {exc}")
    state.services = services
    con.redactor = services.redactor
    if not config.psi_enabled:
        _disable_psi(services)

    # 4. Collect.
    from .scope import ScopeError

    def excluded_check(host: str) -> bool:
        entry = lst.match(host)
        if entry:
            state.canonical_entry = entry
        return entry is not None

    con.warn(f"Measuring {config.url} (this takes a few minutes)...")
    try:
        from .collect import collect

        state.obs = obs = collect(config, services, no_contact_check=excluded_check, progress=con.progress)
    except ScopeError as exc:
        return _abort_scope(state, con, exc)

    psi_key_note = _psi_key_note(obs)
    # Time bombs: a Lighthouse major the audit names were not verified for, and
    # a WordPress branch the release table does not have yet.
    lighthouse_note = _lighthouse_note(obs, config)
    wp_table_note = _wp_table_note(obs)
    if config.site_budget and obs.site_requests > config.site_budget:
        state.errors.append(
            f"site requests ({obs.site_requests}) exceeded --max-requests ({config.site_budget}): "
            "services.build_services must pass config.site_budget to ClientConfig"
        )
    if obs.home_problem == "left-site" and obs.home_redirect_target:
        # example.com.ar -> example.edu.ar is one site: the destination is checked too.
        entry = lst.match(obs.home_redirect_target)
        if entry:
            state.canonical_entry = entry
    excluded = bool(state.canonical_entry or obs.final_host_no_contact)
    home_unreachable = bool(obs.home_unreachable)

    # 5. Evaluate.
    from . import evaluate
    from .model import EvalContext

    written = _safe(services.artifacts.written_map, None, state.errors, "artifacts.written_map")
    if not isinstance(written, dict):
        written = dict(obs.artifacts_written)
    home_reason = _home_reason(obs)
    try:
        pages = evaluate.build_pages(obs)
        ctx = EvalContext(
            run_date=run_date,
            institution=config.institution,
            kind=config.kind,
            artifacts_written=written,
            pages=pages,
        )
        result = evaluate.evaluate_all(obs, ctx, overrides=overrides)
    except Exception as exc:  # noqa: BLE001
        if not home_unreachable:
            raise
        state.errors.append(f"evaluation failed on an unreachable home: {type(exc).__name__}: {exc}")
        from .checks.header import GoogleSummary
        from .checks.tables import MailAuthTable, VelocityTable

        result = evaluate.EvaluationResult(
            findings=_grey_findings(home_reason),
            google_summary=GoogleSummary(reason=home_reason),
            velocity=VelocityTable(intro=""),
            mail_auth=MailAuthTable(),
            hack_gate=evaluate.HackGate(),
        )
    findings = result.findings
    state.errors.extend(result.errors)
    if home_unreachable:
        _force_unverified(findings, home_reason, keep=SITE_INDEPENDENT_CHECKS)
    hack_reasons = [] if home_unreachable else list(result.hack_gate.reasons)

    wrapper_info: dict[str, Any] | None = None
    wrapper = None if home_unreachable else _home_wrapper(obs)
    if wrapper is not None:
        # Not the page the visitor sees: the console and datos.json say what to measure instead.
        w_reason, w_todo = _wrapper_texts(wrapper, state.domain)
        wrapper_info = {"tipo": wrapper.kind, "destino": wrapper.target, "motivo": w_reason, "que_hacer": w_todo}

    # 6. Render.
    from .render_report import ReportContext, render_annex, render_report

    finished = _now_utc()
    institution = config.institution or state.domain  # the report names the domain without --name
    n_site = int(obs.site_requests or 0)
    minutes = _site_minutes(services, state.errors)
    tools = _tools_used(obs)
    conditions = _conditions(obs)
    report_ctx = ReportContext(
        institution=institution,
        domain=state.domain,
        run_date=run_date,
        para=config.para,
        started_local=state.started.astimezone(ART),
        finished_local=finished.astimezone(ART),
        findings=findings,
        google_summary=result.google_summary,
        velocity=result.velocity,
        mail_auth=result.mail_auth,
        hack_gate=bool(hack_reasons),
        n_site_requests=n_site,
        site_minutes=minutes,
        tools_used=tools,
        kind=config.kind,
        conditions=conditions,
        psi_skipped=not config.psi_enabled,
    )
    _write_client_files(paths, render_report(report_ctx), render_annex(report_ctx), rerender=False)
    outputs.write_tiempo(paths, state.started, finished)
    # A cut in the middle of the run (exit 3 already says why the home was not read).
    cut_note = _cut_note(bool(obs.blocked) and not home_unreachable, findings, throttle=obs.block_cause == "throttle")

    # 7. Control.
    allowed_emails = _allowed_emails(findings)
    control = _control(paths, services.redactor, sweep=True, allowed_emails=allowed_emails)
    if not paths.requests_log.exists():
        state.errors.append("evidencia/requests.log was not written")

    # 8. datos.json, last.
    extra = {
        "pedidos_sitio": n_site,
        "minutos_sitio": minutes,
        "herramientas": tools,
        "condiciones": conditions,
        "motivo_portada": home_reason if home_unreachable else None,
        "dominio_compartido": obs.shared_parent,
        "portada_envoltorio": _sanitize_raw(wrapper_info) if wrapper_info else None,
        "aviso_corte": cut_note,
        "aviso_pagespeed": psi_key_note,
        "aviso_lighthouse": lighthouse_note,
        "aviso_wordpress": wp_table_note,
    }
    encabezado = _safe(result.google_summary.to_datos, None, state.errors, "GoogleSummary.to_datos")
    datos: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "encabezado": encabezado,
        "checks": _findings_to_datos(findings, state.errors),
        "tablas": _tables_to_datos(result.velocity, result.mail_auth),
        "resumen": _resumen(findings),
        "senales_hackeo": hack_reasons,
        "meta": _build_meta(state, finished, extra),  # last: it collects every error recorded above
    }
    datos, problems = _finalize_datos(datos, services.redactor, allowed_emails)
    issues = [i.to_datos() for i in control.issues] + [_datos_issue(p) for p in problems]
    flags = OutcomeFlags(
        excluded=excluded,
        home_unreachable=home_unreachable,
        text_control_failed=bool(issues),
        hack_gate=bool(hack_reasons),
    )
    code = resolve(flags)
    datos["salida"] = {"codigo": int(code), "nombre": code.name, "control_texto": issues, "borrados": control.deleted}
    outputs.write_datos(paths, datos)
    state.datos_written = True

    # 9. Summary.
    for issue in issues:
        con.warn(f"Text control: {issue['archivo']}:{issue['linea']} {issue['regla']}: {issue['extracto']}")
    if wrapper_info:
        con.warn(f"Note: {wrapper_info['motivo']}. {wrapper_info['que_hacer']}")
    clave = datos["meta"].get("clave")
    notes = [home_reason if home_unreachable else None, cut_note, psi_key_note, lighthouse_note, wp_table_note]
    for line in _summary_lines(state.domain, paths, findings, hack_reasons, code, clave, notes=notes):
        con.say(line)
    return RunOutcome(code, run_dir=paths.root, datos_path=paths.datos, messages=con.messages)


def _psi_key_note(obs: "Observations") -> str | None:
    """The Spanish note when PageSpeed rejected the key, else None."""
    from .psi import KEY_REJECTED_NOTE, STATUS_KEY_REJECTED

    return KEY_REJECTED_NOTE if getattr(obs.psi, "status", None) == STATUS_KEY_REJECTED else None


def _lighthouse_note(obs: "Observations", config: "RunConfig") -> str | None:
    """psi.lighthouse_note of the run's Lighthouse version (the one datos.json records), or None."""
    from .psi import lighthouse_note

    return lighthouse_note(_psi_facts(obs, config)[1])


def _wp_table_note(obs: "Observations") -> str | None:
    """wpversions.table_stale_note of the stable-check list's newest version, or None (never raises)."""
    from .wpversions import table_stale_note

    latest = getattr(getattr(obs, "wp_status", None), "latest", None)
    return table_stale_note(latest if isinstance(latest, str) else None)


def _home_wrapper(obs: "Observations") -> Any:
    """gate.home_wrapper of the home response, or None (never raises)."""
    from . import gate

    resp = obs.home.response if obs.home is not None else None
    if resp is None or resp.status != 200:
        return None
    try:
        return gate.home_wrapper(resp, obs.canonical_host)
    except Exception:  # noqa: BLE001 - a detector failure never stops the run
        return None


def _wrapper_texts(wrapper: Any, domain: str) -> tuple[str, str]:
    """(reason, todo) in Spanish for a wrapper home: what it is and what to measure instead."""
    from urllib.parse import urlsplit

    from . import domains
    from .fmt import sanitize_site_url

    target = getattr(wrapper, "target", None)
    if wrapper.kind == "spa-shell":
        reason = WRAPPER_SPA.format(n=int(getattr(wrapper, "text_chars", 0) or 0)) + "; " + WRAPPER_IN_BROWSER
        return reason, WRAPPER_TODO_SPA
    if not target:
        return WRAPPER_FRAME_NO_TARGET + "; " + WRAPPER_IN_BROWSER, WRAPPER_TODO_BROWSER.format(what="el sitio")
    shown = sanitize_site_url(target, 200)
    what = WRAPPER_WHAT.get(wrapper.kind, WRAPPER_WHAT["meta-refresh"]).format(target=shown)
    parts = urlsplit(target)
    has_path = (parts.path or "/") != "/" or bool(parts.query)
    if has_path:
        root = sanitize_site_url(f"{parts.scheme}://{parts.netloc}/", 120)
        advice = WRAPPER_PATH.format(root=root)
        if not domains.is_same_site(target, domain):
            advice = "es otro dominio, y " + advice
        return f"{what}; {advice}", WRAPPER_TODO_BROWSER.format(what=shown)
    advice = WRAPPER_MEASURE if domains.is_same_site(target, domain) else WRAPPER_OTHER_DOMAIN
    return f"{what}; {advice}", WRAPPER_TODO_MEASURE.format(target=shown)


def _home_reason(obs: "Observations") -> str:
    """Why the home was not read, in Spanish, for the report and the console."""
    from . import domains
    from .fmt import sanitize_site_url

    if obs.blocked or obs.challenge_events:
        return REASON_HOME_THROTTLE if obs.block_cause == "throttle" else REASON_HOME_CHALLENGE
    if obs.home_problem == "private":
        return REASON_HOME_PRIVATE
    if obs.home_problem == "tls-unverified":
        return REASON_HOME_TLS
    if obs.home_problem == "left-site" and obs.home_redirect_target:
        try:
            target = domains.host_of(obs.home_redirect_target)
        except ValueError:
            target = obs.home_redirect_target
        return REASON_HOME_MOVED.format(target=sanitize_site_url(target, 80))
    # The home answered something unusable: say what.
    from .checks.common import home_answer_reason

    answered = home_answer_reason(obs.home.response if obs.home is not None else None)
    if answered:
        return f"{answered} y la corrida se detuvo"
    return REASON_HOME_DOWN


def _remove_if_empty(paths: outputs.RunPaths) -> None:
    try:
        if paths.evidencia.is_dir() and not any(paths.evidencia.iterdir()):
            paths.evidencia.rmdir()
        if paths.root.is_dir() and not any(paths.root.iterdir()):
            paths.root.rmdir()
    except OSError:
        pass


def _minimal_datos(state: _State, code: ExitCode, message: str) -> dict[str, Any]:
    finished = _now_utc()
    meta = _build_meta(state, finished, {})
    redactor = state.services.redactor if state.services is not None else None
    meta["errores"] = [*meta["errores"], *_sanitize_raw([_scrub(redactor, message)])]
    return {
        "schema_version": SCHEMA_VERSION,
        "meta": meta,
        "encabezado": None,
        "checks": [],
        "tablas": {},
        "resumen": _resumen([]),
        "senales_hackeo": [],
        "salida": {"codigo": int(code), "nombre": code.name, "control_texto": [], "borrados": []},
    }


def _abort_scope(state: _State, con: _Console, exc: Exception) -> RunOutcome:
    """ScopeError: the guard refused a request. Write what exists, exit 50 (10 if excluded, by precedence)."""
    code = resolve(OutcomeFlags(scope_violation=True, excluded=bool(state.excluded_entry or state.canonical_entry)))
    redactor = state.services.redactor if state.services is not None else None
    message = _scrub(redactor, f"ScopeError: {exc}")
    paths = state.paths
    if paths is not None:
        outputs.write_tiempo(paths, state.started, _now_utc())
        if redactor is not None:
            for leaked in _safe(lambda: outputs.sweep_secrets(paths.root, redactor), [], state.errors, "sweep"):
                state.errors.append(f"deleted {leaked.name}: it contained a secret")
        datos, _ = _finalize_datos(_minimal_datos(state, code, message), redactor)
        outputs.write_datos(paths, datos)
        state.datos_written = True
    con.warn(f"The scope guard refused a request and the run stopped: {message}")
    for line in _summary_lines(state.domain or "?", paths, [], [], code, None):
        con.say(line)
    return RunOutcome(code, run_dir=paths.root if paths else None, datos_path=paths.datos if paths else None, messages=con.messages)


def _unexpected(state: _State, con: _Console, exc: BaseException) -> RunOutcome:
    """Any uncaught error: redacted message and traceback on stderr, datos.json if possible, exit 1."""
    code = ExitCode.UNEXPECTED
    redactor = state.services.redactor if state.services is not None else None
    message = _scrub(redactor, f"{type(exc).__name__}: {exc}")
    tb = _scrub(redactor, "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
    con.warn(f"Unexpected error: {message}")
    print(tb, file=con.err, flush=True)
    paths = state.paths
    if paths is not None and not state.datos_written:
        try:
            datos, _ = _finalize_datos(_minimal_datos(state, code, message), redactor)
            outputs.write_datos(paths, datos)
        except Exception as inner:  # noqa: BLE001
            con.warn(f"datos.json could not be written either: {type(inner).__name__}")
    return RunOutcome(code, run_dir=paths.root if paths else None, messages=con.messages)


# ---------------------------------------------------------------------------
# rerender
# ---------------------------------------------------------------------------


def rerender(
    config: "RunConfig",
    *,
    stdout: IO[str] | None = None,
    stderr: IO[str] | None = None,
) -> RunOutcome:
    """Re-render the report from config.rerender_from (a datos.json) without any request."""
    con = _Console(stdout, stderr)
    try:
        return _rerender(config, con)
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001
        con.warn(f"Unexpected error: {type(exc).__name__}: {exc}")
        print("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)), file=con.err, flush=True)
        return RunOutcome(ExitCode.UNEXPECTED, messages=con.messages)


def _local_date(meta: dict[str, Any]) -> dt.date:
    for key in ("inicio_local", "inicio_utc"):
        value = meta.get(key)
        if isinstance(value, str) and value:
            try:
                moment = dt.datetime.fromisoformat(value)
            except ValueError:
                continue
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=dt.timezone.utc)
            return moment.astimezone(ART).date()
    raise ValueError("datos.json has no measurement date (meta.inicio_local)")


def _local_moment(meta: dict[str, Any], key: str, fallback: dt.datetime) -> dt.datetime:
    value = meta.get(key)
    if isinstance(value, str):
        try:
            moment = dt.datetime.fromisoformat(value)
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=dt.timezone.utc)
            return moment.astimezone(ART)
        except ValueError:
            pass
    return fallback.astimezone(ART)


def _rerender(config: "RunConfig", con: _Console) -> RunOutcome:
    from . import evaluate
    from .config import DEFAULT_KIND, DEFAULT_PARA
    from .model import Finding
    from .render_report import ReportContext, render_annex, render_report

    assert config.rerender_from is not None
    source = Path(config.rerender_from)
    try:
        old = outputs.read_datos(source)
    except ValueError as exc:
        return _usage(con, f"--rerender: {exc}")
    meta = old.get("meta") if isinstance(old.get("meta"), dict) else {}
    checks = old.get("checks") or []
    previous = (old.get("salida") or {}).get("codigo")
    if not checks:
        return _usage(con, f"--rerender: that run has no checks (it ended with exit {previous}); measure again")
    domain = str(meta.get("dominio") or "")
    try:
        run_date = _local_date(meta)
    except ValueError as exc:
        return _usage(con, f"--rerender: {exc}")

    overrides = None
    if config.overrides is not None:
        from .colours import load_overrides

        try:
            overrides = load_overrides(config.overrides)
        except (ValueError, OSError) as exc:
            return _usage(con, f"--overrides could not be used: {exc}")

    findings = evaluate.recolour([Finding.from_datos(c) for c in checks], overrides)
    home_unreachable = bool(meta.get("portada_no_respondio"))
    hack_reasons = [] if home_unreachable else list(evaluate.hack_gate_of(findings).reasons)

    paths = outputs.RunPaths.for_root(source.parent)
    institution = config.institution or meta.get("institucion") or domain
    para = config.para or meta.get("para") or DEFAULT_PARA
    kind = config.kind if config.kind_explicit else (meta.get("tipo") or DEFAULT_KIND)
    velocity, mail_auth = _tables_from_datos(old.get("tablas"))
    now = _now_utc()
    report_ctx = ReportContext(
        institution=str(institution),
        domain=domain,
        run_date=run_date,
        para=str(para),
        started_local=_local_moment(meta, "inicio_local", now),
        finished_local=_local_moment(meta, "fin_local", now),
        findings=findings,
        google_summary=_summary_from_datos(old.get("encabezado")),
        velocity=velocity,
        mail_auth=mail_auth,
        hack_gate=bool(hack_reasons),
        n_site_requests=int(meta.get("pedidos_sitio") or 0),
        site_minutes=int(meta.get("minutos_sitio") or 0),
        tools_used=[str(t) for t in meta.get("herramientas") or []],
        kind=str(kind),
        conditions=str(meta.get("condiciones") or ""),
        psi_skipped=bool(meta.get("sin_pagespeed")),
    )
    _write_client_files(paths, render_report(report_ctx), render_annex(report_ctx), rerender=True)

    allowed_emails = _allowed_emails(findings)
    control = _control(paths, None, sweep=False, allowed_emails=allowed_emails)
    errors: list[str] = []
    new = dict(old)
    new_meta = dict(meta)
    if config.institution and config.institution.strip():
        new_meta["institucion"] = config.institution.strip()
    if config.kind_explicit:
        new_meta["tipo"], new_meta["tipo_explicito"] = str(kind), True
    new["meta"] = new_meta
    new["checks"] = _findings_to_datos(findings, errors)
    new["resumen"] = _resumen(findings)
    new["senales_hackeo"] = hack_reasons
    new, problems = _finalize_datos(new, None, allowed_emails)
    issues = [i.to_datos() for i in control.issues] + [_datos_issue(p) for p in problems]
    flags = OutcomeFlags(
        excluded=bool(meta.get("excluido")),
        home_unreachable=home_unreachable,
        text_control_failed=bool(issues),
        hack_gate=bool(hack_reasons),
    )
    code = resolve(flags)
    new["salida"] = {
        "codigo": int(code),
        "nombre": code.name,
        "control_texto": issues,
        "borrados": control.deleted,
        "errores_rehacer": errors,
        "rehecho": {"fecha_local": _iso_local(now), "desde": source.name},
    }
    if source.name != outputs.DATOS and paths.datos.exists():
        con.warn(f"Note: rerendered from {source.name}; the current datos.json is kept under another name.")
    outputs.write_datos(paths, new, rerender=True)

    for issue in issues:
        con.warn(f"Text control: {issue['archivo']}:{issue['linea']} {issue['regla']}: {issue['extracto']}")
    cut_note = _cut_note(bool(meta.get("sitio_cortado")) and not home_unreachable, findings)
    notes = [cut_note, *(meta.get(k) for k in ("aviso_pagespeed", "aviso_lighthouse", "aviso_wordpress"))]
    notes = [n if isinstance(n, str) else None for n in notes]
    # A rerender uses no key, so the key line is left out.
    for line in _summary_lines(domain, paths, findings, hack_reasons, code, None, notes=notes):
        con.say(line)
    return RunOutcome(code, run_dir=paths.root, datos_path=paths.datos, messages=con.messages)
