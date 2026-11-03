"""FAKE EXTERNAL SERVICES on 127.0.0.1:<random port>: PSI, CrUX, DoH (Google and
Cloudflare shapes), RDAP, WordPress stable-check, Observatory, plus the two
test-only probes that replace non-HTTP lookups (TLS handshake and Spamhaus DBL).

Point the tool at it with ``--test-services http://127.0.0.1:PORT`` (paths are
those of sitecheck.endpoints.Endpoints.for_test). Every request is recorded
(method, path, query, headers, body, time) so tests can assert, for example,
that the PSI key travelled only in the X-goog-api-key header, or that no API was
called for an excluded domain.
"""

from __future__ import annotations

import datetime as dt
import json
import socketserver
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

RTYPES = {"A": 1, "CNAME": 5, "MX": 15, "TXT": 16, "AAAA": 28}


@dataclass(frozen=True)
class ApiRequest:
    method: str
    path: str  # without query
    query: dict[str, list[str]]
    headers: dict[str, str]  # lowercased names
    body: bytes
    t: float
    raw_path: str  # path with query, as sent


# The "meta-viewport" audit of psi_payload, by case (see its docstring).
META_VIEWPORT_AUDITS: dict[str, dict[str, Any]] = {
    "pass": {"id": "meta-viewport", "score": 1, "scoreDisplayMode": "binary"},
    "absent": {"id": "meta-viewport", "score": None, "scoreDisplayMode": "notApplicable"},
    "zoom": {
        "id": "meta-viewport",
        "score": 0,
        "scoreDisplayMode": "binary",
        "details": {
            "type": "table",
            "items": [{"node": {"type": "node", "selector": "head > meta", "snippet": '<meta name="viewport" content="width=device-width, user-scalable=no">'}}],
        },
    },
}


def psi_payload(
    final_url: str,
    *,
    strategy: str = "MOBILE",
    lab_lcp_ms: float = 4830.0,
    lab_cls: float = 0.04,
    field_lcp_ms: int | None = 4830,
    field_inp_ms: int | None = 180,
    field_cls_pct: int | None = 5,
    origin_only: bool = False,
    scores: tuple[float | None, float | None, float | None, float | None] = (0.45, 0.88, 0.92, 0.85),
    total_bytes: int = 3_000_000,
    image_bytes: int = 2_000_000,
    runtime_error: str | None = None,
    meta_viewport: str = "pass",
) -> dict[str, Any]:
    """A PSI v5 JSON shaped like the real one, with only the
    fields the tool reads. Field CLS is given x100 like PSI does.

    ``meta_viewport``: the axe audit "meta-viewport" as Lighthouse
    reports it: "pass" (a viewport that lets the user zoom, score 1), "absent"
    (no viewport meta: the rule does not apply, notApplicable) or "zoom" (a
    viewport that blocks the zoom: score 0 with the meta as its failing node).
    """
    metrics: dict[str, Any] = {}
    if field_lcp_ms is not None:
        metrics["LARGEST_CONTENTFUL_PAINT_MS"] = {"percentile": field_lcp_ms, "category": "SLOW" if field_lcp_ms > 4000 else ("AVERAGE" if field_lcp_ms > 2500 else "FAST")}
    if field_inp_ms is not None:
        metrics["INTERACTION_TO_NEXT_PAINT"] = {"percentile": field_inp_ms, "category": "FAST" if field_inp_ms <= 200 else "AVERAGE"}
    if field_cls_pct is not None:
        metrics["CUMULATIVE_LAYOUT_SHIFT_SCORE"] = {"percentile": field_cls_pct, "category": "FAST" if field_cls_pct <= 10 else "AVERAGE"}
    experience = {"id": final_url, "metrics": metrics, "overall_category": "SLOW", "initial_url": final_url, "origin_fallback": False}
    data: dict[str, Any] = {
        "kind": "pagespeedonline#result",
        "captchaResult": "CAPTCHA_NOT_NEEDED",
        "id": final_url,
        "analysisUTCTimestamp": "2026-10-09T15:00:00.000Z",
        "lighthouseResult": {
            "lighthouseVersion": "13.5.0",
            "requestedUrl": final_url,
            "finalUrl": final_url,
            "finalDisplayedUrl": final_url,
            "runWarnings": [],
            "configSettings": {"formFactor": strategy.lower()},
            "categories": {
                "performance": {"id": "performance", "score": scores[0]},
                "accessibility": {"id": "accessibility", "score": scores[1]},
                "best-practices": {"id": "best-practices", "score": scores[2]},
                "seo": {"id": "seo", "score": scores[3]},
            },
            "audits": {
                "largest-contentful-paint": {"id": "largest-contentful-paint", "score": 0.2, "scoreDisplayMode": "numeric", "numericValue": lab_lcp_ms},
                "cumulative-layout-shift": {"id": "cumulative-layout-shift", "score": 1, "scoreDisplayMode": "numeric", "numericValue": lab_cls},
                "total-byte-weight": {"id": "total-byte-weight", "score": 0.5, "scoreDisplayMode": "numeric", "numericValue": total_bytes},
                "resource-summary": {
                    "id": "resource-summary",
                    "score": None,
                    "scoreDisplayMode": "informative",
                    "details": {
                        "type": "table",
                        "items": [
                            {"resourceType": "total", "transferSize": total_bytes, "requestCount": 60},
                            {"resourceType": "image", "transferSize": image_bytes, "requestCount": 25},
                            {"resourceType": "script", "transferSize": 500_000, "requestCount": 20},
                            {"resourceType": "third-party", "transferSize": 300_000, "requestCount": 10},
                        ],
                    },
                },
                "third-parties-insight": {"id": "third-parties-insight", "score": None, "scoreDisplayMode": "informative", "details": {"type": "table", "items": [{"entity": "Google Tag Manager", "transferSize": 120_000}, {"entity": "YouTube", "transferSize": 180_000}]}},
                "color-contrast": {"id": "color-contrast", "score": 0, "scoreDisplayMode": "binary", "details": {"type": "table", "items": [{"node": {}}, {"node": {}}]}},
                "label": {"id": "label", "score": None, "scoreDisplayMode": "notApplicable"},
                "target-size": {"id": "target-size", "score": 1, "scoreDisplayMode": "binary"},
                "meta-viewport": META_VIEWPORT_AUDITS[meta_viewport],
                "image-alt": {"id": "image-alt", "score": 0, "scoreDisplayMode": "binary", "details": {"type": "table", "items": [{"node": {}}]}},
            },
        },
    }
    if origin_only:
        data["originLoadingExperience"] = dict(experience, origin_fallback=True)
    elif metrics:
        data["loadingExperience"] = experience
        data["originLoadingExperience"] = dict(experience)
    if runtime_error:
        data["lighthouseResult"]["runtimeError"] = {"code": runtime_error, "message": "fake"}
    return data


