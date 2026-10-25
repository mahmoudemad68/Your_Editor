"""Synthetic detector observations are contract inputs, never language accuracy gold."""

import copy

import pytest
from pydantic import ValidationError

from editagent_ai_worker.contracts.media_analysis_generated import Transcript as Legacy
from editagent_ai_worker.contracts.media_analysis_v1_2_generated import Transcript as Current
from editagent_ai_worker.domain.analysis.language_evidence import (
    LanguageObservation,
    summarize_language_observations,
)
from editagent_ai_worker.domain.analysis.transcription import Transcript, Word
from editagent_ai_worker.infrastructure.transcript_schema import to_document


def probe(start: int, language: str | None, confidence: float = 0.9) -> LanguageObservation:
    return LanguageObservation(
        start, start + 4_000_000, "small", ((language, confidence),) if language else (), True
    )


@pytest.mark.parametrize(
    "languages",
    [
        ["en"],
        ["ar"],
        ["en", "ar"],
        ["ar", "en"],
        ["en", "ar", "en", "ar"],
    ],
)
def test_local_observations_preserve_order_and_original_coordinates(languages: list[str]) -> None:
    segments = summarize_language_observations(
        [probe(i * 4_000_000, v) for i, v in enumerate(languages)], 125
    )
    assert [s.languages for s in segments] == [(v,) for v in languages]
    assert all(s.status == "dominant" and s.confidence == 0.9 for s in segments)
    assert segments[0].start_us == 125
    assert segments[-1].end_us == len(languages) * 4_000_000 + 125


@pytest.mark.parametrize("confidence", [0.49, float("nan"), float("inf"), -0.1, 1.1])
def test_ambiguous_or_invalid_scores_cannot_be_presented_as_local_language(
    confidence: float,
) -> None:
    result = summarize_language_observations([probe(0, "ar", confidence)], 0)[0]
    assert result.status == "unknown" and result.languages == () and result.confidence is None


def test_silence_noise_and_weak_cells_cannot_borrow_language_from_context() -> None:
    for base in [probe(0, None), probe(0, "ar", 0.3)]:
        nearby = LanguageObservation(0, 4_000_000, "small", (("en", 0.9),))
        result = summarize_language_observations([base, nearby], 0)[0]
        assert result.status == "unknown" and result.confidence is None


def test_short_tied_and_malformed_language_observations_are_unknown() -> None:
    for observation in [
        LanguageObservation(0, 999_999, "small", (("en", 0.99),), True),
        LanguageObservation(0, 4_000_000, "small", (("en", 0.5), ("ar", 0.5)), True),
        probe(0, "EN"),
        probe(0, "en\n"),
    ]:
        result = summarize_language_observations([observation], 0)[0]
        assert result.status == "unknown" and result.confidence is None


def test_conflicting_observed_probes_are_explicit_mixed_without_invented_confidence() -> None:
    observations = [
        probe(0, "en"),
        LanguageObservation(2_000_000, 4_000_000, "small", (("ar", 0.8),)),
    ]
    result = summarize_language_observations(observations, 0)[0]
    assert result.status == "mixed" and result.confidence is None
    assert result.languages == ("ar", "en")
    data = to_document(Transcript("en", 0.9, (), (result,)))
    assert data["languageSegments"][0]["status"] == "mixed"
    assert "confidence" not in data["languageSegments"][0]
    assert "language" not in data["languageSegments"][0]


def test_metadata_never_resegments_text_or_invents_word_language_confidence() -> None:
    words = (Word(" English", 10, 100, 0.7), Word(" العربية", 110, 200, 0.8))
    original = to_document(Transcript("en", 0.6, words))
    expected = copy.deepcopy(original)
    annotated = to_document(
        Transcript("en", 0.6, words, summarize_language_observations([probe(0, "ar")], 0))
    )
    metadata = annotated.pop("languageSegments")
    assert annotated == expected
    assert metadata[0]["language"] == "ar"  # Detector input, irrespective of word spelling.
    assert metadata[0]["confidence"] == 0.9
    assert metadata[0]["scope"] == "audio_context_not_word_language"
    assert metadata[0]["model"]["name"] == "faster-whisper-small"
    assert Legacy.model_validate(annotated).model_dump(mode="json") == original


def test_new_metadata_is_optional_and_unknown_cannot_carry_a_language_or_confidence() -> None:
    legacy = {"language": "en", "segments": []}
    assert Current.model_validate(legacy).model_dump(mode="json") == legacy
    data = to_document(
        Transcript("und", 0.0, (), summarize_language_observations([probe(0, None)], 0))
    )
    with pytest.raises(ValidationError):
        Legacy.model_validate(data)
    for extra in [{"confidence": 0.9}, {"language": "en"}, {"wordLanguage": "ar"}]:
        malformed = copy.deepcopy(data)
        malformed["languageSegments"][0].update(extra)
        with pytest.raises(ValidationError):
            Current.model_validate(malformed)
