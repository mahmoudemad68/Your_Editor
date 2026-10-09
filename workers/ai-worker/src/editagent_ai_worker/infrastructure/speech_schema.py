"""Canonical speech-section serialization. Shared schema stays in packages/schemas."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import jsonschema

from editagent_ai_worker.domain.analysis.voice_activity import (
    AudioIdentity,
    InferenceProvenance,
    SpeechAnalysis,
    SpeechRegion,
    VadConfiguration,
)


def schema_path() -> Path:
    sibling = Path(__file__).with_name("speech-analysis.schema.json")
    if sibling.is_file():
        return sibling
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages/schemas/src/speech-analysis.schema.json"
        if candidate.is_file():
            return candidate
    raise ValueError("Shared speech-analysis schema unavailable")


def _camel(name: str) -> str:
    return re.sub(r"_([a-z])", lambda m: m[1].upper(), name)


def to_document(value: SpeechAnalysis) -> dict[str, Any]:
    def fields(item: Any) -> dict[str, Any]:
        return {_camel(k): str(v) if k.endswith("_us") else v for k, v in vars(item).items()}

    provenance = fields(value.provenance)
    provenance["configuration"] = fields(value.provenance.configuration)
    return {
        "schemaVersion": 1,
        "source": fields(value.source),
        "speechRegions": [fields(r) for r in value.regions],
        "provenance": provenance,
    }


def parse_document(document: dict[str, Any]) -> SpeechAnalysis:
    schema = json.loads(schema_path().read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema).validate(document)

    def snake(item: dict[str, Any]) -> dict[str, Any]:
        result = {}
        for k, v in item.items():
            name = re.sub(r"([A-Z])", lambda m: "_" + m[1].lower(), k)
            result[name] = int(v) if name.endswith("_us") else v
        return result

    source = AudioIdentity(**snake(document["source"]))
    config = VadConfiguration(**snake(document["provenance"]["configuration"]))
    provenance = snake(document["provenance"])
    provenance["configuration"] = config
    return SpeechAnalysis(
        source,
        tuple(SpeechRegion(**snake(r)) for r in document["speechRegions"]),
        InferenceProvenance(**provenance),
    )


def serialize(value: SpeechAnalysis) -> str:
    document = to_document(value)
    parse_document(document)  # Both structural schema and semantic domain invariants.
    return json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
