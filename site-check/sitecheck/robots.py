"""robots.txt per RFC 9309: our own parser and matcher.

Trap : urllib.robotparser uses first-match and has no wildcards, so
it gives wrong answers for real WordPress robots files. Rules implemented here:

* groups start with one or more ``User-agent`` lines; rules (Allow/Disallow) after
  them belong to the group; groups for the same agent are merged (RFC 9309 2.2.1);
* group selection: the group whose product token matches "googlebot"
  (case-insensitive), else the "*" group, else no rules (everything allowed);
* matching: the LONGEST matching pattern wins; on a tie, Allow wins; ``*`` matches
  any sequence, ``$`` anchors the end; an empty Disallow allows everything;
* ``Sitemap:`` lines are global, in file order, whatever group they sit in.

Response classification : valid only with status 200, a text/plain
Content-Type and a body that is not HTML.
4xx = no restrictions (RFC 9309 2.3.1.3); 5xx = unreachable, treated as a full
disallow (2.3.1.4).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING
from urllib.parse import quote, unquote

if TYPE_CHECKING:
    from .httpclient import Response

# Characters left unescaped when a path or pattern is normalized for matching
# ("*" and "$" stay literal so patterns keep their wildcards).
_NORMALIZE_SAFE = "/:@!$&'()*+,;=-._~?"
_BOM = chr(0xFEFF)


class RobotsState(StrEnum):
    OK = "ok"
    NO_RESTRICTIONS_4XX = "4xx"
    UNREACHABLE_5XX = "5xx"
    CHALLENGED = "challenged"  # HTML instead of text, or flagged by the detector
    INVALID = "invalid"  # 200 but not text/plain
    SOFT_404 = "soft-404"  # an HTML "not found" page (or the home itself) served with 200: no robots.txt
    ERROR = "error"  # no response
    NOT_FETCHED = "not-fetched"  # skipped (budget, blocked)


@dataclass
class RobotsGroup:
    agents: list[str] = field(default_factory=list)  # lowercased product tokens
    rules: list[tuple[bool, str]] = field(default_factory=list)  # (allow?, pattern)


@dataclass
class RobotsTxt:
    groups: list[RobotsGroup] = field(default_factory=list)
    sitemaps: list[str] = field(default_factory=list)  # absolute URLs as written


def _product_token(value: str) -> str:
    token = value.strip().split()[0] if value.strip() else ""
    return token.split("/", 1)[0].lower()


def parse_robots(text: str) -> RobotsTxt:
    """Parse a robots.txt body. Tolerant: unknown lines and comments are ignored."""
    result = RobotsTxt()
    current: RobotsGroup | None = None
    last_was_agent = False
    for raw in text.lstrip(_BOM).splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower()
        value = value.strip()
        if key == "user-agent":
            token = _product_token(value)
            if current is None or not last_was_agent:
                current = RobotsGroup()
                result.groups.append(current)
            if token:
                current.agents.append(token)
            last_was_agent = True
            continue
        if key in ("allow", "disallow"):
            last_was_agent = False
            if current is None:
                continue  # rules before any User-agent line belong to no group
            if value:  # an empty Disallow (or Allow) allows everything: no rule
                current.rules.append((key == "allow", value))
            continue
        if key == "sitemap":
            if value:
                result.sitemaps.append(value)
            continue
        # Other lines (crawl-delay, host...) end a run of User-agent lines too.
        last_was_agent = False
    return result


def _normalize(path: str) -> str:
    """Normalize percent-encoding so equivalent spellings compare equal."""
    return quote(unquote(path), safe=_NORMALIZE_SAFE)


def pattern_matches(pattern: str, path: str) -> bool:
    """RFC 9309 match of one (normalized) pattern against a (normalized) path, in linear time.

    ``*`` matches any sequence and a final ``$`` anchors the end; otherwise the
    pattern matches a prefix. The pattern is split on ``*`` into literal pieces:
    the first must be a prefix of the path and the others are placed, in order,
    at their LEFTMOST occurrence (str.find), which is optimal for a glob with
    ``*`` only. Translating ``*`` to a regex ``.*`` backtracked exponentially
    with many stars.
    """
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    pieces = body.split("*")
    first, rest = pieces[0], pieces[1:]
    if not path.startswith(first):
        return False
    if not rest:  # no star
        return path == first if anchored else True
    pos = len(first)
    if anchored:
        last = rest[-1]
        middle = rest[:-1]
    else:
        last = None
        middle = rest
    for piece in middle:
        if not piece:
            continue
        i = path.find(piece, pos)
        if i < 0:
            return False
        pos = i + len(piece)
    if last is None:
        return True
    return path.endswith(last) and len(path) - len(last) >= pos


def _select_rules(robots: RobotsTxt, user_agent: str) -> list[tuple[bool, str]]:
    ua = user_agent.strip().lower()
    groups: list[RobotsGroup] = []
    if ua != "*":
        groups = [g for g in robots.groups if ua in g.agents]
    if not groups:
        groups = [g for g in robots.groups if "*" in g.agents]
    rules: list[tuple[bool, str]] = []
    for g in groups:  # RFC 9309 2.2.1: groups for the same agent are merged
        rules.extend(g.rules)
    return rules


def is_allowed(robots: RobotsTxt, path: str, user_agent: str = "googlebot") -> bool:
    """RFC 9309 decision for ``path`` (path plus optional query) and ``user_agent``.

    ``user_agent`` "googlebot" falls back to "*"; "*" uses the "*" group only.
    Percent-encoding is normalized on both sides before matching.
    """
    rules = _select_rules(robots, user_agent)
    if not rules:
        return True
    target = _normalize(path if path.startswith("/") else "/" + path)
    best_len = -1
    best_allow = True
    for allow, pattern in rules:
        normalized = _normalize(pattern)
        if not normalized.startswith("/") and not normalized.startswith("*"):
            normalized = "/" + normalized
        if not pattern_matches(normalized, target):
            continue
        length = len(normalized)
        if length > best_len or (length == best_len and allow and not best_allow):
            best_len, best_allow = length, allow
    return best_allow if best_len >= 0 else True


def _looks_like_html(body: bytes) -> bool:
    head = bytes(body[:1024]).lower().lstrip(b" \t\r\n" + bytes([0xEF, 0xBB, 0xBF]))
    return head.startswith(b"<!doctype html") or head.startswith(b"<html") or b"<body" in head or b"<head" in head


def classify_response(resp: "Response | None") -> RobotsState:
    """Classify the robots.txt response per the module docstring."""
    if resp is None:
        return RobotsState.ERROR
    if resp.skipped:
        return RobotsState.NOT_FETCHED
    if resp.error or resp.status is None:
        return RobotsState.ERROR
    if resp.challenge:
        return RobotsState.CHALLENGED
    if getattr(resp, "soft_404", False):
        return RobotsState.SOFT_404
    status = resp.status
    if status == 200:
        if _looks_like_html(resp.body):
            return RobotsState.CHALLENGED
        if resp.content_type == "text/plain" and not resp.undecodable_encoding:
            return RobotsState.OK
        return RobotsState.INVALID
    if 400 <= status < 500:
        return RobotsState.NO_RESTRICTIONS_4XX
    if 500 <= status < 600:
        return RobotsState.UNREACHABLE_5XX
    return RobotsState.INVALID
