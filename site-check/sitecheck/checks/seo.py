"""Visibility (SEO) checks: VIS-01..VIS-08 and VIS-14 (VIS module: FALLA is Azul).

Pages come from ctx.pages ("home", "interna", "hreflang:<code>"), parsed once by
evaluate.py. "The worst result of home and interna wins" where the check says so;
a missing interna never fails a check by itself (it is noted).
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from .. import artifacts, domains, fmt
from ..htmlextract import normalize_for_match, parse_link_header
from .. import kinds
from ..model import ColourException, ReportPhrase, State
from ..robots import RobotsState, _select_rules, is_allowed, parse_robots
from ..scope import Purpose
from . import common
from .common import new_finding, not_applicable, not_verified

if TYPE_CHECKING:
    from ..htmlextract import PageFacts
    from ..httpclient import Response
    from ..model import EvalContext, Finding
    from ..observations import Observations

TITLE_SEPARATORS: tuple[str, ...] = (" - ", " | ", " \u2013 ", " · ")  # the en dash is site text, never ours
GENERIC_TITLE_WORDS: tuple[str, ...] = (
    "inicio",
    "home",
    "pagina de inicio",
    "bienvenidos",
    "welcome",
    "otro sitio realizado con wordpress",
    "just another wordpress site",
)
TITLE_LEN = (50, 60)
DESCRIPTION_LEN = (120, 160)
OG_MIN_SIZE = (1200, 630)
OG_RATIO = 1.91
OG_RATIO_TOLERANCE = 0.10
ORG_TYPES: frozenset[str] = frozenset(
    {
        "Organization",
        "EducationalOrganization",
        "School",
        "ElementarySchool",
        "MiddleSchool",
        "HighSchool",
        "Preschool",
        "CollegeOrUniversity",
        "LocalBusiness",
    }
)
SPANISH_STOPWORDS: tuple[str, ...] = ("de", "la", "que", "el", "en", "los", "para", "con")

# Region subtags that look valid but are wrong (en-UK should be en-GB; es-LA is Laos).
_WRONG_REGIONS: frozenset[str] = frozenset({"uk", "la", "eu"})
_HREFLANG_RE = re.compile(r"^[a-z]{2}(?:-[a-z]{2})?$", re.IGNORECASE)
_LANG_RE = re.compile(r"^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$", re.IGNORECASE)
_XRT_KNOWN_DIRECTIVES: frozenset[str] = frozenset(
    {"unavailable_after", "max-snippet", "max-image-preview", "max-video-preview"}
)
_LANG_NAMES: dict[str, str] = {
    "en": "inglés",
    "pt": "portugués",
    "fr": "francés",
    "it": "italiano",
    "de": "alemán",
    "ca": "catalán",
}

_WHO = "Quien mantiene el sitio"

# Trailing legal forms that are not part of the name a reader looks for in a
# title ("Acme S.A." is titled "Acme").
LEGAL_SUFFIXES: frozenset[str] = frozenset(
    {"sa", "s.a", "s.a.", "sas", "s.a.s", "s.a.s.", "srl", "s.r.l", "s.r.l.", "sca", "s.c.a", "s.c.a.", "sh", "s.h", "s.h.", "ltda", "ltda."}
)


def strip_legal_suffix(name: str) -> str:
    """"Acme S.A." -> "Acme"; a name that is only a legal form is left as typed."""
    words = name.split()
    while len(words) > 1 and words[-1].lower().rstrip(",") in LEGAL_SUFFIXES:
        words = words[:-1]
    return " ".join(words)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _home_evidence(obs: "Observations") -> str:
    return common.page_evidence(obs.home, artifacts.HOME_HTML)


def _interna_page(obs: "Observations", ctx: "EvalContext") -> "PageFacts | None":
    return ctx.pages.get("interna") if obs.interna is not None else None


def _first_segment(title: str) -> str:
    """The title up to its first separator (site text, unsanitized)."""
    cut = len(title)
    for sep in TITLE_SEPARATORS:
        i = title.find(sep)
        if 0 <= i < cut:
            cut = i
    return title[:cut].strip()


def generic_word(title: str | None) -> str | None:
    """The generic first segment of ``title`` as written (e.g. "Inicio"), or None."""
    if not title:
        return None
    first = _first_segment(title)
    generic = {normalize_for_match(w) for w in GENERIC_TITLE_WORDS}
    if normalize_for_match(first) in generic:
        return first
    if normalize_for_match(title) in generic:
        return title.strip()
    return None


def _directive_tokens(value: str) -> list[str]:
    return [t.strip().lower() for t in value.split(",") if t.strip()]


def _meta_noindex(values: list[str]) -> bool:
    for v in values:
        tokens = _directive_tokens(v)
        if "noindex" in tokens or "none" in tokens:
            return True
    return False


def _header_noindex(resp: "Response | None") -> bool:
    """X-Robots-Tag noindex/none for every crawler or for googlebot."""
    if resp is None:
        return False
    for value in resp.header_all("X-Robots-Tag"):
        text = value.strip().lower()
        agent = None
        if ":" in text:
            head, rest = text.split(":", 1)
            head = head.strip()
            if head and " " not in head and "," not in head and head not in _XRT_KNOWN_DIRECTIVES:
                agent, text = head, rest
        if agent not in (None, "googlebot"):
            continue
        tokens = _directive_tokens(text)
        if "noindex" in tokens or "none" in tokens:
            return True
    return False


def _path_of(url: str) -> str:
    parts = urlsplit(url)
    path = parts.path or "/"
    return path + ("?" + parts.query if parts.query else "")


def _robots_parsed(obs: "Observations"):
    """(state, parsed) of robots.txt; an INVALID file (wrong Content-Type) is parsed
    anyway when it is not HTML, because Google reads it as text."""
    rf = obs.robots
    if rf is None:
        return None, None
    state = rf.state
    if state == RobotsState.OK:
        return state, rf.parsed
    if state == RobotsState.INVALID and rf.response is not None and rf.response.body:
        text, _ = rf.response.text()
        if "<html" not in text[:1024].lower():
            return state, parse_robots(text)
    return state, None


def _join_clauses(parts: list[str]) -> str:
    """Join whole clauses with commas and a final "y"."""
    parts = [p for p in parts if p]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " y " + parts[-1]


# ---------------------------------------------------------------------------
# VIS-01
# ---------------------------------------------------------------------------


def evaluate_vis01(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-01 · Google puede mostrar el sitio.

    Sources: meta robots/googlebot (noindex, none) and X-Robots-Tag of home and
    interna; robots.txt (robots.RobotsState) evaluated with robots.is_allowed for
    "googlebot" on "/", the interna path, and one CSS and one JS asset path of
    the home. FALLA when the home or interna has noindex, or robots.txt
    disallows "/" or the interna. When the HOME carries noindex (meta or header)
    set colour_exception SITEWIDE_NOINDEX. A robots.txt
    "Disallow: /" keeps the table colour (Azul); the decision names only noindex.
    APROBADO_CON_OBSERVACION (Amarillo, Crítica) when robots.txt blocks the CSS
    or JS asset, or answered 5xx. NO_VERIFICADO when robots.txt was challenged
    and no noindex was seen (a meta noindex is confirmable alone and stays FALLA).
    measured.robots_whole_site is True only when "/" AND the interna are blocked
    and the googlebot group has no Allow rule: "Disallow: /$" or an Allow
    exception blocks the home and leaves other pages open. robots.txt forbids
    crawling, not showing: Google can still list the address, so the sentence
    says what robots.txt says ("no lo recorra"), never "no lo muestre".
    """
    spec = common.spec_of("VIS-01")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    home_resp = common.home_response(obs)
    interna = _interna_page(obs, ctx)
    interna_resp = obs.interna.response if obs.interna is not None else None

    home_meta = _meta_noindex(page.robots_meta + page.googlebot_meta)
    home_header = _header_noindex(home_resp)
    interna_meta = bool(interna is not None and _meta_noindex(interna.robots_meta + interna.googlebot_meta))
    interna_header = bool(interna is not None and _header_noindex(interna_resp))

    state, parsed = _robots_parsed(obs)
    blocks_root = blocks_interna = False
    blocked_assets: list[str] = []
    if parsed is not None:
        blocks_root = not is_allowed(parsed, "/", "googlebot")
        if interna is not None and obs.interna is not None:
            blocks_interna = not is_allowed(parsed, _path_of(obs.interna.url), "googlebot")
        css = next((u for u in page.stylesheet_hrefs if domains.is_same_site(u, obs.registrable)), None)
        js = next((u for u in page.script_srcs if domains.is_same_site(u, obs.registrable)), None)
        if css and not is_allowed(parsed, _path_of(css), "googlebot"):
            blocked_assets.append("css")
        if js and not is_allowed(parsed, _path_of(js), "googlebot"):
            blocked_assets.append("js")

    measured: dict[str, Any] = {
        "home_noindex_meta": home_meta,
        "home_noindex_header": home_header,
        "interna_noindex": interna_meta or interna_header,
        "interna_checked": interna is not None,
        "robots_state": state.value if state is not None else None,
        "robots_blocks_root": blocks_root,
        "robots_blocks_interna": blocks_interna,
        "robots_blocked_assets": blocked_assets,
    }
    evidence = [_home_evidence(obs), common.headers_evidence(obs.home, artifacts.HOME_HEADERS)]
    evidence += common.optional_evidence(ctx, artifacts.ROBOTS)
    if interna is not None:
        evidence += common.optional_evidence(ctx, common.page_evidence(obs.interna, artifacts.INTERNA_HTML))

    kind = kinds.of(ctx.kind)
    consequence = f"Quien busca {kind.el} en Google no lo encuentra"
    action = common.on_platform(obs, ctx, wordpress="Quitar el bloqueo en el plugin de SEO o en los ajustes de lectura", other="Quitar el bloqueo en la configuración del sitio")

    if home_meta or home_header:
        how = "con una etiqueta en la página principal" if home_meta else "con una indicación del servidor"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            colour_exception=ColourException.SITEWIDE_NOINDEX,
            phrase_report=ReportPhrase(
                found=f"El sitio entero le pide a Google que no lo muestre ({how})",
                consequence=consequence,
                action=action,
                who=_WHO,
            ),
        )
    if blocks_root:
        has_allow = parsed is not None and any(allow for allow, _ in _select_rules(parsed, "googlebot"))
        whole_site = blocks_interna and not has_allow
        measured["robots_whole_site"] = whole_site
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="El sitio entero le pide a Google que no lo recorra (en el archivo robots.txt)",
                consequence=consequence,
                action=action,
                who=_WHO,
            ),
        )
    if interna_meta or interna_header or blocks_interna:
        how = "en el archivo robots.txt" if blocks_interna and not (interna_meta or interna_header) else "con una etiqueta en la página"
        path = fmt.sanitize_site_text(urlsplit(obs.interna.url).path or "/", 60) if obs.interna else ""
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=f"La página {path} le pide a Google que no la muestre ({how})",
                consequence="Quien busca esa sección en Google no la encuentra",
                action=action,
                who=_WHO,
            ),
        )
    if state == RobotsState.CHALLENGED or (state is None and obs.blocked):
        return not_verified(spec, common.blocked_reason(obs), measured=measured)
    if state in (RobotsState.ERROR, RobotsState.NOT_FETCHED, None) or (state == RobotsState.INVALID and parsed is None):
        reason = common.fetch_reason(
            obs, Purpose.ROBOTS.value, obs.robots.response if obs.robots else None, "el archivo robots.txt no se pudo leer"
        )
        return not_verified(spec, reason, measured=measured)
    if state == RobotsState.UNREACHABLE_5XX and not blocked_assets and common.run_throttled(obs):
        # A 5xx while the site asked to slow down, or after the cut, is not an error of robots.txt.
        return not_verified(spec, common.throttle_reason(obs), measured=measured)
    if state == RobotsState.UNREACHABLE_5XX or blocked_assets:
        if blocked_assets:
            found = "Google puede mostrar el sitio, pero el archivo robots.txt le impide ver el diseño de la página"
        else:
            found = "Google puede mostrar la página principal, pero el archivo robots.txt da un error del servidor"
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="robots.txt con bloqueos parciales" if blocked_assets else "robots.txt con error del servidor",
            phrase_report=ReportPhrase(
                found=found,
                consequence="Google puede dejar de recorrer el sitio o verlo incompleto",
                action="Corregir el archivo robots.txt",
                who=_WHO,
            ),
        )
    found = (
        "Google puede mostrar la página principal y las internas"
        if interna is not None
        else "Google puede mostrar la página principal"
    )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=found, consequence="El sitio aparece cuando lo buscan"),
    )


