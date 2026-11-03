"""Security as seen from outside: EXT-07, EXT-13, EXT-17, EXT-16, EXT-01, EXT-02, EXT-09,
EXT-23, EXT-25 (EXT module: FALLA Crítica/Alta is Rojo, Media/Baja Amarillo).

Client text never names a vulnerability, never says "inseguro"/"insecure" and never says "certificado". Expiry dates in client
text are the Buenos Aires calendar date of the expiry instant
(fmt.local_date), written with fmt.fecha_larga.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote, urlsplit

from .. import artifacts, domains, fmt, wpversions
from ..dbl import DblVerdict
from ..htmlextract import normalize_for_match
from .. import kinds
from ..model import ReportPhrase, State
from ..sitemapfeed import wordpress_version_from_generator
from ..wpapi import branch_of, core_version_from_assets, normalize_version
from . import common
from .common import new_finding, not_applicable, not_verified
from .content import LEGAL_TERMS, PRIVACY_TERMS

if TYPE_CHECKING:
    from ..httpclient import Response
    from ..model import EvalContext, Finding
    from ..observations import Observations
    from ..tlsprobe import TlsResult

TLS_FAIL_DAYS = 7  # expired or <= 7 days = FALLA
TLS_OBSERVATION_DAYS = 15  # 8..15 days = observation
DOMAIN_FAIL_DAYS = 30  # <= 30 days = FALLA
DOMAIN_OBSERVATION_DAYS = 60  # 31..60 days = observation (many domains auto-renew)
DOMAIN_FAIL_STATUSES: tuple[str, ...] = ("redemption period", "pending delete")
HSTS_MIN_MAX_AGE = 15_552_000
PROTECTIONS: tuple[str, ...] = (
    "strict-transport-security",
    "content-security-policy",
    "x-content-type-options",
    "referrer-policy",
    "x-frame-options|frame-ancestors",
    "permissions-policy",
)  # six, including Permissions-Policy
VERSIONED_PRODUCTS: tuple[str, ...] = ("Apache", "nginx", "Microsoft-IIS", "LiteSpeed", "OpenSSL", "PHP")
TRANSPARENCY_REPORT_URL = "https://transparencyreport.google.com/safe-browsing/search?url={domain}"

REASON_GOOGLE_MANUAL = "la consulta de Google se revisa a mano"
REASON_TLS_DOWN = "la conexión segura del sitio no respondió"
REASON_TLS_INCONCLUSIVE = "la comprobación de la conexión segura no fue concluyente desde esta computadora; se revisa en un navegador"
REASON_NO_HTTPS = "el sitio no responde con conexión segura; lo muestra la fila de la dirección con y sin www"
REASON_RDAP_DOWN = "el registro del dominio no respondió"

# Codes 20 and 21: part of the chain is missing; many browsers fetch it, some do
# not. The report never says "El navegador no acepta" for them.
REPORT_EXT07_CHAIN = (
    "A la conexión segura del sitio le falta una parte de la cadena de confianza; muchos navegadores la completan "
    "solos y otros muestran una advertencia"
)
CONSEQUENCE_EXT07_CHAIN = "Quien entra desde un navegador o un programa que no completa la cadena ve una advertencia o no puede abrir el sitio"
ACTION_EXT07_CHAIN = "Configurar el servidor para que envíe la cadena completa de la conexión segura"


def _tls_consequence(ctx: "EvalContext") -> str:
    return f"Si no se renueva, el navegador muestra una pantalla de advertencia y {kinds.of(ctx.kind).audience} no pueden entrar"
_TLS_WHO = "Quien administra el hosting"

# OpenSSL verify codes -> plain Spanish (never "certificado").
_VERIFY_PLAIN: dict[int, str] = {
    10: "venció",
    9: "todavía no es válida",
    18: "no la firmó una entidad reconocida",
    19: "no la firmó una entidad reconocida",
    20: "le falta una parte de la cadena de confianza",
    21: "le falta una parte de la cadena de confianza",
    62: "no corresponde al nombre del sitio",
}


def _dias(n: int) -> str:
    if n == 0:
        return "hoy"
    if n == 1:
        return "en 1 día"
    return f"en {n} días"


def _local_day(iso: str | None) -> dt.date | None:
    if not iso:
        return None
    try:
        moment = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.timezone.utc)
    return fmt.local_date(moment)


def _canonical_tls(obs: "Observations") -> "TlsResult | None":
    if not obs.tls:
        return None
    for t in obs.tls:
        if obs.canonical_host and t.host == obs.canonical_host:
            return t
    return obs.tls[0]


def _home_usable(obs: "Observations") -> "Response | None":
    resp = common.home_response(obs)
    if resp is None or not resp.usable or resp.status is None:
        return None
    return resp


# ---------------------------------------------------------------------------
# EXT-07
# ---------------------------------------------------------------------------


def evaluate_ext07(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-07 · candado válido y su vencimiento.

    obs.tls[0] (canonical host). FALLA: verification failed (not inconclusive),
    expired, or days_left <= 7. APROBADO_CON_OBSERVACION (Amarillo, Alta):
    8..15 days, report only. APROBADO: > 15 days; note "la calificación y los
    protocolos viejos no se midieron". NO_VERIFICADO: port 443 refused/timed out
    (EXT-17 carries http-only), or an inconclusive Windows code 20.

    The day thresholds use calendar days (the expiry date in Buenos Aires minus
    the run date), the number a reader gets from the date printed next to it;
    TlsResult.days_left is kept in ``measured``.
    """
    spec = common.spec_of("EXT-07")
    tls = _canonical_tls(obs)
    if tls is None:
        if obs.home_unreachable or obs.home is None:
            return common.home_missing_finding(spec, obs)
        reason = REASON_NO_HTTPS
        for s in obs.skipped:
            if s.purpose == "tls":
                reason = {"budget": common.REASON_BUDGET, "blocked": common.blocked_reason(obs)}.get(s.reason, REASON_NO_HTTPS)
                break
        return not_verified(spec, reason)
    measured: dict[str, Any] = {
        "host": tls.host,
        "days_left": tls.days_left,
        "not_after": tls.not_after,
        "verify_code": tls.verify_code,
        "inconclusive": tls.inconclusive,
        "strict_only_failure": tls.strict_only_failure,
        "tls_version": tls.tls_version,
        "not_measured": tls.not_measured,
    }
    error = tls.error or ""
    if error.startswith("skipped"):
        reason = common.REASON_BUDGET if "budget" in error else common.blocked_reason(obs)
        return not_verified(spec, reason, measured=measured)
    if tls.inconclusive:
        return not_verified(spec, REASON_TLS_INCONCLUSIVE, measured=measured)
    evidence = [artifacts.TLS]
    expiry_day = _local_day(tls.not_after)
    days = tls.days_left
    if not tls.ok:
        if error != "verify" and tls.verify_code is None:
            return not_verified(spec, REASON_TLS_DOWN, measured=measured)
        expired = tls.verify_code == 10 or (days is not None and days < 0)
        plain = "venció" if expired else _VERIFY_PLAIN.get(tls.verify_code or -1, "no es válida")
        if not expired and tls.verify_code in (20, 21):
            # Browsers usually complete the chain, so the report never says the
            # browser rejects the site.
            report = ReportPhrase(found=REPORT_EXT07_CHAIN, consequence=CONSEQUENCE_EXT07_CHAIN, action=ACTION_EXT07_CHAIN, who=_TLS_WHO)
        else:
            report = ReportPhrase(
                found=f"El navegador no acepta la conexión segura del sitio ({plain})",
                consequence=_tls_consequence(ctx),
                action="Instalar una conexión segura completa y válida",
                who=_TLS_WHO,
            )
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=report,
        )
    if days is None or expiry_day is None:
        return not_verified(spec, "la fecha de vencimiento de la conexión segura no se pudo leer", measured=measured)
    # Calendar days between the run date and the expiry date in Buenos Aires: the
    # number the reader gets from the date printed next to it ("vence el 14 de
    # octubre, en 5 días" on the 9th), used for the thresholds too.
    days = (expiry_day - ctx.run_date).days
    measured["dias_calendario"] = days
    fecha = fmt.fecha_larga(expiry_day)
    found = f"La conexión segura vence el {fecha}, {_dias(days)}" if days >= 0 else f"La conexión segura venció el {fecha}"
    # Every sentence below prints the date; those that say "en N días" print the day count too.
    trace = {"{fecha_larga}": "checks[EXT-07].measured.not_after"}
    if days >= 0:
        trace["{dias}"] = "checks[EXT-07].measured.dias_calendario"
    if days < 0:
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            trace=trace,
            phrase_report=ReportPhrase(found=found, consequence=_tls_consequence(ctx), action="Renovar la conexión segura", who=_TLS_WHO),
        )
    if days <= TLS_FAIL_DAYS:
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            trace=trace,
            phrase_report=ReportPhrase(
                found=found, consequence=_tls_consequence(ctx), action="Revisar la renovación automática en el hosting", who=_TLS_WHO
            ),
        )
    if days <= TLS_OBSERVATION_DAYS:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            trace=trace,
            reason="vence en pocos días",
            phrase_report=ReportPhrase(
                found=found, consequence=_tls_consequence(ctx), action="Revisar la renovación automática en el hosting", who=_TLS_WHO
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        note="la calificación y los protocolos viejos no se midieron",
        trace=trace,
        phrase_report=ReportPhrase(
            found=f"La conexión segura es válida y vence el {fecha}, {_dias(days)}",
            consequence="Nadie ve advertencias en el navegador y los datos de los formularios viajan protegidos",
        ),
    )


