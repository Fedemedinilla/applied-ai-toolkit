"""The fictional school after a round of fixes: the "after" side of the before/after example.

The "before" side is the ordinary fake school (sitefixtures.school_scenario and
default_apis), measured on 14/10/2026 into examples/. This module describes the
same site five weeks later, with the fixes a maintainer would make:

- WordPress updated and its version no longer printed (generator meta and
  ?ver= gone), the server no longer naming its software versions;
- the four missing browser protection headers added;
- a page cache in front of the site (an X-Cache header on every answer);
- the broken link on the home fixed, the footer year and the news current,
  a shorter title;
- a DMARC record on the domain;
- lighter images, so the lab LCP, the page weight and the real-user LCP drop.

Two things are left as they were, on purpose: the third-party share and the
contrast and alt-text audits. A before/after report must show what is still
open, not only what improved.

Everything is invented, under the reserved .test TLD.
"""

from __future__ import annotations

import datetime as dt

from fakeapis import FakeApisConfig, psi_payload
from fakesite import Route, Scenario
from sitefixtures import SchoolOptions, default_apis, school_scenario

AFTER_OPTIONS = SchoolOptions(
    title="Colegio Ejemplo | Inicial, primaria y secundaria",
    wp_version=None,
    footer_year=2026,
    feed_last_item="Mon, 09 Nov 2026 10:00:00 +0000",
    broken_link=False,
)

# What the maintainer changed on the home's response headers.
_DROPPED_HEADERS = frozenset({"server", "x-powered-by", "cache-control"})
_ADDED_HEADERS: tuple[tuple[str, str], ...] = (
    ("Server", "Apache"),
    ("Cache-Control", "public, max-age=600"),
    ("X-Cache", "HIT"),
    ("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'self'"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("X-Frame-Options", "SAMEORIGIN"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
)


def improved_scenario() -> Scenario:
    """school_scenario(AFTER_OPTIONS) with the home's headers fixed."""
    scenario = school_scenario(AFTER_OPTIONS, name="wp-school-after")
    home_url = f"https://www.{AFTER_OPTIONS.domain}/"
    home = scenario.routes[home_url]
    headers = [(k, v) for k, v in home.headers if k.lower() not in _DROPPED_HEADERS]
    headers.extend(_ADDED_HEADERS)
    scenario.routes[home_url] = Route(home.status, headers, home.body, gzip=home.gzip)
    return scenario


def improved_apis(now: dt.datetime) -> FakeApisConfig:
    """default_apis with lighter pages, faster field data and a DMARC record."""
    config = default_apis(now=now)
    domain = AFTER_OPTIONS.domain
    final_url = f"https://www.{domain}/"
    light = {"total_bytes": 1_250_000, "image_bytes": 560_000, "field_lcp_ms": 2300, "field_inp_ms": 150, "field_cls_pct": 3}
    config.psi_mobile = [
        psi_payload(final_url, lab_lcp_ms=2210.0, lab_cls=0.02, scores=(0.86, 0.90, 1.0, 0.92), **light),
        psi_payload(final_url, lab_lcp_ms=2480.0, lab_cls=0.02, scores=(0.81, 0.90, 1.0, 0.92), **light),
        psi_payload(final_url, lab_lcp_ms=2050.0, lab_cls=0.02, scores=(0.89, 0.90, 1.0, 0.92), **light),
    ]
    config.psi_desktop = psi_payload(
        final_url, strategy="DESKTOP", lab_lcp_ms=900.0, lab_cls=0.01, scores=(0.96, 0.90, 1.0, 0.92), **light
    )
    config.zone = dict(config.zone)
    config.zone[(f"_dmarc.{domain}", "TXT")] = ["v=DMARC1; p=quarantine; rua=mailto:dmarc@colegio.test"]
    return config
