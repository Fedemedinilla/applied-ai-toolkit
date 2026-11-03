"""PageSpeed Insights v5 client and defensive parsing of its JSON.

Facts: GET .../pagespeedonline/v5/runPagespeed with
``url``, ``strategy`` (MOBILE must be explicit: the default is DESKTOP), repeated
``category`` (PERFORMANCE, ACCESSIBILITY, BEST_PRACTICES, SEO) and ``locale=es``.
The key goes ONLY in the ``X-goog-api-key`` header. Timeout 120 s.

Run plan: ``runs`` (default 3, --psi-runs) sequential MOBILE runs,
then 1 DESKTOP run for the header scores, all BEFORE any request to the site.
Lab values: median of the valid mobile runs. Field data: from run 1.

Failure handling:
* HTTP 429: never retried. Without a key the very first 429 ends the whole PSI
  phase (the keyless quota is 0 per day); with a key too, a 429 ends the phase.
* 5xx or timeout: one retry after 30 s, then that run is invalid.
* ``lighthouseResult.runtimeError`` with a code other than NO_ERROR: invalid run
  ("PSI no pudo cargar el sitio (<code>)"), not evidence of slowness.
* finalDisplayedUrl (then finalUrl, then top-level id) outside the registrable
  domain: invalid run (PSI landed on a challenge or a parked page).

Parsing: every key read with .get; an absent audit is a missing
sub-measure, never a crash and never a guessed value. Field CLS percentile is
CLS x 100 (divide by 100; pinned by a fixture test). Lab CLS numericValue is
already a decimal. Lighthouse 13 renamed audits: AUDIT_CANDIDATES lists, per
concept, the candidate IDs newest first.

Each raw JSON is stored as evidence (psi-mobile-<n>.json, psi-desktop.json) with
the key scrubbed. Google APIs ToS 5e: raw JSON is evidence of the run, not a
database; datos.json keeps derived numbers only. The screenshots of the home
are never stored: ``strip_screenshots`` drops the
SCREENSHOT_AUDITS, ``lighthouseResult.fullPageScreenshot`` and any other
``data:image`` string before the evidence is written.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode

from . import artifacts as art
from . import domains
from .scope import Purpose

if TYPE_CHECKING:
    from collections.abc import Callable

    from .artifacts import ArtifactStore
    from .credentials import ApiKey
    from .httpclient import HttpClient, Response

STRATEGY_MOBILE = "MOBILE"
STRATEGY_DESKTOP = "DESKTOP"
CATEGORIES: tuple[str, ...] = ("PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO")
CATEGORY_KEYS: tuple[str, ...] = ("performance", "accessibility", "best-practices", "seo")
LOCALE = "es"
TIMEOUT_SECONDS = 120.0
RETRY_WAIT_SECONDS = 30.0
DEFAULT_MOBILE_RUNS = 3

FIELD_METRICS: dict[str, str] = {
    "lcp_ms": "LARGEST_CONTENTFUL_PAINT_MS",
    "inp_ms": "INTERACTION_TO_NEXT_PAINT",
    "cls_x100": "CUMULATIVE_LAYOUT_SHIFT_SCORE",
    "fcp_ms": "FIRST_CONTENTFUL_PAINT_MS",
    "ttfb_ms": "EXPERIMENTAL_TIME_TO_FIRST_BYTE",
}

# The Lighthouse major the audit IDs below were verified against (Lighthouse 13
# renamed several audits). Another major may rename audits again: the run then warns on the console
# and records the note in datos.json meta.aviso_lighthouse.
VERIFIED_LIGHTHOUSE_MAJOR = 13
LIGHTHOUSE_NOTE = (
    "PageSpeed respondió con Lighthouse {version} y los nombres de las pruebas que lee el script se verificaron "
    "con la versión {verified}: revisar psi.py (AUDIT_CANDIDATES)"
)


def lighthouse_note(version: str | None) -> str | None:
    """LIGHTHOUSE_NOTE when ``version``'s major is not VERIFIED_LIGHTHOUSE_MAJOR (or cannot be read); None without a version."""
    text = (version or "").strip()
    if not text:
        return None
    major = text.split(".", 1)[0]
    if major.isdigit() and int(major) == VERIFIED_LIGHTHOUSE_MAJOR:
        return None
    return LIGHTHOUSE_NOTE.format(version=text[:20], verified=VERIFIED_LIGHTHOUSE_MAJOR)


