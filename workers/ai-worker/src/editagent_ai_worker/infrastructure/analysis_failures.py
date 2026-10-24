"""Safe internal categories with a backward-compatible MediaAnalysis projection."""

from dataclasses import dataclass

from editagent_ai_worker.domain.analysis.transcription import (
    TranscriptionAlignmentError,
    TranscriptionCancelled,
    TranscriptionTimeout,
    TranscriptionUnavailable,
)
from editagent_ai_worker.domain.analysis.voice_activity import VadTimeout

SAFE_ANALYSIS_MESSAGES = {
    "authorization_failed": (
        "Analysis could not be published because authorization failed. Contact support."
    ),
    "authorization_revoked": (
        "Analysis authorization is no longer valid. An editor can start a new analysis."
    ),
    "publication_fenced": "This analysis result is no longer current. Refresh the analysis.",
    "untrustworthy_alignment": (
        "Trustworthy word timing could not be established with the selected model. "
        "Choose a qualified model explicitly."
    ),
    "analyzer_unavailable": "The analyzer is unavailable. Try again later.",
    "cancelled": "Analysis was cancelled.",
    "timeout": "Analysis reached its time limit. Retry only on a qualified runtime.",
    "invalid_input": "The analysis input is invalid. Check the media and try again.",
    "internal": "Analysis failed unexpectedly. Try again or contact support.",
}


class AnalysisInputError(ValueError):
    """Validated input/identity failure, not an arbitrary ValueError."""


class AnalysisAuthorizationError(Exception):
    """Current analysis authorization is unavailable."""


class AnalysisFencedError(Exception):
    """The admitted result is no longer current."""


@dataclass(frozen=True)
class AnalysisFailure:
    category: str
    code: str
    reason: str
    retryable: bool = False


def classify_failure(
    error: Exception, *, transport_retryable: bool = False, transport_unavailable: bool = False
) -> AnalysisFailure:
    constraint = getattr(getattr(error, "diag", None), "constraint_name", None)
    if constraint == "analysis_deadline":
        return AnalysisFailure("timeout", "timeout", "Analysis timed out.")
    if constraint == "analysis_result_admission":
        return AnalysisFailure("publication_fenced", "unavailable", "Analyzer is unavailable.")
    if getattr(error, "sqlstate", None) in {"42501", "28000", "28P01"}:
        return AnalysisFailure("authorization_failed", "unavailable", "Analyzer is unavailable.")
    if isinstance(error, AnalysisAuthorizationError) or getattr(error, "sqlstate", None) == "EA001":
        return AnalysisFailure("authorization_revoked", "unavailable", "Analyzer is unavailable.")
    if isinstance(error, AnalysisFencedError):
        return AnalysisFailure("publication_fenced", "unavailable", "Analyzer is unavailable.")
    if isinstance(error, TranscriptionCancelled):
        return AnalysisFailure("cancelled", "unavailable", "Analyzer is unavailable.")
    if isinstance(error, (TranscriptionTimeout, VadTimeout, TimeoutError)):
        return AnalysisFailure("timeout", "timeout", "Analysis timed out.")
    if isinstance(error, TranscriptionAlignmentError):
        return AnalysisFailure(
            "untrustworthy_alignment", "unsupported", "This analysis is unsupported."
        )
    if isinstance(error, TranscriptionUnavailable):
        return AnalysisFailure("analyzer_unavailable", "unavailable", "Analyzer is unavailable.")
    if transport_retryable or transport_unavailable:
        return AnalysisFailure(
            "analyzer_unavailable", "unavailable", "Analyzer is unavailable.", transport_retryable
        )
    if isinstance(error, AnalysisInputError):
        return AnalysisFailure("invalid_input", "invalid_input", "Analysis input is invalid.")
    return AnalysisFailure("internal", "internal", "Analysis failed.")
