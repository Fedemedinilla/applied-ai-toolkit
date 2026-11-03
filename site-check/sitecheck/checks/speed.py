"""Speed checks: EXT-08, EXT-21, EXT-20, EXT-18, EXT-19 (speed module: FALLA is Amarillo).

Thresholds: the boundary counts as GOOD, like Google, so the number
matches what the site owner sees in PageSpeed web: LCP <= 2500 ms, INP <= 200 ms,
CLS <= 0.10, TTFB <= 800 ms are good.

A speed FALLA is always Amarillo (registry flag ``speed``): a slow site is
worth fixing, never an emergency. Lab numbers and real-user (field) numbers are
kept apart: a field LCP from Chrome UX Report wins over the Lighthouse lab
median, and a lab-only result says so in the report.
"""

from __future__ import annotations

import re
import statistics
from typing import TYPE_CHECKING, Any

from .. import artifacts, fmt
from ..model import ColourException, ReportPhrase, State
from . import common
from .common import new_finding, not_verified

if TYPE_CHECKING:
    from ..httpclient import Response
    from ..model import EvalContext, Finding
    from ..observations import Observations
    from ..psi import AuditResult, PsiRun

LCP_GOOD_MS = 2500
INP_GOOD_MS = 200
CLS_GOOD = 0.10
TTFB_GOOD_MS = 800
PAGE_WEIGHT_GOOD_BYTES = 1_638_400  # 1,600 KiB (Chrome for Developers, "Avoid enormous network payloads")
LIGHTHOUSE_HUGE_BYTES = 5_120_000  # 5,000 KiB: noted in the evidence, state unchanged
IMAGE_CLAUSE_MIN_BYTES = 104_858  # 0,1 MB: below this the EXT-21 report sentence does not name the images
COMPRESSIONS: frozenset[str] = frozenset({"gzip", "br", "zstd", "deflate"})
CACHE_HEADERS: tuple[str, ...] = (
    "x-litespeed-cache",
    "cf-cache-status",
    "x-cache",
    "x-cache-status",
    "x-proxy-cache",
)
CACHE_PLUGIN_SIGNATURES: tuple[str, ...] = (
    "Page cached by LiteSpeed Cache",
    "WP Rocket",
    "WP-Super-Cache",
    "W3 Total Cache",
    "WP Fastest Cache",
    "Cache served by breeze",
)

LAB_NOTE = "prueba de laboratorio; Google no tiene datos de usuarios reales de este sitio"
REASON_PSI_FEW_RUNS = "la herramienta de velocidad de Google dio menos de dos mediciones válidas"
REASON_PSI_NO_LCP = "la herramienta de velocidad de Google no informó cuánto tarda en aparecer la página"
REASON_PSI_NO_WEIGHT = "la herramienta de velocidad de Google no informó el peso de la página"
REASON_TLS_MISSING = "la conexión segura del sitio no respondió"
REASON_RELOADS_MISSING = "las cargas repetidas de la página principal no se completaron"
REASON_TTFB_FEW = "menos de dos mediciones válidas del servidor"
REASON_NO_CONTROL = "no hubo un sitio de control con qué comparar, porque el sitio medido es el de control"

# The date, never "ese día": the report may be read days later.
_GREY_PSI = "No se pudo medir el {fecha}: {motivo}; se repite aparte."


def _psi_grey(spec_id: str, reason: str, run_date, **fields: Any) -> "Finding":
    spec = common.spec_of(spec_id)
    sentence = _GREY_PSI.format(fecha=fmt.fecha_dmy(run_date), motivo=reason)
    return not_verified(spec, reason, phrase_report=ReportPhrase(found=common.grey_sentence(sentence)), **fields)


