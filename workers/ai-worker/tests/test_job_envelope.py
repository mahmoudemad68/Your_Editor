"""The shared job envelope schema accepts version 1 and rejects a partial document."""

from __future__ import annotations

import jsonschema
import pytest

from editagent_ai_worker.infrastructure.job_envelope import load_job_envelope_schema


def _sample() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "jobId": "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f",
        "queueName": "media",
        "jobType": "probe",
        "idempotencyKey": "probe-1",
        "payload": {"mediaAssetId": "018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f"},
        "timeoutMs": 1000,
        "maxAttempts": 3,
        "attempt": 1,
        "backoffBaseMs": 50,
        "subject": {"kind": "media-asset", "id": "018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f"},
    }


def test_version_one_envelope_matches_the_shared_schema() -> None:
    jsonschema.validate(_sample(), load_job_envelope_schema())


def test_envelope_without_idempotency_key_is_rejected() -> None:
    document = _sample()
    del document["idempotencyKey"]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(document, load_job_envelope_schema())
