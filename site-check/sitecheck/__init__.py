"""sitecheck: a passive, outside-in diagnostic of a public website.

Measures a site from the outside, with only what any visitor gets (the pages
the site serves and links, plus public DNS, RDAP, Spamhaus and PageSpeed
answers), applies fixed rules and leaves, under <out>/<registrable-domain>/<date>/,
the measured data (run.json), the report (report.md), the technical annex
(technical-annex.md) and the evidence folder.

Entry points: ``python3 -m sitecheck``, site_check.py next to this package and,
once installed, the ``site-check`` command (pyproject.toml).

Importing this package must stay cheap and side-effect free: no submodule is
imported here, no network, no file access.
"""

__version__ = "1.0.0"

# Version of the stored run (run.json; schema/run.schema.json). Bump it on any
# incompatible change, because --rerender and --compare read old files:
# runformat.py holds the migration of each older version. Version 1 was
# datos.json, with Spanish names.
SCHEMA_VERSION = 2

# The name of the distribution in pyproject.toml. Not yet published, and not
# checked against PyPI: change it here and there (tests/test_packaging.py).
DIST_NAME = "site-check-passive"

__all__ = ["__version__", "SCHEMA_VERSION", "DIST_NAME"]
