"""The stored-run format: English names on disk, and the migration of older files.

Inside the package a run is a dict with the names the rules were written with
(Spanish: ``meta.dominio``, ``checks[].estado``). That dict never reaches a
reader. Everything written to disk goes through ``to_public`` and everything
read comes back through ``to_internal``:

* schema_version 2 (written today): English keys, English state, colour and
  priority values, in ``run.json`` and ``comparison.json``.
* schema_version 1 (written by site-check before the rename, as
  ``datos.json``): the internal layout itself. ``migrate`` turns such a
  document into schema_version 2; ``to_internal`` reads either one.

The whole rename is the tables of this module (``RENAMES`` lists it for the
README and the tests). The translation is by position: a key is renamed
according to where it sits, so ``scope`` inside ``measured`` (the kind of
field data) and ``meta.scope`` (what the scope guard admitted) never meet.
Keys and values that are not in a table pass unchanged, in both directions.

What is NOT translated, on purpose:

* report text (``sentence``, ``reason``, ``note``, ``label``, table rows,
  ``conditions``, ``tools``): it is the Spanish text of the rules, see
  ``--lang`` for the report language;
* the placeholder names of ``traces`` (``{dias}``): they name the placeholder
  of the Spanish sentence they belong to;
* code values inside ``measured`` (``scope: "laboratorio"``, marker names)
  and ``meta.kind``: fixed vocabularies of the rules;
* evidence file names.

``to_public`` checks that reading its own output gives the dict back; a key
that would not survive the round trip (a new measured key that collides with a
translated name) raises RunFormatError instead of writing a file that
``--rerender`` would read differently.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from . import SCHEMA_VERSION

LEGACY_SCHEMA_VERSION = 1
# The one key this version adds; a schema_version 1 export leaves it out.
_V2_ONLY_META = ("idioma_informe",)


class RunFormatError(ValueError):
    """A document that cannot be translated without loss, or of an unknown version."""


# ---------------------------------------------------------------------------
# Value vocabularies (internal -> public)
# ---------------------------------------------------------------------------

STATES: dict[str, str] = {
    "APROBADO": "pass",
    "APROBADO_CON_OBSERVACION": "pass_with_note",
    "FALLA": "fail",
    "NO_APLICA": "not_applicable",
    "NO_VERIFICADO": "not_verified",
    "CORREGIDO": "fixed",
    "RIESGO_ACEPTADO": "risk_accepted",
}
COLOURS: dict[str, str] = {
    "rojo": "red",
    "amarillo": "yellow",
    "azul": "blue",
    "verde": "green",
    "gris": "grey",
    "oculto": "hidden",
}
PRIORITIES: dict[str, str] = {"Crítica": "critical", "Alta": "high", "Media": "medium", "Baja": "low"}
KEY_PRESENCE: dict[str, str] = {"presente": "present", "ausente": "absent"}
COLOUR_EXCEPTIONS: dict[str, str] = {
    "ext08-solo-laboratorio": "ext08-lab-only",
    "vis01-sitio-entero": "vis01-whole-site",
    "vis18-numero-mal-escrito": "vis18-number-miswritten",
    "vis21-correo-rebota": "vis21-mail-bounces",
}
TEXT_RULES: dict[str, str] = {
    "palabra-prohibida": "forbidden-word",
    "raya": "dash",
    "marcador": "placeholder",
    "caracter-roto": "broken-character",
    "enlace-o-etiqueta": "link-or-tag",
    "correo": "email",
    "clave": "key",
}
ROW_GROUPS: dict[str, str] = {
    "campo": "field",
    "laboratorio": "lab",
    "servidor": "server",
    "seguridad": "security",
    "correo": "mail",
}
ROW_KEYS: dict[str, str] = {
    "campo_lcp": "field_lcp",
    "campo_inp": "field_inp",
    "campo_cls": "field_cls",
    "lab_puntaje_celular": "lab_score_mobile",
    "lab_lcp_celular": "lab_lcp_mobile",
    "lab_puntaje_computadora": "lab_score_desktop",
    "peso_total": "weight_total",
    "peso_terceros": "weight_third_party",
    "protecciones": "protections",
    "nota_observatory": "observatory_grade",
    **{f"correo_{n}": f"mail_{n}" for n in range(12)},
}
TRANSITION_KINDS: dict[str, str] = {"mejoro": "improved", "empeoro": "worse", "otro": "other"}
TRANSITION_COLOURS: dict[str, str] = {**COLOURS, "ausente": "absent"}

# ---------------------------------------------------------------------------
# Key tables (internal -> public), one per position
# ---------------------------------------------------------------------------

TOP_KEYS: dict[str, str] = {
    "encabezado": "header",
    "tablas": "tables",
    "resumen": "summary",
    "senales_hackeo": "hack_signals",
    "salida": "output",
}
META_KEYS: dict[str, str] = {
    "version_script": "tool_version",
    "version_python": "python_version",
    "version_openssl": "openssl_version",
    "version_expat": "expat_version",
    "url_entrada": "input_url",
    "dominio": "domain",
    "url_canonica": "canonical_url",
    "url_interna": "inner_url",
    "origen_interna": "inner_source",
    "institucion": "organisation",
    "tipo": "kind",
    "tipo_explicito": "kind_explicit",
    "para": "to",
    "idioma_informe": "report_language",
    "inicio_utc": "started_utc",
    "fin_utc": "finished_utc",
    "inicio_local": "started_local",
    "fin_local": "finished_local",
    "pedidos": "requests",
    "eventos_desafio": "challenge_events",
    "sitio_cortado": "site_cut",
    "tope_agotado": "budget_exhausted",
    "clave": "api_key",
    "corridas_psi": "psi_runs",
    "version_lighthouse": "lighthouse_version",
    "alcance": "scope",
    "corridas_previas": "previous_runs",
    "excluido": "excluded",
    "modo_prueba": "test_mode",
    "errores": "errors",
    "portada_no_respondio": "home_unreachable",
    "sin_pagespeed": "no_pagespeed",
    "pausa_segundos": "pause_seconds",
    "max_pedidos": "max_requests",
    "pedidos_sitio": "site_requests",
    "minutos_sitio": "site_minutes",
    "herramientas": "tools",
    "condiciones": "conditions",
    "omitidos": "skipped",
    "aviso_pagespeed": "pagespeed_notice",
    "aviso_lighthouse": "lighthouse_notice",
    "aviso_wordpress": "wordpress_notice",
    "aviso_corte": "cut_notice",
    "motivo_portada": "home_reason",
    "dominio_compartido": "shared_domain",
    "portada_envoltorio": "home_wrapper",
}
PSI_RUNS_KEYS: dict[str, str] = {
    "pedidas": "requested",
    "validas": "valid",
    "computadora_valida": "desktop_valid",
    "estado": "status",
}
SCOPE_KEYS: dict[str, str] = {
    "dominio": "domain",
    "url_entrada": "input_url",
    "url_canonica": "canonical_url",
    "sitemaps_estandar": "standard_sitemaps",
    "admitidas": "admitted",
    "rechazadas": "refused",
}
SCOPE_ENTRY_KEYS: dict[str, str] = {"proposito": "purpose", "origen": "source", "motivo": "reason"}
WRAPPER_KEYS: dict[str, str] = {"tipo": "kind", "destino": "target", "motivo": "reason", "que_hacer": "what_to_do"}
HEADER_KEYS: dict[str, str] = {"celular": "mobile", "computadora": "desktop", "motivo": "reason"}
SCORE_KEYS: dict[str, str] = {"puntaje": "score", "forma": "shape", "rotulo": "label", "motivo": "reason"}
CHECK_KEYS: dict[str, str] = {
    "nombre_llano": "name",
    "modulo": "module",
    "prioridad": "priority",
    "estado": "state",
    "color_derivado": "derived_colour",
    "color_final": "colour",
    "motivo_ajuste": "colour_reason",
    "excepcion_color": "colour_exception",
    "forma": "shape",
    "rotulo": "label",
    "mediciones": "measured",
    "evidencia": "evidence",
    "evidencia_ok": "evidence_ok",
    "motivo": "reason",
    "motivo_no_verificado": "not_verified_reason",
    "nota": "note",
    "nota_interna": "internal_note",
    "senal_hackeo": "hack_signal",
    "frase_informe_llena": "sentence",
    "trazas": "traces",
    "nota_compuerta": "gate_note",
}
SENTENCE_KEYS: dict[str, str] = {
    "que_se_encontro": "found",
    "que_puede_pasar": "consequence",
    "que_se_hace": "action",
    "quien": "who",
}
TRACE_KEYS: dict[str, str] = {"caso": "case"}
MEASURED_KEYS: dict[str, str] = {
    "anio_ciclo": "cycle_year",
    "anio_pie": "footer_year",
    "buscar": "search_for",
    "caso_mail": "mail_case",
    "ciclo_fuera_del_pie": "cycle_outside_footer",
    "ciclo_palabra": "cycle_word",
    "dias_calendario": "calendar_days",
    "direccion": "address",
    "direccion_mail": "mail_address",
    "dmarc_org_consultado": "dmarc_org_queried",
    "dmarc_org_dominio": "dmarc_org_domain",
    "dmarc_org_valido": "dmarc_org_valid",
    "dominio": "domain",
    "dominio_mail": "mail_domain",
    "dominios": "domains",
    "flash_codigo": "flash_code",
    "flash_con_emulador": "flash_with_emulator",
    "fuera_del_tope": "over_cap",
    "gratuitos": "free_mail",
    "interna_checked": "inner_checked",
    "interna_fails": "inner_fails",
    "interna_mixed": "inner_mixed",
    "interna_noindex": "inner_noindex",
    "interna_problem": "inner_problem",
    "interna_url": "inner_url",
    "marcadores": "markers",
    "mas_alta_de_la_rama": "highest_of_branch",
    "mes_anio_feed": "feed_month_year",
    "meta_celular_anterior": "legacy_mobile_meta",
    "motivos_falla": "fail_reasons",
    "n_destinos_rotos": "n_broken_targets",
    "n_h1_interna": "n_h1_inner",
    "n_meses": "n_months",
    "numeros_distintos": "distinct_numbers",
    "pagina_mail": "mail_page",
    "paginas": "pages",
    "paginas_falla": "failing_pages",
    "paginas_mail": "mail_pages",
    "pie_encontrado": "footer_located",
    "rama_mas_alta": "highest_branch",
    "robots_blocks_interna": "robots_blocks_inner",
    "skips_interna": "skips_inner",
    "texto_de_ejemplo": "default_content",
    "texto_ejemplo": "sample_text",
    "texto_ejemplo_lugar": "sample_text_place",
    "ultima_novedad": "latest_news",
    "veredicto": "delivery_verdict",
    "veredicto_dns": "dns_verdict",
    "veredicto_mail": "mail_verdict",
    "viewport_celular": "mobile_viewport",
}
TABLES_KEYS: dict[str, str] = {"velocidad": "speed", "correo": "mail"}
TABLE_KEYS: dict[str, str] = {
    "filas": "rows",
    "nota_laboratorio": "lab_note",
    "atribucion": "attribution",
    "nota_no_aplica": "not_applicable_note",
}
TABLE_ROW_KEYS: dict[str, str] = {"que": "what", "valor": "value", "significa": "meaning"}
SUMMARY_KEYS: dict[str, str] = {
    "por_color": "by_colour",
    "aplicables": "applicable",
    "no_aplica": "not_applicable",
    "por_estado": "by_state",
}
OUTPUT_KEYS: dict[str, str] = {
    "codigo": "code",
    "nombre": "name",
    "control_texto": "text_control",
    "borrados": "deleted",
    "errores_rehacer": "rerender_errors",
    "rehecho": "rerendered",
}
TEXT_ISSUE_KEYS: dict[str, str] = {"archivo": "file", "linea": "line", "regla": "rule", "extracto": "excerpt"}
RERENDERED_KEYS: dict[str, str] = {"fecha_local": "local_time", "desde": "from"}

# comparison.json
COMPARISON_KEYS: dict[str, str] = {
    "version_script": "tool_version",
    "antes": "before",
    "despues": "after",
    "dias_entre_mediciones": "days_between",
    "filas": "rows",
    "transiciones": "transitions",
    "quedan": "still_open",
    "salida": "output",
}
SIDE_KEYS: dict[str, str] = {
    "dominio": "domain",
    "url_canonica": "canonical_url",
    "inicio_utc": "started_utc",
    "version_script": "tool_version",
    "version_lighthouse": "lighthouse_version",
    "corridas_psi": "psi_runs",
    "condiciones": "conditions",
    "herramientas": "tools",
    "por_modulo": "by_module",
}
MODULE_COUNT_KEYS: dict[str, str] = {
    "aprobados": "passed",
    "con_observacion": "with_note",
    "sin_verificar": "not_verified",
    "aplicables": "applicable",
}
ROW_KEYS_OF_ROW: dict[str, str] = {
    "clave": "key",
    "grupo": "group",
    "que": "what",
    "antes": "before",
    "despues": "after",
    "cambio": "change",
    "comparada": "compared",
    "motivo": "reason",
    "significa": "meaning",
}
CELL_KEYS: dict[str, str] = {"valor": "value", "texto": "text", "traza": "trace"}
TRANSITION_KEYS: dict[str, str] = {"nombre": "name", "antes": "before", "despues": "after", "tipo": "kind"}
STILL_OPEN_KEYS: dict[str, str] = {"nombre": "name", "color": "colour", "que_se_encontro": "found"}


# ---------------------------------------------------------------------------
# The position tree
# ---------------------------------------------------------------------------


@dataclass(eq=False)
class _Node:
    """How to translate the value at one position.

    ``keys``: renames of a dict's keys. ``children``: the node of the value
    under a key (by its name on the side being read). ``default``: the node of
    every other value of a dict. ``items``: the node of a list's elements.
    ``values``: renames of a string value. ``trace``: the value is a trace
    string, translated with the tree itself.
    """

    keys: dict[str, str] = field(default_factory=dict)
    children: dict[str, "_Node"] = field(default_factory=dict)
    default: "_Node | None" = None
    items: "_Node | None" = None
    values: dict[str, str] = field(default_factory=dict)
    trace: bool = False


def _values(table: dict[str, str]) -> _Node:
    return _Node(values=table)


def _list(node: _Node) -> _Node:
    return _Node(items=node)


def _build() -> tuple[_Node, _Node]:
    trace = _Node(trace=True)
    measured = _Node(keys=MEASURED_KEYS)
    measured.default = measured  # the same table at any depth of a measurement
    measured.items = measured

    score = _Node(keys=SCORE_KEYS)
    side = _Node(default=score)
    header = _Node(keys=HEADER_KEYS, children={"celular": side, "computadora": side})

    check = _Node(
        keys=CHECK_KEYS,
        children={
            "prioridad": _values(PRIORITIES),
            "estado": _values(STATES),
            "color_derivado": _values(COLOURS),
            "color_final": _values(COLOURS),
            "excepcion_color": _values(COLOUR_EXCEPTIONS),
            "mediciones": measured,
            "frase_informe_llena": _Node(keys=SENTENCE_KEYS),
            "trazas": _Node(keys=TRACE_KEYS, default=trace),
        },
    )
    table_rows = _list(_Node(keys=TABLE_ROW_KEYS))
    table = _Node(keys=TABLE_KEYS, children={"filas": table_rows})
    scope_entries = _list(_Node(keys=SCOPE_ENTRY_KEYS))
    psi_runs = _Node(keys=PSI_RUNS_KEYS)
    meta = _Node(
        keys=META_KEYS,
        children={
            "clave": _values(KEY_PRESENCE),
            "corridas_psi": psi_runs,
            "alcance": _Node(keys=SCOPE_KEYS, children={"admitidas": scope_entries, "rechazadas": scope_entries}),
            "omitidos": scope_entries,
            "portada_envoltorio": _Node(keys=WRAPPER_KEYS),
        },
    )
    output = _Node(
        keys=OUTPUT_KEYS,
        children={
            "control_texto": _list(_Node(keys=TEXT_ISSUE_KEYS, children={"regla": _values(TEXT_RULES)})),
            "rehecho": _Node(keys=RERENDERED_KEYS),
        },
    )
    run = _Node(
        keys=TOP_KEYS,
        children={
            "meta": meta,
            "encabezado": header,
            "checks": _list(check),
            "tablas": _Node(keys=TABLES_KEYS, children={"velocidad": table, "correo": table}),
            "resumen": _Node(
                keys=SUMMARY_KEYS,
                children={"por_color": _Node(keys=COLOURS), "por_estado": _Node(keys=STATES)},
            ),
            "salida": output,
        },
    )

    cell = _Node(keys=CELL_KEYS, children={"traza": trace})
    side_of = _Node(
        keys=SIDE_KEYS,
        children={"corridas_psi": psi_runs, "por_modulo": _Node(default=_Node(keys=MODULE_COUNT_KEYS))},
    )
    comparison = _Node(
        keys=COMPARISON_KEYS,
        children={
            "antes": side_of,
            "despues": side_of,
            "filas": _list(
                _Node(
                    keys=ROW_KEYS_OF_ROW,
                    children={
                        "clave": _values(ROW_KEYS),
                        "grupo": _values(ROW_GROUPS),
                        "antes": cell,
                        "despues": cell,
                    },
                )
            ),
            "transiciones": _list(
                _Node(
                    keys=TRANSITION_KEYS,
                    children={
                        "antes": _values(TRANSITION_COLOURS),
                        "despues": _values(TRANSITION_COLOURS),
                        "tipo": _values(TRANSITION_KINDS),
                    },
                )
            ),
            "quedan": _list(_Node(keys=STILL_OPEN_KEYS, children={"color": _values(COLOURS)})),
            "salida": output,
        },
    )
    return run, comparison


def _invert_table(table: dict[str, str]) -> dict[str, str]:
    inverse = {new: old for old, new in table.items()}
    if len(inverse) != len(table):
        raise RunFormatError(f"two names share a translation in {sorted(table)[:3]}...")
    return inverse


def _invert(node: _Node, memo: dict[int, _Node]) -> _Node:
    done = memo.get(id(node))
    if done is not None:
        return done
    out = _Node(trace=node.trace)
    memo[id(node)] = out
    out.keys = _invert_table(node.keys)
    out.values = _invert_table(node.values)
    out.children = {node.keys.get(key, key): _invert(child, memo) for key, child in node.children.items()}
    out.default = _invert(node.default, memo) if node.default is not None else None
    out.items = _invert(node.items, memo) if node.items is not None else None
    return out


_RUN, _COMPARISON = _build()
_MEMO: dict[int, _Node] = {}
_RUN_BACK, _COMPARISON_BACK = _invert(_RUN, _MEMO), _invert(_COMPARISON, _MEMO)
_MEASURED_BACK = _invert_table(MEASURED_KEYS)

_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_CHECK_TRACE_RE = re.compile(r"^(checks\[[^\]]+\]\.measured\.)(.+)$", re.DOTALL)
_SEGMENT_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)((?:\[[^\]]*\])*)$")


def _trace(text: str, root: _Node, measured: dict[str, str]) -> str:
    """A trace string with its names translated: ``checks[ID].measured.<keys>`` or a dotted path of the run."""
    m = _CHECK_TRACE_RE.match(text)
    if m:
        return m.group(1) + _IDENT_RE.sub(lambda t: measured.get(t.group(0), t.group(0)), m.group(2))
    node: _Node | None = root
    out: list[str] = []
    first = True
    for segment in text.split("."):
        s = _SEGMENT_RE.match(segment)
        if s is None or node is None:
            return text  # free text ("home <title>"): not a path
        name, index = s.group(1), s.group(2)
        if first and name not in node.keys and name not in node.children:
            return text
        first = False
        out.append(node.keys.get(name, name) + index)
        child = node.children.get(name, node.default)
        node = child.items if (index and child is not None and child.items is not None) else child
    return ".".join(out)


def _apply(value: Any, node: _Node | None, root: _Node, measured: dict[str, str]) -> Any:
    if node is None:
        return value
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            name = str(key)
            new = node.keys.get(name, name)
            if new in out:
                raise RunFormatError(f"two keys become {new!r} in the same object")
            out[new] = _apply(item, node.children.get(name, node.default), root, measured)
        return out
    if isinstance(value, (list, tuple)):
        return [_apply(item, node.items if node.items is not None else node, root, measured) for item in value]
    if isinstance(value, str):
        if node.trace:
            return _trace(value, root, measured)
        return node.values.get(value, value)
    return value


def _plain(value: Any) -> Any:
    """The JSON shape of ``value``: tuples as lists and keys as strings, as json.dumps writes them."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def _is_comparison(document: dict[str, Any]) -> bool:
    return "filas" in document or "rows" in document


