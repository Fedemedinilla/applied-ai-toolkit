"""The per-run REQUEST LOG.

Every connection attempt of the run, allowed or refused, becomes one JSON line in
``evidencia/requests.log``, written and flushed immediately (a crash keeps what
was already done). It answers exactly "¿qué le hicieron a nuestro sitio?" and
feeds the report sentence about how many requests were made and in how long.

The key never appears: URLs are passed through the Redactor, and the client
refuses to build a URL with the key in the first place (defence in depth).
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .credentials import Redactor


class Outcome:
    """Values of RequestRecord.outcome."""

    OK = "ok"  # a response (any status) was received
    ERROR = "error"  # network error: dns, refused, timeout, tls
    REFUSED_SCOPE = "refused-scope"  # ScopeError: never sent
    SKIPPED_BUDGET = "skipped-budget"  # the 90-request site budget was spent
    SKIPPED_BLOCKED = "skipped-blocked"  # the host was cut after a repeated challenge
    SKIPPED_NO_CONTACT = "skipped-no-contact"  # final host is on the exclusion list


_LF = chr(10)
_KINDS: tuple[str, ...] =("site", "control", "external", "api", "dns", "tls")
_OUTCOMES: tuple[str, ...] = (
    Outcome.OK,
    Outcome.ERROR,
    Outcome.REFUSED_SCOPE,
    Outcome.SKIPPED_BUDGET,
    Outcome.SKIPPED_BLOCKED,
    Outcome.SKIPPED_NO_CONTACT,
)


def utc_now_iso() -> str:
    """Current UTC time as ISO 8601 with milliseconds (the ts_utc format)."""
    return dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class RequestRecord:
    """One line of requests.log. Field names are the JSON keys."""

    seq: int  # 1-based, in send order
    ts_utc: str  # ISO 8601 UTC, when the attempt started
    kind: str  # scope.RequestKind value
    purpose: str  # scope.Purpose value
    method: str  # "GET", "POST", "TLS", "DNS"
    url: str  # redacted; for TLS "tls://host:443", for DNS "dns:<name>"
    host: str
    status: int | None
    bytes_raw: int  # bytes on the wire (compressed body)
    ms: float | None  # total time of this attempt
    ttfb_ms: float | None
    sha256_prefix: str | None  # first 16 hex chars of the decoded body hash
    hop: int  # 0 for the first request of a chain, 1.. for redirect hops
    challenge: str | None  # ChallengeVerdict.describe when flagged
    outcome: str  # Outcome value
    error: str | None  # short English reason, redacted

    def to_json(self) -> str:
        """Return the record as one JSON line (sort_keys=True, ensure_ascii=False)."""
        return json.dumps(dataclasses.asdict(self), sort_keys=True, ensure_ascii=False)


class RequestLog:
    """Append-only log of the run. ``path`` None keeps it in memory only (unit tests)."""

    def __init__(self, path: Path | None, redactor: "Redactor") -> None:
        self._path = path
        self._redactor = redactor
        self._records: list[RequestRecord] = []
        self._seq = 0
        self.write_errors = 0  # lines that could not be written to disk (kept in memory)
        if path is not None:
            # The file is opened, appended and closed per record: a crash keeps
            # every line already written, and no handle stays open (Windows
            # cannot delete a folder with an open file).
            path.parent.mkdir(parents=True, exist_ok=True)

    def next_seq(self) -> int:
        """Reserve and return the next sequence number."""
        self._seq += 1
        return self._seq

    def record(self, rec: RequestRecord) -> None:
        """Append one record: redact url and error, write the JSON line, flush.

        The url also goes through artifacts.mask_personal_data: a refused /author/<user>/ hop never names the user.
        """
        from .artifacts import mask_personal_data

        clean = dataclasses.replace(
            rec,
            url=mask_personal_data(self._redactor.scrub(rec.url)),
            host=self._redactor.scrub(rec.host),
            error=self._redactor.scrub(rec.error) if rec.error else rec.error,
            challenge=self._redactor.scrub(rec.challenge) if rec.challenge else rec.challenge,
        )
        self._records.append(clean)
        if self._path is None:
            return
        try:
            with open(self._path, "a", encoding="utf-8", newline=_LF) as fh:
                fh.write(clean.to_json() + _LF)
                fh.flush()
        except OSError:
            self.write_errors += 1

    def records(self) -> list[RequestRecord]:
        """All records so far, in seq order."""
        return sorted(self._records, key=lambda r: r.seq)

    def counts(self) -> dict[str, int]:
        """Counts by kind and by outcome, e.g. {"site": 41, "api": 9, "refused-scope": 0, ...}.

        Kind counts include only attempts that went out (outcome "ok" or
        "error"); skipped and refused attempts appear only under their outcome.
        "total" is every record.
        """
        out: dict[str, int] = {k: 0 for k in _KINDS}
        out.update({o: 0 for o in _OUTCOMES})
        for r in self._records:
            out[r.outcome] = out.get(r.outcome, 0) + 1
            if r.outcome in (Outcome.OK, Outcome.ERROR):
                out[r.kind] = out.get(r.kind, 0) + 1
        out["total"] = len(self._records)
        return out

    def site_window(self) -> tuple[str | None, str | None]:
        """UTC timestamps of the first and last SITE/TLS request (for "N pedidos en M minutos")."""
        stamps = [
            r.ts_utc
            for r in self.records()
            if r.kind in ("site", "tls") and r.outcome in (Outcome.OK, Outcome.ERROR) and r.ts_utc
        ]
        if not stamps:
            return None, None
        return min(stamps), max(stamps)
