"""Persisted readers coexist; migration changes only the document version."""

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from editagent_ai_worker.contracts import (
    migrate_media_analysis_v1_to_v1_1,
    parse_media_analysis,
    validate_media_analysis_v1,
    validate_media_analysis_v1_1,
)

FIXTURES = Path(__file__).resolve().parents[3] / "packages/schemas/fixtures/media-analysis"


@pytest.mark.parametrize("name", ["minimal", "full", "partial-failure", "us202", "large-time"])
def test_exact_readers_and_pure_migration(name: str) -> None:
    value: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    before = copy.deepcopy(value)
    validate_media_analysis_v1(value)
    latest = migrate_media_analysis_v1_to_v1_1(value).model_dump(mode="json")
    assert value == before
    assert latest == {**before, "schemaVersion": "1.1.0"}
    assert "shortTermLoudness" not in latest["sections"]["audio"].get("data", {})
    assert parse_media_analysis(latest).model_dump(mode="json") == latest
    validate_media_analysis_v1_1(latest)
    with pytest.raises(ValueError):
        validate_media_analysis_v1(latest)
    with pytest.raises(ValueError):
        validate_media_analysis_v1_1(value)


@pytest.mark.parametrize("version", ["1.2.0", "2.0.0", "1.1", 1, None])
def test_unknown_version_and_invalid_migration_rejected(version: object) -> None:
    value = json.loads((FIXTURES / "minimal.json").read_text())
    value["schemaVersion"] = version
    with pytest.raises(ValueError):
        parse_media_analysis(value)
    with pytest.raises(ValueError):
        migrate_media_analysis_v1_to_v1_1(value)
