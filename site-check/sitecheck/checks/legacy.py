"""VIS-20 · un sitio hecho para otra época: code for Internet Explorer or Flash in the home.

"The site looks ten years old" is an opinion; code written for Internet
Explorer or for Flash in the home is a fact, and this check measures it. It is
passive: it reads only the home HTML already downloaded (no request of its own).
A visitor cannot see the code it names, so the report gives the Ctrl+F word
(measured["buscar"]) for anyone who wants to confirm it in the page source.

Markers (MARKER_* below):

* Internet Explorer conditional comments, ``<!--[if lt IE 9]>`` and the like.
  Only an IE term that is not negated counts: ``[if !IE]`` and ``!(IE)`` target
  every OTHER browser, and a condition that only targets IE 10 or later
  (``gt IE 9``) never applies (IE 10 dropped conditional comments), so the
  HTML5 Boilerplate opener ``[if (gt IE 9)|!(IE)]`` is no marker. ``IEMobile``
  is no marker either.
* IE helper scripts and stylesheets, in the page or inside a conditional
  comment: html5shiv (also html5shim), respond.js, selectivizr, and a
  stylesheet named ie.css, ie6.css to ie9.css (also .min.css).
* Flash: an .swf file in an <embed>, an <object> or its <param>, or named in an
  inline swfobject call (MARKER_SWF); the swfobject library alone
  (MARKER_SWFOBJECT) proves the code for Flash, not that a Flash file is shown.
  When a script src contains "ruffle" (RUFFLE_HINT: Ruffle, the Flash emulator
  that runs in current browsers) no Flash marker counts: the .swf is then
  visible. ``measured["flash_con_emulador"]``
  records that Flash was there and is played by the emulator.

The version named: for each term of a condition, the version at the edge of
its range next to the number written ("lt IE 9" covers IE 8 and older: 8;
"lte IE 8": 8; "IE 9": 9; "gt IE 6" covers IE 7 and newer: 7; "lt IE 7": 6);
html5shiv, respond.js and selectivizr are IE 8; ie8.css is IE 8. Then the
OLDEST of those versions among all the terms and markers of the page. A bare
"[if IE]", an ie.css, or a version below 6 (no release year in
IE_RELEASE_YEARS) names just "Internet Explorer". Release years: IE 6 2001,
IE 7 2006, IE 8 2009, IE 9 2011, IE 10 2012, IE 11 2013. Microsoft retired
Internet Explorer on 15 June 2022 (IE_RETIRED_YEAR).

FALLA (Azul, the VIS colour) when any marker is present. The report says what
was found and that this "suele" mean an old theme or base, never as a
certainty. ``measured`` keeps the marker names and the version, never site
text beyond those names, plus ``buscar``: the word to look for with Ctrl+F in
the code (Flash ".swf", the IE term, "swfobject"). Flash: Adobe ended Flash on
31 December 2020 and the browsers removed it in January 2021.
"""

from __future__ import annotations

import posixpath
import re
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote, urlsplit

from .. import artifacts
from ..model import ReportPhrase, State
from . import common
from .common import new_finding

if TYPE_CHECKING:
    from ..htmlextract import PageFacts
    from ..model import EvalContext, Finding
    from ..observations import Observations

# Release years of Internet Explorer (Microsoft): the year the report can name next to the version.
IE_RELEASE_YEARS: dict[int, int] = {6: 2001, 7: 2006, 8: 2009, 9: 2011, 10: 2012, 11: 2013}
IE_RETIRED_YEAR = 2022  # 15 June 2022: the Internet Explorer 11 desktop application was retired
# Conditional comments stopped working in IE 10: a condition that only targets 10 or later never applies.
IE_FIRST_WITHOUT_CONDITIONALS = 10
# A script src with this word loads Ruffle, the Flash emulator: the Flash content is then visible.
RUFFLE_HINT = "ruffle"

# Marker names kept in measured["marcadores"] (fixed vocabulary, never site text).
MARKER_CONDITIONAL = "comentario-condicional"
MARKER_HTML5SHIV = "html5shiv"
MARKER_RESPOND = "respond.js"
MARKER_SELECTIVIZR = "selectivizr"
MARKER_IE_CSS = "hoja-ie"  # ie.css, ie6.css ... ie9.css
MARKER_SWF = "swf"
MARKER_SWFOBJECT = "swfobject"

# How the report names each marker kind.
_MARKER_WORDS: dict[str, str] = {
    MARKER_CONDITIONAL: "comentarios condicionales para Internet Explorer",
    MARKER_HTML5SHIV: "html5shiv",
    MARKER_RESPOND: "respond.js",
    MARKER_SELECTIVIZR: "selectivizr",
    MARKER_IE_CSS: "una hoja de estilos para Internet Explorer",
    MARKER_SWF: "un archivo .swf",
    MARKER_SWFOBJECT: "swfobject",
}