# Concept -> candidate audit IDs, newest first (Lighthouse 13 insights, then legacy).
AUDIT_CANDIDATES: dict[str, tuple[str, ...]] = {
    "lcp": ("largest-contentful-paint",),
    "cls": ("cumulative-layout-shift",),
    "total_byte_weight": ("total-byte-weight",),
    "resource_summary": ("resource-summary",),
    "network_requests": ("network-requests",),
    "third_parties": ("third-parties-insight", "third-party-summary"),
    "image_delivery": ("image-delivery-insight", "modern-image-formats", "uses-optimized-images"),
    "server_response_time": ("server-response-time", "document-latency-insight"),
    "color_contrast": ("color-contrast",),
    "label": ("label",),
    "target_size": ("target-size",),
    "meta_viewport": ("meta-viewport",),
    "image_alt": ("image-alt",),
    "heading_order": ("heading-order",),
    "document_title": ("document-title",),
    "meta_description": ("meta-description",),
    "is_crawlable": ("is-crawlable",),
    "robots_txt": ("robots-txt",),
    "html_has_lang": ("html-has-lang",),
    "html_lang_valid": ("html-lang-valid",),
}


@dataclass
class FieldMetrics:
    """Real-user (CrUX) p75 values, 28-day window."""

    scope: str  # "pagina" | "origen"
    source: str  # "psi" | "crux"
    lcp_ms: int | None = None
    inp_ms: int | None = None
    cls: float | None = None  # already divided by 100 when it came from PSI
    ttfb_ms: int | None = None
    categories: dict[str, str] = field(default_factory=dict)  # metric -> FAST/AVERAGE/SLOW
    origin_fallback: bool = False


@dataclass
class AuditResult:
    id: str  # the audit ID actually found
    score: float | None
    score_display_mode: str | None
    numeric_value: float | None
    failing_items: int | None  # len(details.items) when details is a table/list, else None
    details: dict[str, Any] | None = None


@dataclass
class PsiRun:
    strategy: str
    n: int  # 1-based run number within its strategy
    ok: bool
    error: str | None = None  # "http-429", "http-5xx", "timeout", "runtime-error:<code>",
    #                           "outside-domain", "invalid-json", "skipped-quota"
    http_status: int | None = None
    lighthouse_version: str | None = None
    final_url: str | None = None
    runtime_error: str | None = None
    run_warnings: list[str] = field(default_factory=list)
    captcha_result: str | None = None
    field_data: FieldMetrics | None = None
    lab_lcp_ms: float | None = None
    lab_cls: float | None = None
    scores: dict[str, int | None] = field(default_factory=dict)  # CATEGORY_KEYS -> 0..100 or None
    audits: dict[str, AuditResult | None] = field(default_factory=dict)  # concept -> result
    artifact: str | None = None  # evidence file name


@dataclass
class PsiSeries:
    """The mobile series plus the desktop run."""

    status: str  # "ok", "sin-clave-cuota", "cuota", "clave-rechazada", "error", "no-valid-runs"
    reason: str | None = None  # Spanish motivo for NO_VERIFICADO, e.g. "la cuota de Google se agotó"
    key_present: bool = False
    mobile: list[PsiRun] = field(default_factory=list)
    desktop: PsiRun | None = None
    field_data: FieldMetrics | None = None  # from mobile run 1 (or CrUX, filled by the collector)
    median_run: PsiRun | None = None  # the valid mobile run with the median lab LCP
    lab_lcp_ms_median: float | None = None
    lab_cls_median: float | None = None
    field_run: PsiRun | None = None  # the run whose JSON carried field_data (its artifact is the evidence)

    @property
    def valid_mobile(self) -> list[PsiRun]:
        """Mobile runs with ok True."""
        return [r for r in self.mobile if r.ok]