# ---------------------------------------------------------------------------
# VIS-02
# ---------------------------------------------------------------------------


def _sitemap_system(url: str) -> str:
    path = urlsplit(url).path.lower()
    if "wp-sitemap" in path:
        return "wordpress"
    if "sitemap_index" in path or "sitemap-index" in path:
        return "indice"
    return path.rsplit("/", 1)[-1] or "sitemap"


def _on_canonical_origin(url: str, canonical_url: str | None) -> bool:
    if not canonical_url:
        return False
    a, b = urlsplit(url.strip()), urlsplit(canonical_url)
    try:
        return a.scheme.lower() == b.scheme.lower() and domains.normalize_host(a.hostname or "") == domains.normalize_host(b.hostname or "")
    except ValueError:
        return False


def evaluate_vis02(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-02 · mapa del sitio.

    APROBADO: robots.txt 200 with at least one Sitemap: line, the declared sitemap
    valid XML with at least one <loc> on the canonical scheme and host.
    APROBADO_CON_OBSERVACION: valid but found at a standard path (not declared);
    or robots.txt declares two sitemap systems; or some <loc> use another scheme
    or host. FALLA: no sitemap found or it has no <loc>. NO_VERIFICADO: challenged
    or HTML instead of XML. measured: n_locs, n_locs_canonical,
    declared, systems.
    """
    spec = common.spec_of("VIS-02")
    if obs.home_unreachable or obs.home is None or obs.canonical_url is None:
        return common.home_missing_finding(spec, obs)
    rf = obs.robots
    state = rf.state if rf is not None else None
    robots_resp = rf.response if rf is not None else None
    if state is None:
        return not_verified(spec, common.fetch_reason(obs, Purpose.ROBOTS.value, None, "el archivo robots.txt no se pidió"))
    if state == RobotsState.CHALLENGED:
        return not_verified(spec, common.blocked_reason(obs))
    if state in (RobotsState.ERROR, RobotsState.NOT_FETCHED):
        return not_verified(spec, common.fetch_reason(obs, Purpose.ROBOTS.value, robots_resp, "el archivo robots.txt no respondió"))
    if state != RobotsState.OK or rf.parsed is None:
        reason = {
            RobotsState.NO_RESTRICTIONS_4XX: "el sitio no publica el archivo robots.txt, y el mapa del sitio se busca a mano",
            RobotsState.SOFT_404: "el sitio no publica el archivo robots.txt, y el mapa del sitio se busca a mano",
            RobotsState.UNREACHABLE_5XX: "el archivo robots.txt da un error del servidor, y el mapa del sitio se busca a mano",
        }.get(state, "el archivo robots.txt no se pudo leer, y el mapa del sitio se busca a mano")
        # The report says what was not seen; the manual search is in the annex.
        grey = {
            RobotsState.NO_RESTRICTIONS_4XX: "El sitio no publica el archivo robots.txt, así que el mapa del sitio no se buscó",
            RobotsState.SOFT_404: "El sitio no publica el archivo robots.txt, así que el mapa del sitio no se buscó",
            RobotsState.UNREACHABLE_5XX: "El archivo robots.txt da un error del servidor, así que el mapa del sitio no se buscó",
        }.get(state, "El archivo robots.txt no se pudo leer, así que el mapa del sitio no se buscó")
        return not_verified(spec, reason, measured={"robots_state": state.value}, phrase_report=ReportPhrase(found=grey))

    declared_urls = list(rf.parsed.sitemaps)
    same_site_declared = [u for u in declared_urls if domains.is_same_site(u, obs.registrable)]
    systems = sorted({_sitemap_system(u) for u in same_site_declared})
    measured: dict[str, Any] = {
        "declared": bool(declared_urls),
        "declared_count": len(declared_urls),
        "systems": len(systems),
        "n_locs": None,
        "n_locs_canonical": None,
        "kind": None,
        "robots_state": state.value,
    }
    evidence = [artifacts.ROBOTS]

    valid = next((sf for sf in obs.sitemaps if sf.valid and sf.doc is not None), None)
    if valid is None:
        if declared_urls and not same_site_declared:
            return not_verified(spec, "el mapa del sitio declarado está en otro dominio", measured=measured)
        for sf in obs.sitemaps:
            r = sf.response
            if r is None:
                continue
            if r.skipped or r.challenge or (r.error and r.status is None):
                reason = common.fetch_reason(obs, Purpose.SITEMAP.value, r, "el mapa del sitio no respondió")
                return not_verified(spec, reason, measured=measured)
            if getattr(sf, "unreadable", False):
                # A gzipped sitemap that could not be read is not "missing".
                return not_verified(spec, "el mapa del sitio está comprimido y no se pudo leer", measured=measured)
            if getattr(sf, "soft_404", False) or getattr(r, "soft_404", False):
                continue  # an HTML "not found" page served with 200: the sitemap does not exist
            if r.status == 200 and r.content_type in ("text/html", "application/xhtml+xml"):
                return not_verified(spec, "el mapa del sitio respondió con una página en lugar del mapa", measured=measured)
        if not obs.sitemaps:
            reason = common.fetch_reason(obs, Purpose.SITEMAP.value, None, "el mapa del sitio no se pidió")
            if declared_urls:
                return not_verified(spec, reason, measured=measured)
        found = "El mapa del sitio declarado no se encuentra" if declared_urls else "No hay mapa del sitio para Google"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=found,
                consequence="Google tarda más en encontrar las páginas nuevas o mira direcciones viejas",
                action=common.on_platform(obs, ctx, wordpress="Dejar un solo mapa en el plugin de SEO y declararlo", other="Dejar un solo mapa del sitio y declararlo en robots.txt"),
                who=_WHO,
            ),
        )

    doc = valid.doc
    locs = list(doc.locs)
    kind = doc.kind.value
    child = valid.child
    if child is not None and child.valid and child.doc is not None:
        page_locs = list(child.doc.locs)
        evidence += common.optional_evidence(ctx, artifacts.SITEMAP_CHILD)
    else:
        page_locs = locs if kind == "urlset" else []
    all_locs = locs + page_locs if kind != "urlset" else locs
    n_canonical = sum(1 for u in all_locs if _on_canonical_origin(u, obs.canonical_url))
    measured.update(n_locs=len(page_locs) if kind != "urlset" else len(locs), n_locs_canonical=n_canonical, kind=kind)
    evidence.append(artifacts.SITEMAP)

    if not locs:
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="El mapa del sitio está vacío",
                consequence="Google tarda más en encontrar las páginas nuevas o mira direcciones viejas",
                action=common.on_platform(obs, ctx, wordpress="Dejar un solo mapa en el plugin de SEO y declararlo", other="Dejar un solo mapa del sitio y declararlo en robots.txt"),
                who=_WHO,
            ),
        )

    observation = None
    if not valid.declared:
        observation = "El mapa del sitio existe pero no está declarado"
    elif len(systems) >= 2:
        observation = "Hay dos mapas del sitio"
    elif n_canonical < len(all_locs):
        observation = "El mapa lista direcciones con otro formato que el del sitio"
    if observation:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason=observation,
            phrase_report=ReportPhrase(
                found=observation,
                consequence="Google tarda más en encontrar las páginas nuevas o mira direcciones viejas",
                action=common.on_platform(obs, ctx, wordpress="Dejar un solo mapa en el plugin de SEO y declararlo", other="Dejar un solo mapa del sitio y declararlo en robots.txt"),
                who=_WHO,
            ),
        )
    n = len(locs)
    if kind == "urlset" and n > 1:
        found = f"El sitio le da a Google el mapa de sus {n} páginas"
    elif kind == "urlset":
        found = "El sitio le da a Google el mapa de su única página"
    else:
        found = "El sitio le da a Google el mapa de sus páginas"
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=found, consequence="Google encuentra las páginas nuevas sin esperar"),
    )


# ---------------------------------------------------------------------------
# VIS-03
# ---------------------------------------------------------------------------


def _canonicals_of(page: "PageFacts", resp: "Response | None") -> list[str]:
    out = list(page.canonicals)
    if resp is not None:
        for value in resp.header_all("Link"):
            for url, params in parse_link_header(value):
                rels = {r.lower() for r in (params.get("rel") or "").split()}
                if "canonical" in rels:
                    resolved = domains.resolve_url(resp.final_url or resp.url, url)
                    if resolved:
                        out.append(resolved)
    return out


def _canonical_problem(page: "PageFacts", resp: "Response | None", page_url: str, canonical_url: str) -> tuple[str | None, str | None]:
    """(problem key, the other URL) for one page; (None, None) when it points to itself."""
    canon = _canonicals_of(page, resp)
    keys = {domains.compare_key(u) for u in canon}
    if not keys:
        return "missing", None
    if len(keys) > 1:
        return "conflict", None
    target = canon[0]
    if domains.compare_key(target) != domains.compare_key(page_url) or not _on_canonical_origin(target, canonical_url):
        return "elsewhere", target
    return None, None


def evaluate_vis03(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-03 · dirección oficial (canonical).

    <link rel=canonical> (rel as token list) and Link header rel=canonical of home
    and interna, compared with domains.compare_key against each page's final URL
    and the canonical scheme/host. APROBADO: both self-referencing on H's origin.
    FALLA: missing, conflicting, or pointing elsewhere. APROBADO_CON_OBSERVACION:
    home fine but interna not fetched. NO_VERIFICADO: no home.
    """
    spec = common.spec_of("VIS-03")
    page = ctx.pages.get("home")
    home_resp = common.home_response(obs)
    if page is None or home_resp is None or obs.canonical_url is None:
        return common.home_missing_finding(spec, obs)
    interna = _interna_page(obs, ctx)
    home_problem, home_other = _canonical_problem(page, home_resp, home_resp.final_url or obs.canonical_url, obs.canonical_url)
    interna_problem = interna_other = None
    if interna is not None and obs.interna is not None and obs.interna.response is not None:
        iresp = obs.interna.response
        interna_problem, interna_other = _canonical_problem(interna, iresp, iresp.final_url or obs.interna.url, obs.canonical_url)
    measured = {
        "home_problem": home_problem,
        "interna_problem": interna_problem,
        "interna_checked": interna is not None,
    }
    evidence = [_home_evidence(obs)]
    if interna is not None:
        evidence.append(common.page_evidence(obs.interna, artifacts.INTERNA_HTML))

    def sentence(where: str, problem: str, other: str | None) -> str:
        if problem == "missing":
            return f"{where} no indica cuál es su dirección oficial"
        if problem == "conflict":
            return f"{where} indica más de una dirección oficial"
        return f"{where} indica como oficial otra dirección: {fmt.sanitize_site_url(other or '', 90)}"

    problems = []
    if home_problem:
        problems.append(sentence("La página principal", home_problem, home_other))
    if interna_problem:
        problems.append(sentence("Una página interna", interna_problem, interna_other))
    if problems:
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="; ".join([problems[0]] + [p[0].lower() + p[1:] for p in problems[1:]]),
                consequence="Google puede repartir la relevancia entre dos direcciones o mostrar la equivocada",
                action=common.on_platform(obs, ctx, wordpress="Corregir la dirección oficial en el plugin de SEO", other="Corregir la dirección oficial en la configuración del sitio"),
                who=_WHO,
            ),
        )
    if interna is None:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="la página interna no se pudo revisar",
            phrase_report=ReportPhrase(
                found="La página principal indica su propia dirección oficial; una página interna no se pudo revisar",
                consequence="Sin la página interna no se sabe si el resto del sitio hace lo mismo",
                action="Revisar una página interna",
                who=_WHO,
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found="Cada página indica su propia dirección oficial", consequence="Google no se confunde entre copias"),
    )


