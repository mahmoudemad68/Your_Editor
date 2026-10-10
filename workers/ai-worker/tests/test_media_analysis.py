"""Generated contract regressions; all documents are synthetic and contain no evaluation gold."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from pydantic import ValidationError

from editagent_ai_worker.contracts import MediaAnalysis, SpeechAnalysis
from editagent_ai_worker.infrastructure.speech_schema import parse_document

FIXTURES = Path(__file__).resolve().parents[3] / "packages/schemas/fixtures/media-analysis"


def fixture(name: str = "full") -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))  # type: ignore[no-any-return]


@pytest.mark.parametrize("name", ["minimal", "full", "partial-failure", "us202", "large-time"])
def test_generated_producer_roundtrip(name: str) -> None:
    document = fixture(name)
    model = MediaAnalysis(**document)
    assert json.loads(model.model_dump_json()) == document
    assert (
        model.model_dump() == document
    )  # Optional fields are absent, not auto-materialized nulls.
    assert MediaAnalysis.model_validate_json(model.model_dump_json()) == model


@pytest.mark.parametrize("time", ["1\n", "1\r\n", "01", "-1", "0.5", "NaN"])
def test_us202_f4_rejects_noncanonical_time(time: str) -> None:
    document = fixture("us202")["sections"]["audio"]["data"]["speech"]
    document["speechRegions"][0]["startUs"] = time
    with pytest.raises(ValidationError):
        SpeechAnalysis.model_validate(document)
    with pytest.raises((ValueError, jsonschema.ValidationError)):
        parse_document(document)


@pytest.mark.parametrize("version", [True, "1", 2, None])
def test_us202_f4_rejects_schema_version_mismatch(version: Any) -> None:
    document = fixture("us202")["sections"]["audio"]["data"]["speech"]
    document["schemaVersion"] = version
    with pytest.raises(ValidationError):
        SpeechAnalysis.model_validate(document)
    with pytest.raises((ValueError, jsonschema.ValidationError)):
        parse_document(document)


def test_us202_f4_version_limits_agree_with_existing_parser() -> None:
    document = fixture("us202")["sections"]["audio"]["data"]["speech"]
    for version in ["x" * 32, "1.31.0"]:
        document["provenance"]["runtimeVersion"] = version
        assert SpeechAnalysis.model_validate(document).model_dump() == document
        parse_document(document)
    for version in ["x" * 33, "", "1.31.0\n"]:
        document["provenance"]["runtimeVersion"] = version
        with pytest.raises(ValidationError):
            SpeechAnalysis.model_validate(document)
        with pytest.raises((ValueError, jsonschema.ValidationError)):
            parse_document(document)


@pytest.mark.parametrize("confidence", [math.nan, math.inf, -math.inf, True, "0.5"])
def test_numeric_values_do_not_coerce_or_accept_nonfinite(confidence: Any) -> None:
    document = fixture()
    document["sections"]["transcript"]["data"]["languageConfidence"] = confidence
    with pytest.raises(ValidationError):
        MediaAnalysis.model_validate(document)


@pytest.mark.parametrize("text", ["\ud800", "\udfff", "\ud800hello"])
def test_illformed_unicode_rejected(text: str) -> None:
    document = fixture()
    document["sections"]["transcript"]["data"]["segments"][0]["text"] = text
    with pytest.raises(ValidationError):
        MediaAnalysis.model_validate(document)


def test_prototype_shaped_keys_and_null_rejected() -> None:
    pairs: list[tuple[str, Any]] = [("__proto__", {}), ("constructor", {}), ("unexpected", None)]
    for key, value in pairs:
        document = copy.deepcopy(fixture("minimal"))
        document[key] = value
        with pytest.raises(ValidationError):
            MediaAnalysis.model_validate(document)