# Spanish reasons (client text in the grey list): formal, no voseo, no dashes.
REASON_NO_KEY_QUOTA = "la herramienta de velocidad de Google no dio resultados"  # plain; status says "sin-clave-cuota"
REASON_QUOTA = "la cuota diaria de la herramienta de velocidad de Google se agotó"
REASON_ERROR = "la herramienta de velocidad de Google no respondió"
REASON_NO_VALID = "la herramienta de Google no pudo medir la página"

# A key Google rejects. The client text stays
# plain; the note is for the operator (console, datos.json meta.aviso_pagespeed and
# the nota_interna of the PageSpeed greys).
ERROR_KEY_REJECTED = "key-rejected"
STATUS_KEY_REJECTED = "clave-rechazada"
REASON_KEY_REJECTED = "la herramienta de velocidad de Google no dio resultados"
KEY_REJECTED_NOTE = "PageSpeed rechazó la clave: revisar que la API esté habilitada y la restricción de la clave"
# What Google writes when the key itself is the problem (invalid, API not enabled,
# restricted by referrer, IP or API).
_KEY_ERROR_MARKERS: tuple[str, ...] = (
    "api key", "api_key_", "service_disabled", "accessnotconfigured", "has not been used in project",
    "is disabled", "are blocked", "permission_denied", "keyinvalid",
)


def key_rejected(status: int | None, body: str) -> bool:
    """True when a 400 or 403 answer says the key is the problem (a 403 with a key always is)."""
    if status not in (400, 403):
        return False
    text = (body or "").lower()
    return status == 403 or any(m in text for m in _KEY_ERROR_MARKERS)


