"""Builders of hand-made Observations and EvalContext for the check unit tests.

No network: Response objects are built directly with the fields the checks read.
Pages are parsed with htmlextract.extract_page, the same parser a run uses.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import support  # noqa: F401
from support import AllWritten

from sitecheck.httpclient import RedirectHop, Response
from sitecheck.model import EvalContext
from sitecheck.observations import LinkProbe, LinkSurvey, Observations, OgImageFetch, PageFetch
from sitecheck.psi import AuditResult, FieldMetrics, PsiRun, PsiSeries
from sitecheck.scope import Purpose, RequestKind

BASE = "https://www.colegio.test"
HOME = f"{BASE}/"
RUN_DATE = dt.date(2026, 10, 9)

HTML_HEADERS = [("Content-Type", "text/html; charset=UTF-8")]

FILLER = "<p>" + ("Texto de relleno de la página del colegio para superar el umbral de evidencia. " * 20) + "</p>"


def response(
    url: str = HOME,
    *,
    status: int | None = 200,
    headers: list[tuple[str, str]] | None = None,
    body: bytes | str = b"",
    purpose: Purpose = Purpose.HOME,
    kind: RequestKind = RequestKind.SITE,
    final_url: str | None = None,
    challenge: str | None = None,
    content_encoding: str | None = None,
    raw_length: int | None = None,
    redirects: list[RedirectHop] | None = None,
    error: str | None = None,
) -> Response:
    b = body.encode("utf-8") if isinstance(body, str) else body
    return Response(
        url=url,
        final_url=final_url or url,
        purpose=purpose,
        kind=kind,
        status=status,
        reason="OK" if status == 200 else "",
        headers=list(HTML_HEADERS if headers is None else headers),
        body=b,
        raw_length=len(b) if raw_length is None else raw_length,
        decoded_length=len(b),
        content_encoding=content_encoding,
        redirects=list(redirects or []),
        challenge=challenge,
        error=error,
    )


def html_page(head: str = "", body: str = "", *, lang: str | None = "es-AR", title: str | None = "Colegio Ejemplo | Educación inicial y primaria") -> str:
    """A complete HTML document padded above the evidence gate's 1 KiB minimum."""
    lang_attr = f' lang="{lang}"' if lang is not None else ""
    title_tag = f"<title>{title}</title>" if title is not None else ""
    return f'<!DOCTYPE html><html{lang_attr}><head><meta charset="utf-8">{title_tag}{head}</head><body>{body}{FILLER}</body></html>'


def page(role: str, url: str, html: str, headers: list[tuple[str, str]] | None = None, **resp_kw: Any) -> PageFetch:
    return PageFetch(role=role, url=url, response=response(url, headers=headers, body=html, **resp_kw), body_artifact=f"{role}.html")


def psi_run(n: int = 1, *, lab_lcp_ms: float = 2000.0, lab_cls: float = 0.02, ok: bool = True, scores: dict | None = None,
            audits: dict[str, AuditResult | None] | None = None, field: FieldMetrics | None = None, strategy: str = "MOBILE") -> PsiRun:
    return PsiRun(
        strategy=strategy,
        n=n,
        ok=ok,
        lighthouse_version="13.5.0",
        final_url=HOME,
        field_data=field,
        lab_lcp_ms=lab_lcp_ms,
        lab_cls=lab_cls,
        scores=scores or {"performance": 45, "accessibility": 88, "best-practices": 92, "seo": 85},
        audits=audits or {},
        artifact=f"psi-mobile-{n}.json",
    )


def psi_series(*, field: FieldMetrics | None = None, labs: tuple[float, ...] = (2000.0, 2100.0, 1900.0), lab_cls: float = 0.02,
               status: str = "ok", reason: str | None = None, audits: dict[str, AuditResult | None] | None = None) -> PsiSeries:
    runs = [psi_run(i, lab_lcp_ms=v, lab_cls=lab_cls, audits=audits, field=field if i == 1 else None) for i, v in enumerate(labs, 1)]
    ordered = sorted(runs, key=lambda r: r.lab_lcp_ms or 0)
    median = ordered[(len(ordered) - 1) // 2] if ordered else None
    return PsiSeries(
        status=status,
        reason=reason,
        key_present=True,
        mobile=runs if status == "ok" else [],
        desktop=psi_run(1, strategy="DESKTOP") if status == "ok" else None,
        field_data=field,
        median_run=median if status == "ok" else None,
        lab_lcp_ms_median=median.lab_lcp_ms if (median and status == "ok") else None,
        lab_cls_median=lab_cls if status == "ok" else None,
    )


def field(lcp: int | None = 2000, inp: int | None = 150, cls: float | None = 0.05, scope: str = "pagina") -> FieldMetrics:
    return FieldMetrics(scope=scope, source="psi", lcp_ms=lcp, inp_ms=inp, cls=cls)


def make_obs(home_html: str | None = None, *, home_headers: list[tuple[str, str]] | None = None, interna_html: str | None = None,
             home_challenge: str | None = None, **fields: Any) -> Observations:
    obs = Observations(input_url=HOME, registrable="colegio.test", canonical_url=HOME, canonical_host="www.colegio.test", other_host="colegio.test")
    if home_html is not None:
        obs.home = page("home", HOME, home_html, home_headers, challenge=home_challenge)
    if interna_html is not None:
        obs.interna = page("interna", f"{BASE}/institucional/", interna_html, purpose=Purpose.INTERNA)
        obs.interna_source = "auto"
    for k, v in fields.items():
        setattr(obs, k, v)
    return obs


def link_survey(statuses: dict[str, int | None], hops: dict[str, int] | None = None) -> LinkSurvey:
    hops = hops or {}
    return LinkSurvey(
        selection=None,
        probes=[LinkProbe(url=u, statuses=[s] if s else [], final_url=u, final_status=s, hops=hops.get(u, 0)) for u, s in statuses.items()],
    )


def og_fetch(status: int = 200, ctype: str = "image/png", width: int | None = 1200, height: int | None = 630) -> OgImageFetch:
    from sitecheck.imagesize import ImageInfo

    url = f"{BASE}/wp-content/uploads/2024/03/portada.png"
    img = ImageInfo("png", width, height) if (width and height) else None
    return OgImageFetch(url=url, response=response(url, status=status, headers=[("Content-Type", ctype)], body=b"\x89PNG", purpose=Purpose.OG_IMAGE, kind=RequestKind.SITE), image=img)


def make_ctx(obs: Observations, *, run_date: dt.date = RUN_DATE, institution: str | None = "Colegio Ejemplo", kind: str = "colegio") -> EvalContext:
    from sitecheck.htmlextract import extract_page

    pages: dict[str, Any] = {}
    for role, pf in (("home", obs.home), ("interna", obs.interna), ("formulario", obs.form_page)):
        pages[role] = extract_page(pf.response.body.decode("utf-8"), pf.url) if (pf and pf.response and pf.response.body) else None
    return EvalContext(run_date=run_date, institution=institution, kind=kind, artifacts_written=AllWritten(), pages=pages)