_CONDITION_RE = re.compile(r"^\s*\[\s*if\s+([^\]]*)\]", re.IGNORECASE)
_IE_TERM_RE = re.compile(r"(?:\b(lte|lt|gte|gt)\s+)?\bIE\b(?:\s+(\d+)(?:\.\d+)?)?", re.IGNORECASE)
_URL_ATTR_RE = re.compile(r"""(?:src|href|data|value)\s*=\s*["']?([^"'\s>]+)""", re.IGNORECASE)
_IE_CSS_RE = re.compile(r"^ie([6-9])?(?:\.min)?\.css$", re.IGNORECASE)
_RESPOND_RE = re.compile(r"^respond(?:\.min|\.src)?\.js$", re.IGNORECASE)
_SWFOBJECT_CALL_RE = re.compile(r"""swfobject\.\w+\(\s*["']([^"']+\.swf)\b""", re.IGNORECASE)
_SWF_PARAMS: frozenset[str] = frozenset({"movie", "src", "data", "url"})


def _basename(url: str) -> str:
    try:
        path = urlsplit(url).path
    except ValueError:
        path = url
    return posixpath.basename(unquote(path or "")).lower()


def _is_swf(url: str) -> bool:
    return _basename(url).endswith(".swf")


def ie_condition_version(condition: str) -> tuple[bool, int | None]:
    """(targets IE, the version it names) of one conditional-comment condition ("lt IE 9").

    Each term names the version at the edge of its range next to the number
    written: "lt IE 9" covers IE 8 and older, so 8; "lte IE 8" 8; "IE 9" 9;
    "gt IE 6" covers IE 7 and newer, so 7; "gte IE 7" 7. Several terms
    (``IE 7|IE 8``): the oldest of those versions, a bare term only when no
    term has a version. ``(False, None)`` when no IE term applies: negated
    terms (``!IE``, ``!(gt IE 8)``) and terms that only target IE 10 or later.
    ``(True, None)`` for a bare ``IE`` or a version below 6.
    """
    targets = False
    versions: list[int] = []
    for m in _IE_TERM_RE.finditer(condition or ""):
        before = condition[: m.start()].rstrip().rstrip("(").rstrip()
        if before.endswith("!"):
            continue
        op = (m.group(1) or "").lower()
        if m.group(2) is None:
            targets = True  # a bare IE term (an operator without a version is read the same way)
            continue
        n = int(m.group(2))
        version = {"lt": n - 1, "gt": n + 1}.get(op, n)
        if version >= IE_FIRST_WITHOUT_CONDITIONALS:
            continue
        targets = True
        if version in IE_RELEASE_YEARS:
            versions.append(version)
    return targets, (min(versions) if versions else None)


def _name_marker(url: str) -> tuple[str, int | None, str] | None:
    """(marker, IE version or None, Ctrl+F word) of a script or stylesheet URL, or None."""
    base = _basename(url)
    if "html5shiv" in base or "html5shim" in base:
        return MARKER_HTML5SHIV, 8, "html5sh"
    if _RESPOND_RE.match(base):
        return MARKER_RESPOND, 8, "respond."
    if "selectivizr" in base:
        return MARKER_SELECTIVIZR, 8, "selectivizr"
    m = _IE_CSS_RE.match(base)
    if m:
        return MARKER_IE_CSS, (int(m.group(1)) if m.group(1) else None), base
    return None


def loads_ruffle(page: "PageFacts") -> bool:
    """True when a script src of the page contains RUFFLE_HINT (the Flash emulator)."""
    return any(RUFFLE_HINT in (src or "").lower() for src in page.script_srcs)