def _num(value: Any) -> float | None:
    """A JSON number as float; None for null, booleans, strings and absent values."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _int(value: Any) -> int | None:
    n = _num(value)
    return int(round(n)) if n is not None else None


class PsiClient:
    def __init__(
        self,
        http: "HttpClient",
        endpoint: str,
        key: "ApiKey",
        artifacts: "ArtifactStore",
        registrable: str,
        *,
        sleeper: "Callable[[float], None]",
        retry_wait: float = RETRY_WAIT_SECONDS,
    ) -> None:
        self._http = http
        self._endpoint = endpoint
        self._key = key
        self._artifacts = artifacts
        self._registrable = registrable
        self._sleep = sleeper
        self._retry_wait = retry_wait

    def _call(self, url: str) -> "Response":
        headers = {"X-goog-api-key": self._key.value} if self._key.present and self._key.value else {}
        return self._http.api_request("GET", url, purpose=Purpose.PSI, headers=headers, timeout=TIMEOUT_SECONDS)

    def run_once(self, url: str, strategy: str, n: int) -> PsiRun:
        """One PSI call (with the single 5xx/timeout retry), stored as evidence and parsed."""
        request_url = build_url(self._endpoint, url, strategy)
        resp = self._call(request_url)
        retryable = resp.error is not None or (resp.status is not None and 500 <= resp.status < 600)
        if retryable:  # 5xx or timeout: exactly one retry after 30 s (a 429 never)
            if self._retry_wait > 0:
                self._sleep(self._retry_wait)
            resp = self._call(request_url)
        if resp.status == 429:
            return PsiRun(strategy=strategy, n=n, ok=False, error="http-429", http_status=429)
        if resp.error is not None:
            err = "timeout" if resp.error == "timeout" else f"network-{resp.error}"
            return PsiRun(strategy=strategy, n=n, ok=False, error=err)
        if resp.status is None or not 200 <= resp.status < 300:
            status = resp.status
            err = "http-5xx" if status is not None and status >= 500 else f"http-{status}"
            if self._key.present and key_rejected(status, resp.text()[0] if resp.body else ""):
                err = ERROR_KEY_REJECTED
            return PsiRun(strategy=strategy, n=n, ok=False, error=err, http_status=status)
        try:
            data = json.loads(resp.text()[0])
        except ValueError:
            data = None
        if not isinstance(data, dict):
            return PsiRun(strategy=strategy, n=n, ok=False, error="invalid-json", http_status=resp.status)
        name = art.PSI_DESKTOP if strategy.upper() == STRATEGY_DESKTOP else art.PSI_MOBILE.format(n=n)
        written = self._artifacts.put_json(name, strip_screenshots(data))
        run = parse_psi(data, strategy=strategy, n=n, registrable=self._registrable)
        run.http_status = resp.status
        run.artifact = name if written else None
        return run

    def run_series(
        self, url: str, runs: int = DEFAULT_MOBILE_RUNS, stop: "Callable[[PsiRun], bool] | None" = None
    ) -> PsiSeries:
        """``runs`` mobile runs then 1 desktop run, sequential, honoring the 429 rule.

        Computes median_run (median of lab LCP over valid runs; with an even
        count, the lower middle), lab_lcp_ms_median, lab_cls_median and takes
        ``field_data`` from mobile run 1.

        ``stop(first_run)``: asked once, after the first
        response; True ends the series there (the pipeline passes the
        exclusion check of the run's final URL: Lighthouse must not keep
        loading a domain that asked not to be measured).
        """
        series = PsiSeries(status="ok", key_present=self._key.present)
        runs = max(1, int(runs))
        quota_hit = key_hit = no_contact = False
        for n in range(1, runs + 1):
            run = self.run_once(url, STRATEGY_MOBILE, n)
            series.mobile.append(run)
            if n == 1 and stop is not None and run.error not in ("http-429", ERROR_KEY_REJECTED) and stop(run):
                no_contact = True
            if no_contact or run.error in ("http-429", ERROR_KEY_REJECTED):
                # A 429, or a key Google rejects, will not change within the run: stop.
                quota_hit = run.error == "http-429"
                key_hit = run.error == ERROR_KEY_REJECTED
                skipped = "skipped-quota" if quota_hit else ("skipped-key" if key_hit else "skipped-no-contact")
                for rest in range(n + 1, runs + 1):
                    series.mobile.append(PsiRun(strategy=STRATEGY_MOBILE, n=rest, ok=False, error=skipped))
                break
        if not (quota_hit or key_hit or no_contact):
            series.desktop = self.run_once(url, STRATEGY_DESKTOP, 1)
        else:
            skipped = "skipped-quota" if quota_hit else ("skipped-key" if key_hit else "skipped-no-contact")
            series.desktop = PsiRun(strategy=STRATEGY_DESKTOP, n=1, ok=False, error=skipped)

        valid = series.valid_mobile
        series.median_run = median_run(valid)
        if series.median_run is not None:
            series.lab_lcp_ms_median = series.median_run.lab_lcp_ms
        cls_values = sorted(r.lab_cls for r in valid if r.lab_cls is not None)
        if cls_values:
            series.lab_cls_median = cls_values[(len(cls_values) - 1) // 2]
        # Field data comes from run 1; if run 1 has none, from the first
        # run that has it. A run whose LAB part failed (runtimeError: a WAF blocked
        # Lighthouse) still carries Google's real-user data for the page, which
        # does not depend on that lab load. Runs that
        # ended outside the site or with an unreadable answer are never used.
        def field_source(run: PsiRun) -> bool:
            return run.field_data is not None and (run.ok or (run.error or "").startswith("runtime-error"))

        series.field_run = next((r for r in series.mobile if field_source(r)), None)
        series.field_data = series.field_run.field_data if series.field_run is not None else None

        if valid:
            series.status = "ok"
        elif key_hit:
            series.status = STATUS_KEY_REJECTED
            series.reason = REASON_KEY_REJECTED
        elif quota_hit:
            series.status = "cuota" if self._key.present else "sin-clave-cuota"
            series.reason = REASON_QUOTA if self._key.present else REASON_NO_KEY_QUOTA
        elif any(r.error and (r.error.startswith("runtime-error") or r.error in ("outside-domain", "invalid-json")) for r in series.mobile):
            series.status = "no-valid-runs"
            series.reason = REASON_NO_VALID
        else:
            series.status = "error"
            series.reason = REASON_ERROR
        return series


SCREENSHOT_AUDITS: tuple[str, ...] = ("final-screenshot", "screenshot-thumbnails", "full-page-screenshot")
SCREENSHOT_MARK = "[captura quitada]"


def strip_screenshots(data: Any) -> Any:
    """A copy of a PSI JSON without the pictures of the page (module docstring); the rest unchanged."""

    def walk(obj: Any) -> Any:
        if isinstance(obj, dict):
            return {k: walk(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [walk(v) for v in obj]
        if isinstance(obj, str) and obj[:11].lower() == "data:image/":
            return SCREENSHOT_MARK
        return obj

    out = walk(data)
    lighthouse = out.get("lighthouseResult") if isinstance(out, dict) else None
    if isinstance(lighthouse, dict):
        lighthouse.pop("fullPageScreenshot", None)
        audits = lighthouse.get("audits")
        if isinstance(audits, dict):
            for audit_id in SCREENSHOT_AUDITS:
                audits.pop(audit_id, None)
    return out


def build_url(endpoint: str, page_url: str, strategy: str) -> str:
    """Return the request URL with url, strategy, the 4 categories and locale. Never a key."""
    params: list[tuple[str, str]] = [("url", page_url), ("strategy", strategy.upper())]
    params += [("category", c) for c in CATEGORIES]
    params.append(("locale", LOCALE))
    return endpoint + "?" + urlencode(params)


def parse_psi(data: dict[str, Any], *, strategy: str, n: int, registrable: str) -> PsiRun:
    """Turn one PSI JSON into a PsiRun, applying the invalid-run rules above."""
    run = PsiRun(strategy=strategy, n=n, ok=False)
    if not isinstance(data, dict):
        run.error = "invalid-json"
        return run
    lh = data.get("lighthouseResult")
    lh = lh if isinstance(lh, dict) else {}
    version = lh.get("lighthouseVersion")
    run.lighthouse_version = version if isinstance(version, str) else None
    final = lh.get("finalDisplayedUrl") or lh.get("finalUrl") or data.get("id")
    run.final_url = final if isinstance(final, str) else None
    warnings = lh.get("runWarnings")
    run.run_warnings = [str(w) for w in warnings] if isinstance(warnings, list) else []
    captcha = data.get("captchaResult")
    run.captcha_result = captcha if isinstance(captcha, str) else None
    run.field_data = extract_field(data)

    runtime = lh.get("runtimeError")
    if isinstance(runtime, dict):
        code = runtime.get("code")
        if isinstance(code, str) and code and code != "NO_ERROR":
            run.runtime_error = code
            run.error = f"runtime-error:{code}"
            return run
    if not lh:
        run.error = "invalid-json"
        return run
    if not run.final_url or not domains.is_same_site(run.final_url, registrable):
        run.error = "outside-domain"
        return run

    audits = lh.get("audits")
    audits = audits if isinstance(audits, dict) else {}
    lcp = find_audit(audits, "lcp")
    cls = find_audit(audits, "cls")
    run.lab_lcp_ms = lcp.numeric_value if lcp else None
    run.lab_cls = cls.numeric_value if cls else None
    run.scores = category_scores(data)
    run.audits = {concept: find_audit(audits, concept) for concept in AUDIT_CANDIDATES}
    run.ok = True
    return run


def _experience_metrics(exp: Any) -> dict[str, Any] | None:
    if not isinstance(exp, dict):
        return None
    metrics = exp.get("metrics")
    if not isinstance(metrics, dict):
        return None
    has_core = any(isinstance(metrics.get(k), dict) for k in ("LARGEST_CONTENTFUL_PAINT_MS", "CUMULATIVE_LAYOUT_SHIFT_SCORE"))
    return metrics if has_core else None


def extract_field(data: dict[str, Any]) -> FieldMetrics | None:
    """Field data: loadingExperience.metrics, else originLoadingExperience.metrics (scope "origen").

    ``origin_fallback`` true also means scope "origen". Returns None when neither
    has LCP or CLS. CLS = percentile / 100.
    """
    if not isinstance(data, dict):
        return None
    page = data.get("loadingExperience")
    metrics = _experience_metrics(page)
    origin_fallback = False
    if metrics is not None:
        origin_fallback = bool(page.get("origin_fallback")) if isinstance(page, dict) else False
    else:
        metrics = _experience_metrics(data.get("originLoadingExperience"))
        origin_fallback = True
    if metrics is None:
        return None

    def percentile(name: str) -> float | None:
        m = metrics.get(name)
        return _num(m.get("percentile")) if isinstance(m, dict) else None

    fm = FieldMetrics(scope="origen" if origin_fallback else "pagina", source="psi", origin_fallback=origin_fallback)
    lcp = percentile(FIELD_METRICS["lcp_ms"])
    inp = percentile(FIELD_METRICS["inp_ms"])
    cls = percentile(FIELD_METRICS["cls_x100"])
    ttfb = percentile(FIELD_METRICS["ttfb_ms"])
    fm.lcp_ms = int(round(lcp)) if lcp is not None else None
    fm.inp_ms = int(round(inp)) if inp is not None else None
    fm.cls = round(cls / 100.0, 4) if cls is not None else None
    fm.ttfb_ms = int(round(ttfb)) if ttfb is not None else None
    for key, name in FIELD_METRICS.items():
        m = metrics.get(name)
        if isinstance(m, dict) and isinstance(m.get("category"), str):
            fm.categories[key] = m["category"]
    if fm.lcp_ms is None and fm.cls is None:
        return None
    return fm


def find_audit(audits: dict[str, Any], concept: str) -> AuditResult | None:
    """Look up ``concept`` through AUDIT_CANDIDATES; None when no candidate is present."""
    if not isinstance(audits, dict):
        return None
    for audit_id in AUDIT_CANDIDATES.get(concept, ()):
        a = audits.get(audit_id)
        if not isinstance(a, dict):
            continue
        details = a.get("details")
        details = details if isinstance(details, dict) else None
        failing = None
        if details is not None and details.get("type") in ("table", "list", "opportunity", "checklist"):
            items = details.get("items")
            if isinstance(items, list):
                failing = len(items)
        mode = a.get("scoreDisplayMode")
        return AuditResult(
            id=audit_id,
            score=_num(a.get("score")),
            score_display_mode=mode if isinstance(mode, str) else None,
            numeric_value=_num(a.get("numericValue")),
            failing_items=failing,
            details=details,
        )
    return None


def category_scores(data: dict[str, Any]) -> dict[str, int | None]:
    """lighthouseResult.categories[<key>].score x 100, rounded half up; None when null or absent."""
    out: dict[str, int | None] = {k: None for k in CATEGORY_KEYS}
    lh = data.get("lighthouseResult") if isinstance(data, dict) else None
    cats = lh.get("categories") if isinstance(lh, dict) else None
    if not isinstance(cats, dict):
        return out
    for key in CATEGORY_KEYS:
        cat = cats.get(key)
        score = _num(cat.get("score")) if isinstance(cat, dict) else None
        if score is None:
            continue
        try:
            out[key] = int((Decimal(repr(score)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        except InvalidOperation:
            out[key] = None
    return out


def median_run(runs: list[PsiRun]) -> PsiRun | None:
    """The valid run whose lab LCP is the median (lower middle for an even count)."""
    valid = [r for r in runs if r.ok and r.lab_lcp_ms is not None]
    if not valid:
        return None
    ordered = sorted(valid, key=lambda r: r.lab_lcp_ms)  # stable: ties keep run order
    return ordered[(len(ordered) - 1) // 2]