@dataclass
class FakeApisConfig:
    psi_mobile: list[dict[str, Any]] = field(default_factory=list)  # served in order, cycling
    psi_desktop: dict[str, Any] | None = None
    psi_status: int = 200  # e.g. 429 for the quota case
    psi_error: dict[str, Any] | None = None  # the error JSON of a non-200 PSI answer (default: a quota message)
    crux: dict[str, Any] | None = None  # None -> 404
    zone: dict[tuple[str, str], list[str] | None] = field(default_factory=dict)  # (name, TYPE) -> data or None (NXDOMAIN)
    rdap: dict[str, dict[str, Any]] = field(default_factory=dict)  # domain -> JSON
    wp_stable: dict[str, str] = field(default_factory=dict)
    observatory: dict[str, Any] | None = None
    dbl: dict[str, list[str] | None] = field(default_factory=dict)  # query name -> addresses, None -> NXDOMAIN
    tls: dict[str, dict[str, Any]] = field(default_factory=dict)  # host -> TlsResult-shaped JSON


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


class FakeApis:
    """Context manager serving FakeApisConfig on loopback and recording every request."""

    def __init__(self, config: FakeApisConfig) -> None:
        self.config = config
        self.requests: list[ApiRequest] = []
        self._lock = threading.Lock()
        self._psi_index = 0
        self._server: _Server | None = None

    def start(self) -> "FakeApis":
        apis = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: object) -> None:
                return

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                parts = urlsplit(self.path)
                rec = ApiRequest(
                    method=self.command,
                    path=parts.path,
                    query=parse_qs(parts.query),
                    headers={k.lower(): v for k, v in self.headers.items()},
                    body=body,
                    t=time.perf_counter(),
                    raw_path=self.path,
                )
                with apis._lock:
                    apis.requests.append(rec)
                status, ctype, payload = apis._dispatch(rec)
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)
                self.close_connection = True

            do_GET = _handle
            do_POST = _handle

        self._server = _Server(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, name="fake-apis", daemon=True).start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self) -> "FakeApis":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    @property
    def base(self) -> str:
        """Value for --test-services."""
        assert self._server is not None, "FakeApis not started"
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    # -- dispatch ----------------------------------------------------------
    def _dispatch(self, r: ApiRequest) -> tuple[int, str, Any]:
        c = self.config
        q = {k: v[0] for k, v in r.query.items()}
        if r.path == "/pagespeedonline/v5/runPagespeed":
            if c.psi_status != 200:
                return c.psi_status, "application/json", c.psi_error or {"error": {"code": c.psi_status, "message": "Quota exceeded for quota metric 'Queries' (fake)", "status": "RESOURCE_EXHAUSTED"}}
            if (q.get("strategy") or "").upper() == "DESKTOP":
                return 200, "application/json", c.psi_desktop or {}
            if not c.psi_mobile:
                return 500, "application/json", {"error": {"code": 500, "message": "no fixture"}}
            with self._lock:
                payload = c.psi_mobile[self._psi_index % len(c.psi_mobile)]
                self._psi_index += 1
            return 200, "application/json", payload
        if r.path == "/v1/records:queryRecord":
            return (200, "application/json", c.crux) if c.crux else (404, "application/json", {"error": {"code": 404, "message": "chrome ux report data not found"}})
        if r.path in ("/resolve", "/dns-query"):
            return 200, "application/dns-json" if r.path == "/dns-query" else "application/json", self._doh(q.get("name", ""), q.get("type", "A"), quoted=r.path == "/dns-query")
        if r.path.startswith("/rdap/domain/") or r.path.startswith("/rdap-ar/domain/"):
            domain = r.path.rsplit("/", 1)[-1]
            obj = c.rdap.get(domain)
            return (200, "application/rdap+json", obj) if obj else (404, "application/rdap+json", {"errorCode": 404})
        if r.path == "/core/stable-check/1.0/":
            return 200, "application/json", c.wp_stable
        if r.path == "/api/v2/scan":
            return (200, "application/json", c.observatory) if c.observatory else (500, "application/json", {"error": "fake"})
        if r.path == "/dbl":
            name = q.get("name", "").rstrip(".").lower()
            listing = {k.rstrip(".").lower(): v for k, v in c.dbl.items()}
            if listing.get(name) is None:
                return 200, "application/json", {"nxdomain": True}
            return 200, "application/json", {"addresses": listing[name]}
        if r.path == "/tls":
            host = q.get("host", "").rstrip(".").lower()
            obj = c.tls.get(host)
            return (200, "application/json", obj) if obj else (200, "application/json", {"host": host, "error": "refused"})
        return 404, "application/json", {"error": "unknown fake endpoint"}

    def _doh(self, name: str, rtype: str, *, quoted: bool) -> dict[str, Any]:
        name_n = name.rstrip(".").lower()
        rtype_u = rtype.upper()
        key = (name_n, rtype_u)
        known_names = {n for (n, _t) in self.config.zone}
        explicit_nxdomain = key in self.config.zone and self.config.zone[key] is None
        if explicit_nxdomain or name_n not in known_names:
            return {"Status": 3, "TC": False, "RD": True, "RA": True, "AD": False, "CD": False, "Question": [{"name": name, "type": RTYPES.get(rtype_u, 0)}]}
        data = self.config.zone.get(key) or []
        answers = []
        for d in data:
            value = f'"{d}"' if (quoted and rtype_u == "TXT") else d
            answers.append({"name": name_n + ("" if quoted else "."), "type": RTYPES.get(rtype_u, 0), "TTL": 300, "data": value})
        out: dict[str, Any] = {"Status": 0, "TC": False, "RD": True, "RA": True, "AD": False, "CD": False, "Question": [{"name": name, "type": RTYPES.get(rtype_u, 0)}]}
        if answers:
            out["Answer"] = answers
        return out

    # -- inspection --------------------------------------------------------
    def calls(self, path: str) -> list[ApiRequest]:
        with self._lock:
            return [r for r in self.requests if r.path == path]

    def last_time(self, path_prefix: str = "") -> float | None:
        with self._lock:
            return max((r.t for r in self.requests if r.path.startswith(path_prefix)), default=None)


def tls_fixture(host: str, *, days_from_now: int = 58, alpn: str = "h2", now: dt.datetime | None = None) -> dict[str, Any]:
    """TlsResult-shaped JSON for the fake /tls probe; not_after relative to ``now``
    (default: the real clock) so the state does not depend on the day the tests run.
    examples/make_example.py passes its fixed clock."""
    now = now or dt.datetime.now(dt.timezone.utc)
    not_after = (now + dt.timedelta(days=days_from_now)).replace(microsecond=0)
    not_before = not_after - dt.timedelta(days=90)
    return {
        "host": host,
        "port": 443,
        "ok": True,
        "tls_version": "TLSv1.3",
        "alpn": alpn,
        "issuer_org": "Let's Encrypt",
        "not_before": not_before.isoformat(),
        "not_after": not_after.isoformat(),
        "verify_code": None,
        "verify_message": None,
        "chain_length": 3,
    }
