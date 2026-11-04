"""Hand-written fixtures: a WordPress-like school site and the default fake API answers.

Everything here is invented ("Colegio Ejemplo" under the reserved .test TLD).
The structure is the one a typical small-school WordPress site has: a
page-builder theme, a Yoast-style sitemap index, a floating WhatsApp button,
a footer year and a feed.

Each scenario carries, WRITTEN BY HAND, the set of URLs the passive scope
allows the tool to request (``allowed``) and URLs the site links or exposes but
that must never be requested (``forbidden``). Tests compare the fake site's
request record against them.
"""

from __future__ import annotations

import datetime as dt
import struct
import zlib
from dataclasses import dataclass
from string import Template

from fakeapis import FakeApisConfig, psi_payload, tls_fixture
from fakesite import Route, Scenario

HTML = [("Content-Type", "text/html; charset=UTF-8")]


def png_bytes(width: int, height: int) -> bytes:
    """A minimal PNG (signature + IHDR + empty IDAT + IEND) with the given pixel size."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"")) + chunk(b"IEND", b"")


def challenge_route() -> Route:
    """A typical hosting challenge page: 200, about 12 KB, 'One moment, please...'."""
    filler = "<!-- " + ("x" * 11800) + " -->"
    body = (
        "<!DOCTYPE html><html><head><title>One moment, please...</title></head>"
        f"<body><h1>One moment, please...</h1><p>Please wait while your request is being verified...</p>{filler}</body></html>"
    ).encode("utf-8")
    return Route(200, list(HTML), body)


@dataclass
class SchoolOptions:
    domain: str = "colegio.test"
    name: str = "Colegio Ejemplo"
    title: str = "Colegio Ejemplo | Educación inicial, primaria y secundaria en Buenos Aires"
    description: str | None = (
        "Colegio Ejemplo acompaña a cada familia desde el nivel inicial hasta la secundaria, "
        "con jornada completa, inglés y talleres en la Ciudad de Buenos Aires."
    )
    lang: str = "es-AR"
    wp_version: str | None = "6.1.1"
    og_image: bool = True
    og_description: bool = True
    noindex: bool = False
    footer_year: int = 2019
    whatsapp: str | None = "5491123456789"
    robots_declares_sitemap: bool = True
    feed_last_item: str = "Mon, 20 May 2024 10:00:00 +0000"
    tagline: str = "Educación con valores desde 1960"
    broken_link: bool = True
    challenge: bool = False


_HOME = Template(
    """<!DOCTYPE html>
