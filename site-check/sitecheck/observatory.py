"""MDN HTTP Observatory v2, optional evidence for EXT-01.

Only with --observatory. POST https://observatory-api.mdn.mozilla.net/api/v2/scan?host=<H>
(no body). Reads grade, score, tests_passed, tests_quantity. A host can be
rescanned at most every 60 s. Any error is recorded and never changes a state.
Note: the scan makes Mozilla request the measured site's home; that is why it is off.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode

from . import artifacts as art
from .scope import Purpose, ScopeError

if TYPE_CHECKING:
    from .artifacts import ArtifactStore
    from .httpclient import HttpClient

TIMEOUT_SECONDS = 60.0


@dataclass
class ObservatoryResult:
    host: str
    grade: str | None = None
    score: int | None = None
    tests_passed: int | None = None
    tests_quantity: int | None = None
    error: str | None = None


def _int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


class ObservatoryClient:
    def __init__(self, http: "HttpClient", endpoint: str, artifacts: "ArtifactStore") -> None:
        self._http = http
        self._endpoint = endpoint
        self._artifacts = artifacts

    def scan(self, host: str) -> ObservatoryResult:
        """One POST scan for ``host``; stores observatory.json; never raises except ScopeError."""
        result = ObservatoryResult(host=host)
        url = self._endpoint + "?" + urlencode({"host": host})
        try:
            resp = self._http.api_request("POST", url, purpose=Purpose.OBSERVATORY, body=b"", timeout=TIMEOUT_SECONDS)
        except ScopeError:
            raise
        except Exception as exc:
            result.error = type(exc).__name__
            resp = None
        if resp is not None:
            if resp.error or resp.status != 200:
                result.error = resp.error or f"http-{resp.status}"
            else:
                try:
                    obj = json.loads(resp.text()[0])
                except ValueError:
                    obj = None
                if not isinstance(obj, dict):
                    result.error = "not-json"
                else:
                    grade = obj.get("grade")
                    result.grade = grade if isinstance(grade, str) else None
                    result.score = _int(obj.get("score"))
                    result.tests_passed = _int(obj.get("tests_passed"))
                    result.tests_quantity = _int(obj.get("tests_quantity"))
                    if obj.get("error") and result.grade is None:
                        result.error = str(obj.get("error"))[:120]
        self._artifacts.put_json(art.OBSERVATORY, asdict(result))
        return result
