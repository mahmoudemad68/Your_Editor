"""Mock editing tools for the US-107 spike. Nothing here edits media."""

from __future__ import annotations

SOURCE_DURATION_SECONDS = 600.0

TOOLS: dict[str, dict[str, object]] = {
    "trim": {
        "description": "Keep the source between start_seconds and end_seconds.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["start_seconds", "end_seconds"],
            "properties": {
                "start_seconds": {"type": "number", "minimum": 0},
                "end_seconds": {"type": "number", "exclusiveMinimum": 0},
            },
        },
    },
    "add_caption": {
        "description": "Place a caption on the frame for a time range.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["text", "start_seconds", "end_seconds", "position"],
            "properties": {
                "text": {"type": "string"},
                "start_seconds": {"type": "number", "minimum": 0},
                "end_seconds": {"type": "number", "exclusiveMinimum": 0},
                "position": {"type": "string", "enum": ["top", "center", "bottom"]},
            },
        },
    },
    "reframe": {
        "description": "Convert the frame to an aspect ratio.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["aspect_ratio"],
            "properties": {
                "aspect_ratio": {"type": "string", "enum": ["9:16", "1:1", "16:9"]},
            },
        },
    },
}


def schema_errors(name: str, arguments: object) -> list[str]:
    schema = TOOLS.get(name)
    if schema is None:
        return [f"unknown tool {name}"]
    if not isinstance(arguments, dict):
        return ["arguments must be an object"]
    return _check(arguments, schema["parameters"])  # type: ignore[arg-type]


def _check(value: object, schema: dict[str, object]) -> list[str]:
    errors: list[str] = []
    expected = schema.get("type")
    if expected == "object":
        if not isinstance(value, dict):
            return ["expected object"]
        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            return ["schema properties must be an object"]
        if schema.get("additionalProperties") is False:
            extra = sorted(set(value) - set(properties))
            errors.extend(f"unexpected property {name}" for name in extra)
        required = schema.get("required", [])
        if isinstance(required, list):
            errors.extend(f"missing {name}" for name in required if name not in value)
        for key, prop in properties.items():
            if key in value and isinstance(prop, dict):
                errors.extend(_check(value[key], prop))
        return errors
    if expected == "string":
        if not isinstance(value, str):
            return ["expected string"]
        allowed = schema.get("enum")
        if isinstance(allowed, list) and value not in allowed:
            return [f"{value} is not an allowed value"]
        return errors
    if expected == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return ["expected number"]
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            return ["below minimum"]
        exclusive = schema.get("exclusiveMinimum")
        if isinstance(exclusive, (int, float)) and value <= exclusive:
            return ["not above exclusiveMinimum"]
        return errors
    return [f"unsupported schema type {expected}"]