def _median_low(values: list[float]) -> float | None:
    """Median; with an even count, the lower middle (the value of a real run)."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    return vals[(len(vals) - 1) // 2]


def _audit(run: "PsiRun | None", concept: str) -> "AuditResult | None":
    if run is None:
        return None
    return (run.audits or {}).get(concept)


def _items(audit: "AuditResult | None") -> list[dict[str, Any]]:
    if audit is None or not isinstance(audit.details, dict):
        return []
    items = audit.details.get("items")
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


# ---------------------------------------------------------------------------
# EXT-08
# ---------------------------------------------------------------------------


def evaluate_ext08(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-08 · velocidad en el celular.

    WITH FIELD DATA (psi.field_data, page or origin scope, or CrUX):
      APROBADO when LCP, INP and CLS are present and good; FALLA when any is
      above its threshold; INP missing with LCP and CLS good ->
      APROBADO_CON_OBSERVACION ("sin datos de interacción").
    WITHOUT FIELD DATA (median of valid lab runs):
      lab LCP <= 2500 and lab CLS <= 0.10 -> APROBADO_CON_OBSERVACION with
      colour_exception LAB_ONLY_PASS and note
      "prueba de laboratorio; Google no tiene datos de usuarios reales de este
      sitio"; otherwise FALLA.
    NO_VERIFICADO (never a plausible number): PSI status not ok (no key and 429,
    429, 5xx/timeout after the retry, runtimeError, final URL outside D), or
    fewer than 2 valid runs and no field data. Reasons from checks.common.
    measured keys (read by checks/tables.py): lcp_ms, inp_ms, cls, scope
    ("pagina" | "origen" | "laboratorio"), field_source, lab_lcp_ms_median,
    lab_cls_median, valid_runs, runs, lighthouse_version.
    Evidence: psi-mobile-<n>.json (and crux.json when used).
    """
    spec = common.spec_of("EXT-08")
    psi = obs.psi
    fd = (psi.field_data if psi is not None else None) or obs.crux_field
    has_field = fd is not None and (fd.lcp_ms is not None or fd.cls is not None)
    # Real-user data does not depend on the lab load: a WAF that blocks
    # Lighthouse leaves the lab runs invalid but Google's field data stands.
    # Only the lab branch depends on psi.status.
    if (psi is None or psi.status != "ok") and not has_field:
        return _psi_grey("EXT-08", common.psi_unavailable_reason(obs), ctx.run_date, internal_note=common.psi_internal_note(obs))
    valid = psi.valid_mobile if psi is not None and psi.status == "ok" else []
    lab_lcp = psi.lab_lcp_ms_median if psi is not None and psi.lab_lcp_ms_median is not None else _median_low([r.lab_lcp_ms for r in valid])
    lab_cls = psi.lab_cls_median if psi is not None and psi.lab_cls_median is not None else _median_low([r.lab_cls for r in valid])
    lh_version = next((r.lighthouse_version for r in valid if r.lighthouse_version), None)
    measured: dict[str, Any] = {
        "runs": len(psi.mobile) if psi is not None else 0,
        "valid_runs": len(valid),
        "lighthouse_version": lh_version,
        "lab_lcp_ms_median": round(lab_lcp) if lab_lcp is not None else None,
        "lab_cls_median": round(lab_cls, 4) if lab_cls is not None else None,
        "lcp_ms": None,
        "inp_ms": None,
        "cls": None,
        "scope": None,
        "field_source": None,
    }
    evidence: list[str] = []
    for run in valid:
        evidence += common.psi_evidence(run)

    if has_field:
        scope = "origen" if (fd.origin_fallback or fd.scope == "origen") else "pagina"
        lcp, inp, cls = fd.lcp_ms, fd.inp_ms, fd.cls
        measured.update(lcp_ms=lcp, inp_ms=inp, cls=round(cls, 4) if cls is not None else None, scope=scope, field_source=fd.source)
        if fd.source == "crux":
            evidence.append(artifacts.CRUX)
        else:
            run = getattr(psi, "field_run", None) or (psi.mobile[0] if psi is not None and psi.mobile else None)
            if run is not None and run.artifact and run.artifact not in evidence:
                evidence.insert(0, run.artifact)
        lcp_bad = lcp is not None and lcp > LCP_GOOD_MS
        inp_bad = inp is not None and inp > INP_GOOD_MS
        cls_bad = cls is not None and round(cls, 4) > CLS_GOOD
        if lcp_bad or inp_bad or cls_bad:
            return _ext08_failure(spec, measured, evidence, lcp, inp, cls, lcp_bad, inp_bad, lab=False)
        if lcp is not None and cls is not None and inp is not None:
            lcp_s = common.seconds_phrase(lcp, LCP_GOOD_MS)
            return new_finding(
                spec,
                State.APROBADO,
                measured=measured,
                evidence=evidence,
                phrase_report=ReportPhrase(
                    found=f"En celular, lo principal de la página aparece en {lcp_s} para quienes visitan el sitio; Google considera bien hasta 2,5 segundos",
                    consequence="Quien entra desde el celular no espera de más",
                ),
            )
        if lcp is not None and cls is not None:
            lcp_s = common.seconds_phrase(lcp, LCP_GOOD_MS)
            return new_finding(
                spec,
                State.APROBADO_CON_OBSERVACION,
                measured=measured,
                evidence=evidence,
                reason="sin datos de interacción",
                phrase_report=ReportPhrase(
                    found=f"En celular, lo principal de la página aparece en {lcp_s}, pero Google no tiene datos de cuánto tarda en responder cuando se toca algo",
                    consequence="Sin ese dato no se sabe si la página responde rápido cuando se la toca",
                    action="Volver a medir cuando Google tenga datos de uso",
                    who="Quien mantiene el sitio",
                ),
            )
        # Field data with LCP or CLS missing and nothing failing: incomplete, not a pass.
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence,
            reason="Google no tiene todas las medidas de usuarios reales",
            phrase_report=ReportPhrase(
                found="Google tiene solo una parte de las medidas de velocidad de quienes visitan el sitio, y las que tiene están bien",
                consequence="Sin las medidas que faltan no se puede dar la velocidad por buena",
                action="Volver a medir cuando Google tenga datos de uso",
                who="Quien mantiene el sitio",
            ),
        )

    # Lab only. Two valid runs, or one when only one was asked for.
    required = max(1, min(2, len(psi.mobile)))
    if len(valid) < required:
        return _psi_grey("EXT-08", REASON_PSI_FEW_RUNS, ctx.run_date, measured=measured)
    if lab_lcp is None or lab_cls is None:
        return _psi_grey("EXT-08", REASON_PSI_NO_LCP, ctx.run_date, measured=measured)
    measured.update(lcp_ms=round(lab_lcp), cls=round(lab_cls, 4), scope="laboratorio", field_source=None)
    lcp_bad = lab_lcp > LCP_GOOD_MS
    cls_bad = round(lab_cls, 4) > CLS_GOOD
    if lcp_bad or cls_bad:
        return _ext08_failure(spec, measured, evidence, lab_lcp, None, lab_cls, lcp_bad, False, lab=True)
    lcp_s = common.seconds_phrase(lab_lcp, LCP_GOOD_MS)
    return new_finding(
        spec,
        State.APROBADO_CON_OBSERVACION,
        measured=measured,
        evidence=evidence,
        reason=LAB_NOTE,
        note=LAB_NOTE,
        colour_exception=ColourException.LAB_ONLY_PASS,
        phrase_report=ReportPhrase(
            found=f"En celular, lo principal de la página aparece en {lcp_s} en una prueba de laboratorio de Google",
            consequence="Google considera bien hasta 2,5 segundos; quien entra desde el celular no espera de más",
        ),
    )


