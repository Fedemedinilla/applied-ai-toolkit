"""The exclusion list: domains this tool must never send a request to.

A site owner who asks not to be measured goes on this list, and the list is
read BEFORE ANY REQUEST. A match means exit 10 with zero requests and no run
folder. The canonical host after redirects is checked again (collect.py calls
back), so ``example.com.ar`` redirecting to an excluded ``example.edu.ar`` stops
the site phase there.

Sources, merged: the file given with --exclude (or the SITE_CHECK_EXCLUDE
environment variable) and ``<output root>/exclude.txt`` when it exists. A
missing file is an empty list.

Format: one domain per line; ``#`` starts a comment; blank lines are ignored;
anything after the first word is a note ("example.org asked on 2026-10-10").
A pasted URL or ``*.example.org`` is read as its domain, and a pasted address
("Office <info@example.org>") as the domain of the address.

Matching: an entry matches a host when the host without "www." equals the entry
or ends with "." + entry, so "network.edu.ar" covers every site under it while
"a.network.edu.ar" covers only that one. Entries are normalized locally
(lowercase, no trailing dot, no port, IDNA for accented labels): this check runs
before anything else and must not depend on the network modules.

The list never fails open:

* encodings: UTF-8 with or without a BOM, UTF-16 with a BOM, and BOM-less or
  mixed UTF-16 LE (PowerShell 5.1 ">>" appends UTF-16 LE to a UTF-8 file): NUL
  bytes and stray BOMs are dropped, then UTF-8, else windows-1252;
* a line that still cannot be read (not a domain, or only the address of a free
  mail service such as gmail.com, which does not say which site it is) STOPS
  the run before any request (exit 2, the console names the file and the line).

Dedupe lives here too: ``prior_runs`` lists the dated run folders the domain
already has, for a console warning and datos.json meta.corridas_previas.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from . import domains

EXCLUDE_FILE = "exclude.txt"
ENV_VAR = "SITE_CHECK_EXCLUDE"
PROBLEM_NOT_A_DOMAIN = "not-a-domain"
PROBLEM_FREE_MAIL = "free-mail"

_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_RUN_DIR_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$")
# An e-mail address pasted on the line ("Office <info@example.org>").
_EMAIL_DOMAIN_RE = re.compile(r"[A-Za-z0-9._%+-]+@([^\s<>()\[\],;:\"']+)")


def _host_from(text: str) -> str | None:
    """The host part of a pasted URL or bare host; None when there is none."""
    text = text.strip()
    if not text:
        return None
    if "://" in text:
        try:
            host = urlsplit(text).hostname
        except ValueError:
            return None
        return host or None
    text = text.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    if "@" in text:
        text = text.rsplit("@", 1)[1]
    if text.startswith("["):
        return None  # IPv6 literal: never a domain entry
    return text.split(":", 1)[0] or None


def _normalize_host(host: str) -> str | None:
    """Comparable ASCII host (lowercase, no trailing dot, IDNA); None when it is not a domain name."""
    host = host.strip().rstrip(".").lower()
    if not host:
        return None
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    labels = ascii_host.split(".")
    if len(labels) < 2 or not all(_LABEL_RE.match(label) for label in labels):
        return None
    if all(label.isdigit() for label in labels):
        return None  # an IPv4 address is not a domain
    return ascii_host


def _strip_www(host: str) -> str:
    return host[4:] if host.startswith("www.") and host.count(".") >= 2 else host


def decode_list(data: bytes) -> str:
    """The text of a list file, whatever editor or shell saved it.

    UTF-16 with a BOM; UTF-8 with or without a BOM; and, when NUL bytes remain
    (BOM-less UTF-16 LE, or UTF-16 LE appended to a UTF-8 file), the NULs and
    stray BOMs dropped and the rest read as UTF-8, else windows-1252. A line
    garbled beyond repair stays garbled, and the caller stops the run on it.
    """
    if data.startswith((b"\xff\xfe", b"\xfe\xff")) and b"\x00" in data[2:]:
        text = data.decode("utf-16", errors="replace")
    else:
        if b"\x00" in data:
            for junk in (b"\x00", b"\xef\xbb\xbf", b"\xff\xfe", b"\xfe\xff"):
                data = data.replace(junk, b"")
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("cp1252", errors="replace")  # domains are ASCII anyway
    return text.replace("\ufeff", "")


def parse_line(line: str) -> tuple[list[str], str | None]:
    """(entries, problem) of one line: ([], None) for a blank or comment line.

    The entries are the first word when it is a domain (a note may follow, a
    pasted URL or "*.example.org" counts) and the domain of an e-mail address
    on the line; both count when both are there (a list that blocks more never
    fails open). A line whose only domain is a free mail service's
    (PROBLEM_FREE_MAIL), or with no domain at all (PROBLEM_NOT_A_DOMAIN), is a
    problem.
    """
    content = (line or "").replace("\x00", "").replace("\ufeff", "").split("#", 1)[0].strip()
    if not content:
        return [], None
    entries: list[str] = []
    token = content.split()[0].strip("<>()[]\"'.,;")
    if token.startswith("*."):
        token = token[2:]
    if "@" not in token or "://" in token:
        raw = _host_from(token)
        host = _normalize_host(raw) if raw else None
        if host is not None:
            entries.append(_strip_www(host))
    free_mail = False
    for email in _EMAIL_DOMAIN_RE.finditer(content):
        if "://" in token and email.start() < len(token):
            continue  # user info of the pasted URL, already read as a host
        host = _normalize_host(email.group(1).strip(".>"))
        if host is None:
            continue
        host = _strip_www(host)
        if host in domains.FREE_MAIL_DOMAINS:
            free_mail = True
        elif host not in entries:
            entries.append(host)
    if entries:
        return entries, None
    return [], PROBLEM_FREE_MAIL if free_mail else PROBLEM_NOT_A_DOMAIN


@dataclass
class ExclusionList:
    entries: list[str] = field(default_factory=list)
    problems: list[tuple[Path, int, str]] = field(default_factory=list)  # (file, 1-based line, PROBLEM_*)
    sources: list[Path] = field(default_factory=list)  # the files read

    def match(self, host_or_url: str) -> str | None:
        """The matching entry for ``host_or_url``, or None."""
        raw = _host_from(host_or_url or "")
        host = _normalize_host(raw) if raw else None
        if host is None:
            return None
        host = _strip_www(host)
        for entry in self.entries:
            if host == entry or host.endswith("." + entry):
                return entry
        return None

    def problems_message(self) -> str:
        """For the console: which lines stopped the run and how to fix them."""
        where = "; ".join(
            f"{path}, line {lineno}" + (" (a free mail address does not say which site it is)" if problem == PROBLEM_FREE_MAIL else "")
            for path, lineno, problem in self.problems
        )
        return (
            f"the exclusion list has lines that are not a domain: {where}. No request was made. "
            "Fix them first: one domain per line (for example example.org), notes after the domain or after #."
        )


def _same_file(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return str(a) == str(b)


def load(files: Iterable[Path | None]) -> ExclusionList:
    """Read every existing file of ``files`` once (decode_list) and merge them."""
    result = ExclusionList()
    for candidate in files:
        if candidate is None:
            continue
        path = Path(candidate)
        if any(_same_file(path, seen) for seen in result.sources):
            continue
        try:
            data = path.read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            continue
        result.sources.append(path)
        for lineno, line in enumerate(decode_list(data).splitlines(), start=1):
            entries, problem = parse_line(line)
            if problem is not None:
                result.problems.append((path, lineno, problem))
                continue
            for entry in entries:
                if entry not in result.entries:
                    result.entries.append(entry)
    return result


def prior_runs(out_root: Path, registrable: str) -> list[str]:
    """Names of existing dated folders under ``out_root/<registrable>/`` (YYYY-MM-DD and YYYY-MM-DD-N), sorted."""
    base = Path(out_root) / registrable
    if not base.is_dir():
        return []
    found: list[tuple[str, int, str]] = []
    for child in base.iterdir():
        m = _RUN_DIR_RE.match(child.name)
        if m and child.is_dir():
            found.append((m.group(1), int(m.group(2) or 1), child.name))
    return [name for _, _, name in sorted(found)]
