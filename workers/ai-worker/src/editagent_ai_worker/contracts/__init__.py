"""Stable boundary imports for schema-owned generated analysis contracts."""

from .media_analysis_generated import MediaAnalysis, SpeechAnalysis
from .versions import (
    MediaAnalysisV1,
    MediaAnalysisV1_1,
    migrate_media_analysis_v1_to_v1_1,
    parse_media_analysis,
    validate_media_analysis_v1,
    validate_media_analysis_v1_1,
)

__all__ = [
    "MediaAnalysis",
    "SpeechAnalysis",
    "MediaAnalysisV1",
    "MediaAnalysisV1_1",
    "migrate_media_analysis_v1_to_v1_1",
    "parse_media_analysis",
    "validate_media_analysis_v1",
    "validate_media_analysis_v1_1",
]
