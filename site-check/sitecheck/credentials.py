"""PageSpeed API key loading and secret redaction.

The key comes only from the environment variable PAGESPEED_API_KEY. It is sent
only in the ``X-goog-api-key`` header and never appears in a URL, a log line,
datos.json, an evidence file or an exception message. The tool never reads a
key file, and a ``.env`` inside the repository is never looked at.

Test isolation: in test mode (any ``--test-*`` flag, see
config.RunConfig.test_mode) PAGESPEED_API_KEY is ignored; the key is
SITE_CHECK_TEST_API_KEY or FAKE_TEST_KEY. Otherwise a test flag would become a
channel to send the real key to an arbitrary server.
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

ENV_VAR = "PAGESPEED_API_KEY"
TEST_ENV_VAR = "SITE_CHECK_TEST_API_KEY"
FAKE_TEST_KEY = "FAKE-TEST-KEY-not-a-secret-0000"

# Shorter values are refused: the Redactor cannot scrub them safely and no
# Google API key is that short.
MIN_KEY_LENGTH = 8

# How a key is spelled in datos.json: only presence, never the value.
PRESENT = "presente"
ABSENT = "ausente"


@dataclass(frozen=True)
class ApiKey:
    """A Google API key, or its absence.

    ``source`` is one of "env", "test", "none". ``__repr__`` and ``__str__``
    never include ``value`` (the explicit __repr__ below wins over the
    dataclass-generated one), so a key printed by accident shows nothing.
    """

    value: str | None
    source: str
    # Why a configured key was not usable ("env key too short"), never the content.
    problem: str | None = None

    @property
    def present(self) -> bool:
        """True when a non-empty key is available."""
        return bool(self.value)

    def as_datos(self) -> str:
        """Return PRESENT or ABSENT, the only form that reaches datos.json."""
        return PRESENT if self.present else ABSENT

    def __repr__(self) -> str:  # never leak the value
        return f"ApiKey(source={self.source!r}, present={self.present})"

    __str__ = __repr__


def _usable(value: str | None, source: str) -> ApiKey:
    if not value:
        return ApiKey(None, "none")
    if len(value) < MIN_KEY_LENGTH:
        return ApiKey(None, "none", problem=f"{source} key too short")
    return ApiKey(value, source)


def load_api_key(*, test_mode: bool, environ: Mapping[str, str] | None = None) -> ApiKey:
    """Load the PageSpeed key.

    Normal mode: ``environ[ENV_VAR]`` (source "env"), else ``ApiKey(None, "none")``.
    Without a key PageSpeed still answers, with a lower quota.

    Test mode: ignores ENV_VAR; returns ``environ[TEST_ENV_VAR]`` or
    FAKE_TEST_KEY with source "test". A TEST_ENV_VAR set to the empty string
    means "no key" (source "none"), so tests can exercise the keyless path.
    ``environ`` defaults to os.environ.
    """
    env: Mapping[str, str] = os.environ if environ is None else environ
    if test_mode:
        if TEST_ENV_VAR in env:
            return _usable((env.get(TEST_ENV_VAR) or "").strip() or None, "test")
        return ApiKey(FAKE_TEST_KEY, "test")
    return _usable((env.get(ENV_VAR) or "").strip() or None, "env")


class Redactor:
    """Removes secrets from any text or bytes before it is logged or written.

    Built with every secret of the run (today only the API key). The
    replacement is the fixed string "[REDACTED]". Used by RequestLog,
    ArtifactStore, exception messages and the final output sweep.
    """

    REPLACEMENT = "[REDACTED]"

    def __init__(self, secrets: Iterable[str | None]) -> None:
        """Keep the non-empty secrets (shorter than 8 chars are refused: ValueError)."""
        forms: set[str] = set()
        for secret in secrets:
            if not secret:
                continue
            if len(secret) < MIN_KEY_LENGTH:
                raise ValueError("secret too short to be redacted safely")
            forms.add(secret)
            # Defence in depth: the percent-encoded spelling a URL would carry.
            forms.add(quote(secret, safe=""))
        # Longest first, so a form that contains another is replaced whole.
        self._secrets: tuple[str, ...] = tuple(sorted(forms, key=len, reverse=True))
        self._secret_bytes: tuple[bytes, ...] = tuple(s.encode("utf-8") for s in self._secrets)

    def __repr__(self) -> str:  # never leak the secrets
        return f"Redactor(secrets={len(self._secrets)})"

    def scrub(self, text: str) -> str:
        """Return ``text`` with every occurrence of every secret replaced."""
        for secret in self._secrets:
            if secret in text:
                text = text.replace(secret, self.REPLACEMENT)
        return text

    def scrub_bytes(self, data: bytes) -> bytes:
        """Byte-level equivalent of scrub (UTF-8 encoded secrets)."""
        replacement = self.REPLACEMENT.encode("ascii")
        for secret in self._secret_bytes:
            if secret in data:
                data = data.replace(secret, replacement)
        return data

    def scrub_json(self, obj: Any) -> Any:
        """Return a deep copy of a JSON-like object with secrets scrubbed in keys and values."""
        if isinstance(obj, str):
            return self.scrub(obj)
        if isinstance(obj, dict):
            return {(self.scrub(k) if isinstance(k, str) else k): self.scrub_json(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self.scrub_json(v) for v in obj]
        return obj

    def contains_secret(self, data: str | bytes) -> bool:
        """True when any secret occurs in ``data`` (used by the output sweep)."""
        if isinstance(data, (bytes, bytearray)):
            return any(s in data for s in self._secret_bytes)
        return any(s in data for s in self._secrets)
