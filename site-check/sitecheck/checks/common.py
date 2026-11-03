"""Helpers shared by the evaluators: finding constructors, standard reasons, state ordering.

The Spanish reasons below are client text (they appear in the grey list of the
report as "{nombre_llano}: {motivo}"): formal, no voseo, no dashes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..model import CheckSpec, Finding, ReportPhrase, State

if TYPE_CHECKING:
    from ..htmlextract import PageFacts
    from ..httpclient import Response
    from ..model import EvalContext
    from ..observations import LinkProbe, Observations, PageFetch
    from ..psi import PsiRun

REASON_ANTIBOT = "verificación anti-bot del hosting"
REASON_BUDGET = "tope de pedidos"
REASON_HOME_MISSING = "la página principal no respondió"
REASON_NOT_LINKED = "la página no está enlazada desde la principal"
# a non-technical reader does not know what "cuota" or "clave" refer to. The
# technical detail goes to datos.json: meta.corridas_psi.estado "sin-clave-cuota"
# and the finding's nota_interna (PSI_NO_KEY_NOTE). The reason itself is also
# the "No se midió: {motivo}" cell of the velocity table, so it stays plain.
REASON_PSI_NO_KEY_QUOTA = "la herramienta de velocidad de Google no dio resultados"
PSI_NO_KEY_NOTE = (
    "PageSpeed respondió 429 sin clave: la cuota compartida de las consultas sin clave estaba agotada; "
    "con la clave propia no pasa"
)
REASON_PSI_QUOTA = "la cuota diaria de la herramienta de velocidad de Google se agotó"
REASON_PSI_ERROR = "la herramienta de velocidad de Google no respondió"
REASON_PSI_RUNTIME = "la herramienta de Google no pudo cargar el sitio ({code})"
REASON_PSI_OUTSIDE = "la herramienta de Google terminó en otra dirección"
REASON_BROWSER_FOCUS = "el foco con teclado requiere una prueba en navegador"
REASON_BROWSER_REFLOW = "el ajuste a 320 píxeles y el zoom al 200 % requieren una prueba en navegador"
REASON_CONTROL_SLOW = "la conexión desde donde se midió estaba lenta; se repite"
REASON_DNS_CONTROL = "la consulta de control del correo falló; se repite"


REASON_EVAL_ERROR = "la medición no se pudo evaluar"
REASON_PAGE_ERROR = "la página no respondió"
REASON_THROTTLE = "el sitio pidió bajar el ritmo"  # 429, 503 + Retry-After, repeated 403
REASON_HOME_TLS = "el navegador no acepta la conexión segura de la página principal, así que no se leyó"
REASON_SHARED_DOMAIN = (
    "El sitio está en un subdominio de {parent}: el correo, el vencimiento del dominio y las listas de bloqueo "
    "son de ese dominio y no se revisaron."
)


def blocked_reason(obs: "Observations") -> str:
    """Why the host was cut: the site asked to slow down, or an anti-bot check."""
    return REASON_THROTTLE if getattr(obs, "block_cause", None) == "throttle" else REASON_ANTIBOT


def shared_domain_reason(obs: "Observations") -> str | None:
    """NO_APLICA reason of EXT-05/13/23 when the site lives under someone else's domain, else None."""
    parent = getattr(obs, "shared_parent", None)
    return REASON_SHARED_DOMAIN.format(parent=parent) if parent else None


def new_finding(spec: CheckSpec, state: State, **fields: Any) -> Finding:
    """A Finding pre-filled with the static facts of ``spec`` (id, name, module, priority, destination)."""
    return Finding(
        id=spec.id,
        name_plain=spec.name_plain,
        module=spec.module,
        priority=spec.priority,
        state=state,
        **fields,
    )


def grey_sentence(text: str) -> str:
    """A grey-row sentence as it goes after "{nombre_llano}: ": first letter lowercased, no final period."""
    t = (text or "").strip().rstrip(".").strip()
    if t and t[0].isupper() and not t[:2].isupper():
        t = t[0].lower() + t[1:]
    return t


def not_verified(spec: CheckSpec, reason: str, **fields: Any) -> Finding:
    """NO_VERIFICADO with ``reason`` and phrase_report.found = reason sentence for the grey list.

    A caller may pass its own ``phrase_report`` (a spec-specific grey sentence).
    """
    fields.setdefault("phrase_report", ReportPhrase(found=grey_sentence(reason)))
    return new_finding(spec, State.NO_VERIFICADO, reason=reason, **fields)


def not_applicable(spec: CheckSpec, reason: str, **fields: Any) -> Finding:
    """NO_APLICA with ``reason`` (not shown in the report, kept in datos.json)."""
    return new_finding(spec, State.NO_APLICA, reason=reason, **fields)


