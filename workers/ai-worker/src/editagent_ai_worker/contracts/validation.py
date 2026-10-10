"""Generic schema-owned relational rules and JSON scalar semantics, not contract definitions."""

from __future__ import annotations

import math
import re
from typing import Any, get_args

from pydantic import BaseModel, ConfigDict, model_validator


def json_integer(value: Any) -> int:
    if type(value) is int:
        return value
    if (
        type(value) is float
        and math.isfinite(value)
        and value.is_integer()
        and abs(value) <= 9007199254740991
    ):
        return int(value)  # JSON 1.0 and 1 denote the same integer; never coerce strings/bools.
    raise ValueError("Expected a JSON integer")


def text_rules(value: str, minimum: int, maximum: int | None, patterns: tuple[str, ...]) -> str:
    value.encode("utf-8", errors="strict")
    if (
        len(value) < minimum
        or (maximum is not None and len(value) > maximum)
        or any(re.search(p, value) is None for p in patterns)
    ):
        raise ValueError("Text violates canonical schema")
    return value


def at(value: Any, path: str) -> Any:
    for key in path.split("."):
        if isinstance(value, BaseModel):
            value = getattr(value, key, None)
        elif isinstance(value, dict):
            value = value.get(key)
        else:
            return None
    return value


def records(value: Any, field: str) -> list[Any]:
    return at(value, field) or []


def check_rules(value: Any, rules: list[dict[str, Any]]) -> bool:
    for rule in rules:
        kind = rule["kind"]
        field = rule.get("field", "")
        n = int if rule.get("decimal") else float
        left, right = at(value, rule.get("left", "")), at(value, rule.get("right", ""))
        if kind == "positive":
            if at(value, field) is not None and n(at(value, field)) <= 0:
                return False
        elif kind == "maximum":
            if at(value, field) is not None and n(at(value, field)) > n(rule["value"]):
                return False
        elif kind == "less":
            if n(left) >= n(right):
                return False
        elif kind == "lessEqual":
            if n(left) > n(right):
                return False
        elif kind == "sameWhenPresent":
            if right is not None and left != right:
                return False
        elif kind == "together":
            count = sum(at(value, key) is not None for key in rule["fields"])
            if count not in (0, len(rule["fields"])):
                return False
        elif kind == "sumMax":
            if sum(float(at(value, key)) for key in rule["fields"]) > rule["maximum"]:
                return False
        elif kind == "unique":
            keys = [at(item, rule["key"]) for item in records(value, field)]
            if len(set(keys)) != len(keys):
                return False
        elif kind == "nestedCount":
            if (
                sum(len(records(item, rule["child"])) for item in records(value, field))
                > rule["maximum"]
            ):
                return False
        elif kind == "orderedRanges":
            previous = 0
            for item in records(value, field):
                start, end = int(at(item, rule["start"])), int(at(item, rule["end"]))
                if start < previous or start >= end:
                    return False
                previous = end
        elif kind == "orderedPoints":
            previous = -1
            for item in records(value, field):
                time = int(at(item, rule["time"]))
                if time <= previous:
                    return False
                previous = time
        elif kind in ("rangesWithin", "pointsWithin"):
            lower, upper = int(at(value, rule["lower"])), int(at(value, rule["upper"]))
            for item in records(value, field):
                if kind == "pointsWithin":
                    time = int(at(item, rule["time"]))
                    if time < lower or time >= upper:
                        return False
                elif int(at(item, rule["start"])) < lower or int(at(item, rule["end"])) > upper:
                    return False
        elif kind == "rotatedDimensions":
            width, height = at(value, rule["width"]), at(value, rule["height"])
            rotation = at(value, rule["rotation"])
            if width is None:
                if rotation is not None:
                    return False
            else:
                swaps = rotation in (90, 270)
                if at(value, rule["displayWidth"]) != (height if swaps else width) or at(
                    value, rule["displayHeight"]
                ) != (width if swaps else height):
                    return False
        elif kind == "timesWithin":
            duration = at(value, rule["duration"])
            if not all(
                times_within(at(value, key), duration, rule["timeKeys"]) for key in rule["fields"]
            ):
                return False
        else:
            raise ValueError("Unsupported schema-owned contract rule")
    return True


def times_within(item: Any, duration: str | None, time_keys: list[str]) -> bool:
    if isinstance(item, BaseModel):
        item = item.model_dump(exclude_unset=True)
    if isinstance(item, list):
        return all(times_within(value, duration, time_keys) for value in item)
    if not isinstance(item, dict):
        return True
    return all(
        (duration is not None and int(value) <= int(duration))
        if key in time_keys
        else times_within(value, duration, time_keys)
        for key, value in item.items()
    )


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def canonical_object(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            raise ValueError("Expected a JSON object")
        if any(v is None for v in value.values()):
            raise ValueError("Optional values must be absent, not null")
        # Pydantic Literal[1] otherwise equates True and 1, contrary to JSON Schema.
        for key, field in cls.model_fields.items():
            if (
                key in value
                and isinstance(value[key], bool)
                and field.annotation is not bool
                and not any(type(arg) is bool for arg in get_args(field.annotation))
            ):
                raise ValueError("Boolean is not a numeric/string literal")
        return value

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        kwargs.setdefault("exclude_unset", True)
        return super().model_dump(**kwargs)

    def model_dump_json(self, **kwargs: Any) -> str:
        kwargs.setdefault("exclude_unset", True)
        return super().model_dump_json(**kwargs)