def to_public(document: dict[str, Any]) -> dict[str, Any]:
    """The schema_version 2 document of an internal run (or comparison) dict.

    Raises RunFormatError when reading the result back would not give the same
    dict: nothing is written that ``--rerender`` would read differently.
    """
    comparison = _is_comparison(document)
    forward, back = (_COMPARISON, _COMPARISON_BACK) if comparison else (_RUN, _RUN_BACK)
    public = _apply(document, forward, _RUN, MEASURED_KEYS)
    if not comparison:
        public["schema_version"] = SCHEMA_VERSION
        if _apply(public, back, _RUN_BACK, _MEASURED_BACK) != {**_plain(document), "schema_version": SCHEMA_VERSION}:
            raise RunFormatError(
                "a key or value of this run collides with a translated name (sitecheck/runformat.py); "
                "the run would not read back as it was measured"
            )
    return public


def to_internal(document: dict[str, Any]) -> dict[str, Any]:
    """The internal dict of a stored run, whatever its version.

    schema_version 2 is translated back; schema_version 1 (``datos.json``) is
    the internal layout already. Any other version raises RunFormatError.
    """
    version = document.get("schema_version")
    if version == SCHEMA_VERSION:
        return _apply(document, _RUN_BACK, _RUN_BACK, _MEASURED_BACK)
    if version == LEGACY_SCHEMA_VERSION:
        internal = {**document, "schema_version": SCHEMA_VERSION}
        meta = internal.get("meta")
        if isinstance(meta, dict):
            # Version 1 had one report language and did not record it.
            internal["meta"] = {"idioma_informe": "es", **meta}
        return internal
    raise RunFormatError(
        f"schema_version {version!r}; this tool reads {SCHEMA_VERSION} and migrates {LEGACY_SCHEMA_VERSION}"
    )


