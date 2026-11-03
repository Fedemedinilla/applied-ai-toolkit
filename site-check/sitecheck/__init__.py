"""sitecheck: a passive, outside-in diagnostic of a public website.

Measures a site from the outside, with only what any visitor gets (the pages
the site serves and links, plus public DNS, RDAP, Spamhaus and PageSpeed
answers), applies fixed rules and leaves, under <out>/<registrable-domain>/<date>/,
the measured data (datos.json), the report (informe.md), the technical annex
(anexo-tecnico.md) and the evidence folder.

Entry points: ``python3 -m sitecheck`` and site_check.py next to this package.

Importing this package must stay cheap and side-effect free: no submodule is
imported here, no network, no file access.
"""

__version__ = "1.0.0"

# Version of the datos.json layout. Bump it on any incompatible change, because
# --rerender reads old files.
SCHEMA_VERSION = 1

__all__ = ["__version__", "SCHEMA_VERSION"]
