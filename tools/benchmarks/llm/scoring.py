"""Schema validity and semantic correctness are separate scores.

An empty tool-call list is not a schema-valid tool call. It is a correct
abstention only when the scripted request expects no calls.
"""

from __future__ import annotations

import json
from typing import Any

from tools import schema_errors

EXPECTED_MODES = frozenset({"calls", "no_calls"})


def parse_arguments(raw: object) -> tuple[object, str | None]:
    if isinstance(raw, dict):
        return raw, None
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            return None, str(exc)
        return parsed, None
    return None, "arguments are neither an object nor a JSON string"


def schema_valid(calls: list[dict[str, Any]], expected_mode: str) -> bool:
    """True only when the model returned one or more schema-valid tool calls.

    ``expected_mode`` is required so a caller cannot treat an empty list as
    valid without saying whether the scripted request expected calls.
    Empty calls are never schema-valid tool calls, including when abstaining
    was the right edit.
    """

    if expected_mode not in EXPECTED_MODES:
        raise ValueError(f"unknown expected mode {expected_mode}")
    if not calls:
        return False
    for call in calls:
        arguments, error = parse_arguments(call.get("arguments"))
        if error is not None:
            return False
        if schema_errors(str(call.get("name")), arguments):
            return False
    return True


def _same_arguments(expected: dict[str, Any], actual: object) -> bool:
    parsed, error = parse_arguments(actual)
    if error is not None or not isinstance(parsed, dict):
        return False
    if set(parsed) != set(expected):
        return False
    for key, value in expected.items():
        other = parsed[key]
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if isinstance(other, bool) or not isinstance(other, (int, float)):
                return False
            if abs(float(other) - float(value)) > 1e-6:
                return False
        elif other != value:
            return False
    return True


def semantic_match(expected: dict[str, Any], calls: list[dict[str, Any]]) -> bool:
    mode = expected["mode"]
    if mode == "no_calls":
        return calls == []
    if mode != "calls":
        raise ValueError(f"unknown expected mode {mode}")
    wanted = expected["calls"]
    if not isinstance(wanted, list) or len(wanted) != len(calls):
        return False
    remaining = calls.copy()
    for item in wanted:
        match = next(
            (
                call
                for call in remaining
                if call.get("name") == item["name"]
                and _same_arguments(item["arguments"], call.get("arguments"))
            ),
            None,
        )
        if match is None:
            return False
        remaining.remove(match)
    return True


def score_case(case: dict[str, Any], calls: list[dict[str, Any]]) -> dict[str, bool]:
    expected = case["expected"]
    mode = str(expected["mode"])
    tool_call_valid = schema_valid(calls, mode)
    abstention = calls == [] and mode == "no_calls"
    return {
        # Schema-valid tool calls only. Correct abstention is a different field.
        "schema_valid": tool_call_valid,
        "schema_valid_tool_call": tool_call_valid,
        "correct_abstention": abstention,
        "valid_outcome": tool_call_valid or abstention,
        "semantic_correct": semantic_match(expected, calls),
    }