def _ext08_failure(spec, measured, evidence, lcp, inp, cls, lcp_bad, inp_bad, *, lab: bool) -> "Finding":
    """The EXT-08 FALLA; the trace says which measured value the sentence prints."""
    consequence = "Quien entra desde el celular espera más de lo que Google considera aceptable en cada visita."
    action = "Plan de velocidad: imágenes, caché y lo que carga primero."
    who = "Quien mantiene el sitio, con acceso al panel."
    note = LAB_NOTE if lab else None
    if lcp_bad:
        lcp_s = common.seconds_phrase(lcp, LCP_GOOD_MS)
        found = f"En celular, lo principal de la página tarda {lcp_s} en aparecer; Google considera bien hasta 2,5 segundos."
        trace = {"{lcp_s}": "checks[EXT-08].measured." + ("lab_lcp_ms_median" if lab else "lcp_ms")}
    elif inp_bad:
        inp_s = common.seconds_phrase(inp, INP_GOOD_MS)  # one rule for every time
        found = f"En celular, la página tarda {inp_s} en responder cuando se toca algo; Google considera bien hasta 0,2 segundos."
        consequence = "Quien usa el sitio desde el celular siente que la página se traba al tocarla."
        trace = {"{inp_s}": "checks[EXT-08].measured.inp_ms"}
    else:
        found = f"En celular, la página se mueve mientras carga ({common.cls_vs_threshold(cls, CLS_GOOD)}); Google considera bien hasta 0,1."
        consequence = "Quien entra desde el celular puede tocar lo que no quería porque la página se corre."
        trace = {"{cls}": "checks[EXT-08].measured." + ("lab_cls_median" if lab else "cls")}
    return new_finding(
        spec,
        State.FALLA,
        measured=measured,
        evidence=evidence,
        note=note,
        trace=trace,
        phrase_report=ReportPhrase(found=found, consequence=consequence, action=action, who=who),
    )


