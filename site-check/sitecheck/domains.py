"""Host and domain arithmetic: registrable domain, www variants, URL comparison keys.

The standard library has no Public Suffix List, so a fixed subset is embedded
(for EXT-13): the Argentine second-level suffixes, copied from publicsuffix.org,
plus the entries of the PSL PRIVATE section for the hosting platforms that
Argentine schools and SMEs use (PLATFORM_SUFFIXES: Blogger, WordPress.com,
Tiendanube, Wix, GitHub Pages, Netlify, Vercel, Firebase...). Any other host
falls back to "the last two labels". The reserved TLD ``.test`` (RFC 6761),
used by the local fake site, follows the same fallback
(``www.colegio.test`` -> ``colegio.test``).

The SITE DOMAIN is what the tool measures:
the registrable domain D when the input host is D or www.D, else the input host
without "www." (a school under a university or a provincial network,
``www.colegio.universidad-ejemplo.edu.ar`` -> ``colegio.universidad-ejemplo.edu.ar``). shared_parent names the
domain that belongs to someone else (the organization or the platform): its
mail DNS, registry expiry and blocklist status describe that owner, never the
school, so the checks that read them do not apply.

Everything here is pure (no network, no clock) so the scope guard, the
exclusion list and the checks can share it.
"""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urljoin, urlsplit, urlunsplit

# Copied from https://publicsuffix.org/list/public_suffix_list.dat (section "ar").
# Verify against the live list when this table is edited.
PUBLIC_SUFFIXES: frozenset[str] = frozenset(
    {
        "bet.ar",
        "com.ar",
        "coop.ar",
        "edu.ar",
        # NOT in the PSL. esc.edu.ar has no A record and its NS belong to the
        # educational network that hands out school names; each school under it
        # is a separate delegation with its own NS, SOA and MX. A school under
        # esc.edu.ar owns its name; treating esc.edu.ar as the owner would skip
        # the school's own mail, registry and blocklist checks.
        "esc.edu.ar",
        "gob.ar",
        "gov.ar",
        "int.ar",
        "mil.ar",
        "musica.ar",
        "mutual.ar",
        "net.ar",
        "org.ar",
        "senasa.ar",
        "tur.ar",
    }
)

# PSL private section, the platforms a small site may live on (verify against
# https://publicsuffix.org/list/public_suffix_list.dat when this table is edited).
# A site there has its OWN registrable name (colegio.blogspot.com), and the
# platform's DNS, registry and blocklist status are not the site's.
PLATFORM_SUFFIXES: frozenset[str] = frozenset(
    {
        "blogspot.com",
        "blogspot.com.ar",
        "wordpress.com",
        "mitiendanube.com",
        "wixsite.com",
        "github.io",
        "netlify.app",
        "vercel.app",
        "web.app",
        "firebaseapp.com",
        "pages.dev",
        "herokuapp.com",
        "weebly.com",
        "squarespace.com",
        "glitch.me",
        "onrender.com",
    }
)

# Free mail services. Their address says nothing about the site (the exclusion
# list refuses one alone) and their mail domain always receives mail, so the
# contact check VIS-21 never queries them. The Spanish and regional variants
# (hotmail.es, outlook.es, live.es, yahoo.es, ymail.com and the like) count too.
FREE_MAIL_DOMAINS: frozenset[str] = frozenset({
    "gmail.com", "googlemail.com", "hotmail.com", "hotmail.com.ar", "outlook.com", "outlook.com.ar", "live.com",
    "live.com.ar", "msn.com", "yahoo.com", "yahoo.com.ar", "icloud.com", "me.com", "aol.com", "protonmail.com",
    "proton.me",
    "hotmail.es", "outlook.es", "live.es", "yahoo.es", "ymail.com", "rocketmail.com", "mac.com",
    "hotmail.com.mx", "live.com.mx", "yahoo.com.mx", "hotmail.cl", "live.cl",
    "hotmail.com.br", "outlook.com.br", "yahoo.com.br", "hotmail.co.uk", "yahoo.co.uk",
    "protonmail.ch", "pm.me", "gmx.com", "gmx.es", "zoho.com", "yandex.com", "mail.com",
})

# The four scheme/host variants of the home requested by EXT-17, in this order.
VARIANT_TEMPLATES: tuple[str, ...] = (
    "http://{d}/",
    "https://{d}/",
    "http://www.{d}/",
    "https://www.{d}/",
)

HTTP_SCHEMES: frozenset[str] = frozenset({"http", "https"})
DEFAULT_PORTS: dict[str, int] = {"http": 80, "https": 443}