# ---------------------------------------------------------------------------
# VIS-04
# ---------------------------------------------------------------------------


# Words of an institution's name that a title often changes or leaves out
# ("Colegio Nacional Ejemplo", "Ejemplo School", "Escuela N° 5"): the name test
# compares the OTHER words.
NAME_GENERIC_WORDS: frozenset[str] = frozenset(
    {
        "colegio", "instituto", "escuela", "jardin", "nacional", "provincial", "municipal", "privado", "privada",
        "de", "del", "la", "el", "los", "las", "y", "e", "n", "no", "nro", "numero", "num",
        "the", "school", "college", "institute", "nivel", "inicial", "infantes",
    }
)
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def name_match(institution: str | None, title: str) -> str | None:
    """"full", "partial" or "none": how the meaningful words of ``institution`` appear in ``title``.

    Words are compared after normalize_for_match, in any order, as whole words;
    NAME_GENERIC_WORDS are ignored. A name made only of generic words is
    compared whole. None when there is no name or no title.
    """
    if not institution or not title:
        return None
    title_n = normalize_for_match(title)
    title_words = set(_TOKEN_RE.findall(title_n))
    institution = strip_legal_suffix(institution)  # "Acme S.A.": "s" and "a" are not name words
    core = [w for w in _TOKEN_RE.findall(normalize_for_match(institution)) if w not in NAME_GENERIC_WORDS]
    if not core:
        return "full" if normalize_for_match(institution) in title_n else "none"
    present = [w for w in core if w in title_words]
    if len(present) == len(core):
        return "full"
    return "partial" if present else "none"