# ---------------------------------------------------------------------------
# EXT-21
# ---------------------------------------------------------------------------


def _entity_name(value: Any) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        text = value.get("text") or value.get("name")
        return str(text).strip() if text else None
    return None


def evaluate_ext21(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-21 · peso de la página y parte de terceros.

    From the median mobile run: total-byte-weight; resource-summary items (or
    network-requests aggregated by resourceType when absent); third-parties
    insight (entities and sizes); image-delivery insight savings (raw). Direct:
    home load 1 raw and decoded bytes, counts of <img>, <script src>, <style>.
    APROBADO when total <= PAGE_WEIGHT_GOOD_BYTES; FALLA above; > 5,000 KiB is
    noted in evidence only. No PSI result -> NO_VERIFICADO.
    measured keys: total_bytes, image_bytes, third_party_bytes, third_party_top
    (list of entity names), html_raw_bytes, html_decoded_bytes, n_img,
    n_script_src, n_style.
    """
    spec = common.spec_of("EXT-21")
    run = common.psi_median_run(obs)
    if run is None:
        return _psi_grey("EXT-21", common.psi_unavailable_reason(obs), ctx.run_date, internal_note=common.psi_internal_note(obs))

    total = _num(_audit(run, "total_byte_weight").numeric_value) if _audit(run, "total_byte_weight") else None
    image_bytes: float | None = None
    third_bytes: float | None = None
    rs_items = _items(_audit(run, "resource_summary"))
    if rs_items:
        by_type = {str(i.get("resourceType", "")).lower(): _num(i.get("transferSize")) for i in rs_items}
        image_bytes = by_type.get("image")
        third_bytes = by_type.get("third-party")
        if total is None:
            total = by_type.get("total")
    else:
        nr_items = _items(_audit(run, "network_requests"))
        if nr_items:
            sizes = [(_num(i.get("transferSize")) or 0.0, str(i.get("resourceType", "")).lower()) for i in nr_items]
            image_bytes = sum(s for s, t in sizes if t == "image")
            if total is None:
                total = sum(s for s, _ in sizes)

    entities: list[tuple[str, float]] = []
    for item in _items(_audit(run, "third_parties")):
        name = _entity_name(item.get("entity"))
        size = _num(item.get("transferSize"))
        if name and size is not None:
            entities.append((name, size))
    entities.sort(key=lambda e: -e[1])
    if third_bytes is None and entities:
        third_bytes = sum(s for _, s in entities)
    image_savings = None
    img_items = _items(_audit(run, "image_delivery"))
    if img_items:
        image_savings = sum(_num(i.get("wastedBytes")) or 0.0 for i in img_items)

    page = ctx.pages.get("home")
    home = common.home_response(obs)
    measured: dict[str, Any] = {
        "total_bytes": int(total) if total is not None else None,
        "image_bytes": int(image_bytes) if image_bytes is not None else None,
        "third_party_bytes": int(third_bytes) if third_bytes is not None else None,
        "third_party_top": [fmt.sanitize_site_text(n, 60) for n, _ in entities[:3]],
        "image_savings_bytes": int(image_savings) if image_savings is not None else None,
        "html_raw_bytes": home.raw_length if home is not None and home.status else None,
        "html_decoded_bytes": (home.decoded_length or len(home.body)) if home is not None and home.status else None,
        "n_img": sum(1 for i in page.images if not i.in_noscript) if page else None,
        "n_script_src": len(page.script_srcs) if page else None,
        "n_style": page.n_style_blocks if page else None,
        "lighthouse_huge": bool(total is not None and total > LIGHTHOUSE_HUGE_BYTES),
    }
    evidence = common.psi_evidence(run)
    if total is None:
        return _psi_grey("EXT-21", REASON_PSI_NO_WEIGHT, ctx.run_date, measured=measured)

    peso_mb = fmt.bytes_to_mb(int(total))
    peso_text, limit_text, reads_above = common.weight_vs_threshold(int(total), PAGE_WEIGHT_GOOD_BYTES)
    if total <= PAGE_WEIGHT_GOOD_BYTES:
        return new_finding(
            spec,
            State.APROBADO,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=f"La página principal pesa {peso_mb} MB, dentro de lo que Google aconseja",
                consequence="Carga liviana también con datos móviles",
            ),
        )

    with_images = image_bytes is not None and image_bytes >= IMAGE_CLAUSE_MIN_BYTES
    img_mb = fmt.bytes_to_mb(int(image_bytes)) if with_images else None
    names = ", ".join(measured["third_party_top"])
    if not reads_above:
        # The one-decimal figure reads "1,6", the limit itself: report only, with
        # the decimals (or the unit) that show it is above.
        found = f"La página principal pesa {peso_text}; Google aconseja no pasar de {limit_text}"
    elif with_images and third_bytes and names:
        found = (
            f"La página principal pesa {peso_mb} MB: {img_mb} MB son imágenes y "
            f"{fmt.bytes_to_mb(int(third_bytes))} MB llegan de servicios externos ({names})"
        )
    elif with_images:
        found = f"La página principal pesa {peso_mb} MB: {img_mb} MB son imágenes"
    elif third_bytes and names:
        found = f"La página principal pesa {peso_mb} MB: {fmt.bytes_to_mb(int(third_bytes))} MB llegan de servicios externos ({names})"
    else:
        found = f"La página principal pesa {peso_mb} MB; Google aconseja no pasar de 1,6 MB"
    trace = {"{peso_mb}": "checks[EXT-21].measured.total_bytes"}
    if with_images:
        trace["{img_mb}"] = "checks[EXT-21].measured.image_bytes"
    if third_bytes and names and reads_above:
        trace["{terceros_mb}"] = "checks[EXT-21].measured.third_party_bytes"
    return new_finding(
        spec,
        State.FALLA,
        measured=measured,
        evidence=evidence,
        trace=trace,
        phrase_report=ReportPhrase(
            found=found,
            consequence="Cada visita desde un celular con datos móviles descarga todo eso antes de poder usar la página",
            # No slider is assumed: it is never measured.
            action="Achicar y convertir las imágenes y revisar lo que se carga de afuera",
            who="Quien mantiene el sitio",
        ),
    )


# ---------------------------------------------------------------------------
# EXT-20
# ---------------------------------------------------------------------------


def _valid_samples(samples) -> list[float]:
    out = []
    for s in samples:
        if s.ttfb_ms is None or s.challenged or s.error or s.status is None:
            continue
        if not (200 <= s.status < 400):
            continue
        out.append(float(s.ttfb_ms))
    return out


def evaluate_ext20(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-20 · tiempo de respuesta del servidor.

    Median of the valid site samples (challenged or errored ones discarded):
    <= 800 ms APROBADO, > 800 ms FALLA. NO_VERIFICADO when fewer than 2 valid
    site samples, or the control median is > 800 ms or the control failed
    (REASON_CONTROL_SLOW: the instrument failed, not the site).
    measured keys: ttfb_ms_median, control_ms_median, site_samples,
    control_samples. Evidence: ttfb.json.

    When the measured site is the control site (a self-check), no control was
    taken. Up to 800 ms is APROBADO (a slow
    connection cannot make a reading fast); above it is NO_VERIFICADO with
    REASON_NO_CONTROL, because the instrument cannot be told apart from the site.
    """
    spec = common.spec_of("EXT-20")
    site = _valid_samples(obs.ttfb.site)
    control = _valid_samples(obs.ttfb.control)
    site_median = statistics.median(site) if site else None
    control_median = statistics.median(control) if control else None
    measured: dict[str, Any] = {
        "ttfb_ms_median": round(site_median) if site_median is not None else None,
        "control_ms_median": round(control_median) if control_median is not None else None,
        "site_samples": [round(v) for v in site],
        "control_samples": [round(v) for v in control],
    }
    if len(site) < 2:
        challenged = any(s.challenged for s in obs.ttfb.site)
        reason = common.blocked_reason(obs) if (challenged or obs.blocked) else common.unavailable_reason(obs, "home-reload")
        if reason == common.REASON_HOME_MISSING:
            reason = REASON_TTFB_FEW
        return not_verified(spec, reason, measured=measured)
    no_control = bool(getattr(obs.ttfb, "control_is_site", False))
    if no_control:
        # The self-check: the site is the control site, so there is no
        # independent control. A fast reading cannot come from a slow connection and
        # stays green; a slow one cannot be told apart from the connection.
        measured["control"] = "no aplica: el sitio medido es el de control"
        if site_median > TTFB_GOOD_MS:
            return not_verified(spec, REASON_NO_CONTROL, measured=measured)
    elif len(control) < 2 or control_median is None or control_median > TTFB_GOOD_MS:
        return not_verified(spec, common.REASON_CONTROL_SLOW, measured=measured)
    evidence = [artifacts.TTFB]
    ttfb_s = common.seconds_phrase(site_median, TTFB_GOOD_MS)  # never "0,0 segundos"
    if site_median <= TTFB_GOOD_MS:
        return new_finding(
            spec,
            State.APROBADO,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found=f"El servidor empieza a responder en {ttfb_s}",
                consequence="La página arranca rápido aunque la red sea lenta",
            ),
        )
    if len(site) == 3:
        found = f"El servidor tarda {ttfb_s} en empezar a responder (mediana de tres mediciones)"
    elif len(site) == 2:
        found = f"El servidor tarda {ttfb_s} en empezar a responder (mediana de dos mediciones)"
    else:
        found = f"El servidor tarda {ttfb_s} en empezar a responder (mediana de {len(site)} mediciones)"
    return new_finding(
        spec,
        State.FALLA,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found=found,
            consequence="Carga lenta en celulares, y el sitio sufre con picos de visitas",
            action="Activar caché y revisar el hosting",
            who="Quien mantiene el sitio",
        ),
    )