# ---------------------------------------------------------------------------
# EXT-13
# ---------------------------------------------------------------------------


def evaluate_ext13(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-13 · vencimiento del dominio, solo la fecha.

    FALLA: days_left <= 30, or a status in DOMAIN_FAIL_STATUSES.
    APROBADO_CON_OBSERVACION (Amarillo, Alta): 31..60 days (many
    domains auto-renew). APROBADO: > 60 days. NO_VERIFICADO: no RDAP service,
    404, timeout, no expiration event. Reason for .ar: "los dominios .{tld} no
    tienen consulta automática; se mira a mano en nic.ar"; otherwise "el registro
    del dominio no respondió". Never any holder data.

    Day thresholds use calendar days, as in EXT-07.
    """
    spec = common.spec_of("EXT-13")
    shared = common.shared_domain_reason(obs)
    if shared:  # the domain belongs to the organization or platform
        return not_applicable(spec, shared, measured={"shared_parent": obs.shared_parent})
    r = obs.rdap
    if r is not None and r.tld:
        tld = r.tld.lstrip(".")
    elif obs.registrable.endswith(".ar") and obs.registrable.count(".") >= 2:
        tld = ".".join(obs.registrable.split(".")[-2:])
    else:
        tld = obs.registrable.rsplit(".", 1)[-1]
    ar = tld == "ar" or tld.endswith(".ar") or obs.registrable.endswith(".ar")
    no_auto = f"los dominios .{tld} no tienen consulta automática; se mira a mano en nic.ar"
    # The report says what was not seen; nic.ar is in the annex.
    grey_ar = f"La fecha de vencimiento no se pudo consultar: los dominios .{tld} no tienen consulta automática"
    # Only .edu.ar has no RDAP; rdap.nic.ar answers com.ar, org.ar
    # and gob.ar, so a timeout, a 429 or a 5xx there is "no respondió".
    no_lookup = ar and (tld == "edu.ar" or (r is not None and r.error == "http-404"))
    statuses = [s.lower() for s in (r.status if r is not None else [])]
    bad_status = [s for s in statuses if s in DOMAIN_FAIL_STATUSES]
    measured: dict[str, Any] = {
        "tld": tld,
        "days_left": r.days_left if r is not None else None,
        "expiration": r.expiration if r is not None else None,
        "status": statuses,
        "server": r.server if r is not None else None,
        "error": r.error if r is not None else None,
    }
    who = "Quien administra el dominio"
    consequence = (
        f"Si no se renueva, el sitio y el correo {kinds.of(ctx.kind).del_} dejan de funcionar y la dirección puede quedar en manos de otro"
    )
    if r is None or (r.days_left is None and not bad_status):
        if no_lookup:
            return not_verified(spec, no_auto, measured=measured, phrase_report=ReportPhrase(found=grey_ar))
        return not_verified(spec, REASON_RDAP_DOWN, measured=measured)
    evidence = [artifacts.RDAP]
    day = _local_day(r.expiration)
    fecha = fmt.fecha_larga(day) if day is not None else None
    days = r.days_left
    if bad_status:
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="El registro marca el dominio como en proceso de baja",
                consequence=consequence,
                action="Renovarlo hoy en el registrador",
                who=who,
            ),
        )
    if days is None or fecha is None:
        if no_lookup:
            return not_verified(spec, no_auto, measured=measured, phrase_report=ReportPhrase(found=grey_ar))
        return not_verified(spec, REASON_RDAP_DOWN, measured=measured)
    days = (day - ctx.run_date).days  # calendar days, as in EXT-07
    measured["dias_calendario"] = days
    date_trace = {"{fecha_larga}": "checks[EXT-13].measured.expiration"}
    days_trace = {**date_trace, "{dias}": "checks[EXT-13].measured.dias_calendario"}
    if days < 0:
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            trace=date_trace,
            phrase_report=ReportPhrase(
                found=f"El dominio venció el {fecha}",
                consequence=consequence,
                action="Renovarlo hoy en el registrador",
                who=who,
            ),
        )
    found = f"El dominio vence el {fecha}, {_dias(days)}"
    if days <= DOMAIN_FAIL_DAYS:
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            trace=days_trace,
            phrase_report=ReportPhrase(
                found=found,
                consequence=consequence,
                action="Confirmar quién renueva y activar la renovación automática con segundo factor en el registrador",
                who=who,
            ),
        )
    if days <= DOMAIN_OBSERVATION_DAYS:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="vence en menos de dos meses",
            trace=days_trace,
            phrase_report=ReportPhrase(
                found=found,
                consequence="Muchos dominios se renuevan solos; conviene confirmar que este también",
                action="Confirmar quién renueva y que la renovación automática esté activa",
                who=who,
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        trace=date_trace,
        phrase_report=ReportPhrase(
            found=f"El dominio vence el {fecha}",
            consequence="Hay tiempo para confirmar la renovación antes de que venza",
        ),
    )


# ---------------------------------------------------------------------------
# EXT-17
# ---------------------------------------------------------------------------


def evaluate_ext17(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-17 · mismo sitio con o sin www, siempre con candado.

    obs.variants. APROBADO: both http variants reach https, the non-canonical
    host redirects to the canonical one (or does not resolve), every redirect is
    301/308, each variant reaches H in 1 hop. APROBADO_CON_OBSERVACION
    (Amarillo, Alta): a 302/307, or 2+ hops. FALLA: an http variant answers 200
    without moving to https, or both hosts answer 200 over https, or a variant
    ends in an error. NO_VERIFICADO: challenged.

    A variant that does not resolve (DNS) is fine for the non-canonical host;
    a timeout or a skipped request (budget, anti-bot) is NO_VERIFICADO, never a
    failure of the site.

    a cut of the host after the variants answered (robots.txt
    challenged, two 503s on links) no longer greys the check. Only a variant
    that was challenged or throttled itself, was skipped, or got a 5xx/429 in a
    throttled run is NO_VERIFICADO.
    """
    spec = common.spec_of("EXT-17")
    if not obs.variants:
        if obs.home_unreachable or obs.home is None:
            return common.home_missing_finding(spec, obs)
        return not_verified(spec, common.fetch_reason(obs, "variant", None, "las variantes de la dirección no se pudieron probar"))
    # Only a variant that was itself challenged greys the check: a
    # host cut LATER in the run (robots.txt, a link) does not undo four variants
    # that had already answered. A variant skipped after the cut, or a 5xx/429 in
    # a throttled run, is handled below.
    if any(v.challenged for v in obs.variants):
        return not_verified(spec, common.blocked_reason(obs))
    if common.run_throttled(obs) and any(
        v.final_status is not None and (v.final_status >= 500 or v.final_status == 429) for v in obs.variants
    ):
        # A 5xx while the site asked to slow down is not a fault of the address.
        return not_verified(spec, common.throttle_reason(obs))
    canonical = obs.canonical_url or ""
    canon_host = obs.canonical_host or ""
    http_open: list[str] = []
    two_copies: list[str] = []
    broken: list[str] = []
    temporary = 0
    max_hops = 0
    for v in obs.variants:
        start = urlsplit(v.start_url)
        start_host = domains.normalize_host(start.hostname or "") if start.hostname else ""
        err = v.error or ""
        if err.startswith("skipped") or err == "timeout":
            return not_verified(spec, common.fetch_reason(obs, "variant", None, "una de las variantes de la dirección no respondió"))
        if err:
            if err == "no resuelve" and start_host != canon_host:
                continue
            broken.append(v.start_url)
            continue
        redirects = [s for s in v.statuses if 300 <= s < 400]
        temporary += sum(1 for s in redirects if s in (302, 303, 307))
        max_hops = max(max_hops, v.hops)
        final = urlsplit(v.final_url or v.start_url)
        final_scheme = (final.scheme or "").lower()
        if v.final_status == 200 and final_scheme == "http":
            http_open.append(v.start_url)
            continue
        if v.left_site:
            broken.append(v.start_url)
            continue
        if not v.reached_canonical:
            if v.final_status == 200 and final_scheme == "https":
                two_copies.append(v.start_url)
            elif v.final_status is not None and v.final_status >= 400:
                broken.append(v.start_url)
            elif v.final_status is not None and 300 <= v.final_status < 400:
                broken.append(v.start_url)
    measured = {
        "variants": len(obs.variants),
        "http_open": len(http_open),
        "two_copies": len(two_copies),
        "broken": len(broken),
        "temporary_redirects": temporary,
        "max_hops": max_hops,
        "canonical": fmt.sanitize_site_url(canonical, 120),
    }
    evidence = [artifacts.VARIANTS]
    if http_open or two_copies or broken:
        if http_open:
            found = "Escrito con http:// el sitio se abre sin candado"
            consequence = "Parte de las visitas navega sin protección y Google ve dos copias del sitio"
        elif two_copies:
            found = "El sitio responde en dos direcciones distintas, con y sin www"
            consequence = "Google ve dos copias del sitio y reparte la relevancia entre las dos"
        else:
            shown = fmt.sanitize_site_url(broken[0], 80)
            found = f"La dirección {shown} no lleva al sitio"
            consequence = "Quien escribe esa dirección no llega al sitio"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=found, consequence=consequence, action="Configurar la redirección en el hosting", who="Quien mantiene el sitio"
            ),
        )
    if temporary or max_hops >= 2:
        if max_hops >= 2:
            found = f"El sitio llega a la dirección correcta, pero dando {max_hops} vueltas"
        else:
            found = "El sitio llega a la dirección correcta, pero con una redirección marcada como temporal"
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="redirección temporal o con vueltas",
            phrase_report=ReportPhrase(
                found=found, consequence="Cada vuelta suma espera", action="Dejar una sola redirección permanente", who="Quien mantiene el sitio"
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found=(
                "Con o sin www, y aunque se escriba sin la s de seguro, el sitio lleva siempre a una sola dirección "
                "con conexión segura"
            ),
            consequence=f"{kinds.of(ctx.kind).Audience} y Google llegan siempre al mismo sitio protegido",
        ),
    )