def unavailable_reason(obs: "Observations", purpose: str, resp: "Response | None" = None) -> str:
    """Best Spanish reason why something for ``purpose`` is missing.

    REASON_ANTIBOT when the host was cut or the response was challenged,
    REASON_BUDGET when skipped for budget, REASON_NOT_LINKED when the guard did
    not admit it, else REASON_HOME_MISSING.

    ``resp`` (optional) is the response that was obtained, if any: a challenge,
    a skip or a network error on it refines the reason.
    """
    if resp is not None:
        if resp.challenge:
            return REASON_THROTTLE if getattr(resp, "throttled", False) else REASON_ANTIBOT
        if resp.skipped == "budget":
            return REASON_BUDGET
        if resp.skipped in ("blocked",):
            return blocked_reason(obs)
    skip_reason = None
    for s in obs.skipped:
        if s.purpose == purpose:
            skip_reason = s.reason
            break
    if skip_reason == "budget":
        return REASON_BUDGET
    if skip_reason == "blocked":
        return blocked_reason(obs)
    if skip_reason == "not-linked":
        return REASON_NOT_LINKED
    if obs.blocked:
        return blocked_reason(obs)
    if resp is not None and (resp.error or "").startswith("tls"):
        return REASON_HOME_TLS if purpose == "home" else REASON_PAGE_ERROR
    if purpose == "home" and resp is not None:
        answered = home_answer_reason(resp)
        if answered:
            return answered
    if resp is not None and (resp.error or resp.status is None):
        return REASON_PAGE_ERROR
    return REASON_HOME_MISSING


# The home answered, but not with a page that can be read:
# the reason says what it answered, never "no respondió".
REASON_HOME_STATUS = "la página principal respondió con un error {status}"
REASON_HOME_LOOP = "la página principal entra en un círculo de redirecciones"
REASON_HOME_UNREADABLE = "la página principal llegó en un formato que no se pudo leer"


def home_answer_reason(resp: "Response | None") -> str | None:
    """What the home answered when it answered something unusable, or None (it did not answer, or it is fine)."""
    if resp is None or resp.skipped or resp.challenge:
        return None
    if getattr(resp, "hops_exceeded", False):
        return REASON_HOME_LOOP
    if resp.error:
        return None
    if resp.status is not None and resp.status >= 400:
        return REASON_HOME_STATUS.format(status=resp.status)
    if getattr(resp, "undecodable_encoding", None):
        return REASON_HOME_UNREADABLE
    return None


def fetch_reason(obs: "Observations", purpose: str, resp: "Response | None", default: str) -> str:
    """Like unavailable_reason, for something other than the home: ``default`` replaces
    the generic "la página principal no respondió" fallback (which would read wrong
    for robots.txt, a sitemap or the og:image)."""
    if obs.home_unreachable or obs.home is None:
        return unavailable_reason(obs, "home", home_response(obs))
    reason = unavailable_reason(obs, purpose, resp)
    if reason in (REASON_HOME_MISSING, REASON_PAGE_ERROR):
        return default
    return reason


def written(ctx: "EvalContext", name: str | None) -> bool:
    """True when the evidence file ``name`` was written in this run."""
    return bool(name) and bool(ctx.artifacts_written.get(name, False))


def optional_evidence(ctx: "EvalContext", *names: str | None) -> list[str]:
    """Supporting evidence names that were actually written (primary evidence is listed
    unconditionally by the caller, so the gate still catches a missing primary file)."""
    return [n for n in names if n and written(ctx, n)]


# ---------------------------------------------------------------------------
# Shared readers (pure helpers over Observations and EvalContext)
# ---------------------------------------------------------------------------


def home_response(obs: "Observations") -> "Response | None":
    """Home load 1, or None."""
    return obs.home.response if obs.home is not None else None


def page_evidence(pf: "PageFetch | None", default: str) -> str:
    """Evidence name of a page body (the collector's name when it set one)."""
    return (pf.body_artifact if pf is not None and pf.body_artifact else None) or default


def headers_evidence(pf: "PageFetch | None", default: str) -> str:
    """Evidence name of a page's headers (the collector's name when it set one)."""
    return (pf.headers_artifact if pf is not None and pf.headers_artifact else None) or default


def home_missing_finding(spec: CheckSpec, obs: "Observations") -> Finding:
    """The NO_VERIFICADO for a check that needs the home HTML and does not have it."""
    return not_verified(spec, unavailable_reason(obs, "home", home_response(obs)))


