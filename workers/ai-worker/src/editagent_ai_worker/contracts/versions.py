"""Exact persisted version dispatch and a pure, validated additive migration."""

from .media_analysis_generated import MediaAnalysis as MediaAnalysisV1
from .media_analysis_v1_1_generated import MediaAnalysis as MediaAnalysisV1_1

__all__ = [
    "MediaAnalysisV1",
    "MediaAnalysisV1_1",
    "validate_media_analysis_v1",
    "validate_media_analysis_v1_1",
    "parse_media_analysis",
    "migrate_media_analysis_v1_to_v1_1",
]


def validate_media_analysis_v1(document: object) -> MediaAnalysisV1:
    return MediaAnalysisV1.model_validate(document)


def validate_media_analysis_v1_1(document: object) -> MediaAnalysisV1_1:
    return MediaAnalysisV1_1.model_validate(document)


def parse_media_analysis(document: object) -> MediaAnalysisV1 | MediaAnalysisV1_1:
    if not isinstance(document, dict):
        raise ValueError("Missing MediaAnalysis version.")
    version = document.get("schemaVersion")
    if version == "1.0.0":
        return validate_media_analysis_v1(document)
    if version == "1.1.0":
        return validate_media_analysis_v1_1(document)
    raise ValueError("Unsupported MediaAnalysis version.")


def migrate_media_analysis_v1_to_v1_1(document: object) -> MediaAnalysisV1_1:
    validated = validate_media_analysis_v1(document)
    value = validated.model_dump(mode="json", exclude_unset=True)
    value["schemaVersion"] = "1.1.0"
    return validate_media_analysis_v1_1(value)