# ---------------------------------------------------------------------------
# EXT-16
# ---------------------------------------------------------------------------

_TYPE_NAMES: dict[str, tuple[str, str]] = {
    "img": ("una imagen", "imágenes"),
    "source": ("un video o una imagen", "videos o imágenes"),
    "video": ("un video", "videos"),
    "audio": ("un audio", "audios"),
    "script": ("un programa", "programas"),
    "link": ("un estilo o un ícono", "estilos o íconos"),
    "style": ("un fondo", "fondos"),
    "iframe": ("un contenido incrustado", "contenidos incrustados"),
    "embed": ("un contenido incrustado", "contenidos incrustados"),
    "object": ("un contenido incrustado", "contenidos incrustados"),
    "track": ("un subtítulo", "subtítulos"),
    "input": ("una imagen", "imágenes"),
    "form": ("un formulario", "formularios"),
}


def _http_subresources(page) -> list[tuple[str, str, str]]:
    return [s for s in page.subresources if s[2].lower().startswith("http://")]


def evaluate_ext16(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-16 · partes que cargan sin candado.

    PageFacts.subresources with http:// URLs on https pages (home, interna);
    exclusions per spec (rel profile/pingback/dns-prefetch/preconnect/alternate/
    canonical, xmlns, JSON-LD @context). FALLA (Amarillo): >= 1 subresource.
    APROBADO_CON_OBSERVACION (Azul): none, but http:// navigation links (hosts
    listed). APROBADO: none. NO_APLICA: the site serves no https at all.

    Only http:// links to OTHER sites count for the observation: an http link to
    the site itself is redirected (EXT-17 judges that).
    """
    spec = common.spec_of("EXT-16")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    home_url = (common.home_response(obs).final_url if common.home_response(obs) else "") or ""
    if urlsplit(home_url).scheme.lower() != "https":
        return not_applicable(spec, "el sitio no usa conexión segura; lo muestra la fila de la dirección con y sin www")
    interna = ctx.pages.get("interna") if obs.interna is not None else None
    home_mixed = _http_subresources(page)
    interna_mixed = _http_subresources(interna) if interna is not None else []
    off_site_http = []
    for a in page.anchors:
        if a.url and a.url.lower().startswith("http://") and not domains.is_same_site(a.url, obs.registrable):
            off_site_http.append(a.url)
    hosts: list[str] = []
    for u in off_site_http:
        try:
            h = domains.host_of(u)
        except ValueError:
            continue
        if h not in hosts:
            hosts.append(h)
    measured = {
        "home_mixed": len(home_mixed),
        "interna_mixed": len(interna_mixed),
        "types": sorted({t for t, _, _ in home_mixed + interna_mixed}),
        "http_links_off_site": len(off_site_http),
        "http_link_hosts": [fmt.sanitize_site_url(h, 60) for h in hosts[:5]],
    }
    evidence = [common.page_evidence(obs.home, artifacts.HOME_HTML)]
    if interna is not None:
        evidence.append(common.page_evidence(obs.interna, artifacts.INTERNA_HTML))
    mixed = home_mixed or interna_mixed
    if mixed:
        n = len(mixed)
        kinds = []
        for t, _, _ in mixed:
            if t not in kinds:
                kinds.append(t)
        if n == 1:
            tipos = _TYPE_NAMES.get(kinds[0], ("un archivo", "archivos"))[0]
        else:
            names = []
            for t in kinds:
                plural_name = _TYPE_NAMES.get(t, ("un archivo", "archivos"))[1]
                if plural_name not in names:
                    names.append(plural_name)
            tipos = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " y " + names[-1]
        if home_mixed and interna_mixed:
            where = "de la página principal y de una interna"
        elif home_mixed:
            where = "de la página principal"
        else:
            where = "de una página interna"
        if n == 1:
            found = f"Una parte {where} se carga sin conexión segura ({tipos})"
        else:
            found = f"{n} partes {where} se cargan sin conexión segura ({tipos})"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=found,
                consequence="El navegador puede bloquearlas o mostrar el candado incompleto",
                action="Pasarlas a conexión segura, con copia previa",
                who="Quien mantiene el sitio",
            ),
        )
    if off_site_http:
        n = len(off_site_http)
        shown = ", ".join(measured["http_link_hosts"][:3])
        found = (
            f"Hay un enlace a una página sin conexión segura ({shown})"
            if n == 1
            else f"Hay {n} enlaces a páginas sin conexión segura ({shown})"
        )
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="enlaces a páginas sin conexión segura",
            phrase_report=ReportPhrase(
                found=found,
                consequence="Quien los toca sale del sitio sin protección",
                action="Cambiarlos por su versión segura o traer ese contenido al sitio",
                who="Quien mantiene el sitio",
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found="Todo lo que carga la página viaja con conexión segura", consequence="El candado se ve completo"),
    )


# ---------------------------------------------------------------------------
# EXT-01
# ---------------------------------------------------------------------------

_MAX_AGE_RE = re.compile(r"max-age\s*=\s*\"?(\d+)", re.IGNORECASE)


def _protections(resp: "Response") -> tuple[list[str], int | None, bool]:
    present: list[str] = []
    hsts_values = resp.header_all("Strict-Transport-Security")
    max_age = None
    for v in hsts_values:
        m = _MAX_AGE_RE.search(v)
        if m:
            max_age = int(m.group(1))
            break
    if max_age is not None and max_age > 0:
        present.append("strict-transport-security")
    csp_values = resp.header_all("Content-Security-Policy")
    if any(v.strip() for v in csp_values):
        present.append("content-security-policy")
    nosniff = any(v.strip().lower() == "nosniff" for v in resp.header_all("X-Content-Type-Options"))
    if nosniff:
        present.append("x-content-type-options")
    if any(v.strip() for v in resp.header_all("Referrer-Policy")):
        present.append("referrer-policy")
    xfo = any(v.strip().lower() in ("deny", "sameorigin") for v in resp.header_all("X-Frame-Options"))
    frame_ancestors = any("frame-ancestors" in v.lower() for v in csp_values)
    if xfo or frame_ancestors:
        present.append("x-frame-options|frame-ancestors")
    if any(v.strip() for v in resp.header_all("Permissions-Policy")):
        present.append("permissions-policy")
    return present, max_age, nosniff


# the consequence and the action follow what is missing, in this
# order of risk. Each entry: (protection, plain name for the action, what can
# happen without it). Framing and injection merge into the spec's sentence when
# both X-Frame-Options/frame-ancestors and CSP are missing.
_FRAMING = "x-frame-options|frame-ancestors"
_INJECTION = "content-security-policy"
_MISSING_ORDER: tuple[tuple[str, str, str], ...] = (
    ("strict-transport-security", "la de conexión segura obligatoria", "el navegador puede abrir el sitio sin candado"),
    (_FRAMING, "la que impide mostrar el sitio dentro de otro", "es más fácil incrustar el sitio en otro"),
    (_INJECTION, "la que limita qué contenido carga la página", "es más fácil inyectarle contenido al sitio"),
    ("x-content-type-options", "la que fija el tipo de cada archivo", "el navegador puede leer un archivo como si fuera de otro tipo"),
    ("referrer-policy", "la que fija qué se comparte con otros sitios", "el sitio no indica qué parte de sus direcciones ven los sitios que enlaza"),
    (
        "permissions-policy",
        "la que limita los permisos del navegador",
        "el sitio no limita qué funciones del navegador, como la cámara o la ubicación, pueden usar sus páginas",
    ),
)
_FRAMING_AND_INJECTION = "es más fácil incrustar el sitio en otro o inyectarle contenido"
_MAX_CONSEQUENCES = 3
_HSTS_EXTEND = "alargar a seis meses o más la de conexión segura obligatoria"
_HTTPS_FIRST = "usar la conexión segura en todo el sitio"


def _hsts_clause(*, no_https: bool, hsts_short: bool) -> str:
    """What happens without a working HSTS, in words that agree with EXT-17.

    Most small sites redirect http to https (EXT-17 green), so "the browser can
    open the site without the padlock" contradicted the same report. Without
    HSTS the real exposure is the first, unencrypted hop before that redirect.
    """
    if no_https:
        return "el sitio se abre sin candado"
    if hsts_short:
        return "el navegador recuerda por poco tiempo que tiene que usar la conexión segura"
    return "si alguien escribe la dirección sin https, la primera conexión viaja sin candado"


def _ext01_problems(*, https: bool, present: list[str], hsts_short: bool, nosniff: bool) -> list[str]:
    """Why EXT-01 is a FALLA, named, so the found text never shows only a count."""
    problems: list[str] = []
    if not https:
        problems.append("el sitio responde sin conexión segura")
    elif "strict-transport-security" not in present:
        problems.append("falta la que obliga a usar la conexión segura")
    elif hsts_short:
        problems.append("la que obliga a usar la conexión segura dura menos de seis meses")
    if not nosniff:
        problems.append("falta la que fija el tipo de cada archivo")
    return problems


def _ext01_texts(present: list[str], hsts_short: bool, no_https: bool = False) -> tuple[str, str]:
    """(consequence, action) of an EXT-01 observation or FALLA from the missing protections.

    ``hsts_short``: the header is there with a max-age under six months, so it
    is extended, not added. ``no_https``: the home answered without https, where
    the header does nothing; the first step is the secure connection itself.
    """
    missing = [p for p, _, _ in _MISSING_ORDER if p not in present]
    clauses: list[str] = []
    hsts_clause = _hsts_clause(no_https=no_https, hsts_short=hsts_short)
    if (hsts_short or no_https) and _MISSING_ORDER[0][0] not in missing:
        clauses.append(hsts_clause)
    for key, _, clause in _MISSING_ORDER:
        if key not in missing:
            continue
        if key == _MISSING_ORDER[0][0]:
            clauses.append(hsts_clause)
        elif key == _FRAMING and _INJECTION in missing:
            clauses.append(_FRAMING_AND_INJECTION)
        elif key == _INJECTION and _FRAMING in missing:
            continue  # already in the merged sentence
        else:
            clauses.append(clause)
    clauses = clauses[:_MAX_CONSEQUENCES]
    consequence = "; ".join(clauses)
    consequence = consequence[:1].upper() + consequence[1:] if consequence else ""
    names = [name for key, name, _ in _MISSING_ORDER if key in missing]
    steps: list[str] = []
    if no_https:
        steps.append(_HTTPS_FIRST)
    if len(names) == 1:
        steps.append(f"agregar la protección que falta ({names[0]})")
    elif names:
        joined = ", ".join(names[:-1]) + " y " + names[-1]
        steps.append(f"agregar las {len(names)} protecciones que faltan ({joined})")
    if hsts_short and not no_https:
        steps.append(_HSTS_EXTEND)
    if not steps:
        steps.append("agregar las líneas de configuración que faltan")
    action = ", ".join(steps)
    action = f"{action[:1].upper()}{action[1:]} y probar que nada se rompa"
    return consequence, action


def _ext01_trace(n: int, n_missing: int) -> dict[str, str]:
    """The counts the EXT-01 sentences print. The 6 is len(PROTECTIONS), a constant."""
    trace = {"{n}": "checks[EXT-01].measured.n_protections"} if n else {}
    if n_missing > 1:  # "agregar las {n_faltan} protecciones que faltan"
        trace["{n_faltan}"] = "checks[EXT-01].measured.n_missing"
    return trace


def evaluate_ext01(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-01 · protecciones del navegador.

    Headers of home load 1 and interna. N = PROTECTIONS present on the home, of 6
    (CSP Report-Only does not count; X-Frame-Options DENY/SAMEORIGIN or CSP
    frame-ancestors). FALLA (Rojo, Alta) when HSTS max-age >= 15552000 or
    nosniff is missing on the home, including no https (the tool's rule).
    Observatory grade (only with --observatory) is evidence and never changes
    the state. NO_VERIFICADO: home challenged. As a count:
      "El servidor activa {n} de las 6 protecciones que ofrecen los navegadores."

    the state agrees with the count. A green
    line next to "2 de 6" read as a contradiction, so APROBADO needs the tool's
    two plus all six; HSTS and nosniff with fewer than six is
    APROBADO_CON_OBSERVACION (Amarillo, Alta), with the count and the missing
    ones to add.

    the consequence and the action of the observation and the
    FALLA are built from the missing set (_ext01_texts), never one fixed
    sentence: framing only when X-Frame-Options and frame-ancestors are both
    missing, injection only when CSP is missing, "sin candado" for a missing or
    short HSTS, a plain line for Referrer-Policy and Permissions-Policy (at most
    three, in order of risk). The action names what is missing. measured gains
    ``missing``. The spec's "Es más fácil incrustar el sitio en otro o
    inyectarle contenido" stays, verbatim, when both of its protections are
    missing.
    """
    spec = common.spec_of("EXT-01")
    resp = _home_usable(obs)
    if resp is None:
        return common.home_missing_finding(spec, obs)
    present, max_age, nosniff = _protections(resp)
    https = urlsplit(resp.final_url or resp.url).scheme.lower() == "https"
    grade = obs.observatory.grade if obs.observatory is not None and not obs.observatory.error else None
    n = len(present)
    measured = {
        "n_protections": n,
        "present": present,
        "hsts_max_age": max_age,
        "nosniff": nosniff,
        "https": https,
        "observatory_grade": grade,
    }
    evidence = [common.headers_evidence(obs.home, artifacts.HOME_HEADERS)]
    evidence += common.optional_evidence(ctx, artifacts.OBSERVATORY) if grade else []
    ok = https and max_age is not None and max_age >= HSTS_MIN_MAX_AGE and nosniff
    mozilla = f"; calificación {fmt.sanitize_site_text(grade, 4)} en la prueba de Mozilla" if grade else ""
    if ok and n >= len(PROTECTIONS):
        return new_finding(
            spec,
            State.APROBADO,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="El servidor activa las 6 protecciones que ofrecen los navegadores",
                # What the six headers do, never a guarantee.
                consequence=(
                    "Después de la primera visita, el navegador ya no abre el sitio sin candado, y es más difícil "
                    "incrustar el sitio en otro o inyectarle contenido"
                ),
            ),
        )
    hsts_short = "strict-transport-security" in present and (max_age or 0) < HSTS_MIN_MAX_AGE
    consequence, action = _ext01_texts(present, hsts_short, no_https=not https)
    measured["missing"] = [p for p in PROTECTIONS if p not in present]
    measured["n_missing"] = len(measured["missing"])
    trace = _ext01_trace(n, measured["n_missing"])
    if ok:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason=f"activa {n} de las 6 protecciones",
            trace=trace,
            phrase_report=ReportPhrase(
                found=(
                    f"El servidor activa {n} de las 6 protecciones que ofrecen los navegadores; la que obliga a usar "
                    f"la conexión segura está activa{mozilla}"
                ),
                consequence=consequence,
                action=action,
                who="Quien mantiene el sitio",
            ),
        )
    if n == 0:
        found = "El servidor no activa ninguna de las 6 protecciones que ofrecen los navegadores"
    else:
        found = f"El servidor activa {n} de las 6 protecciones que ofrecen los navegadores"
    problems = _ext01_problems(https=https, present=present, hsts_short=hsts_short, nosniff=nosniff)
    if n == 0:
        # "ninguna de las 6" already says every one is missing; naming two of them reads as if only those were.
        problems = [p for p in problems if not p.startswith("falta ")]
    if problems:
        found += "; " + "; ".join(problems)
    found += mozilla
    return new_finding(
        spec,
        State.FALLA,
        measured=measured,
        evidence=evidence,
        trace=trace,
        phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who="Quien mantiene el sitio"),
    )