def psi_unavailable_reason(obs: "Observations") -> str:
    """Spanish reason why PageSpeed gave nothing usable (series status, then the runs' errors)."""
    psi = obs.psi
    if psi is None:
        return REASON_PSI_ERROR
    by_status = {
        "sin-clave-cuota": REASON_PSI_NO_KEY_QUOTA,
        "clave-rechazada": REASON_PSI_NO_KEY_QUOTA,  # plain for the client; the note says why
        "cuota": REASON_PSI_QUOTA,
        "error": REASON_PSI_ERROR,
    }
    if psi.status in by_status:
        return by_status[psi.status]
    for run in psi.mobile:
        err = run.error or ""
        if err.startswith("runtime-error"):
            code = run.runtime_error or err.split(":", 1)[-1] or "error"
            return REASON_PSI_RUNTIME.format(code=code)
        if err == "outside-domain":
            return REASON_PSI_OUTSIDE
        if err in ("http-429", "skipped-quota"):
            return REASON_PSI_QUOTA if obs.key_present or psi.key_present else REASON_PSI_NO_KEY_QUOTA
    if psi.status != "ok" and psi.reason:
        return psi.reason
    return REASON_PSI_ERROR


def psi_internal_note(obs: "Observations") -> str | None:
    """The note for the operator (datos.json nota_interna) of a PageSpeed grey, or None."""
    psi = obs.psi
    if psi is None:
        return None
    if psi.status == "clave-rechazada":
        from ..psi import KEY_REJECTED_NOTE

        return KEY_REJECTED_NOTE
    if psi.status == "sin-clave-cuota" or (
        psi.status != "ok" and not (obs.key_present or psi.key_present) and any(r.error in ("http-429", "skipped-quota") for r in psi.mobile)
    ):
        return PSI_NO_KEY_NOTE
    return None


def psi_median_run(obs: "Observations") -> "PsiRun | None":
    """The median valid mobile run when PSI answered, else None."""
    psi = obs.psi
    if psi is None or psi.status != "ok":
        return None
    if psi.median_run is not None and psi.median_run.ok:
        return psi.median_run
    valid = psi.valid_mobile
    return valid[0] if valid else None


def psi_evidence(run: "PsiRun | None") -> list[str]:
    """Evidence name of one PSI run."""
    if run is None:
        return []
    from ..artifacts import PSI_DESKTOP, PSI_MOBILE

    if run.artifact:
        return [run.artifact]
    return [PSI_DESKTOP if run.strategy.upper() == "DESKTOP" else PSI_MOBILE.format(n=run.n)]


def link_status_map(obs: "Observations") -> dict[str, "LinkProbe"]:
    """VIS-09 probes indexed by domains.compare_key of the URL they checked."""
    from .. import domains

    out: dict[str, LinkProbe] = {}
    for probe in obs.links.probes:
        try:
            out.setdefault(domains.compare_key(probe.url), probe)
        except ValueError:
            continue
    return out


def run_throttled(obs: "Observations | None") -> bool:
    """True when the site asked to slow down in this run or the host was cut."""
    if obs is None:
        return False
    if getattr(obs, "blocked", False):
        return True
    from ..challenge import Rule

    return any(getattr(e, "rule", None) == Rule.THROTTLE for e in (getattr(obs, "challenge_events", None) or []))


def throttle_reason(obs: "Observations") -> str:
    """Why a 5xx of a throttled run is grey: the cut (anti-bot or throttle), or the request to slow down."""
    return blocked_reason(obs) if getattr(obs, "blocked", False) else REASON_THROTTLE


def probe_verified(probe: "LinkProbe", obs: "Observations | None" = None) -> bool:
    """A link probe that got a final status (not challenged, not errored, not skipped).

    With ``obs``: a 5xx or 429 answer in a run the site throttled or cut is not
    verified either. A WAF that answers 503
    while it slows the tool down says nothing about the page behind it.
    """
    if probe.final_status is None or probe.challenged or probe.error:
        return False
    if obs is not None and (probe.final_status >= 500 or probe.final_status == 429) and run_throttled(obs):
        return False
    return True


def wordpress_fingerprint(page: "PageFacts", obs: "Observations") -> bool:
    """True when the home shows WordPress: generator, /wp-content/ or /wp-includes/ assets, or the feed generator."""
    if any(g.lower().startswith("wordpress") for g in page.generator):
        return True
    urls = page.script_srcs + page.stylesheet_hrefs + [i.src or "" for i in page.images]
    if any("/wp-content/" in u.lower() or "/wp-includes/" in u.lower() for u in urls):
        return True
    feed = getattr(obs, "feed", None)
    if feed is not None and feed.doc is not None and "wordpress.org" in (feed.doc.generator or "").lower():
        return True
    return False