def comparison_to_internal(document: dict[str, Any]) -> dict[str, Any]:
    """A comparison.json with the internal names (the tests read it this way; the tool never reads one)."""
    return _apply(document, _COMPARISON_BACK, _RUN_BACK, _MEASURED_BACK)


def is_legacy(document: dict[str, Any]) -> bool:
    return document.get("schema_version") == LEGACY_SCHEMA_VERSION


def migrate(document: dict[str, Any]) -> dict[str, Any]:
    """A schema_version 1 document (``datos.json``) as schema_version 2. A version 2 document is returned as it is."""
    if document.get("schema_version") == SCHEMA_VERSION:
        return document
    return to_public(to_internal(document))


def to_legacy(document: dict[str, Any]) -> dict[str, Any]:
    """An internal run dict as the schema_version 1 document older readers expect.

    Used for ``examples/datos.json`` only: the checklist app imports that
    layout, and the file is the fixture of the migration tests.
    """
    legacy = dict(document)
    legacy["schema_version"] = LEGACY_SCHEMA_VERSION
    meta = legacy.get("meta")
    if isinstance(meta, dict):
        legacy["meta"] = {k: v for k, v in meta.items() if k not in _V2_ONLY_META}
    return legacy


def public_trace(text: str) -> str:
    """A trace of the internal notation as it is written in run.json."""
    return _trace(text, _RUN, MEASURED_KEYS)