# ---------------------------------------------------------------------------
# EXT-02
# ---------------------------------------------------------------------------

_WP_GENERATOR_RE = re.compile(r"^\s*WordPress\s+(\d+(?:\.\d+){1,2})\b", re.IGNORECASE)
_OTHER_CMS_RE = re.compile(r"^\s*(Joomla!?|Drupal)\b[^0-9]*(\d+(?:\.\d+){0,2})?", re.IGNORECASE)


def _ext02_case(
    version: str,
    status: str | None,
    latest: str | None,
    highest: bool | None,
    age: int | None,
    branch_day: dt.date | None,
) -> str | None:
    """The EXT-02 case the stable-check list proves, for the report consequence; None when no case applies.

    "insegura"; for "outdated", a branch at least a year old and older than the
    latest one: "al-dia-en-rama" (the newest release of its branch),
    "rama-vieja" (a newer release of its branch exists) or "rama-sin-dato"
    (unknown).
    """
    if status is None or latest is None:
        return None
    if status == "insecure":
        return "insegura"
    if branch_day is None or status != "outdated" or age is None or age < 1:
        return None
    try:
        if branch_of(version) == branch_of(latest):
            return None
    except ValueError:
        return None
    if highest is True:
        return "al-dia-en-rama"
    if highest is False:
        return "rama-vieja"
    return "rama-sin-dato"


