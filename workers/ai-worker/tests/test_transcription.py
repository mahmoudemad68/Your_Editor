"""Word integrity, deterministic chunk ownership and safe deployment settings."""

from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from editagent_ai_worker.domain.analysis.transcription import Transcript, TranscriptionError, Word
from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.faster_whisper import (
    attach_boundary_punctuation,
    merge_owned_words,
    microseconds,
)


def test_boundary_punctuation_preserves_text_and_real_lexical_interval() -> None:
    word = SimpleNamespace(word=" unfinished", start=1.0, end=2.0, probability=0.8)
    dash = SimpleNamespace(word="-", start=2.0, end=2.0, probability=0.2)
    result = attach_boundary_punctuation([word, dash])
    assert len(result) == 1
    assert result[0].word == " unfinished-"
    assert (result[0].start, result[0].end, result[0].probability) == (1.0, 2.0, 0.8)
    # Lexical words and non-touching punctuation cannot acquire fabricated timing.
    lexical = SimpleNamespace(word=" missing", start=2.0, end=2.0, probability=0.2)
    assert attach_boundary_punctuation([word, lexical]) == [word, lexical]
    dash.start = dash.end = 3.0
    assert attach_boundary_punctuation([word, dash]) == [word, dash]


def identity() -> AudioIdentity:
    return AudioIdentity("asset", "a" * 64, "audio", "b" * 64, 10_000_000, 0, 10_000_000)


@pytest.mark.parametrize(
    "key,value",
    [
        ("beam_size", 0),
        ("cpu_threads", 9),
        ("speech_threshold", math.nan),
        ("speech_threshold", math.inf),
        ("negative_threshold", 0.6),
        ("overlap_us", 20_000_000),
        ("device", "remote"),
        ("model", "../../other"),
        ("compute_type", "float32"),
        ("timeout_ms", 600001),
        ("chunk_us", 0),
    ],
)
def test_configuration_rejects_invalid(key: str, value: object) -> None:
    with pytest.raises(ValueError):
        AsrSettings.model_validate({key: value})


def test_cpu_int8_is_explicit() -> None:
    assert AsrSettings().compute_type == "int8"
    with pytest.raises(ValueError):
        AsrSettings(device="cpu", compute_type="float16")


def test_whole_boundary_word_preserved_and_context_duplicate_owned_once() -> None:
    first = Word(" hello", 4_800_000, 5_200_000, 0.9)
    second = Word(" مرحبا", 6_000_000, 6_500_000, 0.8)
    chunks: list[tuple[int, int, tuple[Word, ...]]] = [
        (0, 5_000_000, (first,)),
        (5_000_000, 10_000_000, (first, second)),
    ]
    assert merge_owned_words(chunks, identity()) == (first, second)
    assert merge_owned_words(chunks, identity()) == merge_owned_words(chunks, identity())


def test_conflicting_chunks_fail_without_dropping_text() -> None:
    chunks: list[tuple[int, int, tuple[Word, ...]]] = [
        (0, 5_000_000, (Word(" first", 4_000_000, 5_100_000, 0.9),)),
        (5_000_000, 10_000_000, (Word(" second", 5_000_000, 6_000_000, 0.9),)),
    ]
    with pytest.raises(TranscriptionError):
        merge_owned_words(chunks, identity())


def test_overlapping_identical_context_word_reconciles_once() -> None:
    a = Word(" hello", 4_600_000, 5_100_000, 0.9)
    b = Word(" hello", 4_900_000, 5_300_000, 0.8)
    c = Word(" world", 5_400_000, 5_900_000, 0.9)
    assert merge_owned_words(
        [(0, 5_000_000, (a,)), (5_000_000, 10_000_000, (b, c))], identity()
    ) == (a, c)


@pytest.mark.parametrize("a,b", [(0, 0), (3, 2), (-1, 2), (0.1, 2)])
def test_invalid_word_boundaries_are_not_repaired(a: int, b: int) -> None:
    with pytest.raises(ValueError):
        Word("word", a, b, 0.8)


@pytest.mark.parametrize("value", [math.inf, math.nan, -0.1, True, "0.2"])
def test_invalid_external_timestamps(value: object) -> None:
    with pytest.raises(TranscriptionError):
        microseconds(value)


def test_timestamp_rounding_and_full_transcript_value() -> None:
    assert microseconds(0.0000005) == 1
    assert microseconds(0.1234564) == 123456
    assert microseconds(0, 1) == 63
    assert microseconds(0.0000005, 1) == 63  # one rounding, not 63 + 1
    assert microseconds(0.02, 3) == 20188
    value = Transcript(
        "ar", 0.99, (Word(" مرحبا", 0, 100000, 0.9), Word(" بالعالم", 100000, 200000, 0.8))
    )
    assert "".join(w.text for w in value.words) == " مرحبا بالعالم"


def test_join_uses_complete_shared_pcm_alignment_not_clipped_boundaries() -> None:
    source = identity()
    chunks = [
        (
            0,
            5000000,
            (
                Word("vision", 4300000, 4770000, 0.9),
                Word("into", 4770000, 5310000, 0.8),
                Word("something", 5310000, 5670000, 0.9),
            ),
        ),
        (
            5000000,
            10000000,
            (
                Word("vision", 4360000, 4760000, 0.9),
                Word("into", 4760000, 5280000, 0.8),
                Word("something", 5280000, 5660000, 0.9),
                Word("real", 5700000, 6000000, 0.9),
            ),
        ),
    ]
    result = merge_owned_words(chunks, source)
    assert [w.text for w in result] == ["vision", "into", "something", "real"]
    assert result[1] == chunks[0][2][1]
    assert result[2] == chunks[0][2][2]
    assert all(a.end_us <= b.start_us for a, b in zip(result, result[1:], strict=False))
