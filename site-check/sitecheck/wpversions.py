"""WordPress branch release dates: data, not network.

No WordPress API gives dates. This table maps each major branch x.y to the
release date of x.y.0, taken from wordpress.org/documentation/article/
wordpress-versions/ and, for 3.0 to
4.9, from wordpress.org/documentation/article/wordpress-versions-0-7-to-4-9/
(verified 2026-10-09). UPDATE IT WITH
EACH MAJOR RELEASE (about three per year); a branch missing from the table gives
no age, so EXT-02 prints no age for it (no number without measurement).
Age is measured from the branch's x.y.0 date, never from the point release
(6.1.15 shipped 2026-10-06 but belongs to a branch of November 2022).
"""

from __future__ import annotations

import datetime as dt
import math
import re

VERIFIED_AT = dt.date(2026, 10, 8)

BRANCH_RELEASES: dict[str, dt.date] = {
    # 3.0 to 4.9 added and checked one by one on
    # against the x.y row of
    # https://wordpress.org/documentation/article/wordpress-versions-0-7-to-4-9/
    # (the same table, split off in May 2026, that gives 5.0 onwards). Two branches
    # differed from the first draft and follow that page: 4.1 is 17 December 2014
    # and 4.9 is 15 November 2017. Their release posts (wordpress.org/news/
    # 2014/12/dinah/ and 2017/11/tipton/) are dated one day later, 18 December
    # 2014 and 16 November 2017; the versions table is the one source for every
    # branch here, so it wins. A one-day gap never changes a whole year of age.
    "3.0": dt.date(2010, 6, 17),
    "3.1": dt.date(2011, 2, 23),
    "3.2": dt.date(2011, 7, 4),
    "3.3": dt.date(2011, 12, 12),
    "3.4": dt.date(2012, 6, 13),
    "3.5": dt.date(2012, 12, 11),
    "3.6": dt.date(2013, 8, 1),
    "3.7": dt.date(2013, 10, 24),
    "3.8": dt.date(2013, 12, 12),
    "3.9": dt.date(2014, 4, 16),
    "4.0": dt.date(2014, 9, 4),
    "4.1": dt.date(2014, 12, 17),
    "4.2": dt.date(2015, 4, 23),
    "4.3": dt.date(2015, 8, 18),
    "4.4": dt.date(2015, 12, 8),
    "4.5": dt.date(2016, 4, 12),
    "4.6": dt.date(2016, 8, 16),
    "4.7": dt.date(2016, 12, 6),
    "4.8": dt.date(2017, 6, 8),
    "4.9": dt.date(2017, 11, 15),
    "5.0": dt.date(2018, 12, 6),
    "5.1": dt.date(2019, 2, 21),
    "5.2": dt.date(2019, 5, 7),
    "5.3": dt.date(2019, 11, 12),
    "5.4": dt.date(2020, 3, 31),
    "5.5": dt.date(2020, 8, 11),
    "5.6": dt.date(2020, 12, 8),
    "5.7": dt.date(2021, 3, 9),
    "5.8": dt.date(2021, 7, 20),
    "5.9": dt.date(2022, 1, 25),
    "6.0": dt.date(2022, 5, 24),
    "6.1": dt.date(2022, 11, 1),
    "6.2": dt.date(2023, 3, 29),
    "6.3": dt.date(2023, 8, 8),
    "6.4": dt.date(2023, 11, 7),
    "6.5": dt.date(2024, 4, 2),
    "6.6": dt.date(2024, 7, 16),
    "6.7": dt.date(2024, 11, 12),
    "6.8": dt.date(2025, 4, 15),
    "6.9": dt.date(2025, 12, 2),
    "7.0": dt.date(2026, 5, 20),
    "7.1": dt.date(2026, 8, 19),
}


_VERSION_RE = re.compile(r"^\s*(\d+)\.(\d+)(?:\.\d+)*\s*$")


def branch_of(version: str) -> str | None:
    """'6.1.15' -> '6.1'; '6.1' -> '6.1'; None when not dotted digits."""
    m = _VERSION_RE.match(version or "")
    if not m:
        return None
    return f"{int(m.group(1))}.{int(m.group(2))}"


# Majors accepted as the shape of a WordPress core version. 3 is the oldest
# branch in the table; 9 leaves room for the majors after 7 (one about every
# three years), so an 8.0.1 seen only through ?ver= is still read as WordPress.
WP_MAJOR_MIN = 3
WP_MAJOR_MAX = 9

# Spanish, for the console and datos.json meta.aviso_wordpress.
TABLE_STALE_NOTE = (
    "La tabla de versiones de WordPress no tiene la rama {rama}: actualizar wpversions.py "
    "(se verificó por última vez el {fecha})."
)


def looks_like_wordpress_branch(version: str) -> bool:
    """True for a dotted version whose major is WP_MAJOR_MIN to WP_MAJOR_MAX: the shape of a
    WordPress core version, even when its branch is not in the table yet."""
    branch = branch_of(version)
    if branch is None:
        return False
    return WP_MAJOR_MIN <= int(branch.split(".", 1)[0]) <= WP_MAJOR_MAX


def missing_branch(latest: str | None) -> str | None:
    """The branch of ``latest`` (the stable-check list's newest version) when the table lacks it, else None."""
    branch = branch_of(latest or "")
    if branch is None or branch in BRANCH_RELEASES:
        return None
    return branch


def table_stale_note(latest: str | None) -> str | None:
    """TABLE_STALE_NOTE when the newest WordPress branch is missing from BRANCH_RELEASES, else None."""
    branch = missing_branch(latest)
    if branch is None:
        return None
    fecha = f"{VERIFIED_AT.day}/{VERIFIED_AT.month}/{VERIFIED_AT.year}"
    return TABLE_STALE_NOTE.format(rama=branch, fecha=fecha)


def branch_release_date(version: str) -> dt.date | None:
    """Release date of the branch of ``version``, or None when the branch is not in the table."""
    branch = branch_of(version)
    return BRANCH_RELEASES.get(branch) if branch else None


def branch_age_years(version: str, run_date: dt.date) -> int | None:
    """floor((run_date - branch date).days / 365.25); None when the branch is unknown."""
    released = branch_release_date(version)
    if released is None:
        return None
    return max(0, math.floor((run_date - released).days / 365.25))
