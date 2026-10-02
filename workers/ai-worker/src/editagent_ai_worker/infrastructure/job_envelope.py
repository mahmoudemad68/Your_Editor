"""Read a BullMQ job payload and check it against the shared JSON Schema.

This adapter does not import the Node bullmq package. It reads the Redis hash
BullMQ writes and validates that JSON with the schema in packages/schemas.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import jsonschema
import redis


class EnvelopeError(Exception):
    """The Redis payload is missing or does not match the shared envelope."""


def shared_schema_path() -> Path:
    """Find the one JSON Schema both runtimes validate."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "schemas" / "src" / "job-envelope.schema.json"
        if candidate.is_file():
            return candidate
    raise EnvelopeError("shared job envelope schema was not found")


SCHEMA_PATH = shared_schema_path()


def load_job_envelope_schema(path: Path | None = None) -> dict[str, Any]:
    schema_path = path if path is not None else SCHEMA_PATH
    loaded = json.loads(schema_path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise EnvelopeError("job envelope schema must be a JSON object")
    return cast(dict[str, Any], loaded)


def read_bullmq_envelope(redis_url: str, queue_name: str, job_id: str) -> dict[str, Any]:
    client = redis.Redis.from_url(redis_url, decode_responses=True)
    try:
        raw = client.hget(f"bull:{queue_name}:{job_id}", "data")
    finally:
        client.close()
    if not isinstance(raw, str):
        raise EnvelopeError(f"BullMQ job {job_id} has no data field")
    document = json.loads(raw)
    if not isinstance(document, dict):
        raise EnvelopeError("BullMQ job data must be a JSON object")
    parsed = cast(dict[str, Any], document)
    jsonschema.validate(parsed, load_job_envelope_schema())
    return parsed
