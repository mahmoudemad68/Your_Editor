"""Portable classification tests: no native model, private input or real exception text."""

import json
from dataclasses import asdict

import pytest

from editagent_ai_worker.domain.analysis.transcription import (
    TranscriptionAlignmentError,
    TranscriptionCancelled,
    TranscriptionError,
    TranscriptionTimeout,
    TranscriptionUnavailable,
)
from editagent_ai_worker.infrastructure.analysis_failures import (
    SAFE_ANALYSIS_MESSAGES,
    AnalysisAuthorizationError,
    AnalysisFencedError,
    AnalysisInputError,
    classify_failure,
)


@pytest.mark.parametrize(
    ("error", "category", "code"),
    [
        (AnalysisAuthorizationError(), "authorization_revoked", "unavailable"),
        (AnalysisFencedError(), "publication_fenced", "unavailable"),
        (TranscriptionAlignmentError(), "untrustworthy_alignment", "unsupported"),
        (TranscriptionCancelled(), "cancelled", "unavailable"),
        (TranscriptionTimeout(), "timeout", "timeout"),
        (TranscriptionUnavailable(), "analyzer_unavailable", "unavailable"),
        (AnalysisInputError(), "invalid_input", "invalid_input"),
        (ValueError("private secret transcript"), "internal", "internal"),
        (TranscriptionError("private secret transcript"), "internal", "internal"),
    ],
)
def test_safe_failure_mapping(error: Exception, category: str, code: str) -> None:
    result = classify_failure(error)
    assert (result.category, result.code, result.retryable) == (category, code, False)
    assert "private" not in json.dumps(asdict(result))
    assert "private" not in SAFE_ANALYSIS_MESSAGES[result.category]


def test_sqlstate_and_retryability_do_not_inspect_raw_messages() -> None:
    class Revoked(Exception):
        sqlstate = "EA001"

    assert classify_failure(Revoked("private")).category == "authorization_revoked"
    assert classify_failure(RuntimeError("EA001 private")).category == "internal"
    assert classify_failure(RuntimeError(), transport_retryable=True).retryable
    assert not classify_failure(RuntimeError(), transport_unavailable=True).retryable
    assert classify_failure(TranscriptionTimeout(), transport_retryable=True).code == "timeout"

    class PublicationDenied(Exception):
        sqlstate = "42501"

    assert classify_failure(PublicationDenied("private")).category == "authorization_failed"
