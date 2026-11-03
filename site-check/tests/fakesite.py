"""LOCAL FAKE SITE: a threaded HTTP server on 127.0.0.1:<random port> that plays a website.

The tool, run with ``--test-loopback 127.0.0.1:PORT`` (or a LoopbackRoute in
unit tests), sends every request for a ``*.test`` host here over plain HTTP,
with the original ``Host`` header and ``X-Site-Check-Test-Scheme: http|https``. The
fake answers from a Scenario (exact URL -> Route) and RECORDS EVERY REQUEST
(method, scheme, host, path with query, headers, time), so a test can assert
that nothing outside the passive scope was requested.

The HTML served is hand-written and fictional (tests/sitefixtures.py).
"""

from __future__ import annotations

import gzip
import socketserver
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCHEME_HEADER = "X-Site-Check-Test-Scheme"


@dataclass
class Route:
    """One canned response."""

    status: int = 200
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: bytes = b""
    gzip: bool = False  # compress when the client accepts gzip
    # Declared Content-Length when it must differ from the body (a connection
    # closed early); None sends the real length.
    content_length: int | None = None


@dataclass(frozen=True)
class RecordedRequest:
    method: str
    scheme: str
    host: str
    path: str  # path plus query, as sent
    headers: dict[str, str]
    t: float  # time.perf_counter when received

    @property
    def url(self) -> str:
        return f"{self.scheme}://{self.host}{self.path}"


@dataclass
class Scenario:
    """What the fake site serves, plus the hand-written expectations of the passive scope.

    ``routes`` maps an exact absolute URL (scheme://host/path?query) to a Route.
    ``allowed`` is the set of URLs the passive scope allows for this
    scenario; ``forbidden`` lists URLs the site LINKS or exposes but that the
    tool must never request. Both are written by hand in sitefixtures.py, never
    computed from the implementation.
    """

    name: str
    routes: dict[str, Route] = field(default_factory=dict)
    allowed: frozenset[str] = frozenset()
    forbidden: frozenset[str] = frozenset()
    challenge: bool = False  # every request gets the challenge page
    challenge_page: Route | None = None
    not_found: Route = field(
        default_factory=lambda: Route(
            404,
            [("Content-Type", "text/html; charset=UTF-8")],
            "<html><head><title>Página no encontrada</title></head><body><h1>404</h1></body></html>".encode("utf-8"),
        )
    )


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def server_bind(self) -> None:  # skip getfqdn: slow on Windows and not needed
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


class FakeSite:
    """Context manager: ``with FakeSite(scenario) as site: ... site.loopback ...``."""

    def __init__(self, scenario: Scenario) -> None:
        self.scenario = scenario
        self.requests: list[RecordedRequest] = []
        self._lock = threading.Lock()
        self._server: _Server | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> "FakeSite":
        site = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def version_string(self) -> str:
                # A fixed Server header, independent of the Python running the tests,
                # so the example output is the same on every machine.
                return "FakeSite/1.0"

            def log_message(self, format: str, *args: object) -> None:  # silence
                return

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                host = (self.headers.get("Host") or "").split(":")[0].lower()
                scheme = (self.headers.get(SCHEME_HEADER) or "http").lower()
                rec = RecordedRequest(
                    method=self.command,
                    scheme=scheme,
                    host=host,
                    path=self.path,
                    headers={k.lower(): v for k, v in self.headers.items()},
                    t=time.perf_counter(),
                )
                with site._lock:
                    site.requests.append(rec)
                route = site._route_for(rec)
                body = route.body
                headers = list(route.headers)
                accept = (self.headers.get("Accept-Encoding") or "").lower()
                if route.gzip and "gzip" in accept and body:
                    body = gzip.compress(body)
                    headers.append(("Content-Encoding", "gzip"))
                self.send_response(route.status)
                for k, v in headers:
                    self.send_header(k, v)
                declared = route.content_length if route.content_length is not None else len(body)
                self.send_header("Content-Length", str(declared))
                self.send_header("Connection", "close")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
                self.close_connection = True

            do_GET = _handle
            do_HEAD = _handle
            do_POST = _handle

        self._server = _Server(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, name="fake-site", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self) -> "FakeSite":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()

    # -- addresses ---------------------------------------------------------
    @property
    def port(self) -> int:
        assert self._server is not None, "FakeSite not started"
        return int(self._server.server_address[1])

    @property
    def loopback(self) -> str:
        """Value for --test-loopback."""
        return f"127.0.0.1:{self.port}"

    # -- routing -----------------------------------------------------------
    def _route_for(self, rec: RecordedRequest) -> Route:
        sc = self.scenario
        if sc.challenge:
            return sc.challenge_page or Route(200, [("Content-Type", "text/html")], b"One moment, please...")
        if rec.method not in ("GET", "HEAD"):
            return Route(405, [("Content-Type", "text/plain")], b"method not allowed")
        return sc.routes.get(rec.url, sc.not_found)

    # -- inspection --------------------------------------------------------
    def requested_urls(self) -> list[str]:
        with self._lock:
            return [r.url for r in self.requests]

    def count(self, url: str) -> int:
        return sum(1 for u in self.requested_urls() if u == url)

    def first_time(self) -> float | None:
        with self._lock:
            return min((r.t for r in self.requests), default=None)

    def outside_allowed(self) -> list[str]:
        """Requested URLs that are not in the scenario's allowed set (should be [])."""
        return [u for u in self.requested_urls() if u not in self.scenario.allowed]

    def forbidden_hits(self) -> list[str]:
        """Requested URLs that are in the scenario's forbidden set (must be [])."""
        return [u for u in self.requested_urls() if u in self.scenario.forbidden]

    def reset(self) -> None:
        with self._lock:
            self.requests.clear()