def _title_check(page: "PageFacts", institution: str | None) -> dict[str, Any]:
    title = (page.title or "").strip()
    description = (page.meta_description or "").strip()
    word = generic_word(title)
    match = name_match(institution, title)
    name_missing = match == "none"
    return {
        "title": title,
        "title_len": len(title),
        "description_len": len(description) if description else 0,
        "empty_title": not title,
        "generic": word,
        "name_missing": name_missing,
        "name_partial": match == "partial",
        "no_description": not description,
        "lengths_off": bool(title)
        and (not (TITLE_LEN[0] <= len(title) <= TITLE_LEN[1]) or (bool(description) and not (DESCRIPTION_LEN[0] <= len(description) <= DESCRIPTION_LEN[1]))),
    }


def _title_fails(c: dict[str, Any]) -> bool:
    return bool(c["empty_title"] or c["generic"] or c["name_missing"] or c["no_description"])


def evaluate_vis04(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-04 · título y descripción.

    Title split on TITLE_SEPARATORS; first segment normalized
    (htmlextract.normalize_for_match) compared with GENERIC_TITLE_WORDS; with
    ctx.institution, the normalized title must contain the normalized name.
    FALLA: empty title, generic first segment, name missing (only with --name),
    or description missing. APROBADO_CON_OBSERVACION (Azul): only lengths outside
    TITLE_LEN / DESCRIPTION_LEN. Worst of home and interna. Without --name the
    name test is skipped and that is said in ``note``.
    Site text is quoted after fmt.sanitize_site_text, so a title cannot
    inject Markdown or control characters into the report.
    """
    spec = common.spec_of("VIS-04")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    kind = kinds.of(ctx.kind)
    home = _title_check(page, ctx.institution)
    interna_page = _interna_page(obs, ctx)
    interna = _title_check(interna_page, None) if interna_page is not None else None
    titulo = fmt.sanitize_site_text(home["title"], 90)
    measured = {
        "title_len": home["title_len"],
        "description_len": home["description_len"],
        "generic_title": bool(home["generic"]),
        "name_missing": home["name_missing"],
        "no_description": home["no_description"],
        "name_checked": bool(ctx.institution),
        "name_partial": home["name_partial"],
        "interna_checked": interna is not None,
        "interna_fails": bool(interna and _title_fails(interna)),
    }
    internal_note = None if ctx.institution else "no se indicó --name, así que no se comprobó si el título lo incluye"
    evidence = [_home_evidence(obs)]
    if interna is not None:
        evidence.append(common.page_evidence(obs.interna, artifacts.INTERNA_HTML))

    consequence = f"Google muestra peor el sitio y quien busca {kind.el} no lo reconoce de un vistazo"
    action = common.on_platform(obs, ctx, wordpress="Escribir título y descripción en el plugin de SEO, página por página clave", other="Escribir título y descripción en la configuración de cada página clave")
    if _title_fails(home) or (interna and _title_fails(interna)):
        trace: dict[str, str] = {}
        if not home["empty_title"] and _title_fails(home):
            trace = {"{titulo}": "home <title>", "{n}": "checks[VIS-04].measured.title_len"}
        if home["empty_title"]:
            found = "La página principal no tiene título" + (" ni descripción" if home["no_description"] else "")
        elif _title_fails(home):
            n = home["title_len"]
            found = f"El título de la página principal es «{titulo}» ({n} caracteres)"
            if home["name_missing"]:
                found += f", sin el nombre {kind.del_}"
            elif home["generic"]:
                found += f", y empieza con «{fmt.sanitize_site_text(home['generic'], 40)}»"
            if home["no_description"]:
                found += ", y la página no tiene descripción"
        else:
            found = "Una página interna tiene un título que no dice qué es o no tiene descripción"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            internal_note=internal_note,
            trace=trace,
            phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who=_WHO),
        )
    if home["name_partial"]:
        # Some words of the name are there and some are not: worth a look, not a failure.
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            internal_note=internal_note,
            reason="el título tiene solo una parte del nombre",
            phrase_report=ReportPhrase(
                found=f"El título de la página principal es «{titulo}» y tiene solo una parte del nombre {kind.del_}",
                consequence=consequence,
                action=action,
                who=_WHO,
            ),
        )
    if home["lengths_off"] or (interna and interna["lengths_off"]):
        n, m = home["title_len"], home["description_len"]
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            internal_note=internal_note,
            reason="largo del título o de la descripción",
            trace={"{n}": "checks[VIS-04].measured.title_len", "{m}": "checks[VIS-04].measured.description_len"},
            phrase_report=ReportPhrase(
                found=f"El título tiene {n} caracteres y la descripción {m}; lo recomendado es 50 a 60 y 120 a 160",
                consequence="Google los corta o los completa a su manera",
                action=action,
                who=_WHO,
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        internal_note=internal_note,
        phrase_report=ReportPhrase(
            found="El título y la descripción de la página principal dicen qué es el sitio",
            consequence=f"Quien busca {kind.el} lo reconoce de un vistazo en Google",
        ),
    )


# ---------------------------------------------------------------------------
# VIS-05
# ---------------------------------------------------------------------------


def _heading_facts(page: "PageFacts") -> tuple[int, bool]:
    levels = page.headings
    n_h1 = sum(1 for lv in levels if lv == 1)
    skips = any(b > a + 1 for a, b in zip(levels, levels[1:]))
    return n_h1, skips


def evaluate_vis05(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-05 · un solo título principal.

    PageFacts.headings of home and interna. APROBADO: exactly one h1 on each
    page and no level skips. FALLA: 0 or 2+ h1 on either page.
    APROBADO_CON_OBSERVACION (Azul, Baja): one h1 but skipped levels.
    """
    spec = common.spec_of("VIS-05")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    interna = _interna_page(obs, ctx)
    h_n, h_skip = _heading_facts(page)
    i_n, i_skip = _heading_facts(interna) if interna is not None else (None, False)
    measured = {"n_h1_home": h_n, "skips_home": h_skip, "n_h1_interna": i_n, "skips_interna": i_skip}
    evidence = [_home_evidence(obs)]
    if interna is not None:
        evidence.append(common.page_evidence(obs.interna, artifacts.INTERNA_HTML))

    def count_sentence(where: str, n: int) -> str:
        if n == 0:
            return f"{where} no tiene títulos de primer nivel; lo correcto es uno"
        return f"{where} tiene {n} títulos de primer nivel; lo correcto es uno"

    if h_n != 1 or (i_n is not None and i_n != 1):
        found = count_sentence("La página principal", h_n) if h_n != 1 else count_sentence("Una página interna", i_n or 0)
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=found,
                consequence="Google y los lectores de pantalla no saben cuál es el tema principal",
                action=common.on_platform(obs, ctx, wordpress="Ajustarlo en el constructor; los sliders suelen agregar títulos de más", other="Ajustarlo en el editor del sitio; los carruseles de imágenes suelen agregar títulos de más"),
                who=_WHO,
            ),
        )
    if h_skip or i_skip:
        where = "La página principal" if h_skip else "Una página interna"
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="subtítulos con saltos de nivel",
            phrase_report=ReportPhrase(
                found=f"{where} tiene un solo título principal, pero sus subtítulos saltan niveles",
                consequence="Los lectores de pantalla recorren la página con saltos",
                action=common.on_platform(obs, ctx, wordpress="Ordenar los subtítulos en el constructor", other="Ordenar los subtítulos en el editor del sitio"),
                who=_WHO,
            ),
        )
    found = (
        "Cada página tiene un solo título principal y sus subtítulos en orden"
        if interna is not None
        else "La página principal tiene un solo título principal y sus subtítulos en orden"
    )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=found, consequence="Google y los lectores de pantalla entienden la estructura"),
    )