def on_platform(obs: "Observations", ctx: "EvalContext", *, wordpress: str, other: str) -> str:
    """The WordPress wording of an action only when the home was fingerprinted as WordPress.

    An owner on Wix, Tiendanube or a hand-made site must not read "el plugin de
    SEO", "el tema hijo" or "la biblioteca de medios"; ``other`` names the place
    in neutral words ("la configuración del sitio", "el editor del sitio").
    """
    page = ctx.pages.get("home") if ctx.pages else None
    return wordpress if page is not None and wordpress_fingerprint(page, obs) else other


def plural(n: int, singular: str, plural_form: str) -> str:
    """Choose a whole sentence by count (never assemble words)."""
    return singular if n == 1 else plural_form


def spec_of(check_id: str) -> CheckSpec:
    """The registry entry of ``check_id`` (imported late: the registry imports this package)."""
    from .. import registry

    return registry.get(check_id)


def seconds_vs_threshold(ms: float, threshold_ms: float, decimals: int = 1) -> str:
    """Seconds near a threshold, ONE rule.

    One decimal, like PageSpeed ("4,8", "2,5", "0,3"). When that figure would
    read as the threshold while the value is above it, two decimals,
    always two: half up ("2,54", "2,55"), and rounded up only when half up
    still reads the threshold (2501 to 2514 ms all read "2,51"; 801 ms reads
    "0,81"). A value at or under the threshold keeps one decimal: "2,5" next to
    "bien hasta 2,5" is on the good side, as Google counts the border.
    ``decimals`` is the normal precision (1 for every caller today).
    """
    from .. import fmt

    value, limit = ms / 1000.0, threshold_ms / 1000.0
    first = fmt.decimal_es(value, decimals)
    if ms <= threshold_ms or first != fmt.decimal_es(limit, decimals):
        return first
    second = fmt.decimal_es(value, decimals + 1)
    if second != fmt.decimal_es(limit, decimals + 1):
        return second
    return fmt.decimal_es_up(value, decimals + 1)


UNDER_A_TENTH = "menos de una décima de segundo"


def seconds_phrase(ms: float, threshold_ms: float) -> str:
    """A time with its unit: "0,3 segundos", "2,51 segundos", or "menos de una décima de
    segundo" when one decimal would print "0,0 segundos"."""
    from .. import fmt

    if fmt.decimal_es(ms / 1000.0, 1) == "0,0":
        return UNDER_A_TENTH
    return f"{seconds_vs_threshold(ms, threshold_ms)} segundos"


def cls_vs_threshold(cls: float, threshold: float = 0.10) -> str:
    """CLS with two decimals; three when a value above the threshold would read "0,10"."""
    from .. import fmt

    text = fmt.cls_es(cls)
    if round(cls, 4) > threshold and text == fmt.cls_es(threshold):
        text = fmt.decimal_es(cls, 3)
        if text == fmt.decimal_es(threshold, 3):
            text = fmt.decimal_es_up(cls, 3)
    return text


def weight_vs_threshold(total_bytes: int, threshold_bytes: int) -> tuple[str, str, bool]:
    """(figure with unit, limit with the same unit, the one-decimal figure reads above the limit).

    Pages are shown in MB with one decimal, like the limit "1,6 MB" (1,600 KiB).
    A page above the limit whose one-decimal figure still reads "1,6" gets two
    decimals ("1,62 MB"); one between 1,600 KiB and 1,6 MB is shown in KB next
    to the limit in KB, so the figure never reads at or below the limit.
    The third value says whether the one-decimal figure, the short form a
    sentence would print, reads above the limit.

    KB are rounded half up, like PageSpeed web ("1,611 KiB" for
    1,650,000 bytes reads "1611 KB"), and rounded up only when half up would
    read the limit itself (1,638,401 bytes reads "1601 KB", never "1600 KB"):
    the same structure as seconds_vs_threshold.
    """
    from decimal import Decimal

    from .. import fmt

    one = fmt.bytes_to_mb(total_bytes)
    limit_mb = fmt.bytes_to_mb(threshold_bytes)
    above_one = total_bytes > threshold_bytes and Decimal(one.replace(".", "").replace(",", ".")) > Decimal(limit_mb.replace(",", "."))
    if total_bytes <= threshold_bytes or above_one:
        return f"{one} MB", f"{limit_mb} MB", above_one
    two = fmt.bytes_to_mb(total_bytes, 2)
    if Decimal(two.replace(",", ".")) > Decimal(limit_mb.replace(",", ".")):
        return f"{two} MB", f"{limit_mb} MB", False
    limit_kb = fmt.bytes_to_kb(threshold_bytes)
    kb = fmt.bytes_to_kb(total_bytes)
    if kb == limit_kb:
        kb = fmt.decimal_es_up(total_bytes / 1024, 0)
    return f"{kb} KB", f"{limit_kb} KB", False