# A URL scheme prefix such as "mailto:" or "https:" (RFC 3986 3.1).
_SCHEME_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$", re.DOTALL)
# Characters a browser removes from anywhere inside a URL (WHATWG URL parser).
_TAB_NEWLINE_RE = re.compile(r"[\t\n\r]")


def normalize_host(host: str) -> str:
    """Return the comparable ASCII form of a host name.

    Lowercases, strips surrounding whitespace, a trailing dot and any ``:port``,
    and converts Unicode labels with ``str.encode("idna")`` (IDNA 2003, enough
    for names with ñ or accents). IPv6 literals in brackets are returned without
    the brackets. Raises ValueError for an empty host or one that IDNA rejects.
    """
    if not isinstance(host, str):
        raise ValueError("host must be a string")
    h = host.strip()
    if not h:
        raise ValueError("empty host")
    if h.startswith("["):
        end = h.find("]")
        if end <= 1:
            raise ValueError("malformed IPv6 literal")
        return h[1:end].lower()
    if h.count(":") == 1:
        h = h.split(":", 1)[0]
    elif h.count(":") > 1:
        # A bare IPv6 address (no brackets): validate and keep it.
        try:
            return str(ipaddress.IPv6Address(h)).lower()
        except ValueError as exc:
            raise ValueError("malformed host") from exc
    h = h.rstrip(".").lower()
    if not h:
        raise ValueError("empty host")
    if not h.isascii():
        try:
            h = h.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise ValueError("host rejected by IDNA") from exc
    if any(not label for label in h.split(".")):
        raise ValueError("empty label in host")
    if any(c.isspace() or c in "/\\?#@" for c in h):
        raise ValueError("invalid character in host")
    return h


def strip_www(host: str) -> str:
    """Return ``host`` without one leading ``www.`` label (after normalize_host)."""
    h = normalize_host(host)
    return h[4:] if h.startswith("www.") and len(h) > 4 else h


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def registrable_domain(host: str) -> str:
    """Return the registrable domain ("D") of ``host``.

    ``www.colegio-ejemplo.edu.ar`` -> ``colegio-ejemplo.edu.ar``; ``sub.colegio-ejemplo.com`` ->
    ``colegio-ejemplo.com``; ``colegio.test`` -> ``colegio.test``. Uses PUBLIC_SUFFIXES
    and otherwise the last two labels. Accepts a bare host or a full URL.
    Raises ValueError when the host is a public suffix itself (``com.ar``), an
    IP address, or has a single label.
    """
    h = host_of(host) if "://" in host else normalize_host(host)
    if _is_ip(h):
        raise ValueError("an IP address has no registrable domain")
    labels = h.split(".")
    if len(labels) < 2:
        raise ValueError("a single-label host has no registrable domain")
    if h in PUBLIC_SUFFIXES or h in PLATFORM_SUFFIXES:
        raise ValueError("the host is a public suffix")
    suffix = public_suffix_of(h)
    if suffix is not None:
        n = suffix.count(".") + 2  # the suffix's labels plus one
        return ".".join(labels[-n:])
    return ".".join(labels[-2:])


def public_suffix_of(host: str) -> str | None:
    """The longest embedded suffix (PUBLIC_SUFFIXES or PLATFORM_SUFFIXES) that ``host`` is under, or None."""
    h = normalize_host(host)
    labels = h.split(".")
    for n in range(len(labels) - 1, 0, -1):  # longest first: blogspot.com.ar before com.ar
        candidate = ".".join(labels[-n:])
        if candidate in PUBLIC_SUFFIXES or candidate in PLATFORM_SUFFIXES:
            return candidate
    return None


def site_domain(host: str) -> str:
    """The domain the tool measures (module docstring): D for D and www.D, else the host without "www."."""
    h = host_of(host) if "://" in host else normalize_host(host)
    d = registrable_domain(h)
    bare = strip_www(h)
    return d if bare == d else bare


def shared_parent(host: str) -> str | None:
    """The domain of the organization or platform the site lives under, or None when the site owns D.

    ``www.colegio.universidad-ejemplo.edu.ar`` -> ``universidad-ejemplo.edu.ar``; ``colegio.blogspot.com`` ->
    ``blogspot.com``; ``www.colegio-ejemplo.edu.ar`` -> None.
    """
    h = host_of(host) if "://" in host else normalize_host(host)
    suffix = public_suffix_of(h)
    if suffix is not None and suffix in PLATFORM_SUFFIXES:
        return suffix
    d = registrable_domain(h)
    return d if strip_www(h) != d else None


