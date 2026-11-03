"""Content signals: VIS-16 (desactualización), VIS-17 (inscripciones), VIS-19 (restos de fábrica),
EXT-24 (páginas ajenas, passive substitute).

No extra requests: home HTML, the linked feed and the sitemap already fetched.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote, urlsplit

from .. import artifacts, domains, fmt
from ..htmlextract import normalize_for_match
from .. import kinds
from ..model import ReportPhrase, State
from . import common
from .common import new_finding, not_applicable, not_verified

if TYPE_CHECKING:
    from ..htmlextract import AnchorFacts, PageFacts
    from ..model import EvalContext, Finding
    from ..observations import Observations

FEED_STALE_MONTHS = 6  # editorial criterion, no public source

INSCRIPTION_TERMS: tuple[str, ...] = ("inscrip", "inscrib", "preinscrip", "admisi", "matricul", "vacante", "admission", "enrol")
INSCRIPTION_WHOLE_WORDS: tuple[str, ...] = ("ingreso", "ingresos")  # never "ingresar" (login)
PRIVACY_TERMS: tuple[str, ...] = (
    "privacidad",
    "privacy",
    "proteccion de datos",
    "datos personales",
    "politica de datos",
    "tratamiento de datos",
    "habeas data",
)
# Legal pages that often hold the privacy policy in Argentina, but whose name does
# not say so: an observation, never a FALLA.
LEGAL_TERMS: tuple[str, ...] = (
    "legales",
    "aviso legal",
    "terminos y condiciones",
    "terminos de uso",
    "condiciones de uso",
    "terms",
)

WP_DEFAULT_TAGLINES: tuple[str, ...] = ("Otro sitio realizado con WordPress", "Just another WordPress site")
WP_DEFAULT_POSTS: tuple[str, ...] = ("¡Hola, mundo!", "Hola mundo", "Hello world!")

# VIS-19 factory leftovers: exact
# patterns, visible text only for Lorem ipsum, demo phones only in unmistakable
# demo formats (never a bare 555: it appears in real Argentine numbers).
FACTORY_TEXT_PATTERNS: tuple[str, ...] = (
    "lorem ipsum",
    "pagina de ejemplo",
    "sample page",
    "your company",
    "info@yourdomain.com",
    "yourdomain.com",
)
# Anchored: "4555-0123" and "15-5555-0199" are real Argentine numbers.
DEMO_PHONE_REGEXES: tuple[str, ...] = (r"\(555\)", r"(?<![\d-])555-01\d\d(?!\d)")
SOCIAL_HOSTS: tuple[str, ...] = ("facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "linkedin.com", "tiktok.com")
THEME_VENDOR_HOSTS: tuple[str, ...] = ("theme-fusion.com", "themeforest.net", "elementor.com", "envato.com")

# Whole-word, accent-insensitive matches. A positive fires the hack gate (the
# report then opens with "the site may be compromised"), so a false positive is
# costly:
# * STRONG_TERMS count anywhere (pharmacy spam has no legitimate use on a
#   school or SME site);
# * the other terms are ordinary words in Argentina ("el Casino de Mar del
#   Plata", "cómo prevenir las apuestas online"): in prose and in links to the
#   site's own pages they never count; they count in the HOST NAME of links to
#   OTHER sites (the link injection of a hacked WordPress; never in the path or
#   the anchor text: a news card about "prevención de apuestas online" on a
#   government site is not spam) and in sitemap URLs (pages injected into the
#   site), and only in numbers (see evaluate_ext24);
# * "replica" and "slot" also need a luxury or gambling word nearby.
# "loan" is not a term: it is also a first name ("Loan,
# de quinto grado, ganó la Olimpíada").
STRONG_TERMS: tuple[str, ...] = ("viagra", "cialis")
WEAK_TERMS: tuple[str, ...] = (
    "casino",
    "replica",
    "poker",
    "slot",
    "apuestas online",
    "pharmacy",
)
SPAM_TERMS: tuple[str, ...] = STRONG_TERMS + WEAK_TERMS
OUTBOUND_LINKS_FOR_GATE = 2  # DISTINCT other-site hosts whose name carries a weak term
SITEMAP_URLS_FOR_GATE = 3  # sitemap URLs with a weak term, or written in another alphabet
# Japanese (Hiragana, Katakana, CJK) and Cyrillic in a Spanish site.
SPAM_SCRIPT_RANGES: tuple[tuple[int, int], ...] = (
    (0x3040, 0x309F),
    (0x30A0, 0x30FF),
    (0x4E00, 0x9FFF),
    (0x0400, 0x04FF),
)
MANUAL_SITE_QUERY = "site:{domain} viagra OR casino OR replica"
FOREIGN_SCRIPT_LABEL = "textos en otro alfabeto"
_LANG_PATH_RE = re.compile(r"^/[a-z]{2,3}(?:[-_][a-z]{2,4})?(?:/|$)", re.IGNORECASE)

# Terms that count in prose only next to a luxury-goods word (or in links and sitemaps).
_CAUTIOUS_TERMS: frozenset[str] = frozenset({"replica", "slot"})
_CAUTIOUS_CONTEXT = ("reloj", "relojes", "rolex", "watch", "watches", "bolso", "bolsos", "cartera", "carteras", "machine", "machines")
# Foreign-script characters needed before they count as a signal.
_SCRIPT_MIN_PROSE = 30
_SCRIPT_MIN_LINK = 5
# Which hreflang languages (primary subtag) are written in each foreign script:
# a sitemap URL in a script of a language the home declares is a translation,
# not an injected page.
_SCRIPT_LANGS: dict[str, frozenset[str]] = {
    "kana": frozenset({"ja"}),
    "han": frozenset({"ja", "zh"}),
    "cyrillic": frozenset({"ru", "uk", "be", "bg", "sr", "mk", "kk", "ky", "mn", "tg"}),
}

# A year written by JavaScript ("© 2019 - <script>...getFullYear...</script>"):
# htmlextract leaves this mark where such a script was.
_JS_YEAR_AFTER_RE = re.compile("\\s*[-\u2010-\u2015/]?\\s*" + "\ufffc")
_HISTORICAL_BEFORE_RE = re.compile(r"\b(?:desde|a partir|hasta|durante|en)\s+(?:el|del|de)?\s*$")
_COPYRIGHT_RE = re.compile(
    r"(?:©|\(c\)|copyright)(?:\s|©|\(c\)|&copy;)*(?:((?:19|20)\d{2})\s*[-\u2010\u2011\u2013\u2014/]\s*)?((?:19|20)\d{2})\b",
    re.IGNORECASE,
)
_CICLO_RE = re.compile(r"(ciclo lectivo|inscripciones|inscripcion)\D{0,20}?((?:19|20)\d{2})\b")
# How the report names the word that matched next to the year (accent-folded), written in full.
DE_CICLO: dict[str, str] = {
    "ciclo lectivo": "del ciclo lectivo {y}",
    "inscripciones": "de las inscripciones {y}",
    "inscripcion": "de la inscripción {y}",
}

# Year gate for the "pie" and "ciclo" signals: two or more years behind, or one
# year behind from 1 April (inclusive) on. A January footer that still says last
# year is normal, and calling it stale would be a false positive. A site whose
# only "old" year is last year's, before 1 April, reads this way.
YEAR_GATE_MONTH_DAY = (4, 1)
VIS16_GRACE_CONSEQUENCE = (
    "Antes de abril es común; si sigue así después de marzo, quien visita el sitio puede pensar que nadie lo mira"
)


def _home_evidence(obs: "Observations") -> str:
    return common.page_evidence(obs.home, artifacts.HOME_HTML)


def _anchor_haystack(a: "AnchorFacts") -> str:
    parts = [a.text or "", a.aria_label or "", a.title or "", " ".join(a.img_alts), unquote(a.href or "")]
    return normalize_for_match(" ".join(parts))


def _link_status(obs: "Observations", url: str | None) -> int | None:
    """Final status of ``url`` from the VIS-09 survey (None when not checked)."""
    if not url:
        return None
    try:
        key = domains.compare_key(url)
    except ValueError:
        return None
    probe = common.link_status_map(obs).get(key)
    if probe is None or not common.probe_verified(probe, obs):
        return None
    return probe.final_status


# ---------------------------------------------------------------------------
# VIS-16
# ---------------------------------------------------------------------------


def _footer_year(page: "PageFacts") -> int | None:
    """The last copyright year of the footer; None when the visible year is the start of a
    range whose end is written by JavaScript."""
    text = page.footer_text if page.footer_found else page.visible_text
    year = None
    for m in _COPYRIGHT_RE.finditer(text or ""):
        if m.group(1) is None and _JS_YEAR_AFTER_RE.match(text, m.end()):
            year = None  # the year that counts is computed in the browser: not measurable here
            continue
        year = int(m.group(2))
    return year


def _ciclo_matches(text: str) -> list[tuple[int, str]]:
    """(year, matched word) next to "ciclo lectivo" or "inscripciones", leaving out history. ``text`` is accent-folded."""
    found = []
    for m in _CICLO_RE.finditer(text):
        if _HISTORICAL_BEFORE_RE.search(text[max(0, m.start() - 25) : m.start()]):
            continue
        found.append((int(m.group(2)), m.group(1)))
    return found


def _ciclo(page: "PageFacts") -> tuple[int | None, str | None, bool]:
    """(newest year, its word, True when that mention is outside the footer).

    The word is the first one written with the newest year. "Outside the footer"
    needs a footer and more mentions of that year and word in the whole page than
    in the footer: only then is "Más arriba" a fact.
    """
    matches = _ciclo_matches(normalize_for_match(page.visible_text or ""))
    if not matches:
        return None, None, False
    year = max(y for y, _ in matches)
    word = next(w for y, w in matches if y == year)
    outside = False
    if page.footer_found:
        in_footer = [m for m in _ciclo_matches(normalize_for_match(page.footer_text or "")) if m == (year, word)]
        outside = sum(1 for m in matches if m == (year, word)) > len(in_footer)
    return year, word, outside


def _wp_default_match(obs: "Observations", page: "PageFacts") -> tuple[str, str] | None:
    """(canonical WordPress example text, where it was found) or None.

    Places: "sitio" (a link on the home or a post of the feed: visible on the
    site), "titulo", "descripcion" (meta description), "vista-previa"
    (og:description, og:site_name), "novedades" (the feed's description).
    Visible places are preferred.
    """
    feed = obs.feed.doc if obs.feed is not None and obs.feed.doc is not None else None
    posts = [(normalize_for_match(p).strip("!¡ "), p) for p in WP_DEFAULT_POSTS]
    titles = [a.text for a in page.anchors] + ([i.title for i in feed.items] if feed is not None else [])
    for t in titles:
        n = normalize_for_match(t or "").strip("!¡ ")
        for key, canonical in posts:
            if n and n == key:
                return canonical, "sitio"
    taglines = [(normalize_for_match(t), t) for t in WP_DEFAULT_TAGLINES]
    places: list[tuple[str, str]] = [(page.title or "", "titulo"), (page.meta_description or "", "descripcion")]
    places += [(t, "vista-previa") for t in page.og.get("og:description", []) + page.og.get("og:site_name", [])]
    if feed is not None:
        places.append((feed.channel_description or "", "novedades"))
    for t, where in places:
        n = normalize_for_match(t)
        for key, canonical in taglines:
            if n and key in n:
                return canonical, where
    return None


def year_gate(year: int | None, run_date: dt.date) -> bool:
    """True when a "pie" or "ciclo" year may be called old (see YEAR_GATE_MONTH_DAY)."""
    if year is None:
        return False
    if year <= run_date.year - 2:
        return True
    return year == run_date.year - 1 and (run_date.month, run_date.day) >= YEAR_GATE_MONTH_DAY


def _newest_item_date(obs: "Observations"):
    if obs.feed is None or obs.feed.doc is None:
        return None
    dates = [i.date for i in obs.feed.doc.items if i.date is not None]
    if not dates:
        return None
    return max(dates)


def evaluate_vis16(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-16 · señales de desactualización.

    Signals: (a) footer year < current year (last year of the last ©/&copy;/
    copyright/(c) match in the footer, or the whole page without footer; a
    footer with no year in the HTML is not a signal); (b) the newest year next to
    "ciclo lectivo" or "inscripciones" < current year; (c) first feed item older
    than FEED_STALE_MONTHS whole months; (d) WordPress default post or tagline.
    0 signals with at least one measured -> APROBADO; 1 -> APROBADO_CON_OBSERVACION
    (Azul); 2+ -> FALLA; nothing measurable -> NO_VERIFICADO. "Measured" means
    the source exists: a footer year found (a), a ciclo/inscripciones year found
    (b), a dated feed item (c). Signal (d) counts only when present; its absence
    is not a measurement (a page with no year and no feed is NO_VERIFICADO). Newest sitemap
    <lastmod> is context only. A FALLA needs two independent signals: one old
    year alone is an observation. Signals (a) and (b) count only through the
    year gate (year_gate: two years behind, or one from 1 April), and the report
    names the word that matched (DE_CICLO). The trace maps every number of the
    sentence to its measurement.

    The newest feed item (by date) is used rather than the first in document
    order, so a feed in ascending order never reads as stale.
    """
    spec = common.spec_of("VIS-16")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    year = ctx.run_date.year
    kind = kinds.of(ctx.kind)
    anio_pie = _footer_year(page)
    anio_ciclo, ciclo_word, ciclo_outside = _ciclo(page)
    newest = _newest_item_date(obs)
    n_meses = fmt.whole_months_between(fmt.local_date(newest), ctx.run_date) if newest is not None else None
    example = _wp_default_match(obs, page)
    default_content = example is not None
    lastmods = []
    for sf in obs.sitemaps:
        for doc in (sf.doc, sf.child.doc if sf.child is not None else None):
            if doc is not None:
                lastmods += [x[:10] for x in doc.lastmods if x]
    signals: list[str] = []
    # From 1 January to 31 March, last year's footer or "ciclo lectivo" is
    # normal; without the gate the report would call every such site abandoned.
    if anio_pie is not None and anio_pie < year and year_gate(anio_pie, ctx.run_date):
        signals.append("pie")
    if n_meses is not None and n_meses >= FEED_STALE_MONTHS:
        signals.append("feed")
    if anio_ciclo is not None and anio_ciclo < year and year_gate(anio_ciclo, ctx.run_date):
        signals.append("ciclo")
    if default_content:
        signals.append("ejemplo")
    measured: dict[str, Any] = {
        "anio_pie": anio_pie,
        "anio_ciclo": anio_ciclo,
        "n_meses": n_meses,
        "ultima_novedad": fmt.local_date(newest).isoformat() if newest is not None else None,
        "texto_de_ejemplo": default_content,
        "signals": list(signals),
        "sitemap_lastmod_max": max(lastmods) if lastmods else None,
        "pie_encontrado": page.footer_found,
        "ciclo_palabra": ciclo_word,
        "ciclo_fuera_del_pie": ciclo_outside,
        "mes_anio_feed": fmt.mes_anio(fmt.local_date(newest)) if newest is not None else None,
        "texto_ejemplo": example[0] if example else None,
        "texto_ejemplo_lugar": example[1] if example else None,
    }
    measured_any = anio_pie is not None or anio_ciclo is not None or n_meses is not None or default_content
    if not measured_any:
        return not_verified(spec, "la página no muestra un año ni novedades con fecha para comparar", measured=measured)
    evidence = [_home_evidence(obs)]
    if n_meses is not None:
        evidence += common.optional_evidence(ctx, artifacts.FEED)

    # The words that matched ("de las inscripciones 2025", never "del ciclo
    # lectivo 2025" for an "Inscripciones 2025").
    de_ciclo = DE_CICLO[ciclo_word].format(y=anio_ciclo) if ciclo_word in DE_CICLO else f"del ciclo lectivo {anio_ciclo}"
    clauses = {
        "pie": f"el pie dice {anio_pie}",
        "feed": f"la última novedad es de hace {n_meses} meses",
        "ciclo": f"la portada habla {de_ciclo}",
        "ejemplo": "el sitio muestra el texto de ejemplo de WordPress",
    }
    if signals:
        parts = [clauses[s] for s in signals]
        text = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " y " + parts[-1]
        found = text[0].upper() + text[1:]
        consequence = f"Quien visita el sitio piensa que nadie lo mira, y eso pesa {kind.elegir}"
        action = "Actualizar el pie, la portada y publicar novedades, o quitar la sección si no se usa"
        who = f"{kind.El}, con quien mantiene el sitio"
        if len(signals) >= 2:
            trace = {
                "pie": ("{anio_pie}", "checks[VIS-16].measured.anio_pie"),
                "feed": ("{n_meses}", "checks[VIS-16].measured.n_meses"),
                "ciclo": ("{de_ciclo}", "checks[VIS-16].measured.anio_ciclo, ciclo_palabra"),
                "ejemplo": ("{texto_ejemplo}", "checks[VIS-16].measured.texto_ejemplo, texto_ejemplo_lugar"),
            }
            return new_finding(
                spec,
                State.FALLA,
                measured=measured,
                evidence=evidence,
                trace=dict(trace[name] for name in signals),
                phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who=who),
            )
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="una sola señal de desactualización",
            phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who=who),
        )
    # No signal. A year of last year let through by the gate (1 January to 31
    # March) is named as it is, never as "el año en curso", and the consequence
    # says when it starts to count.
    pie_last_year = anio_pie is not None and anio_pie < year
    ciclo_last_year = anio_ciclo is not None and anio_ciclo < year
    if anio_pie is not None and n_meses is not None:
        found = (
            f"El pie del sitio muestra el año {anio_pie} y el sitio tiene novedades recientes"
            if pie_last_year
            else "El sitio muestra el año en curso y novedades recientes"
        )
    elif anio_pie is not None:
        found = f"El pie del sitio muestra el año {anio_pie}" if pie_last_year else "El pie del sitio muestra el año en curso"
    elif n_meses is not None:
        found = "El sitio tiene novedades recientes"
    else:
        found = f"La página principal habla {de_ciclo}"
    grace = pie_last_year or (anio_pie is None and n_meses is None and ciclo_last_year)
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found=found, consequence=VIS16_GRACE_CONSEQUENCE if grace else "Se ve cuidado y al día"),
    )