# ---------------------------------------------------------------------------
# VIS-06
# ---------------------------------------------------------------------------


def _distinct(values: list[str]) -> list[str]:
    seen: list[str] = []
    for v in values:
        v = v.strip()
        if v and v not in seen:
            seen.append(v)
    return seen


def evaluate_vis06(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-06 · vista previa al compartir por WhatsApp.

    og:title, og:description, og:image (+secure_url, width, height), og:locale,
    twitter:card from PageFacts (any attribute order); duplicates with different
    values flagged; og:image fetch (status, image/* type, pixel size).
    APROBADO: the five present, one og:image, 200 image/*, >= 1200x630.
    APROBADO_CON_OBSERVACION (Amarillo, Alta): image loads but smaller than
    1200x630 or ratio outside 1.91 +/- 10 %, or conflicting duplicates, or
    og:locale/twitter:card missing. FALLA: og:image missing, or non-200 or
    non-image, or og:title and og:description both missing. NO_VERIFICADO when
    only the image fetch was challenged and the tags are fine.
    A FALLA is html_derived: the gate checks home.html first. "Sin imagen ni
    descripción" needs og:image, og:description, the meta description AND
    twitter:description all missing, because WhatsApp falls back to the meta
    description and a paste test would show it.
    """
    spec = common.spec_of("VIS-06")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    og = page.og
    titles = _distinct(og.get("og:title", []))
    descriptions = _distinct(og.get("og:description", []))
    images = _distinct(og.get("og:image", []) + og.get("og:image:url", []))
    locale = _distinct(og.get("og:locale", []))
    card = _distinct(page.twitter.get("twitter:card", []))
    fetch = obs.og_image
    resp = fetch.response if fetch is not None else None
    image = fetch.image if fetch is not None else None
    measured: dict[str, Any] = {
        "og_title": bool(titles),
        "og_description": bool(descriptions),
        "og_image": bool(images),
        "og_locale": bool(locale),
        "twitter_card": bool(card),
        "duplicates": len(titles) > 1 or len(descriptions) > 1 or len(images) > 1,
        "image_status": resp.status if resp is not None else None,
        "image_type": resp.content_type if resp is not None else None,
        "image_width": image.width if image is not None else None,
        "image_height": image.height if image is not None else None,
    }
    evidence = [_home_evidence(obs)]
    consequence = "El enlace se ve pobre en WhatsApp y en redes, y se toca menos"
    action = common.on_platform(obs, ctx, wordpress="Configurar una imagen y una descripción por defecto en el plugin de SEO", other="Configurar una imagen y una descripción por defecto en la configuración del sitio")

    def failure(found: str, extra: list[str] | None = None) -> "Finding":
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence + (extra or []),
            phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who=_WHO),
        )

    if not images:
        twitter_descriptions = _distinct(page.twitter.get("twitter:description", []))
        if not descriptions and not twitter_descriptions and not (page.meta_description or "").strip():
            return failure("La vista previa al compartir el sitio no tiene imagen ni descripción")
        return failure("La vista previa al compartir el sitio no tiene imagen")
    if not titles and not descriptions:
        return failure("La vista previa al compartir el sitio no tiene título ni descripción propios")

    og_evidence = common.optional_evidence(ctx, artifacts.OG_IMAGE)
    if fetch is None or resp is None:
        reason = common.fetch_reason(obs, Purpose.OG_IMAGE.value, None, "la imagen de la vista previa no se pudo pedir")
        return not_verified(spec, reason, measured=measured)
    if resp.challenge or resp.skipped or resp.error or resp.status is None:
        reason = common.fetch_reason(obs, Purpose.OG_IMAGE.value, resp, "la imagen de la vista previa no respondió")
        return not_verified(spec, reason, measured=measured)
    ctype = resp.content_type or ""
    if resp.status != 200 or not ctype.startswith("image/"):
        return failure("La vista previa al compartir el sitio tiene una imagen que no carga", og_evidence)

    problems: list[str] = []
    if image is None:
        problems.append("usa una imagen cuyo tamaño no se pudo leer")
    else:
        w, h = image.width, image.height
        ratio = (w / h) if h else 0.0
        small = w < OG_MIN_SIZE[0] or h < OG_MIN_SIZE[1]
        off_ratio = not (OG_RATIO * (1 - OG_RATIO_TOLERANCE) <= ratio <= OG_RATIO * (1 + OG_RATIO_TOLERANCE))
        if small or off_ratio:
            # No inner "y": the clauses are joined with "y" and it read as if the
            # recommendation had two versions.
            problems.append(f"usa una imagen de {w} por {h} píxeles (lo recomendado es 1200 por 630)")
    if measured["duplicates"]:
        problems.append("tiene dos versiones que se contradicen")
    if not locale or not card:
        problems.append("no indica su idioma o el formato para redes")
    if not titles or not descriptions:
        problems.append("no tiene título propio" if not titles else "no tiene descripción propia")
    if problems:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence + og_evidence,
            reason="vista previa incompleta",
            phrase_report=ReportPhrase(
                found="La vista previa al compartir el sitio " + _join_clauses(problems),
                consequence=consequence,
                action=action,
                who=_WHO,
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence + [artifacts.OG_IMAGE],
        phrase_report=ReportPhrase(
            found="Al compartir el sitio aparece imagen, título y descripción",
            consequence="El enlace se ve completo en WhatsApp y en redes",
        ),
    )


# ---------------------------------------------------------------------------
# VIS-07
# ---------------------------------------------------------------------------


def _types_of(node: dict) -> list[str]:
    t = node.get("@type")
    if isinstance(t, str):
        return [t.rsplit("/", 1)[-1].rsplit(":", 1)[-1]]
    if isinstance(t, list):
        return [str(x).rsplit("/", 1)[-1].rsplit(":", 1)[-1] for x in t if isinstance(x, str)]
    return []


def _walk(node: Any, found: list[dict], depth: int = 0) -> None:
    if depth > 12:
        return
    if isinstance(node, list):
        for item in node:
            _walk(item, found, depth + 1)
        return
    if not isinstance(node, dict):
        return
    if any(t in ORG_TYPES for t in _types_of(node)):
        found.append(node)
    for key, value in node.items():
        if key in ("@context",):
            continue
        if isinstance(value, (dict, list)):
            _walk(value, found, depth + 1)


def evaluate_vis07(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-07 · datos de la institución marcados para Google.

    json.loads every JSON-LD block; walk objects and @graph; count organization
    entities of ORG_TYPES, deduplicated by @id or name. Decision 22: exactly one
    organization with every block valid (an address present is recorded) ->
    APROBADO_CON_OBSERVACION (Azul, "validez para Google no probada"); a block
    that is not valid JSON, or 2+ distinct organizations, or no organization
    markup -> FALLA (Azul, report only). The script never gives APROBADO here.

    plain words ("los datos ... en el formato
    que lee Google", never "marcado"), and one action per case: add the data
    when it is missing, correct it when it does not parse, keep one description
    when there are several. No action assumes a plugin.
    """
    spec = common.spec_of("VIS-07")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    kind = kinds.of(ctx.kind)
    invalid = 0
    orgs: list[dict] = []
    for block in page.jsonld_blocks:
        text = block.strip()
        if not text:
            continue
        try:
            data = json.loads(text)
        except (ValueError, RecursionError):
            invalid += 1
            continue
        _walk(data, orgs)
    keys: list[str] = []
    has_address = False
    for org in orgs:
        key = org.get("@id") if isinstance(org.get("@id"), str) else None
        if key is None:
            name = org.get("name")
            key = "name:" + normalize_for_match(name) if isinstance(name, str) and name.strip() else None
        if key is None:
            key = f"anon:{len(keys)}"
        if key not in keys:
            keys.append(key)
        if org.get("address"):
            has_address = True
    n_orgs = len(keys)
    measured = {"blocks": len(page.jsonld_blocks), "invalid_blocks": invalid, "organizations": n_orgs, "has_address": has_address}
    evidence = [_home_evidence(obs)]
    if invalid or n_orgs != 1:
        if invalid:
            found = f"Los datos {kind.del_} escritos en el formato que lee Google tienen errores"
            consequence = "Google no puede leerlos y muestra menos información"
            action = "Corregir esos datos y comprobarlos con la prueba de resultados enriquecidos de Google"
        elif n_orgs == 0:
            found = f"La página principal no incluye los datos {kind.del_} (nombre, dirección y contacto) en el formato que lee Google"
            consequence = "Google tiene que deducir esos datos del texto del sitio, y puede mostrarlos incompletos"
            action = f"Agregar a la página principal los datos {kind.del_} en el formato que lee Google"
        else:
            found = f"El sitio describe {n_orgs} organizaciones distintas en el formato que lee Google"
            consequence = f"Google puede mostrar datos contradictorios {kind.del_}"
            action = f"Dejar una sola descripción, con los datos correctos {kind.del_}"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who=_WHO),
        )
    return new_finding(
        spec,
        State.APROBADO_CON_OBSERVACION,
        measured=measured,
        evidence=evidence,
        reason="validez para Google no probada",
        phrase_report=ReportPhrase(
            found=f"Los datos {kind.del_} están escritos una sola vez en el formato que lee Google; falta comprobar que Google los acepte",
            consequence="Sin esa prueba no se sabe si Google los usa",
            action="Pasarlos por la prueba de resultados enriquecidos de Google",
            who=_WHO,
        ),
    )


# ---------------------------------------------------------------------------
# VIS-08
# ---------------------------------------------------------------------------


def _valid_hreflang(code: str) -> bool:
    c = code.strip().lower()
    if c == "x-default":
        return True
    if not _HREFLANG_RE.match(c):
        return False
    if "-" in c and c.split("-", 1)[1] in _WRONG_REGIONS:
        return False
    return True


def evaluate_vis08(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-08 · versiones por idioma (hreflang).

    No hreflang on the home -> NO_APLICA ("sitio en un solo idioma"). Codes must
    be ISO 639-1 [+ ISO 3166-1 alpha-2] or x-default (es-LA, en-UK invalid).
    APROBADO: valid, reciprocal, x-default present, alternates 200 and indexable.
    APROBADO_CON_OBSERVACION: only x-default or the self-reference missing.
    FALLA: invalid code, missing reciprocity, alternate non-200 or noindex.
    NO_VERIFICADO: alternates unreachable, challenged or on another domain.
    """
    spec = common.spec_of("VIS-08")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    if not page.hreflang:
        return not_applicable(spec, "sitio en un solo idioma")
    h_url = obs.canonical_url or (obs.home.url if obs.home else "")
    h_key = domains.compare_key(h_url) if h_url else ""
    codes = [c for c, _ in page.hreflang]
    invalid = [c for c in codes if not _valid_hreflang(c)]
    has_default = any(c.strip().lower() == "x-default" for c in codes)
    has_self = any(domains.compare_key(u) == h_key for _, u in page.hreflang)
    alternates = [(c, u) for c, u in page.hreflang if domains.compare_key(u) != h_key]
    off_site = [u for _, u in alternates if not domains.is_same_site(u, obs.registrable)]
    fetched = {domains.compare_key(p.url): p for p in obs.hreflang_pages}
    bad_status: list[str] = []
    noindex: list[str] = []
    not_reciprocal: list[str] = []
    unreachable: list[str] = []
    for code, url in alternates:
        if not domains.is_same_site(url, obs.registrable):
            continue
        pf = fetched.get(domains.compare_key(url))
        if pf is None:
            continue  # beyond the cap of alternates: not judged
        r = pf.response
        if r is None or r.skipped or r.challenge or r.error or r.status is None:
            unreachable.append(code)
            continue
        if r.status != 200:
            bad_status.append(code)
            continue
        facts = ctx.pages.get(pf.role)
        if facts is None:
            unreachable.append(code)
            continue
        if _meta_noindex(facts.robots_meta + facts.googlebot_meta) or _header_noindex(r):
            noindex.append(code)
        if not any(domains.compare_key(u) == h_key for _, u in facts.hreflang):
            not_reciprocal.append(code)
    measured = {
        "codes": [fmt.sanitize_site_text(c, 20) for c in codes],
        "invalid": [fmt.sanitize_site_text(c, 20) for c in invalid],
        "x_default": has_default,
        "self_reference": has_self,
        "off_site": len(off_site),
        "bad_status": bad_status,
        "noindex": noindex,
        "not_reciprocal": not_reciprocal,
        "unreachable": unreachable,
    }
    evidence = [_home_evidence(obs)] + common.optional_evidence(ctx, artifacts.HREFLANG)
    consequence = "Google puede mostrar a cada visitante la versión equivocada"
    action = common.on_platform(obs, ctx, wordpress="Corregir las etiquetas de idioma en el plugin o la plantilla", other="Corregir las etiquetas de idioma en la configuración del sitio")
    if invalid or bad_status or noindex or not_reciprocal:
        if invalid:
            found = f"Las versiones en otros idiomas usan un código de idioma inválido ({fmt.sanitize_site_text(invalid[0], 20)})"
        elif bad_status or noindex:
            found = "Las versiones en otros idiomas llevan a una página que no responde o que pide no aparecer en Google"
        else:
            found = "Las versiones en otros idiomas no se señalan entre sí"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who=_WHO),
        )
    if unreachable or (alternates and len(off_site) == len(alternates)):
        reason = common.blocked_reason(obs) if obs.blocked else "las versiones en otros idiomas no se pudieron abrir o están en otro dominio"
        return not_verified(spec, reason, measured=measured)
    if not has_default or not has_self:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="falta la versión por defecto o la propia",
            phrase_report=ReportPhrase(
                found="Las versiones en cada idioma se señalan entre sí, pero falta indicar cuál se muestra por defecto o la propia",
                consequence=consequence,
                action=action,
                who=_WHO,
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found="Las versiones en cada idioma se señalan entre sí",
            consequence="Google muestra a cada visitante la versión en su idioma",
        ),
    )


# ---------------------------------------------------------------------------
# VIS-14
# ---------------------------------------------------------------------------


def _looks_spanish(page: "PageFacts") -> bool:
    if any(v.strip().lower().startswith("es") for v in page.og.get("og:locale", [])):
        return True
    words = re.findall(r"[a-záéíóúñü]+", (page.visible_text or "").lower())
    if not words:
        return False
    stop = set(SPANISH_STOPWORDS)
    hits = sum(1 for w in words if w in stop)
    return hits >= 5 and hits / len(words) >= 0.08


def evaluate_vis14(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-14 · idioma declarado y título propio.

    APROBADO: lang "es" or "es-ar" and a non-generic title (VIS-04 rule).
    APROBADO_CON_OBSERVACION (Azul): another Spanish variant (es-es, es-419) or a
    generic title. FALLA: lang missing, empty or invalid, or primary subtag not
    "es" while the content is Spanish (og:locale, SPANISH_STOPWORDS count).
    """
    spec = common.spec_of("VIS-14")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    lang = (page.lang or "").strip().lower().replace("_", "-")
    title = page.title or ""
    word = generic_word(title)
    spanish = _looks_spanish(page)
    measured = {"lang": fmt.sanitize_site_text(lang, 20) or None, "generic_title": bool(word), "content_spanish": spanish}
    evidence = [_home_evidence(obs)]
    consequence = "Los lectores de pantalla la leen con la pronunciación equivocada"
    action = common.on_platform(obs, ctx, wordpress="Ajustar el idioma en los ajustes generales y en el tema", other="Ajustar el idioma en la configuración del sitio")
    primary = lang.split("-", 1)[0] if lang else ""
    if not lang or not _LANG_RE.match(lang) or (primary != "es" and spanish):
        if not lang:
            found = "La página no declara su idioma"
        elif not _LANG_RE.match(lang):
            found = f"La página declara un idioma que no existe («{fmt.sanitize_site_text(lang, 20)}»)"
        else:
            name = _LANG_NAMES.get(primary, f"«{fmt.sanitize_site_text(lang, 20)}»")
            found = f"La página declara estar en {name} aunque está en castellano"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who=_WHO),
        )
    if primary == "es" and (lang not in ("es", "es-ar") or word):
        if word:
            found = f"La página declara que está en castellano, pero su título empieza con «{fmt.sanitize_site_text(word, 40)}»"
            obs_action = "Escribir un título que diga qué es el sitio"
            # Each branch with its own consequence: a generic title is not a region problem.
            obs_consequence = "Quien ve el título en Google o en la pestaña del navegador no reconoce el sitio de un vistazo"
        else:
            found = f"La página declara castellano de otra región («{fmt.sanitize_site_text(lang, 20)}»)"
            obs_action = common.on_platform(obs, ctx, wordpress="Ajustar el idioma a es-AR en los ajustes generales", other="Ajustar el idioma a es-AR en la configuración del sitio")
            obs_consequence = "Los lectores de pantalla y Google pueden tratarla como de otra región"
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="idioma de otra región o título genérico",
            phrase_report=ReportPhrase(
                found=found,
                consequence=obs_consequence,
                action=obs_action,
                who=_WHO,
            ),
        )
    if primary != "es":
        found = "La página declara su idioma y tiene título propio"
    else:
        found = "La página declara que está en castellano y tiene título propio"
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=found, consequence="Los lectores de pantalla la leen bien"),
    )
