"""A validator for the part of JSON Schema that schema/run.schema.json uses. Standard library only.

Keywords: type (a name or a list of names), enum, const, properties, required,
additionalProperties (a boolean or a schema), propertyNames, items, anyOf,
pattern, minimum, maximum, and $ref to "#/$defs/<name>". Any other keyword in
a schema raises, so a schema that grows past this subset fails its test
instead of being half checked. "$schema", "$id", "$defs", "title" and
"description" are annotations.
"""

from __future__ import annotations

import re
from typing import Any

ANNOTATIONS = frozenset({"$schema", "$id", "$defs", "title", "description"})
KEYWORDS = frozenset({
    "type", "enum", "const", "properties", "required", "additionalProperties", "propertyNames", "items", "anyOf",
    "pattern", "minimum", "maximum", "$ref",
})


def _is(value: Any, name: str) -> bool:
    if name == "null":
        return value is None
    if name == "boolean":
        return isinstance(value, bool)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "string":
        return isinstance(value, str)
    if name == "array":
        return isinstance(value, list)
    if name == "object":
        return isinstance(value, dict)
    raise ValueError(f"unknown type {name!r}")


def validate(value: Any, schema: dict[str, Any], root: dict[str, Any] | None = None, path: str = "$") -> list[str]:
    """Every problem of ``value`` against ``schema``, as "path: what"; empty when it is valid."""
    root = root if root is not None else schema
    unknown = set(schema) - KEYWORDS - ANNOTATIONS
    if unknown:
        raise ValueError(f"{path}: schema keywords outside the subset: {sorted(unknown)}")
    if "$ref" in schema:
        prefix = "#/$defs/"
        ref = schema["$ref"]
        if not ref.startswith(prefix):
            raise ValueError(f"{path}: only {prefix}<name> references are read, not {ref!r}")
        return validate(value, root["$defs"][ref[len(prefix):]], root, path)
    problems: list[str] = []
    if "type" in schema:
        names = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_is(value, name) for name in names):
            return [f"{path}: expected {' or '.join(names)}, got {type(value).__name__}"]
    if "const" in schema and (value != schema["const"] or type(value) is not type(schema["const"])):
        problems.append(f"{path}: expected {schema['const']!r}, got {value!r}")
    if "enum" in schema and not any(value == item and type(value) is type(item) for item in schema["enum"]):
        problems.append(f"{path}: {value!r} is not one of {schema['enum']!r}")
    if "anyOf" in schema and all(validate(value, option, root, path) for option in schema["anyOf"]):
        problems.append(f"{path}: matches none of the {len(schema['anyOf'])} alternatives")
    if isinstance(value, str) and "pattern" in schema and not re.search(schema["pattern"], value):
        problems.append(f"{path}: {value!r} does not match {schema['pattern']!r}")
    if _is(value, "number"):
        if "minimum" in schema and value < schema["minimum"]:
            problems.append(f"{path}: {value} is below {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            problems.append(f"{path}: {value} is above {schema['maximum']}")
    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            problems += validate(item, schema["items"], root, f"{path}[{index}]")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                problems.append(f"{path}: missing {name!r}")
        extra = schema.get("additionalProperties", True)
        for name, item in value.items():
            if "propertyNames" in schema:
                problems += validate(name, schema["propertyNames"], root, f"{path}.{name} (name)")
            if name in properties:
                problems += validate(item, properties[name], root, f"{path}.{name}")
            elif extra is False:
                problems.append(f"{path}: unexpected {name!r}")
            elif isinstance(extra, dict):
                problems += validate(item, extra, root, f"{path}.{name}")
    return problems