# EXT-02 report consequence: a security claim only where the list proves the
# install lacks published fixes ("insegura", "rama-vieja"). The newest release
# of an older branch (up to date there) and an install whose place in its
# branch is unknown never read "fallas conocidas".
EXT02_RISK_CONSEQUENCE = "Alguien puede buscar fallas conocidas de esa versión y entrar"
EXT02_BRANCH_CONSEQUENCE = "La rama {rama} deja de recibir arreglos antes que la {rama_vigente}"
EXT02_UNKNOWN_CONSEQUENCE = "Si le faltan actualizaciones, alguien puede buscar fallas conocidas de esa versión"


def _ext02_consequence(version: str, status: str | None, latest: str | None, case: str | None, highest: bool | None) -> str:
    if status == "insecure" or case in ("insegura", "rama-vieja") or highest is False:
        return EXT02_RISK_CONSEQUENCE
    if case == "al-dia-en-rama" and latest:
        try:
            return EXT02_BRANCH_CONSEQUENCE.format(rama=branch_of(version), rama_vigente=branch_of(latest))
        except ValueError:
            pass
    return EXT02_UNKNOWN_CONSEQUENCE


def _wordpress_fingerprint(page, obs: "Observations") -> bool:
    return common.wordpress_fingerprint(page, obs)  # shared with the platform wording of the actions


