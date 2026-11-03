"""Chrome UX Report API fallback for field data.

Used only when the PSI JSON has no loadingExperience/originLoadingExperience
metrics AND a key exists: POST records:queryRecord with formFactor PHONE, first
``{"url": ...}`` then ``{"origin": ...}``, key in X-goog-api-key. Any error (404
= no data, 403 = API not enabled on the project, 429, timeout) is a SILENT
fallback to lab data: it returns None and the reason goes to the evidence only.
CLS p75 comes as a decimal string ("0.23"): parse with float, do not divide.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from . import artifacts as art
from .psi import FieldMetrics
from .scope import Purpose, ScopeError

if TYPE_CHECKING:
    from .artifacts import ArtifactStore
    from .credentials import ApiKey
    from .httpclient import HttpClient

FORM_FACTOR = "PHONE"
METRICS: tuple[str, ...] = (
    "largest_contentful_paint",
    "interaction_to_next_paint",
    "cumulative_layout_shift",
    "experimental_time_to_first_byte",
)
TIMEOUT_SECONDS = 30.0


def _p75(metrics: dict[str, Any], name: str) -> float | None:
    m = metrics.get(name)
    if not isinstance(m, dict):
        return None
    pct = m.get("percentiles")
    if not isinstance(pct, dict):
        return None
    value = pct.get("p75")
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class CruxClient:
    def __init__(self, http: "HttpClient", endpoint: str, key: "ApiKey", artifacts: "ArtifactStore") -> None:
        self._http = http
        self._endpoint = endpoint
        self._key = key
        self._artifacts = artifacts

    def field_for(self, page_url: str, origin: str) -> "FieldMetrics | None":
        """Try url then origin; return FieldMetrics(source="crux", scope "pagina"/"origen") or None.

        Never called without a key (returns None immediately). Stores crux.json.
        """
        if not self._key.present or not self._key.value:
            return None
        attempts: list[dict[str, Any]] = []
        found: FieldMetrics | None = None
        answer: Any = None
        for scope, query in (("pagina", {"url": page_url}), ("origen", {"origin": origin})):
            body = json.dumps({**query, "formFactor": FORM_FACTOR, "metrics": list(METRICS)}).encode("utf-8")
            attempt: dict[str, Any] = {"alcance": scope, "estado_http": None, "error": None}
            attempts.append(attempt)
            try:
                resp = self._http.api_request(
                    "POST",
                    self._endpoint,
                    purpose=Purpose.CRUX,
                    headers={"X-goog-api-key": self._key.value, "Content-Type": "application/json"},
                    body=body,
                    timeout=TIMEOUT_SECONDS,
                )
            except ScopeError:
                raise
            except Exception as exc:  # silent fallback: never stops the run
                attempt["error"] = type(exc).__name__
                continue
            attempt["estado_http"] = resp.status
            if resp.error or resp.status != 200:
                attempt["error"] = resp.error or f"http-{resp.status}"
                continue
            try:
                data = json.loads(resp.text()[0])
            except ValueError:
                attempt["error"] = "not-json"
                continue
            fm = parse_crux(data, scope) if isinstance(data, dict) else None
            if fm is None:
                attempt["error"] = "no-data"
                continue
            found, answer = fm, data
            break
        self._artifacts.put_json(art.CRUX, {"intentos": attempts, "respuesta": answer})
        return found


def parse_crux(data: dict, scope: str) -> "FieldMetrics | None":
    """Parse one records:queryRecord response; None when LCP and CLS are both absent."""
    record = data.get("record") if isinstance(data, dict) else None
    metrics = record.get("metrics") if isinstance(record, dict) else None
    if not isinstance(metrics, dict):
        return None
    lcp = _p75(metrics, "largest_contentful_paint")
    inp = _p75(metrics, "interaction_to_next_paint")
    cls = _p75(metrics, "cumulative_layout_shift")
    ttfb = _p75(metrics, "experimental_time_to_first_byte")
    if lcp is None and cls is None:
        return None
    return FieldMetrics(
        scope=scope,
        source="crux",
        lcp_ms=int(round(lcp)) if lcp is not None else None,
        inp_ms=int(round(inp)) if inp is not None else None,
        cls=cls,
        ttfb_ms=int(round(ttfb)) if ttfb is not None else None,
        origin_fallback=scope == "origen",
    )