# ---------------------------------------------------------------------------
# EXT-18
# ---------------------------------------------------------------------------


def _canonical_tls(obs: "Observations"):
    if not obs.tls:
        return None
    for t in obs.tls:
        if obs.canonical_host and t.host == obs.canonical_host:
            return t
    return obs.tls[0]


def _alt_svc_h3(resp: "Response") -> bool:
    for value in resp.header_all("Alt-Svc"):
        for part in value.split(","):
            token = part.strip().split("=", 1)[0].strip().lower()
            if token.startswith("h3"):
                return True
    return False


def evaluate_ext18(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-18 · protocolos rápidos.

    HTTP/2 from the TLS ALPN of the canonical host (selected "h2"); HTTP/3 only
    "anunciado" from an Alt-Svc header containing a token starting with "h3";
    compression from home load 1 Content-Encoding (raw vs decoded size; "br"
    recorded even if not offered). APROBADO when (h2 or h3 announced) and the
    encoding is in COMPRESSIONS; FALLA otherwise; NO_VERIFICADO when the
    handshake or load 1 failed or was challenged.
    measured keys: alpn, h3_announced, content_encoding, raw_bytes, decoded_bytes.
    """
    spec = common.spec_of("EXT-18")
    home = common.home_response(obs)
    if home is None or not home.usable or home.status != 200:
        return not_verified(spec, common.unavailable_reason(obs, "home", home))
    tls = _canonical_tls(obs)
    if tls is None or not tls.alpn:
        reason = REASON_TLS_MISSING
        if tls is not None and (tls.error or "").startswith("skipped"):
            reason = common.REASON_BUDGET if "budget" in (tls.error or "") else common.blocked_reason(obs)
        return not_verified(spec, reason)
    encoding = (home.content_encoding or home.header("Content-Encoding") or "").strip().lower()
    tokens = [t.strip() for t in encoding.split(",") if t.strip()]
    compressed = any(t in COMPRESSIONS for t in tokens)
    h2 = tls.alpn == "h2"
    h3 = _alt_svc_h3(home)
    raw_b = home.raw_length or 0
    dec_b = home.decoded_length or len(home.body)
    measured = {
        "alpn": tls.alpn,
        "h3_announced": h3,
        "content_encoding": encoding or None,
        "raw_bytes": raw_b,
        "decoded_bytes": dec_b,
    }
    evidence = [artifacts.TLS, common.headers_evidence(obs.home, artifacts.HOME_HEADERS)]
    if (h2 or h3) and compressed:
        trace: dict[str, str] = {}
        if raw_b and dec_b and raw_b < dec_b:
            found = (
                f"La página principal viaja comprimida ({fmt.bytes_to_kb(dec_b)} KB → {fmt.bytes_to_kb(raw_b)} KB) "
                "y por el protocolo moderno"
            )
            trace = {"{kb_antes}": "checks[EXT-18].measured.decoded_bytes", "{kb_despues}": "checks[EXT-18].measured.raw_bytes"}
        else:
            found = "La página principal viaja comprimida y por el protocolo moderno"
        return new_finding(
            spec,
            State.APROBADO,
            measured=measured,
            evidence=evidence,
            trace=trace,
            phrase_report=ReportPhrase(found=found, consequence="Carga menos datos de los que pesa"),
        )
    if not (h2 or h3) and not compressed:
        found = "El servidor no usa el protocolo moderno y no comprime la página"
    elif not (h2 or h3):
        found = "El servidor no usa el protocolo moderno"
    else:
        found = "El servidor no comprime la página"
    return new_finding(
        spec,
        State.FALLA,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found=found,
            consequence="Cada visita descarga más datos y tarda más de lo necesario",
            action="Activarlo en el hosting o poner un servicio de distribución delante",
            who="Quien administra el hosting",
        ),
    )


# ---------------------------------------------------------------------------
# EXT-19
# ---------------------------------------------------------------------------

_MAX_AGE_RE = re.compile(r"(?:^|[,\s])(s-maxage|max-age)\s*=\s*\"?(\d+)", re.IGNORECASE)


def _cache_evidence(resp: "Response") -> list[str]:
    """The headers of one reload that show a cache at work ("name: value"); empty when none."""
    found = []
    for name in CACHE_HEADERS:
        for value in resp.header_all(name):
            if "hit" in value.lower():
                found.append(f"{name}: {value.strip()}")
    for value in resp.header_all("Age"):
        try:
            if int(value.strip()) > 0:
                found.append(f"age: {value.strip()}")
        except ValueError:
            continue
    for value in resp.header_all("Cache-Control"):
        low = value.lower()
        if "no-store" in low or "private" in low:
            continue
        if any(int(m.group(2)) > 0 for m in _MAX_AGE_RE.finditer(low)):
            found.append(f"cache-control: {value.strip()}")
    return found


def evaluate_ext19(obs: "Observations", ctx: "EvalContext") -> "Finding":
    """EXT-19 · caché o CDN.

    Loads 2 and 3 of the home: APROBADO when a CACHE_HEADERS value contains "hit"
    (case-insensitive), or Age > 0, or Cache-Control max-age/s-maxage > 0 without
    no-store or private. APROBADO_CON_OBSERVACION (Azul, Media) when the only
    evidence is a CACHE_PLUGIN_SIGNATURES comment in the load 1 HTML. FALLA when
    there is nothing. NO_VERIFICADO when loads 2 and 3 are missing or challenged.
    Evidence: headers-home-2.txt, headers-home-3.txt, home.html.
    """
    spec = common.spec_of("EXT-19")
    reloads: list[tuple[int, Response]] = []
    for i, resp in enumerate(obs.home_reloads):
        if resp is not None and resp.usable and resp.status == 200:
            reloads.append((i + 2, resp))
    if not reloads:
        last = obs.home_reloads[-1] if obs.home_reloads else None
        reason = common.unavailable_reason(obs, "home-reload", last)
        if reason == common.REASON_HOME_MISSING:
            reason = REASON_RELOADS_MISSING
        return not_verified(spec, reason)
    evidence = [artifacts.HOME_RELOAD_HEADERS.format(n=n) for n, _ in reloads]
    hits: list[str] = []
    for _, resp in reloads:
        hits += _cache_evidence(resp)
    page = ctx.pages.get("home")
    signature = None
    if page is not None:
        for comment in page.comments:
            low = comment.lower()
            for sig in CACHE_PLUGIN_SIGNATURES:
                if sig.lower() in low:
                    signature = sig
                    break
            if signature:
                break
    measured = {"cache_signals": hits, "plugin_signature": signature, "reloads": len(reloads)}
    if hits:
        return new_finding(
            spec,
            State.APROBADO,
            measured=measured,
            evidence=evidence,
            phrase_report=ReportPhrase(
                found="El sitio entrega páginas ya armadas",
                consequence="Responde rápido aunque muchas personas entren a la vez",
            ),
        )
    consequence = "Cada visita obliga al servidor a armar la página de cero; con picos de visitas se pone lento"
    if signature:
        return new_finding(
            spec,
            State.APROBADO_CON_OBSERVACION,
            measured=measured,
            evidence=evidence + [common.page_evidence(obs.home, artifacts.HOME_HTML)],
            reason="hay una herramienta de caché instalada sin señal de uso",
            phrase_report=ReportPhrase(
                found="Hay una herramienta de caché instalada, pero el servidor no confirma que la esté usando",
                consequence=consequence,
                action="Revisar su configuración",
                who="Quien mantiene el sitio",
            ),
        )
    found = (
        "El servidor no guarda páginas listas para servir: dos cargas seguidas, sin señal de caché"
        if len(reloads) >= 2
        else "El servidor no guarda páginas listas para servir: una segunda carga, sin señal de caché"
    )
    return new_finding(
        spec,
        State.FALLA,
        measured=measured,
        evidence=evidence,
        phrase_report=ReportPhrase(
            found=found,
            consequence=consequence,
            action="Activar caché de página, sin cachear los formularios",
            who="Quien mantiene el sitio",
        ),
    )