# ---------------------------------------------------------------------------
# VIS-17
# ---------------------------------------------------------------------------


def _target_key(url: str | None) -> str | None:
    if not url:
        return None
    try:
        return domains.compare_key(url)
    except ValueError:
        return url


def _is_inscription(a: "AnchorFacts") -> bool:
    hay = _anchor_haystack(a)
    if any(t in hay for t in INSCRIPTION_TERMS):
        return True
    words = set(re.findall(r"[a-z0-9]+", hay))
    return any(w in words for w in INSCRIPTION_WHOLE_WORDS)


def evaluate_vis17(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-17 · inscripciones a la vista.

    Home anchors: text, aria-label, title, img alt and href, normalized, matched
    against INSCRIPTION_TERMS and the whole words INSCRIPTION_WHOLE_WORDS; a
    wa.me link whose text= mentions admisiones/inscripción also counts. Target
    status from obs.links when checked. APROBADO: access present and target 200
    (or not checked). FALLA: no access at all, or its target ends in 404/410.
    No seasonal logic. A FALLA with no access rests on a list of words, so the
    report says what was looked for. For a broken access, measured counts the
    DISTINCT broken targets (a menu item and a button to the same dead page are
    one page).
    """
    spec = common.spec_of("VIS-17")
    if not kinds.of(ctx.kind).educational:
        # A company or another institution has no inscriptions.
        return not_applicable(spec, "el sitio no es de una institución educativa: no tiene inscripciones")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    access = [a for a in page.anchors if _is_inscription(a)]
    statuses = [(_link_status(obs, a.url) if a.url and domains.is_same_site(a.url, obs.registrable) else None) for a in access]
    working = [s for s in statuses if s is None or s not in (404, 410)]
    measured = {
        "n_access": len(access),
        "access_paths": sorted({fmt.sanitize_site_text(urlsplit(a.url).path or "/", 60) for a in access if a.url and domains.is_same_site(a.url, obs.registrable)})[:5],
        "target_statuses": [s for s in statuses if s is not None],
    }
    evidence = [_home_evidence(obs)]
    consequence = "Las familias interesadas tienen que buscar cómo inscribirse, y algunas no lo encuentran"
    if not access:
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="La página principal no tiene un acceso a inscripciones",
                consequence=consequence,
                action="Agregar un acceso visible en el menú y en la portada",
                who="Quien mantiene el sitio",
            ),
        )
    if not working:
        targets = {_target_key(a.url) for a in access}
        measured["n_destinos_rotos"] = len(targets)
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence + common.optional_evidence(ctx, artifacts.LINKS),
            phrase_report=ReportPhrase(
                found="El acceso a inscripciones lleva a una página que no existe",
                consequence=consequence,
                action="Corregir el enlace de inscripciones",
                who="Quien mantiene el sitio",
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found="La página principal lleva a inscripciones en un toque",
            consequence="Las familias interesadas llegan directo",
        ),
    )


# ---------------------------------------------------------------------------
# VIS-19
# ---------------------------------------------------------------------------


def _host(url: str | None) -> str | None:
    if not url:
        return None
    try:
        return domains.host_of(url)
    except ValueError:
        return None


def _host_matches(host: str | None, candidates: tuple[str, ...]) -> bool:
    if not host:
        return False
    return any(host == c or host.endswith("." + c) for c in candidates)


_SOCIAL_WORDS = ("facebook", "instagram", "twitter", "youtube", "linkedin", "tiktok", "whatsapp")


def _is_social_icon(a: "AnchorFacts") -> bool:
    hay = " ".join(a.classes_ids) + " " + (a.aria_label or "") + " " + (a.title or "") + " " + (a.text or "")
    hay = hay.lower()
    if _host_matches(_host(a.url), SOCIAL_HOSTS):
        return True
    return any(w in hay for w in _SOCIAL_WORDS) and len((a.text or "").strip()) <= 20


def evaluate_vis19(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """VIS-19 · restos de fábrica del tema y de WordPress.

    Visible text, og:description, og:site_name, the feed channel description and
    footer social links. Signals: WP_DEFAULT_TAGLINES; FACTORY_TEXT_PATTERNS
    (normalized; "lorem ipsum" only in visible text, never in code); demo phones
    by DEMO_PHONE_REGEXES only; social icons in the footer whose href is "#" or
    empty, or a SOCIAL_HOSTS URL with an empty path, or a THEME_VENDOR_HOSTS page
    (only anchors that are social icons). Not looked at: "Sin categoría".
    FALLA (Azul) with one or more signals; APROBADO with none. Report wording neutral,
    no blame; the vendor phrase says "la página del fabricante de la plantilla".
    """
    spec = common.spec_of("VIS-19")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    visible = normalize_for_match(page.visible_text or "")
    meta_texts = page.og.get("og:description", []) + page.og.get("og:site_name", []) + [page.meta_description or "", page.title or ""]
    if obs.feed is not None and obs.feed.doc is not None:
        meta_texts.append(obs.feed.doc.channel_description or "")
    metas = normalize_for_match(" | ".join(meta_texts))
    signals: list[str] = []
    labels: list[str] = []

    taglines = [normalize_for_match(t) for t in WP_DEFAULT_TAGLINES]
    if any(t in visible or t in metas for t in taglines):
        signals.append("wp-tagline")
        labels.append("el lema de ejemplo de WordPress")
    if "lorem ipsum" in visible:
        signals.append("lorem-ipsum")
        labels.append("texto de relleno («lorem ipsum»)")
    for pattern in FACTORY_TEXT_PATTERNS:
        if pattern == "lorem ipsum":
            continue
        if pattern in visible or pattern in metas:
            signals.append(f"text:{pattern}")
            labels.append("textos de ejemplo de la plantilla")
            break
    raw_visible = page.visible_text or ""
    if any(re.search(rx, raw_visible) for rx in DEMO_PHONE_REGEXES):
        signals.append("demo-phone")
        labels.append("un teléfono de demostración")
    dead_icons = vendor_icons = 0
    for a in page.anchors:
        if not a.in_footer or not _is_social_icon(a):
            continue
        href = (a.href or "").strip()
        host = _host(a.url)
        path = urlsplit(a.url).path if a.url else ""
        if href in ("", "#") or (_host_matches(host, SOCIAL_HOSTS) and path in ("", "/")):
            dead_icons += 1
        elif _host_matches(host, THEME_VENDOR_HOSTS):
            vendor_icons += 1
    if dead_icons:
        signals.append("dead-social-icons")
        labels.append("íconos de redes que no llevan a ninguna cuenta")
    if vendor_icons:
        signals.append("vendor-icons")
        labels.append("íconos que llevan a la página del fabricante de la plantilla")
    measured = {"signals": signals, "dead_social_icons": dead_icons, "vendor_icons": vendor_icons}
    evidence = [_home_evidence(obs)]
    if any(s == "wp-tagline" for s in signals):
        evidence += common.optional_evidence(ctx, artifacts.FEED)
    if signals:
        text = labels[0] if len(labels) == 1 else ", ".join(labels[:-1]) + " y " + labels[-1]
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=f"Quedan restos de la instalación a la vista: {text}",
                consequence="Quien visita el sitio o lo ve compartido nota que quedó a medio terminar",
                action=common.on_platform(
                    obs, ctx, wordpress="Completar o quitar esos textos y enlaces en el tema", other="Completar o quitar esos textos y enlaces en el diseño del sitio"
                ),
                who="Quien mantiene el sitio",
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found="No quedan textos ni enlaces de ejemplo de la plantilla",
            consequence="El sitio se ve terminado",
        ),
    )


# ---------------------------------------------------------------------------
# EXT-24
# ---------------------------------------------------------------------------


def _term_regex(term: str) -> re.Pattern[str]:
    return re.compile(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])")


_TERM_RES = {t: _term_regex(t) for t in SPAM_TERMS}
_CONTEXT_RE = re.compile(r"(?<![a-z0-9])(?:" + "|".join(_CAUTIOUS_CONTEXT) + r")(?![a-z0-9])")


def _script_chars(text: str) -> int:
    n = 0
    for ch in text:
        cp = ord(ch)
        for lo, hi in SPAM_SCRIPT_RANGES:
            if lo <= cp <= hi:
                n += 1
                break
    return n


def _prose_hits(text: str) -> list[str]:
    hits: list[str] = []
    for term, rx in _TERM_RES.items():
        for m in rx.finditer(text):
            if term in _CAUTIOUS_TERMS:
                window = text[max(0, m.start() - 40) : m.end() + 40]
                if not _CONTEXT_RE.search(window):
                    continue
            hits.append(term)
            break
    return hits


def _is_language_link(a: "AnchorFacts", registrable: str) -> bool:
    """A link of a language switcher, or to a language version of the same site (/ru/, /zh-cn/)."""
    if a.lang_hint:
        return True
    if a.url and domains.is_same_site(a.url, registrable):
        return bool(_LANG_PATH_RE.match(urlsplit(a.url).path or "/"))
    return False


def _host_weak_terms(url: str | None) -> list[str]:
    """Weak terms written in the HOST NAME of a link (never its path or text).

    Spam hosts glue words together ("casinobonus", "cheap-pharmacy"), so a term
    counts inside any label once hyphens are dropped ("apuestas online" as
    "apuestasonline"). The caller counts distinct hosts, never anchors.
    """
    host = _host(url)
    if not host:
        return []
    labels = [label.replace("-", "") for label in host.lower().split(".") if label]
    found: list[str] = []
    for term in WEAK_TERMS:
        compact = term.replace(" ", "")
        if any(compact in label for label in labels) and term not in found:
            found.append(term)
    return found


def _scripts_in(text: str) -> set[str]:
    """The foreign scripts of _SCRIPT_LANGS present in a text."""
    found: set[str] = set()
    for ch in text:
        cp = ord(ch)
        if 0x3040 <= cp <= 0x30FF:
            found.add("kana")
        elif 0x4E00 <= cp <= 0x9FFF:
            found.add("han")
        elif 0x0400 <= cp <= 0x04FF:
            found.add("cyrillic")
    return found


def _declared_languages(page: "PageFacts") -> tuple[set[str], list[tuple[str, str]]]:
    """(primary language subtags, (host, path prefix) of the alternates) the home declares in hreflang.

    Spanish and x-default are left out: they are the site itself. A prefix is
    kept only when it is more than "/" (a /ru/ section or a ru. subdomain).
    """
    codes: set[str] = set()
    prefixes: list[tuple[str, str]] = []
    for code, url in getattr(page, "hreflang", None) or []:
        primary = (code or "").strip().lower().replace("_", "-").split("-")[0]
        if not primary or primary in ("es", "x"):
            continue
        codes.add(primary)
        try:
            parts = urlsplit(url)
        except ValueError:
            continue
        host = (parts.hostname or "").lower()
        path = parts.path or "/"
        if host:
            prefixes.append((host, path if path.endswith("/") else path + "/"))
    return codes, prefixes


def _is_declared_translation(loc: str, decoded: str, codes: set[str], prefixes: list[tuple[str, str]], home_host: str | None) -> bool:
    """A sitemap URL of a language version: a /ru/ or /zh-cn/ path, or a language the home declares in hreflang.

    Such URLs never count as weak-term or foreign-script signals. Strong terms still count.
    """
    try:
        parts = urlsplit(loc)
    except ValueError:
        return False
    if _LANG_PATH_RE.match(parts.path or "/"):
        return True
    host = (parts.hostname or "").lower()
    path = parts.path or "/"
    for p_host, p_path in prefixes:
        if host != p_host:
            continue
        if p_path != "/" and (path + "/").startswith(p_path):
            return True
        if p_path == "/" and home_host and host != home_host.lower():
            return True  # a language subdomain (ru.colegio.test)
    scripts = _scripts_in(decoded)
    if scripts and codes:
        return all(codes & _SCRIPT_LANGS[s] for s in scripts)
    return False


# The grey line of EXT-24: what was not seen. The site: query to run by
# hand is written once, in anexo-tecnico.md (render_report._manual_checks).
GREY_NOT_SEARCHED = "Lo que Google muestra del sitio no se consultó en este chequeo"


def evaluate_ext24(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-24 · páginas ajenas en Google, passive substitute.

    Positive -> FALLA (Rojo, Crítica) with hack_signal True: the hack gate
    fires and the report leads with it (exit 30). Negative ->
    NO_VERIFICADO with reason "la búsqueda en Google se corre a mano:
    site:{D} viagra OR casino OR replica" (a negative proxy proves nothing).

    The gate needs real spam, not Argentine prose. Positive when ANY of:
    * a STRONG_TERM (viagra, cialis) in the home text, its links or the sitemap;
    * OUTBOUND_LINKS_FOR_GATE or more DISTINCT hosts of home links to OTHER
      sites whose host name carries a weak term (link injection);
    * SITEMAP_URLS_FOR_GATE or more sitemap URLs with a weak term, or written in
      another alphabet (pages injected into the site);
    * two of these three kinds of signal at least once each: a weak term in the
      host of a link to another site, a weak term in a sitemap URL, text in
      another alphabet (home text beyond 30 characters, a home link beyond 5, a
      sitemap URL beyond 3).
    Never a signal: weak terms in the home prose, in links to the site's own
    pages, or in the path or text of links to other sites;
    language switchers (hreflang, lang, data-gt-lang, plugin classes) and links
    to /ru/, /zh-cn/...; sitemap URLs under a language path or in a language
    the home declares in hreflang (except for strong terms); text inside an
    element whose lang is not Spanish.

    measured: terms (the spam words found), examples (for the report: terms, and
    the plain label for another alphabet), sources, sitemap_url, counts.
    """
    spec = common.spec_of("EXT-24")
    query = MANUAL_SITE_QUERY.format(domain=obs.registrable)
    manual_reason = f"la búsqueda en Google se corre a mano: {query}"
    page = ctx.pages.get("home")
    if page is None:
        reason = common.unavailable_reason(obs, "home", common.home_response(obs))
        # The report says only what was not seen; the site: query is in the annex.
        return not_verified(spec, f"{reason}; {manual_reason}", phrase_report=ReportPhrase(found=common.grey_sentence(reason)))

    strong: list[tuple[str, str]] = []  # (term, source)
    outbound_hosts: dict[str, str] = {}  # distinct other-site host -> the first weak term in its name
    sitemap_term_urls = 0
    sitemap_terms: list[str] = []
    sitemap_script_urls = 0
    script_sources: list[str] = []
    sitemap_url: str | None = None

    def strong_in(text: str) -> list[str]:
        return [t for t in _prose_hits(text) if t in STRONG_TERMS]

    def weak_in(text: str) -> list[str]:
        return [t for t in _prose_hits(text) if t not in STRONG_TERMS]

    visible = normalize_for_match(page.visible_text or "")
    for t in strong_in(visible):
        strong.append((t, "texto de la portada"))
    prose_terms = weak_in(visible)  # context only: ordinary words in Argentina, never a signal

    for a in page.anchors:
        link_text = normalize_for_match(" ".join([a.text or "", a.title or "", a.aria_label or ""]))
        target = normalize_for_match(unquote(a.href or "")).replace("-", " ").replace("_", " ").replace("/", " ")
        hay = link_text + " " + target
        for t in strong_in(hay):
            strong.append((t, "enlaces de la portada"))
        outbound = bool(a.url) and not domains.is_same_site(a.url, obs.registrable)
        if outbound:
            found = _host_weak_terms(a.url)
            host = _host(a.url)
            if found and host and host not in outbound_hosts:
                outbound_hosts[host] = found[0]
        if _script_chars(a.text or "") >= _SCRIPT_MIN_LINK and not _is_language_link(a, obs.registrable):
            if "enlaces de la portada" not in script_sources:
                script_sources.append("enlaces de la portada")
    prose_script = _script_chars(page.visible_text or "") - _script_chars(getattr(page, "foreign_lang_text", "") or "")
    if prose_script >= _SCRIPT_MIN_PROSE:
        script_sources.append("texto de la portada")

    declared_codes, declared_prefixes = _declared_languages(page)
    for sf in obs.sitemaps:
        for fetch in (sf, sf.child):
            doc = fetch.doc if fetch is not None else None
            if doc is None:
                continue
            for loc in doc.locs:
                decoded = unquote(loc)
                norm = normalize_for_match(decoded).replace("-", " ").replace("_", " ").replace("/", " ")
                hits_strong = strong_in(norm)
                if _is_declared_translation(loc, decoded, declared_codes, declared_prefixes, obs.canonical_host):
                    hits_weak: list[str] = []
                    script = False
                else:
                    hits_weak = weak_in(norm)
                    script = _script_chars(decoded) >= 3
                for t in hits_strong:
                    strong.append((t, "mapa del sitio"))
                if hits_weak:
                    sitemap_term_urls += 1
                    for t in hits_weak:
                        if t not in sitemap_terms:
                            sitemap_terms.append(t)
                if script:
                    sitemap_script_urls += 1
                if (hits_strong or hits_weak or script) and sitemap_url is None:
                    sitemap_url = fetch.url
    if sitemap_script_urls:
        script_sources.append("mapa del sitio")

    outbound_terms = list(outbound_hosts.values())  # one entry per distinct host
    categories = sum(1 for present in (bool(outbound_terms), bool(sitemap_term_urls), bool(script_sources)) if present)
    fires = (
        bool(strong)
        or len(outbound_hosts) >= OUTBOUND_LINKS_FOR_GATE
        or sitemap_term_urls >= SITEMAP_URLS_FOR_GATE
        or sitemap_script_urls >= SITEMAP_URLS_FOR_GATE
        or categories >= 2
    )
    terms: list[str] = []
    for t in [t for t, _ in strong] + outbound_terms + sitemap_terms:
        if t not in terms:
            terms.append(t)
    sources: list[str] = []
    for src in [s for _, s in strong] + (["enlaces de la portada"] if outbound_terms else []) + (["mapa del sitio"] if sitemap_term_urls else []) + script_sources:
        if src not in sources:
            sources.append(src)
    examples = [fmt.sanitize_site_text(t, 40) for t in terms[:3]]
    if script_sources and len(examples) < 3:
        examples.append(FOREIGN_SCRIPT_LABEL)
    measured: dict[str, Any] = {
        "terms": [fmt.sanitize_site_text(t, 40) for t in terms[:5]],
        "examples": examples,
        "sources": sources,
        "sitemap_url": fmt.sanitize_site_url(sitemap_url, 200) if sitemap_url and fires else None,
        "foreign_script": bool(script_sources),
        "outbound_spam_links": len(outbound_terms),
        "sitemap_spam_urls": sitemap_term_urls,
        "sitemap_foreign_urls": sitemap_script_urls,
        "prose_terms_ignored": [fmt.sanitize_site_text(t, 40) for t in prose_terms[:3]],
    }
    if not fires:
        return not_verified(
            spec,
            manual_reason,
            measured=measured,
            phrase_report=ReportPhrase(found=GREY_NOT_SEARCHED),
        )
    evidence = [_home_evidence(obs)]
    if sitemap_term_urls or sitemap_script_urls or any(src == "mapa del sitio" for _, src in strong):
        evidence += common.optional_evidence(ctx, artifacts.SITEMAP, artifacts.SITEMAP_CHILD)
    kind = kinds.of(ctx.kind)
    shown = ", ".join(e if e == FOREIGN_SCRIPT_LABEL else f"«{e}»" for e in examples)
    return new_finding(
        spec,
        State.FALLA,
        measured=measured,
        evidence=evidence,
        hack_signal=True,
        phrase_report=ReportPhrase(
            found=f"En las páginas del sitio aparecen textos o enlaces que no son {kind.del_} ({shown})",
            consequence=f"Es la señal típica de un sitio intervenido; Google puede marcarlo y {kind.audience} ven publicidad ajena",
            action="Revisar a fondo antes de cualquier otra cosa",
            who="Quien mantiene el sitio, con acceso al panel",
        ),
    )