def decode_idn(host: str) -> str:
    """A host as a reader types it: IDN labels decoded ("xn--colegioespaol-tkb.test" -> "colegioespañol.test").

    The raw host when a label does not decode. Shared by every check that
    writes a domain in a sentence, so the report never prints punycode.
    """
    labels = []
    for label in (host or "").split("."):
        if label.startswith("xn--"):
            try:
                label = label.encode("ascii").decode("idna")
            except (UnicodeError, ValueError):
                return host
        labels.append(label)
    return ".".join(labels)


def host_of(url: str) -> str:
    """Return the normalized host of an absolute http(s) URL; ValueError otherwise."""
    if not isinstance(url, str):
        raise ValueError("URL must be a string")
    parts = urlsplit(url.strip())
    if parts.scheme.lower() not in HTTP_SCHEMES:
        raise ValueError("not an http(s) URL")
    if not parts.hostname:
        raise ValueError("URL without host")
    return normalize_host(parts.hostname)


def _host_from_any(url_or_host: str) -> str | None:
    """Host of an http(s) URL or of a bare host[:port]; None for other schemes."""
    s = url_or_host.strip()
    if "://" in s:
        try:
            return host_of(s)
        except ValueError:
            return None
    m = _SCHEME_RE.match(s)
    if m and not m.group(2).isdigit():
        return None  # mailto:, tel:, javascript: ... (but keep "host:8080")
    try:
        return normalize_host(s)
    except ValueError:
        return None


def is_same_site(url_or_host: str, registrable: str) -> bool:
    """True when the URL's host equals ``registrable`` or is a subdomain of it.

    The comparison uses normalize_host on both sides, so ``WWW.Colegio-Ejemplo.EDU.ar.``
    matches ``colegio-ejemplo.edu.ar``. Non-http(s) URLs (mailto:, tel:, javascript:)
    return False.
    """
    h = _host_from_any(url_or_host)
    if h is None:
        return False
    try:
        d = normalize_host(registrable)
    except ValueError:
        return False
    return h == d or h.endswith("." + d)


def is_apex_or_www(url_or_host: str, registrable: str) -> bool:
    """True only for ``registrable`` itself or ``www.`` + ``registrable``.

    VIS-09 keeps links on the apex and www hosts only.
    """
    h = _host_from_any(url_or_host)
    if h is None:
        return False
    try:
        d = normalize_host(registrable)
    except ValueError:
        return False
    return h in (d, "www." + d)


def site_variants(registrable: str) -> tuple[str, str, str, str]:
    """Return the four EXT-17 URLs, in VARIANT_TEMPLATES order, for ``registrable``."""
    d = normalize_host(registrable)
    a, b, c, e = (t.format(d=d) for t in VARIANT_TEMPLATES)
    return a, b, c, e


def compare_key(url: str) -> str:
    """Return a key under which two URLs that denote the same page are equal.

    Rules : lowercase scheme and host, drop the default port (80 for
    http, 443 for https), drop the fragment, strip surrounding whitespace, and
    treat a path with or without its trailing slash as the same (``/a`` and
    ``/a/``; the empty path equals ``/``). The query string is kept verbatim.
    The scheme is part of the key: ``http://x/`` and ``https://x/`` differ.
    """
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    try:
        host = normalize_host(parts.hostname) if parts.hostname else parts.netloc.lower()
    except ValueError:
        host = parts.netloc.lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"  # IPv6 literal
    try:
        port = parts.port
    except ValueError:
        port = None
    port_part = f":{port}" if port is not None and port != DEFAULT_PORTS.get(scheme) else ""
    path = parts.path.rstrip("/") or "/"
    key = f"{scheme}://{host}{port_part}{path}"
    if parts.query:
        key += "?" + parts.query
    return key


def resolve_url(base_url: str, href: str) -> str | None:
    """Resolve ``href`` against ``base_url`` the way a browser does.

    Strips surrounding whitespace first (the dry run had an href with a trailing
    space), drops the fragment, and returns None for empty hrefs, a bare ``#``,
    and non-http(s) schemes (mailto:, tel:, javascript:, data:, whatsapp:).
    """
    if href is None:
        return None
    h = _TAB_NEWLINE_RE.sub("", href).strip()
    if not h or h == "#":
        return None
    m = _SCHEME_RE.match(h)
    if m and m.group(1).lower() not in HTTP_SCHEMES:
        return None
    try:
        absolute = urljoin(base_url.strip(), h)
        parts = urlsplit(absolute)
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if scheme not in HTTP_SCHEMES or not parts.netloc:
        return None
    path = parts.path or "/"
    return urlunsplit((scheme, parts.netloc, path, parts.query, ""))