<html lang="$lang" class="avada-html-layout-wide">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>$title</title>
$description_meta
<meta name="robots" content="$robots" />
<link rel="canonical" href="$base/" />
<meta content="$name" property="og:title" />
$og_description_meta
$og_image_meta
<meta property="og:locale" content="es_AR" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="alternate" type="application/rss+xml" title="$name &raquo; Feed" href="$base/feed/" />
<link rel="alternate" type="application/rss+xml" title="$name &raquo; Feed de los comentarios" href="$base/comments/feed/" />
<link rel="stylesheet" id="wp-block-library-css" href="$base/wp-includes/css/dist/block-library/style.min.css$core_ver" type="text/css" media="all" />
<link rel="stylesheet" id="avada-stylesheet-css" href="$base/wp-content/themes/Avada/assets/css/style.min.css?ver=7.9.1" type="text/css" media="all" />
<link rel="profile" href="http://gmpg.org/xfn/11" />
<link rel="https://api.w.org/" href="$base/wp-json/" />
<link rel="EditURI" type="application/rsd+xml" title="RSD" href="$base/xmlrpc.php?rsd" />
$generator_meta
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"EducationalOrganization","@id":"$base/#organization","name":"$name","url":"$base/","address":{"@type":"PostalAddress","addressLocality":"Ciudad de Buenos Aires","addressCountry":"AR"}},{"@type":"WebSite","@id":"$base/#website","url":"$base/","name":"$name","publisher":{"@id":"$base/#organization"}}]}</script>
<style id="avada-inline">.fusion-header{background:#fff}</style>
</head>
<body class="home page-template-default">
<header class="fusion-header-wrapper">
<nav class="fusion-main-menu"><ul>
<li><a href="$base/">Inicio</a></li>
<li><a href="$base/institucional/">Institucional</a></li>
<li><a href="$base/niveles/inicial/">Nivel Inicial</a></li>
<li><a href="$base/inscripciones/">Inscripciones 2027</a></li>
<li><a href="$base/contacto/">Contacto</a></li>
<li><a href="http://www.$domain/historia/">Historia</a></li>
<li><a href="$base/?s=buscar">Buscar</a></li>
<li><a href="$base/wp-login.php">Ingresar</a></li>
</ul></nav>
</header>
<main id="main">
<h1>$name</h1>
<section><h2>Nuestra propuesta</h2>
<p>Somos una comunidad educativa de la Ciudad de Buenos Aires. Acompañamos a las familias en cada etapa, con proyectos para el ciclo lectivo 2027.</p>
<img src="$base/wp-content/uploads/2024/03/patio.jpg" alt="Patio del colegio con estudiantes" width="800" height="533">
<img src="$base/wp-content/uploads/2024/03/separador.png" alt="">
<img src="$base/wp-content/uploads/2024/03/banner.jpg" data-alt="Banner de inscripciones" width="1200" height="400">
<noscript><img src="$base/wp-content/uploads/2024/03/banner.jpg"></noscript>
</section>
<section><h2>Novedades</h2>
<ul>
<li><a href="$base/novedades/acto-25-de-mayo/">Acto del 25 de Mayo</a></li>
<li><a href="$base/viejo-enlace/">Calendario escolar</a></li>
<li><a href="$base/wp-content/uploads/2024/03/calendario.pdf">Calendario en PDF</a></li>
<li><a href="$base/author/admin/">Publicado por admin</a></li>
<li><a href="$base/?author=1">Más de este autor</a></li>
</ul>
</section>
<section><h2>Contacto</h2><p><a href="mailto:info@$domain">Correo de secretaría</a></p></section>
</main>
$whatsapp_block
<footer class="fusion-footer">
<div class="fusion-footer-widget-area">
<p>Tel: <a href="tel:+541100000000">0000-0000</a></p>
<p><a href="$base/politica-de-privacidad/">Política de privacidad</a></p>
<ul class="fusion-social-links">
<li><a class="fusion-social-network-icon fusion-facebook" href="https://www.facebook.com/colegioejemplo" aria-label="Facebook"></a></li>
<li><a class="fusion-social-network-icon fusion-instagram" href="https://www.instagram.com/colegioejemplo" aria-label="Instagram"></a></li>
</ul>
</div>
<div class="fusion-copyright-notice">&copy; $footer_year $name. Todos los derechos reservados.</div>
</footer>
<script src="$base/wp-includes/js/wp-emoji-release.min.js$core_ver"></script>
<script src="$base/wp-content/plugins/contact-form-7/includes/js/index.js?ver=5.7.2"></script>
</body>
</html>
"""
)

_PAGE = Template(
    """<!DOCTYPE html>
<html lang="$lang">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>$page_title - $name</title>
<meta name="description" content="$page_title de $name: información para las familias, horarios, niveles y contacto con la secretaría del colegio." />
<link rel="canonical" href="$url" />
</head>
<body>
<header><nav><a href="$base/">Inicio</a></nav></header>
<main><h1>$page_title</h1><p>Contenido de la página $page_title para las familias de $name.</p>
<p>Texto de relleno para que la página tenga un tamaño realista y la evidencia supere el umbral mínimo del control.</p>
<p>Las familias pueden comunicarse con la secretaría de lunes a viernes de 8 a 16 horas para consultas generales.</p>
<p>El equipo directivo recibe a las familias con turno previo para conversar sobre el proyecto institucional y los niveles.</p></main>
<footer class="site-footer">&copy; $footer_year $name</footer>
</body>
</html>
"""
)


def _home_html(o: SchoolOptions) -> bytes:
    base = f"https://www.{o.domain}"
    wa = ""
    if o.whatsapp:
        wa = (
            f'<div class="joinchat" data-settings=\'{{"telephone":"{o.whatsapp}"}}\'></div>\n'
            f'<a class="whatsapp-float" href="https://wa.me/{o.whatsapp}?text=Hola%2C%20quiero%20informaci%C3%B3n%20sobre%20admisiones">WhatsApp</a>'
        )
    html = _HOME.substitute(
        lang=o.lang,
        title=o.title,
        description_meta=f'<meta name="description" content="{o.description}" />' if o.description else "",
        robots="noindex, nofollow" if o.noindex else "index, follow, max-image-preview:large",
        base=base,
        name=o.name,
        og_description_meta=f'<meta property="og:description" content="{o.description}" />' if (o.og_description and o.description) else "",
        og_image_meta=(
            f'<meta property="og:image" content="{base}/wp-content/uploads/2024/03/portada.png" />\n'
            '<meta property="og:image:width" content="1200" />\n<meta property="og:image:height" content="630" />'
        )
        if o.og_image
        else "",
        core_ver=f"?ver={o.wp_version}" if o.wp_version else "",
        generator_meta=f'<meta name="generator" content="WordPress {o.wp_version}" />' if o.wp_version else "",
        domain=o.domain,
        whatsapp_block=wa,
        footer_year=o.footer_year,
    )
    return html.encode("utf-8")


def _page_html(o: SchoolOptions, url: str, page_title: str) -> bytes:
    return _PAGE.substitute(
        lang=o.lang, page_title=page_title, name=o.name, url=url, base=f"https://www.{o.domain}", footer_year=o.footer_year
    ).encode("utf-8")


def _feed_xml(o: SchoolOptions) -> bytes:
    base = f"https://www.{o.domain}"
    gen = f"<generator>https://wordpress.org/?v={o.wp_version}</generator>" if o.wp_version else ""
    return f"""<?xml version="1.0" encoding="UTF-8"?><rss version="2.0">
<channel>
<title>{o.name}</title>
<link>{base}</link>
<description>{o.tagline}</description>
<language>es-AR</language>
{gen}
<item><title>Acto del 25 de Mayo</title><link>{base}/novedades/acto-25-de-mayo/</link><dc:creator><![CDATA[usuario-autor]]></dc:creator><pubDate>{o.feed_last_item}</pubDate></item>
<item><title>Bienvenida al ciclo lectivo</title><link>{base}/novedades/bienvenida/</link><pubDate>Mon, 04 Mar 2024 10:00:00 +0000</pubDate></item>
</channel>
</rss>
""".encode("utf-8")


def _sitemap_index(o: SchoolOptions) -> bytes:
    base = f"https://www.{o.domain}"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>{base}/page-sitemap.xml</loc><lastmod>2024-05-20T10:00:00+00:00</lastmod></sitemap>
<sitemap><loc>{base}/post-sitemap.xml</loc><lastmod>2024-05-20T10:00:00+00:00</lastmod></sitemap>
</sitemapindex>
""".encode("utf-8")


def _page_sitemap(o: SchoolOptions) -> bytes:
    base = f"https://www.{o.domain}"
    locs = ["/", "/institucional/", "/niveles/inicial/", "/inscripciones/", "/contacto/", "/politica-de-privacidad/"]
    entries = "\n".join(f"<url><loc>{base}{p}</loc><lastmod>2024-05-20T10:00:00+00:00</lastmod></url>" for p in locs)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{entries}
</urlset>
""".encode("utf-8")


def school_scenario(o: SchoolOptions | None = None, name: str = "wp-school") -> Scenario:
    """The WordPress-like school home and everything it links, with its allowed/forbidden sets."""
    o = o or SchoolOptions()
    d = o.domain
    base = f"https://www.{d}"
    xml = [("Content-Type", "application/xml; charset=UTF-8")]
    home_headers = [
        ("Content-Type", "text/html; charset=UTF-8"),
        ("Server", "Apache/2.4.41 (Ubuntu)"),
        ("X-Powered-By", "PHP/7.4.33"),
        ("Strict-Transport-Security", "max-age=31536000"),
        ("X-Content-Type-Options", "nosniff"),
        ("Cache-Control", "no-cache, must-revalidate, max-age=0"),
        ("Link", f'<{base}/wp-json/>; rel="https://api.w.org/"'),
        ("Link", f"<{base}/>; rel=shortlink"),
    ]
    robots = "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n"
    if o.robots_declares_sitemap:
        robots += f"\nSitemap: {base}/sitemap_index.xml\n"

    routes: dict[str, Route] = {
        # EXT-17 variants
        f"http://{d}/": Route(301, [("Location", f"{base}/")]),
        f"https://{d}/": Route(301, [("Location", f"{base}/")]),
        f"http://www.{d}/": Route(301, [("Location", f"{base}/")]),
        f"{base}/": Route(200, home_headers, _home_html(o), gzip=True),
        # control site (TTFB)
        "https://control.test/": Route(200, list(HTML), b"<!DOCTYPE html><html><head><title>Control</title></head><body>ok</body></html>"),
        # robots, sitemaps, feed
        f"{base}/robots.txt": Route(200, [("Content-Type", "text/plain; charset=utf-8")], robots.encode("utf-8")),
        f"{base}/sitemap_index.xml": Route(200, xml, _sitemap_index(o)),
        f"{base}/page-sitemap.xml": Route(200, xml, _page_sitemap(o)),
        f"{base}/post-sitemap.xml": Route(200, xml, _page_sitemap(o)),
        f"{base}/feed/": Route(200, [("Content-Type", "application/rss+xml; charset=UTF-8")], _feed_xml(o)),
        # og:image
        f"{base}/wp-content/uploads/2024/03/portada.png": Route(200, [("Content-Type", "image/png")], png_bytes(1200, 630)),
        # linked pages
        f"{base}/institucional/": Route(200, list(HTML), _page_html(o, f"{base}/institucional/", "Institucional")),
        f"{base}/niveles/inicial/": Route(200, list(HTML), _page_html(o, f"{base}/niveles/inicial/", "Nivel Inicial")),
        f"{base}/inscripciones/": Route(200, list(HTML), _page_html(o, f"{base}/inscripciones/", "Inscripciones")),
        f"{base}/contacto/": Route(200, list(HTML), _page_html(o, f"{base}/contacto/", "Contacto")),
        f"{base}/politica-de-privacidad/": Route(200, list(HTML), _page_html(o, f"{base}/politica-de-privacidad/", "Política de privacidad")),
        f"{base}/viejo-enlace/": Route(301, [("Location", f"{base}/intermedio/")]),
        f"{base}/intermedio/": Route(301, [("Location", f"{base}/destino/")]),
        f"{base}/destino/": Route(200, list(HTML), _page_html(o, f"{base}/destino/", "Calendario escolar")),
        f"http://www.{d}/historia/": Route(301, [("Location", f"{base}/historia/")]),
        f"{base}/historia/": Route(200, list(HTML), _page_html(o, f"{base}/historia/", "Historia")),
        # exposed but never to be requested (they exist, so a hit would "work")
        f"{base}/readme.html": Route(200, list(HTML), b"<html>WordPress readme</html>"),
        f"{base}/wp-json/": Route(200, [("Content-Type", "application/json")], b"{}"),
        f"{base}/xmlrpc.php": Route(405, [("Content-Type", "text/plain")], b"XML-RPC server accepts POST requests only."),
        f"{base}/author/admin/": Route(200, list(HTML), b"<html>admin</html>"),
    }
    if not o.broken_link:
        routes[f"{base}/novedades/acto-25-de-mayo/"] = Route(200, list(HTML), _page_html(o, f"{base}/novedades/acto-25-de-mayo/", "Acto"))

    allowed = {
        f"http://{d}/",
        f"https://{d}/",
        f"http://www.{d}/",
        f"{base}/",
        "https://control.test/",
        f"{base}/robots.txt",
        f"{base}/feed/",
        f"{base}/wp-content/uploads/2024/03/portada.png",
        f"{base}/institucional/",
        f"{base}/niveles/inicial/",
        f"{base}/inscripciones/",
        f"{base}/contacto/",
        f"{base}/politica-de-privacidad/",
        f"{base}/novedades/acto-25-de-mayo/",
        f"{base}/viejo-enlace/",
        f"{base}/intermedio/",
        f"{base}/destino/",
        f"http://www.{d}/historia/",
        f"{base}/historia/",
    }
    forbidden = {
        f"{base}/author/admin/",
        f"{base}/?author=1",
        f"{base}/wp-login.php",
        f"{base}/wp-admin/",
        f"{base}/wp-json/",
        f"{base}/comments/feed/",
        f"{base}/post-sitemap.xml",
        f"{base}/?s=buscar",
        f"{base}/wp-content/uploads/2024/03/calendario.pdf",
        f"{base}/wp-content/uploads/2024/03/patio.jpg",
        f"{base}/readme.html",
        f"{base}/xmlrpc.php",
        f"{base}/xmlrpc.php?rsd",
        f"{base}/favicon.ico",
        f"{base}/license.txt",
        f"{base}/wp-sitemap.xml",
    }
    if o.robots_declares_sitemap:
        allowed |= {f"{base}/sitemap_index.xml", f"{base}/page-sitemap.xml"}
        forbidden |= {f"{base}/sitemap.xml"}
    else:
        # No Sitemap: line -> the standard paths in order, stopping at the first valid one:
        # /sitemap.xml is 404 here, /sitemap_index.xml is valid, /wp-sitemap.xml is never tried.
        allowed |= {f"{base}/sitemap.xml", f"{base}/sitemap_index.xml", f"{base}/page-sitemap.xml"}
    return Scenario(
        name=name,
        routes=routes,
        allowed=frozenset(allowed),
        forbidden=frozenset(forbidden),
        challenge=o.challenge,
        challenge_page=challenge_route(),
    )


def default_apis(
    domain: str = "colegio.test",
    *,
    dbl_codes: list[str] | None = None,
    psi_status: int = 200,
    now: dt.datetime | None = None,
) -> FakeApisConfig:
    """Fake API answers matching school_scenario: slow field LCP (4,8 s), no DMARC,
    WordPress 6.1.1 'insecure', domain expiring in 200 days, TLS in 58 days, DBL not listed.
    Dates are relative to ``now`` (default: the real clock)."""
    final_url = f"https://www.{domain}/"
    now = (now or dt.datetime.now(dt.timezone.utc)).replace(microsecond=0)
    return FakeApisConfig(
        psi_mobile=[
            psi_payload(final_url, lab_lcp_ms=4830.0),
            psi_payload(final_url, lab_lcp_ms=5120.0),
            psi_payload(final_url, lab_lcp_ms=4600.0),
        ],
        psi_desktop=psi_payload(final_url, strategy="DESKTOP", lab_lcp_ms=1900.0, scores=(0.78, 0.88, 0.92, 0.85)),
        psi_status=psi_status,
        zone={
            (domain, "TXT"): ["v=spf1 include:_spf.google.com ~all", "google-site-verification=fake-token"],
            (domain, "MX"): ["1 aspmx.l.google.com.", "5 alt1.aspmx.l.google.com."],
            (f"_dmarc.{domain}", "TXT"): None,
            (f"google._domainkey.{domain}", "TXT"): None,
            ("control.test", "TXT"): ["v=spf1 include:_spf.control.test ~all"],
            ("control.test", "MX"): ["10 mx1.control.test.", "20 mx2.control.test."],
            ("_dmarc.control.test", "TXT"): ["v=DMARC1; p=none"],
        },
        rdap={
            domain: {
                "objectClassName": "domain",
                "ldhName": domain.upper(),
                "status": ["client transfer prohibited"],
                "events": [
                    {"eventAction": "registration", "eventDate": "2010-03-01T00:00:00Z"},
                    {"eventAction": "expiration", "eventDate": (now + dt.timedelta(days=200)).isoformat().replace("+00:00", "Z")},
                    {"eventAction": "last update of RDAP database", "eventDate": now.isoformat().replace("+00:00", "Z")},
                ],
                "entities": [
                    {
                        "objectClassName": "entity",
                        "roles": ["registrant"],
                        "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Juana Titular Ficticia"]]],
                    }
                ],
                "secureDNS": {"delegationSigned": False},
            }
        },
        wp_stable={"6.1.1": "insecure", "6.1.15": "outdated", "7.0.7": "outdated", "7.1.3": "latest"},
        observatory={"grade": "F", "score": 20, "tests_passed": 5, "tests_quantity": 10},
        # The RFC 5782 test point is the control of the lookup (dbl.py): always listed.
        dbl={f"{domain}.dbl.spamhaus.org": dbl_codes, "test.dbl.spamhaus.org": ["127.0.1.2"]},
        tls={f"www.{domain}": tls_fixture(f"www.{domain}", now=now), domain: tls_fixture(domain, now=now)},
    )