def evaluate_ext02(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-02 · versión de WordPress visible, solo el núcleo.

    meta generator (WordPress x.y(.z), also Joomla/Drupal), ?ver= on
    /wp-includes/ assets only, the feed <generator>. Plugin/theme ?ver= ignored.
    No CMS fingerprint -> NO_APLICA. WordPress with no visible version ->
    APROBADO. Visible version -> FALLA (Amarillo). Status from
    obs.wp_status ("latest"/"outdated"/"insecure"), age from wpversions.
    The case (_ext02_case: "insegura",
    "al-dia-en-rama", "rama-vieja", "rama-sin-dato" or none) decides the
    report consequence (_ext02_consequence): "fallas conocidas" only when the
    list proves missing fixes; the newest release of an older branch reads that
    the branch stops getting fixes sooner; unknown, a conditional sentence.
    The measured data (version, wp_status, latest, branch_release,
    mas_alta_de_la_rama, rama_mas_alta) are unchanged: the report and the
    annex read them.

    /wp-includes/ assets that are bundled libraries (jQuery and others, listed in
    wpapi.LIBRARY_ASSET_HINTS) carry their own ?ver= and are never read as the
    WordPress version.
    """
    spec = common.spec_of("EXT-02")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    evidence = [common.page_evidence(obs.home, artifacts.HOME_HTML)]
    # Joomla / Drupal: report only, no age table.
    for g in page.generator:
        m = _OTHER_CMS_RE.match(g)
        if m:
            cms = "Joomla" if m.group(1).lower().startswith("joomla") else "Drupal"
            version = m.group(2)
            measured = {"cms": cms.lower(), "version": version}
            if version:
                return new_finding(
                    spec,
                    State.FALLA,
                    measured=measured,
                    evidence=evidence,
                    phrase_report=ReportPhrase(
                        found=f"El sitio funciona con {cms} {version}, y la versión se ve desde afuera",
                        consequence="Le ahorra un paso a quien busca fallas",
                        action="Actualizar con copia previa y ocultar la versión",
                        who="Quien mantiene el sitio, con acceso al panel",
                    ),
                )
            return new_finding(
                spec,
                State.APROBADO,
                measured=measured,
                evidence=evidence,
                phrase_report=ReportPhrase(found=f"La página no anuncia la versión de {cms}", consequence="Menos pistas para alguien que busca entrar"),
            )
    if not _wordpress_fingerprint(page, obs):
        return not_applicable(spec, "el sitio no usa WordPress", measured={"cms": None})

    version = source = None
    for g in page.generator:
        m = _WP_GENERATOR_RE.match(g)
        if m:
            version, source = m.group(1), "generator"
            break
    if version is None:
        same_site = [u for u in page.script_srcs + page.stylesheet_hrefs if domains.is_same_site(u, obs.registrable)]
        v = core_version_from_assets(same_site)
        # Library assets are already left out (wpapi.LIBRARY_ASSET_HINTS); a core
        # version is accepted when it has the shape of a WordPress branch, even
        # one older than the table.
        if v is not None and wpversions.looks_like_wordpress_branch(v):
            version, source = v, "wp-includes"
    if version is None and obs.feed is not None and obs.feed.doc is not None:
        v = wordpress_version_from_generator(obs.feed.doc.generator)
        if v is not None:
            version, source = v, "feed"
            evidence += common.optional_evidence(ctx, artifacts.FEED)
    measured: dict[str, Any] = {"cms": "wordpress", "version": version, "version_source": source}
    if version is None:
        return new_finding(
            spec,
            State.APROBADO,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(found="La página no anuncia la versión de WordPress", consequence="Menos pistas para alguien que busca entrar"),
        )

    status = latest = None
    highest: bool | None = None
    ws = obs.wp_status
    try:
        same = ws is not None and normalize_version(ws.version) == normalize_version(version)
    except ValueError:
        same = False
    if same and ws is not None:
        status, latest = ws.status, ws.latest
        highest = getattr(ws, "highest_of_branch", None)
        if ws.fetched:
            evidence += common.optional_evidence(ctx, artifacts.WP_STABLE)
    age = wpversions.branch_age_years(version, ctx.run_date)
    branch_day = wpversions.branch_release_date(version)
    measured.update(
        wp_status=status,
        latest=latest,
        age_years=age,
        branch_release=branch_day.isoformat() if branch_day else None,
        mas_alta_de_la_rama=highest,
        rama_mas_alta=getattr(ws, "branch_highest", None) if same else None,
    )
    shown = fmt.sanitize_site_text(version, 20)
    if status == "latest":
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="La versión de WordPress está al día, pero se ve desde afuera",
                consequence="Le ahorra un paso a quien busca fallas",
                action="Ocultarla",
                who="Quien mantiene el sitio",
            ),
        )
    case = _ext02_case(version, status, latest, highest, age, branch_day)
    trace = {"{version}": "checks[EXT-02].measured.version"}
    if branch_day is not None:
        found = f"El sitio funciona con WordPress {shown}, de la rama de {fmt.mes_anio(branch_day)}, y la versión se ve desde afuera"
        trace["{mes_anio}"] = "checks[EXT-02].measured.branch_release"
    else:
        found = f"El sitio funciona con WordPress {shown}, y la versión se ve desde afuera"
    return new_finding(
        spec,
        State.FALLA,
        measured=measured,
        evidence=evidence,
        trace=trace,
        phrase_report=ReportPhrase(
            found=found,
            consequence=_ext02_consequence(version, status, latest, case, highest),
            action="Actualizar en un entorno de prueba primero, con copia, y después ocultar la versión",
            who="Quien mantiene el sitio, con acceso al panel",
        ),
    )


# ---------------------------------------------------------------------------
# EXT-09
# ---------------------------------------------------------------------------

_PRODUCT_RES = [re.compile(rf"(?<![A-Za-z]){re.escape(p)}/(\d+(?:\.\d+)+)", re.IGNORECASE) for p in VERSIONED_PRODUCTS]
_ANY_VERSION_RE = re.compile(r"\d+\.\d+")


def evaluate_ext09(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-09 · versión del servidor.

    Server and X-Powered-By of home load 1 and interna. FALLA (Amarillo, Baja):
    a VERSIONED_PRODUCTS name followed by a dotted version (Apache/2.4.41).
    APROBADO_CON_OBSERVACION (Azul): a version in a non-standard server string.
    APROBADO: no exact version.
    """
    spec = common.spec_of("EXT-09")
    resp = _home_usable(obs)
    if resp is None:
        return common.home_missing_finding(spec, obs)
    responses = [resp]
    if obs.interna is not None and obs.interna.response is not None and obs.interna.response.usable:
        responses.append(obs.interna.response)
    values: list[str] = []
    for r in responses:
        for name in ("Server", "X-Powered-By"):
            for v in r.header_all(name):
                v = v.strip()
                if v and v not in values:
                    values.append(v)
    exact = [v for v in values if any(rx.search(v) for rx in _PRODUCT_RES)]
    other = [v for v in values if v not in exact and _ANY_VERSION_RE.search(v)]
    measured = {"values": [fmt.sanitize_site_text(v, 80) for v in values], "exact_versions": len(exact), "other_versions": len(other)}
    evidence = [common.headers_evidence(obs.home, artifacts.HOME_HEADERS)]
    consequence = "Le ahorra un paso a quien busca fallas conocidas"
    if exact:
        valor = "; ".join(fmt.sanitize_site_text(v, 60) for v in exact[:3])
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            trace={"{valor}": "checks[EXT-09].measured.values"},
            phrase_report=ReportPhrase(
                found=f"El servidor anuncia qué programa usa y su versión exacta ({valor})",
                consequence=consequence,
                action="Pedirle al hosting que oculte las versiones",
                who="Quien mantiene el sitio, con el hosting",
            ),
        )
    if other:
        valor = "; ".join(fmt.sanitize_site_text(v, 60) for v in other[:3])
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="versión en la identificación del servidor",
            trace={"{valor}": "checks[EXT-09].measured.values"},
            phrase_report=ReportPhrase(
                found=f"El servidor muestra un número de versión en su identificación ({valor})",
                consequence=consequence,
                action="Pedirle al hosting que oculte las versiones",
                who="Quien mantiene el sitio, con el hosting",
            ),
        )
    return new_finding(
        spec,
        State.APROBADO,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(found="El servidor no anuncia las versiones de su software", consequence="Menos pistas para alguien que busca entrar"),
    )


