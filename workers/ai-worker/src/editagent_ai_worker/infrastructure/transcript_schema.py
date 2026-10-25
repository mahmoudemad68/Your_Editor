"""Additive 1.2 metadata projection; original segment/word representation is retained."""

from typing import Any

from editagent_ai_worker.contracts.media_analysis_v1_2_generated import Transcript as Contract
from editagent_ai_worker.domain.analysis.transcription import Transcript
from editagent_ai_worker.infrastructure.asr_model import model_identity


def to_document(transcript: Transcript) -> dict[str, Any]:
    segments = []
    for index, word in enumerate(transcript.words):
        value = {
            "text": word.text,
            "startUs": str(word.start_us),
            "endUs": str(word.end_us),
            "confidence": word.confidence,
        }
        segments.append({"id": f"word-{index}", **value, "words": [dict(value)]})
    data: dict[str, Any] = {
        "language": transcript.language,
        "languageConfidence": transcript.language_confidence,
        "segments": segments,
    }
    if transcript.language_segments:
        evidence = []
        for segment in transcript.language_segments:
            entry: dict[str, Any] = {
                "startUs": str(segment.start_us),
                "endUs": str(segment.end_us),
                "method": "ct2-source-context-v1",
                "scope": "audio_context_not_word_language",
                "model": model_identity(segment.model),
                "status": segment.status,
            }
            if segment.status == "dominant":
                entry.update(language=segment.languages[0], confidence=segment.confidence)
            evidence.append(entry)
        data["languageSegments"] = evidence
    return Contract.model_validate(data).model_dump(mode="json", exclude_unset=True)
