"""SARIF 2.1.0 output of a stored run: ``--sarif FILE``.

Built from the run as it is written to run.json (English names), never from
anything else, so the same run always gives the same bytes and every result
can be read back in run.json under its rule id.

Mapping (the colour is the severity of this tool; it is derived from the
state, the module and the priority of the rule, colours.py):

    red     "Fix now"               -> level "error"
    yellow  "Review"                -> level "warning"
    blue    "Optional improvement"  -> level "note"
    green, grey (not verified) and hidden (not applicable) -> no result

A result is a rule that did not pass on that site: state ``fail`` or
``pass_with_note``, both printed under "What is worth fixing". A grey rule
could not be checked, which is not a finding about the site; the count of
grey rules is in the run's ``properties``.

The location is the page that was checked: ``artifactLocation.uri`` is the
canonical URL of the run (the input URL when the home never answered). A web
page has no lines, so there is no region. GitHub code scanning lists such a
result without attaching it to a file of the repository.

The message is the stored sentence of the rule (what was found, then what to
do) in the Spanish report, and the rule's fixed description in the report by
rule (--lang en): the same text each report prints for that rule.
"""

from __future__ import annotations

import hashlib
from typing import Any

from . import __version__
from .i18n import Catalog

SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json"
SARIF_VERSION = "2.1.0"
INFORMATION_URI = "https://github.com/Fedemedinilla/applied-ai-toolkit/tree/main/site-check"
# The partialFingerprints key. The version changes if the hash input ever does.
FINGERPRINT_KEY = "siteCheck/v1"
LEVEL_OF_COLOUR: dict[str, str] = {"red": "error", "yellow": "warning", "blue": "note"}
# The internal colour name of each public one, for the catalog keys.
_CATALOG_COLOUR = {"red": "rojo", "yellow": "amarillo", "blue": "azul"}


def fingerprint(rule_id: str, uri: str) -> str:
    """Stable for one rule on one page: a rule gives at most one result per run."""
    return hashlib.sha256(f"{rule_id}\0{uri}".encode("utf-8")).hexdigest()


def _end(text: str) -> str:
    text = text.strip()
    return text if not text or text[-1] in ".!?" else text + "."


def _message(check: dict[str, Any], cat: Catalog) -> str:
    name = cat.strings.get(f"check.{check['id']}.name") or str(check.get("name") or check["id"])
    if cat.by_rule:
        result = cat.strings.get(f"rules.result.{_internal_state(check)}") or cat["rules.result.other"]
        about = _end(cat.strings.get("check." + str(check["id"]) + ".about", ""))
        return f"{name}: {result}. {about}".strip()
    sentence = check.get("sentence") or {}
    parts = [_end(str(sentence.get(key) or "")) for key in ("found", "action")]
    return " ".join(p for p in parts if p) or name


def _internal_state(check: dict[str, Any]) -> str:
    from .runformat import STATES

    back = {public: internal for internal, public in STATES.items()}
    return back.get(str(check.get("state")), "")


def to_sarif(run: dict[str, Any], cat: Catalog) -> dict[str, Any]:
    """The SARIF log of a schema_version 2 run document, in the language of ``cat``."""
    meta = run.get("meta") or {}
    uri = str(meta.get("canonical_url") or meta.get("input_url") or "")
    checks = [c for c in run.get("checks") or [] if isinstance(c, dict) and c.get("id")]
    failed = [c for c in checks if c.get("colour") in LEVEL_OF_COLOUR]
    rules: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    for index, check in enumerate(failed):
        rule_id = str(check["id"])
        colour = str(check["colour"])
        level = LEVEL_OF_COLOUR[colour]
        rules.append(
            {
                "id": rule_id,
                "shortDescription": {"text": cat.strings.get(f"check.{rule_id}.name") or str(check.get("name") or rule_id)},
                "fullDescription": {"text": cat.strings.get(f"check.{rule_id}.about") or str(check.get("name") or rule_id)},
                "defaultConfiguration": {"level": level},
                "properties": {"module": check.get("module"), "priority": check.get("priority")},
            }
        )
        results.append(
            {
                "ruleId": rule_id,
                "ruleIndex": index,
                "level": level,
                "message": {"text": _message(check, cat)},
                "locations": [{"physicalLocation": {"artifactLocation": {"uri": uri}}}],
                "partialFingerprints": {FINGERPRINT_KEY: fingerprint(rule_id, uri)},
                "properties": {
                    "state": check.get("state"),
                    "colour": colour,
                    "label": cat[f"colour.{_CATALOG_COLOUR[colour]}.label"],
                    "evidence": list(check.get("evidence") or []),
                },
            }
        )
    output = run.get("output") or {}
    return {
        "$schema": SARIF_SCHEMA,
        "version": SARIF_VERSION,
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "site-check",
                        "version": __version__,
                        "informationUri": INFORMATION_URI,
                        "rules": rules,
                    }
                },
                "invocations": [{"executionSuccessful": output.get("code") in (0, 30), "exitCode": output.get("code")}],
                "results": results,
                "properties": {
                    "domain": meta.get("domain"),
                    "startedUtc": meta.get("started_utc"),
                    "language": cat.lang,
                    "checks": len(checks),
                    "notVerified": sum(1 for c in checks if c.get("colour") == "grey"),
                    "notApplicable": sum(1 for c in checks if c.get("state") == "not_applicable"),
                },
            }
        ],
    }