def legacy_markers(page: "PageFacts") -> dict[str, Any]:
    """Everything VIS-20 found in one page: marker names, the IE version, Flash, and the Ctrl+F word of each part.

    With Ruffle loaded (loads_ruffle) the Flash markers do not count; ``flash_con_emulador``
    is True when they were there.
    """
    markers: list[str] = []
    ie = False
    ie_versions: list[int] = []
    ie_search: dict[int | None, str] = {}
    swf = False
    swfobject = False

    def add(marker: str) -> None:
        if marker not in markers:
            markers.append(marker)

    def ie_hit(version: int | None, search: str) -> None:
        nonlocal ie
        ie = True
        if version is not None:
            ie_versions.append(version)
        ie_search.setdefault(version, search)

    urls: list[str] = list(page.script_srcs) + list(page.stylesheet_hrefs)
    for comment in page.comments:
        m = _CONDITION_RE.match(comment or "")
        if not m:
            continue
        targets, version = ie_condition_version(m.group(1))
        if not targets:
            continue
        add(MARKER_CONDITIONAL)
        # The word to look for with Ctrl+F: "IE 9" finds "lt IE 9" (and "IE 6" finds "lt IE 6",
        # named without a version); a condition without a number, "[if IE".
        term = re.search(r"IE\s+\d+", m.group(1), re.IGNORECASE)
        ie_hit(version, re.sub(r"\s+", " ", term.group(0)) if term else "[if IE")
        urls += _URL_ATTR_RE.findall(comment)
    for url in urls:
        named = _name_marker(url)
        if named is not None:
            marker, version, search = named
            add(marker)
            ie_hit(version, search)
        elif "swfobject" in _basename(url):
            add(MARKER_SWFOBJECT)
            swfobject = True
        elif _is_swf(url):
            add(MARKER_SWF)
            swf = True
    for tag, _attr, url in page.subresources:
        if tag in ("embed", "object") and _is_swf(url):
            add(MARKER_SWF)
            swf = True
    for name, value in page.params:
        if name in _SWF_PARAMS and _is_swf(value):
            add(MARKER_SWF)
            swf = True
    for script in page.inline_scripts:
        if _SWFOBJECT_CALL_RE.search(script):
            add(MARKER_SWF)
            swf = True
    emulated = (swf or swfobject) and loads_ruffle(page)
    if emulated:
        markers = [m for m in markers if m not in (MARKER_SWF, MARKER_SWFOBJECT)]
        swf = swfobject = False
    oldest = min(ie_versions) if ie_versions else None
    return {
        "marcadores": markers,
        "ie": ie,
        "ie_version": oldest,
        "flash": swf,
        "flash_codigo": swfobject and not swf,
        "flash_con_emulador": emulated,
        "buscar_ie": ie_search.get(oldest) if ie else None,
    }


def _marker_text(markers: list[str]) -> str:
    """The marker kinds in words for the report: one or two named, more as "entre otras"."""
    words = [_MARKER_WORDS[m] for m in markers if m in _MARKER_WORDS]
    if len(words) <= 2:
        return " y ".join(words)
    return f"{words[0]} y {words[1]}, entre otras"


def evaluate_vis20(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-20 · un sitio hecho para otra época, report only.

    Reads the home PageFacts only (comments, scripts, stylesheets, embeds,
    params, inline scripts). FALLA when any marker of the module docstring is
    present; APROBADO when none is. measured: marcadores, ie, ie_version, flash, flash_codigo,
    flash_con_emulador, and for a FALLA buscar (the Ctrl+F word: ".swf" for
    Flash content, the IE term, "swfobject").
    """
    spec = common.spec_of("VIS-20")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    found = legacy_markers(page)
    evidence = [common.page_evidence(obs.home, artifacts.HOME_HTML)]
    markers: list[str] = found["marcadores"]
    measured: dict[str, Any] = {
        "marcadores": list(markers),
        "ie": found["ie"],
        "ie_version": found["ie_version"],
        "flash": found["flash"],
        "flash_codigo": found["flash_codigo"],
        "flash_con_emulador": found["flash_con_emulador"],
    }
    if not markers:
        if found["flash_con_emulador"]:
            approved = ReportPhrase(
                found=(
                    "El código de la página principal no tiene partes para Internet Explorer; su contenido Flash se "
                    "muestra con Ruffle, un emulador que funciona en los navegadores actuales"
                ),
                consequence="El contenido Flash se sigue viendo gracias al emulador",
            )
        else:
            approved = ReportPhrase(
                found="El código de la página principal no tiene partes para Internet Explorer ni contenido para Flash",
                consequence="El código de la portada no arrastra partes para navegadores que ya no se usan",
            )
        return new_finding(spec, State.APROBADO, measured=measured, evidence=evidence, phrase_report=approved)
    version = found["ie_version"]
    ie_markers = [m for m in markers if m not in (MARKER_SWF, MARKER_SWFOBJECT)]
    flash_markers = [m for m in markers if m in (MARKER_SWF, MARKER_SWFOBJECT)]
    if found["flash"]:
        search = ".swf"
    elif found["ie"]:
        search = found["buscar_ie"]
    else:
        search = "swfobject"
    measured["buscar"] = search
    clauses: list[str] = []
    if flash_markers:
        what = "contenido para Flash" if found["flash"] else "una herramienta para mostrar contenido Flash"
        clauses.append(f"{what} ({_marker_text(flash_markers)})")
    if ie_markers:
        target = f"Internet Explorer {version}" if version is not None else "Internet Explorer"
        clauses.append(f"partes escritas para {target} ({_marker_text(ie_markers)})")
    found_text = "El código de la página principal incluye " + " y ".join(clauses)
    consequence = "Suele ser señal de que el tema o la base del sitio se hizo hace años"
    if found["flash"]:
        consequence = "Ese contenido no se ve en los navegadores actuales, y suele ser señal de que la base del sitio se hizo hace años"
    action = common.on_platform(
        obs,
        ctx,
        wordpress="Actualizar el tema o rehacer el sitio sobre una base actual",
        other="Actualizar la base del sitio o rehacerla con una actual",
    )
    return new_finding(
        spec,
        State.FALLA,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=found_text, consequence=consequence, action=action, who="Quien mantiene el sitio"),
    )