# ---------------------------------------------------------------------------
# EXT-23
# ---------------------------------------------------------------------------


def evaluate_ext23(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-23 · listas de bloqueo.

    Spamhaus DBL (obs.dbl) only; Safe Browsing / Web Risk are NOT called in v1: the Google half is always unverified, with the manual link
    TRANSPARENCY_REPORT_URL written in the report. FALLA (Rojo, Crítica) when
    DBL lists the domain (confirmable alone). Otherwise NO_VERIFICADO, because
    APROBADO needs both halves: reason "la consulta de Google se revisa a mano"
    plus, for REFUSED/ERROR, "la lista de Spamhaus rechazó la consulta desde
    esta red". hack_signal True for HACK_SIGNAL_CODES (dbl.py).
    """
    spec = common.spec_of("EXT-23")
    shared = common.shared_domain_reason(obs)
    if shared:  # the blocklists list the organization's or platform's domain
        return not_applicable(spec, shared, measured={"shared_parent": obs.shared_parent})
    dbl = obs.dbl
    link = TRANSPARENCY_REPORT_URL.format(domain=obs.registrable)
    measured: dict[str, Any] = {
        "verdict": dbl.verdict.value if dbl is not None else None,
        "codes": list(dbl.codes) if dbl is not None else [],
        "categories": list(dbl.categories) if dbl is not None else [],
        "control_ok": dbl.control_ok if dbl is not None else None,
        "google": "no consultado (se revisa a mano)",
    }
    if dbl is not None and dbl.verdict == DblVerdict.LISTED:
        hack = bool(dbl.hack_signal)
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=[artifacts.DBL],
            hack_signal=hack,
            phrase_report=ReportPhrase(
                found="El dominio está en la lista de bloqueo de Spamhaus",
                consequence=(
                    "Los mails que lleven el nombre del sitio pueden caer en spam o rebotar; es una secuela típica de "
                    "un sitio que estuvo intervenido"
                ),
                action="Confirmar que no quede contenido ajeno, pedir la baja de la lista y vigilar que no vuelva",
                who="Quien mantiene el sitio",
            ),
        )
    if dbl is None:
        spamhaus = "la lista de Spamhaus no se consultó"
    elif dbl.verdict == DblVerdict.NOT_LISTED:
        spamhaus = "la lista de Spamhaus no marca el dominio"
    elif dbl.verdict == DblVerdict.REFUSED:
        spamhaus = "la lista de Spamhaus rechazó la consulta desde esta red"
    else:
        spamhaus = "la lista de Spamhaus no respondió"
    reason = f"{REASON_GOOGLE_MANUAL}; {spamhaus}"
    # The report says what was not seen; the manual links are written once in
    # anexo-tecnico.md.
    if dbl is not None and dbl.verdict == DblVerdict.NOT_LISTED:
        grey = "La lista de Spamhaus no marca el dominio; la de Google no se consultó en este chequeo"
    else:
        grey = f"La lista de Google no se consultó en este chequeo, y {spamhaus.replace('la lista de Spamhaus', 'la de Spamhaus', 1)}"
    return not_verified(
        spec,
        reason,
        measured=measured,
        evidence=common.optional_evidence(ctx, artifacts.DBL),
        phrase_report=ReportPhrase(found=grey),
    )


# ---------------------------------------------------------------------------
# EXT-25
# ---------------------------------------------------------------------------


def _link_haystack(a) -> str:
    hay = normalize_for_match(" ".join([a.text or "", a.aria_label or "", a.title or "", " ".join(a.img_alts), unquote(a.href or "")]))
    return hay.replace("-", " ").replace("_", " ")


def _is_privacy(a) -> bool:
    hay = _link_haystack(a)
    return any(t in hay for t in PRIVACY_TERMS)


def _is_legal(a) -> bool:
    hay = _link_haystack(a)
    words = set(re.findall(r"[a-z]+", hay))
    return any((t in hay) if " " in t else (t in words) for t in LEGAL_TERMS)


def evaluate_ext25(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-25 · política de privacidad.

    Home anchors matched with content.PRIVACY_TERMS (normalized). APROBADO: link
    on D, https, target 200 (obs.links). APROBADO_CON_OBSERVACION (Azul): policy
    on another domain, over http://, or target not 200 (another host is never
    fetched). FALLA (Amarillo): no link. Context: number of forms, inscription
    link present.

    A same-site link whose target was not checked (budget) is an observation:
    the policy exists, but it was not seen to open.
    """
    spec = common.spec_of("EXT-25")
    page = ctx.pages.get("home")
    if page is None:
        return common.home_missing_finding(spec, obs)
    links = [a for a in page.anchors if a.url and _is_privacy(a)]
    kind = kinds.of(ctx.kind)
    data_forms = getattr(page, "data_forms", 0)
    measured: dict[str, Any] = {"n_links": len(links), "forms": page.forms, "data_forms": data_forms}
    evidence = [common.page_evidence(obs.home, artifacts.HOME_HTML)]
    if not links:
        legal = [a for a in page.anchors if a.url and _is_legal(a)]
        measured["n_legal_links"] = len(legal)
        if legal:
            # «Legales» or «Términos y condiciones» often hold the policy: not seen, not missing.
            return new_finding(
                spec,
                State.APROBADO_CON_OBSERVACION,
                measured=measured,
                evidence=evidence,
                reason="enlace a páginas legales sin el nombre de la política",
                phrase_report=ReportPhrase(
                    found="La página principal enlaza páginas legales, pero ninguna se llama política de privacidad",
                    consequence="No se comprobó que esas páginas expliquen qué se hace con los datos",
                    action="Confirmar que la política esté publicada y enlazarla con ese nombre",
                    who=f"Quien mantiene el sitio, con el texto que tenga {kind.el}",
                ),
            )
        # What was measured is the home's links, not the whole site. The
        # law (Ley 25.326, art. 6) is cited only when a form asks for personal
        # data; a search box does not.
        if data_forms:
            found = "La página principal no enlaza una política de privacidad, y tiene formularios que piden datos personales"
            consequence = f"{kind.Audience} no saben para qué se usan sus datos, y la ley pide informarlo"
        else:
            found = "La página principal no enlaza una política de privacidad"
            consequence = "Quien visita el sitio no sabe qué se hace con sus datos"
        return new_finding(
            spec,
            State.FALLA,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=found,
                consequence=consequence,
                action="Publicar la política y enlazarla desde el pie y los formularios",
                who=f"{kind.El}, con quien mantiene el sitio",
            ),
        )
    same_site = [a for a in links if domains.is_same_site(a.url, obs.registrable)]
    statuses = {}
    probes = common.link_status_map(obs)
    for a in same_site:
        probe = probes.get(domains.compare_key(a.url))
        statuses[a.url] = probe.final_status if probe is not None and common.probe_verified(probe, obs) else None
    good = [a for a in same_site if a.url.lower().startswith("https://") and statuses.get(a.url) == 200]
    measured.update(
        same_site=len(same_site),
        https=any(a.url.lower().startswith("https://") for a in links),
        target_status=next((s for s in statuses.values() if s is not None), None),
    )
    if good:
        return new_finding(
            spec,
            State.APROBADO,
            measured=measured,
            evidence=evidence + common.optional_evidence(ctx, artifacts.LINKS),
            phrase_report=ReportPhrase(found="El sitio publica su política de privacidad", consequence=f"{kind.Audience} saben para qué se usan sus datos"),
        )
    if not same_site:
        a = links[0]
        try:
            host = fmt.sanitize_site_url(domains.host_of(a.url), 60)
        except ValueError:
            host = "otro sitio"
        insecure_http = a.url.lower().startswith("http://")
        found = f"La política de protección de datos personales está alojada en {host}" + (", sin conexión segura" if insecure_http else "")
        consequence = f"Si ese sitio se apaga, {kind.el} queda sin política publicada"
        action = f"Traerla al sitio {kind.del_}"
    else:
        a = same_site[0]
        status = statuses.get(a.url)
        if a.url.lower().startswith("http://"):
            found = "La política de privacidad está publicada, pero el enlace no usa conexión segura"
            consequence = "Quien la abre sale de la conexión segura del sitio"
            action = "Cambiar el enlace por su versión segura"
        elif status is None:
            found = "La política de privacidad está enlazada, pero no se pudo comprobar que la página abra"
            consequence = f"Si la página no abre, {kind.audience} no pueden leerla"
            action = "Comprobar que la página de la política abra"
        else:
            found = "El enlace a la política de privacidad lleva a una página que no responde bien"
            consequence = f"{kind.Audience} no pueden leer para qué se usan sus datos"
            action = "Corregir el enlace a la política"
    return new_finding(
        spec,
        State.APROBADO_CON_OBSERVACION,
        measured=measured,
        evidence=evidence,
        reason="política fuera del sitio o sin comprobar",
        phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who=f"Quien mantiene el sitio, con el texto que tenga {kind.el}"),
    )
