"""Base URLs of every third-party service and of the control site.

Production values are the defaults. ``Endpoints.for_test`` points every service
at the local fake API server of the test harness (tests/fakeapis.py); it accepts
only a loopback base URL. The scope guard admits exactly these hosts as APIs.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from urllib.parse import urlsplit

# The control site: the same TTFB and DNS questions are asked about it at the
# same moment, so a slow network or a failing resolver is never blamed on the
# site under test. There is no default: the control receives real requests on
# every run, so the operator names a site they own in SITE_CHECK_CONTROL_DOMAIN
# and the CLI refuses a real run without it. Test mode uses TEST_CONTROL_DOMAIN,
# which the fake DoH server answers for.
CONTROL_ENV_VAR = "SITE_CHECK_CONTROL_DOMAIN"
TEST_CONTROL_DOMAIN = "control.test"
LOOPBACK_HOSTS: frozenset[str] = frozenset({"127.0.0.1", "::1"})


def control_domain_from_env() -> str:
    """The control domain set by the operator, normalized; "" when unset."""
    return (os.environ.get(CONTROL_ENV_VAR) or "").strip().lower().rstrip(".")


def _control_url() -> str:
    domain = control_domain_from_env()
    return f"https://{domain}/" if domain else ""


@dataclass(frozen=True)
class Endpoints:
    """Where each external call goes. All fields are absolute URLs."""

    psi: str = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
    crux: str = "https://chromeuxreport.googleapis.com/v1/records:queryRecord"
    doh_google: str = "https://dns.google/resolve"
    doh_cloudflare: str = "https://cloudflare-dns.com/dns-query"
    # rdap.org bootstrap for generic TLDs, rdap.nic.ar for .ar.
    rdap_bootstrap: str = "https://rdap.org/domain/"
    rdap_ar: str = "https://rdap.nic.ar/domain/"
    wp_stable_check: str = "https://api.wordpress.org/core/stable-check/1.0/"
    observatory: str = "https://observatory-api.mdn.mozilla.net/api/v2/scan"
    # Empty when SITE_CHECK_CONTROL_DOMAIN is unset; the scope guard then admits no control URL.
    control_url: str = field(default_factory=_control_url)
    control_domain: str = field(default_factory=control_domain_from_env)
    # Test-only fakes for the two non-HTTP probes (TLS handshake, DBL over the
    # system resolver). None in production: the real probes are used.
    test_tls: str | None = None
    test_dbl: str | None = None

    # Fields that are third-party APIs (control_url and control_domain are not).
    API_FIELDS = (
        "psi",
        "crux",
        "doh_google",
        "doh_cloudflare",
        "rdap_bootstrap",
        "rdap_ar",
        "wp_stable_check",
        "observatory",
        "test_tls",
        "test_dbl",
    )

    @classmethod
    def for_test(cls, services_base: str, control_url: str = f"https://{TEST_CONTROL_DOMAIN}/") -> "Endpoints":
        """Endpoints for the fake API server at ``services_base`` (http://127.0.0.1:PORT).

        Paths served by tests/fakeapis.py:
        /pagespeedonline/v5/runPagespeed, /v1/records:queryRecord, /resolve,
        /dns-query, /rdap/domain/, /rdap-ar/domain/, /core/stable-check/1.0/,
        /api/v2/scan, /tls, /dbl. ``control_url`` stays under ``.test`` so the
        loopback transport routes it to the fake site. ``control_domain`` is
        TEST_CONTROL_DOMAIN whatever the environment says: the fake DoH answers for it. Raises ValueError when
        ``services_base`` is not http://127.0.0.1 or http://[::1].
        """
        parts = urlsplit(services_base.strip())
        host = (parts.hostname or "").lower()
        if parts.scheme != "http" or host not in LOOPBACK_HOSTS or parts.path not in ("", "/"):
            raise ValueError("test services must be http://127.0.0.1:PORT or http://[::1]:PORT")
        if parts.query or parts.fragment or parts.username or parts.password:
            raise ValueError("test services base must be a bare origin")
        base = f"http://{parts.netloc}"
        return cls(
            psi=base + "/pagespeedonline/v5/runPagespeed",
            crux=base + "/v1/records:queryRecord",
            doh_google=base + "/resolve",
            doh_cloudflare=base + "/dns-query",
            rdap_bootstrap=base + "/rdap/domain/",
            rdap_ar=base + "/rdap-ar/domain/",
            wp_stable_check=base + "/core/stable-check/1.0/",
            observatory=base + "/api/v2/scan",
            control_url=control_url,
            control_domain=TEST_CONTROL_DOMAIN,
            test_tls=base + "/tls",
            test_dbl=base + "/dbl",
        )

    def api_hosts(self) -> frozenset[str]:
        """Return the normalized hosts of every API field (not control_url)."""
        hosts: set[str] = set()
        for f in fields(self):
            if f.name not in self.API_FIELDS:
                continue
            value = getattr(self, f.name)
            if value:
                host = urlsplit(value).hostname
                if host:
                    hosts.add(host.lower())
        return frozenset(hosts)