def public_key(path: str) -> str:
    """A dotted internal path (``meta.corridas_psi.validas``) with its public names, for console messages."""
    return _trace(path, _RUN, MEASURED_KEYS)


def _table_rows(title: str, table: dict[str, str]) -> list[tuple[str, str, str]]:
    return [(title, old, new) for old, new in table.items()]


def renames() -> list[tuple[str, str, str]]:
    """Every rename as (where, old, new): the migration table of the README."""
    rows: list[tuple[str, str, str]] = []
    for title, table in (
        ("top level", TOP_KEYS),
        ("meta", META_KEYS),
        ("meta.psi_runs", PSI_RUNS_KEYS),
        ("meta.scope", SCOPE_KEYS),
        ("meta.scope entries, meta.skipped", SCOPE_ENTRY_KEYS),
        ("meta.home_wrapper", WRAPPER_KEYS),
        ("header", HEADER_KEYS),
        ("header scores", SCORE_KEYS),
        ("checks[]", CHECK_KEYS),
        ("checks[].sentence", SENTENCE_KEYS),
        ("checks[].traces", TRACE_KEYS),
        ("checks[].measured", MEASURED_KEYS),
        ("tables", TABLES_KEYS),
        ("tables.*", TABLE_KEYS),
        ("tables.*.rows[]", TABLE_ROW_KEYS),
        ("summary", SUMMARY_KEYS),
        ("output", OUTPUT_KEYS),
        ("output.text_control[]", TEXT_ISSUE_KEYS),
        ("output.rerendered", RERENDERED_KEYS),
        ("state values", STATES),
        ("colour values", COLOURS),
        ("priority values", PRIORITIES),
        ("meta.api_key values", KEY_PRESENCE),
        ("colour_exception values", COLOUR_EXCEPTIONS),
        ("text_control rule values", TEXT_RULES),
        ("comparison", COMPARISON_KEYS),
        ("comparison sides", SIDE_KEYS),
        ("comparison by_module", MODULE_COUNT_KEYS),
        ("comparison rows[]", ROW_KEYS_OF_ROW),
        ("comparison cells", CELL_KEYS),
        ("comparison transitions[]", TRANSITION_KEYS),
        ("comparison still_open[]", STILL_OPEN_KEYS),
        ("comparison row groups", ROW_GROUPS),
        ("comparison transition kinds", TRANSITION_KINDS),
    ):
        rows += _table_rows(title, table)
    return rows
