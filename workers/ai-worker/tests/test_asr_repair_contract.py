"""Fail-closed coverage and deterministic preprocessing, without invented speech gold."""

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

import editagent_ai_worker.infrastructure.faster_whisper as whisper
from editagent_ai_worker.domain.analysis.transcription import TranscriptionError
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.asr_features import DeterministicFeatureExtractor


def alignment_word(text: str, start: float, end: float) -> Any:
    return SimpleNamespace(word=text, start=start, end=end, probability=0.8)


def test_complementary_native_alignments_preserve_exact_intervals_and_all_text() -> None:
    words = [
        alignment_word(" lead", 0, 1),
        alignment_word(" repeated", 1, 1),
        alignment_word(" anchor", 2, 3),
        alignment_word(" repeated", 3, 3),
        alignment_word(" end.", 4, 5),
    ]
    first = [*words[:1], alignment_word(" repeated", 1.2, 1.8), *words[2:]]
    second = [*words[:3], alignment_word(" repeated", 3.2, 3.8), *words[4:]]
    repaired = whisper.merge_native_alignment_evidence(words, [first, second], 5)
    assert repaired is not None
    assert [w.word for w in repaired] == [w.word for w in words]
    assert [(w.start, w.end) for w in repaired] == [(0, 1), (1.2, 1.8), (2, 3), (3.2, 3.8), (4, 5)]
    assert repaired[1] is first[1] and repaired[3] is second[3]
    assert words[1].start == words[1].end == 1
    assert words[3].start == words[3].end == 3


@pytest.mark.parametrize("defect", ["text", "anchor", "overlap", "nan", "zero", "outside"])
def test_native_alignment_evidence_cannot_guess_or_move_words(defect: str) -> None:
    words = [
        alignment_word(" left", 0, 1),
        alignment_word(" word", 1, 1),
        alignment_word(" right", 2, 3),
    ]
    candidate = [
        alignment_word(" left", 0, 1),
        alignment_word(" word", 1.2, 1.8),
        alignment_word(" right", 2, 3),
    ]
    if defect == "text":
        candidate[1].word = " replaced"
    elif defect == "anchor":
        candidate[0].start, candidate[0].end = 1.1, 1.15
        candidate[1].start, candidate[1].end = 1.3, 1.4
        candidate[2].start, candidate[2].end = 1.5, 1.6
    elif defect == "overlap":
        candidate[1].start = 0.5
    elif defect == "nan":
        candidate[1].start = float("nan")
    elif defect == "zero":
        candidate[1].end = candidate[1].start
    else:
        candidate[1].end = 4
    assert whisper.merge_native_alignment_evidence(words, [candidate], 3) is None


def test_fixed_order_features_preserve_reference_definition_and_repeat_exactly() -> None:
    from faster_whisper.feature_extractor import FeatureExtractor  # type: ignore[import-untyped]

    pcm = np.sin(np.arange(16000, dtype=np.float32) * np.float32(0.17))
    extractor = DeterministicFeatureExtractor()
    first = extractor(pcm)
    assert np.array_equal(first, extractor(pcm))
    assert first.dtype == np.float32
    # Same log-Mel definition; deterministic reduction deliberately does not
    # promise bit identity with an implementation-dependent BLAS reduction.
    np.testing.assert_allclose(first, FeatureExtractor()(pcm), rtol=2e-5, atol=2e-5)


def adapter_returning(segments: list[Any]) -> Any:
    adapter = whisper.FasterWhisperAdapter.__new__(whisper.FasterWhisperAdapter)
    adapter.settings = AsrSettings()
    adapter.model = SimpleNamespace(transcribe=lambda *args, **kwargs: (iter(segments), None))
    return adapter


def test_uncovered_vad_is_not_by_itself_a_missing_word_error(monkeypatch: Any) -> None:
    monkeypatch.setattr(
        whisper, "get_speech_timestamps", lambda *args: [{"start": 0, "end": 32000}]
    )
    adapter_returning([])._verify_coverage(np.zeros(32000), [], lambda: None)


def test_independently_recognized_missing_words_cannot_publish_completed(monkeypatch: Any) -> None:
    monkeypatch.setattr(
        whisper, "get_speech_timestamps", lambda *args: [{"start": 0, "end": 32000}]
    )
    segments = [
        SimpleNamespace(
            avg_logprob=-0.1,
            no_speech_prob=0.01,
            words=[SimpleNamespace(word=" genuine", start=0.5, end=1.0)],
        )
    ]
    with pytest.raises(TranscriptionError, match="complete word coverage"):
        adapter_returning(segments)._verify_coverage(np.zeros(32000), [], lambda: None)


def test_genuine_silence_never_requires_lexical_output(monkeypatch: Any) -> None:
    monkeypatch.setattr(whisper, "get_speech_timestamps", lambda *args: [])
    adapter = adapter_returning([])
    adapter.model.transcribe = lambda *args, **kwargs: pytest.fail("Silence was decoded twice")
    adapter._verify_coverage(np.zeros(32000), [], lambda: None)


@pytest.mark.parametrize("mode", ["represented", "different", "disjoint", "repeated"])
def test_short_context_word_drift_requires_ordered_temporal_lexical_evidence(
    monkeypatch: Any, mode: str
) -> None:
    # Captured real-model failure: a later short decode extends an existing
    # word into an uncovered VAD region. No timing collar or guessed word.
    monkeypatch.setattr(
        whisper, "get_speech_timestamps", lambda *args: [{"start": 0, "end": 64000}]
    )
    represented = [SimpleNamespace(word=" 2021.", start=0.64, end=1.0)]
    if mode == "disjoint":
        represented[0].start, represented[0].end = 0, 0.1
    words = [
        SimpleNamespace(word=" other" if mode == "different" else " 2021.", start=0.8, end=1.8)
    ]
    if mode == "repeated":
        words.append(SimpleNamespace(word=" 2021.", start=0.9, end=2.0))
    segments = [SimpleNamespace(avg_logprob=-0.1, no_speech_prob=0.01, words=words)]
    adapter = adapter_returning(segments)
    if mode == "represented":
        adapter._verify_coverage(np.zeros(64000), represented, lambda: None)
    else:
        with pytest.raises(TranscriptionError, match="complete word coverage"):
            adapter._verify_coverage(np.zeros(64000), represented, lambda: None)


def test_coverage_uses_union_of_real_word_ranges(monkeypatch: Any) -> None:
    monkeypatch.setattr(
        whisper, "get_speech_timestamps", lambda *args: [{"start": 0, "end": 80000}]
    )
    words = [
        SimpleNamespace(start=0, end=1),
        SimpleNamespace(start=2, end=3),
        SimpleNamespace(start=3, end=4),
    ]
    assert whisper.uncovered_speech(np.zeros(80000), words, None) == [
        (16000, 32000),
        (64000, 80000),
    ]


def test_wider_original_pcm_alignment_preserves_every_recognized_token(monkeypatch: Any) -> None:
    words = [
        SimpleNamespace(word=f" a{i}", start=i * 0.2, end=i * 0.2 + 0.1, probability=0.8)
        for i in range(10)
    ]
    words[0].end = 0.0
    segment = SimpleNamespace(text="".join(w.word for w in words), words=words, start=0, end=2)
    requested = []

    def alignment(_tokenizer: Any, tokens: Any, _encoded: Any, *args: Any, **kwargs: Any) -> Any:
        count = len(tokens[0])
        requested.append(count)
        return [
            [
                {
                    "word": f" a{i}",
                    "start": i * 0.2,
                    "end": i * 0.2 + (0.1 if count == 7 or i > 0 else 0),
                    "probability": 0.8,
                }
                for i in range(count)
            ]
        ]

    monkeypatch.setattr(
        whisper,
        "Tokenizer",
        lambda *args, **kwargs: SimpleNamespace(encode=lambda text: list(range(len(text.split())))),
    )
    monkeypatch.setattr(whisper, "merge_punctuations", lambda *args: None)
    adapter = adapter_returning([])
    adapter.model = SimpleNamespace(
        hf_tokenizer=None,
        model=SimpleNamespace(is_multilingual=True),
        feature_extractor=lambda audio: np.zeros((80, 301), dtype=np.float32),
        encode=lambda features: None,
        find_alignment=alignment,
    )
    result = adapter._aligned_chunk([segment], np.zeros(48000), "en")
    assert "".join(w.word for w in result) == segment.text
    assert len(result) == 10 and 7 in requested
    assert (result[0].start, result[0].end) == (0, 0.1)
    assert all(a.end <= b.start for a, b in zip(result, result[1:], strict=False))


def test_native_repair_cannot_reuse_word_outside_original_pcm(monkeypatch: Any) -> None:
    monkeypatch.setattr(
        whisper,
        "Tokenizer",
        lambda *args, **kwargs: SimpleNamespace(encode=lambda text: [1]),
    )
    monkeypatch.setattr(whisper, "merge_punctuations", lambda *args: None)
    adapter = adapter_returning([])
    adapter.model = SimpleNamespace(
        hf_tokenizer=None,
        model=SimpleNamespace(is_multilingual=True),
        feature_extractor=lambda audio: np.zeros((80, 301), dtype=np.float32),
        encode=lambda features: None,
        find_alignment=lambda *args, **kwargs: [
            [{"word": " word", "start": 0.0, "end": 0.0, "probability": 0.8}]
        ],
    )
    segment = SimpleNamespace(
        text=" word",
        start=0,
        end=2,
        words=[SimpleNamespace(word=" word", start=0.5, end=2.0, probability=0.8)],
    )
    with pytest.raises(TranscriptionError, match="trustworthy realignment"):
        adapter._aligned_chunk([segment], np.zeros(16000), "en")


def test_original_pcm_reconciliation_recovers_unowned_recognized_word_without_guessing() -> None:
    from editagent_ai_worker.domain.analysis.transcription import Word
    from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity

    def word(text: str, start: int, end: int) -> Word:
        return Word(text, start, end, 0.8)

    left = (
        word(" lead", 1_000_000, 1_500_000),
        word(" before", 3_200_000, 3_600_000),
        word(" lost", 5_100_000, 5_300_000),
        word(" anchorA", 5_300_000, 5_500_000),
        word(" anchorB", 5_500_000, 5_800_000),
    )
    right = (
        word(" anchorA", 5_200_000, 5_600_000),
        word(" anchorB", 5_600_000, 5_900_000),
        word(" after", 8_000_000, 8_500_000),
    )
    chunks = [(0, 5_000_000, left), (5_000_000, 10_000_000, right)]
    source = AudioIdentity(
        "fixture", "a" * 64, "fixture-audio", "b" * 64, 10_000_000, 0, 10_000_000
    )
    adapter = adapter_returning([])
    alignment_calls = []

    def align(segments: Any, audio: Any, language: str, check: Any) -> Any:
        alignment_calls.append(segments[0].text)
        assert language == "ar" and len(audio) < 480000
        # Model-provided alignment on the selected original 2.2s..6.9s PCM.
        return [
            SimpleNamespace(word=text, start=start, end=end, probability=0.9)
            for text, start, end in [
                (" before", 1.0, 1.4),
                (" lost", 2.0, 2.2),
                (" anchorA", 3.0, 3.2),
                (" anchorB", 3.2, 3.6),
            ]
        ]

    adapter._aligned_chunk = align
    wav = SimpleNamespace(
        getnframes=lambda: 160000,
        setpos=lambda position: None,
        readframes=lambda count: b"\x00\x00" * count,
    )
    repaired = adapter._reconcile_overlaps(chunks, ["ar", "ar"], wav, source, lambda: None)
    merged = whisper.merge_owned_words(repaired, source)
    assert [w.text for w in merged] == [
        " lead",
        " before",
        " lost",
        " anchorA",
        " anchorB",
        " after",
    ]
    assert alignment_calls == [" before lost anchorA anchorB"]
    assert merged[2].start_us == 4_200_000 and merged[2].confidence == 0.9
    assert chunks[0][2] == left and chunks[1][2] == right
    assert adapter._reconcile_overlaps(chunks, ["en", "ar"], wav, source, lambda: None) == chunks
    assert len(alignment_calls) == 1


class PcmReader:
    """Bounded WAV-reader test double; real-model coverage lives in the real suite."""

    def __init__(self, seconds: int, corrupt: bool = False, truncated: bool = False) -> None:
        self.raw = np.arange(seconds * 16000, dtype=np.int32).astype("<i2").tobytes()
        self.position = 0
        self.reads: list[tuple[int, int]] = []
        self.corrupt, self.truncated = corrupt, truncated

    def getnframes(self) -> int:
        return len(self.raw) // 2

    def setpos(self, position: int) -> None:
        self.position = position

    def readframes(self, frames: int) -> bytes:
        self.reads.append((self.position, frames))
        result = self.raw[self.position * 2 : (self.position + frames) * 2]
        if self.corrupt:
            result = b"\xff\x7f" + result[2:]
        return result[:-2] if self.truncated else result


@pytest.mark.parametrize(
    ("source_seconds", "first_seconds", "end_seconds", "language_seconds", "result_seconds"),
    [
        (40, 0, 28, 40, 30),
        (40, 0, 28, 29, 29),
        (29, 0, 28, 40, 29),
        (40, 5, 33, 40, 30),
        (40, 0, 28, 28, None),
        (16, 0, 8, 8, None),
        (40, 0, 30, 40, None),
    ],
)
def test_original_continuation_clamps_source_language_and_thirty_second_bound(
    source_seconds: int,
    first_seconds: int,
    end_seconds: int,
    language_seconds: int,
    result_seconds: int | None,
) -> None:
    wav = PcmReader(source_seconds)
    first, end = first_seconds * 16000, end_seconds * 16000
    original = np.frombuffer(wav.raw[first * 2 : end * 2], dtype="<i2").astype(np.float32) / 32768
    result = adapter_returning([])._continued_pcm(
        wav,
        first,
        end,
        language_seconds * 1_000_000,
        original,
        lambda: None,
    )
    if result_seconds is None:
        assert result is None and wav.reads == []
    else:
        assert len(result) == result_seconds * 16000 <= 480000
        assert wav.reads == [(first, result_seconds * 16000)]
        assert np.array_equal(result[: len(original)], original)


@pytest.mark.parametrize("failure", ["corrupt", "truncated"])
def test_original_continuation_rejects_changed_prefix_and_truncated_pcm(failure: str) -> None:
    wav = PcmReader(3, corrupt=failure == "corrupt", truncated=failure == "truncated")
    original = np.frombuffer(wav.raw[:64000], dtype="<i2").astype(np.float32) / 32768
    with pytest.raises(
        TranscriptionError, match="source prefix changed|Truncated ASR continuation"
    ):
        adapter_returning([])._continued_pcm(wav, 0, 32000, 3_000_000, original, lambda: None)


def test_continuation_checks_cancellation_before_source_read() -> None:
    from editagent_ai_worker.domain.analysis.transcription import TranscriptionCancelled

    wav = PcmReader(3)

    def cancel() -> None:
        raise TranscriptionCancelled("cancelled")

    with pytest.raises(TranscriptionCancelled):
        adapter_returning([])._continued_pcm(wav, 0, 32000, 3_000_000, np.zeros(32000), cancel)
    assert wav.reads == []


@pytest.mark.parametrize("second_pass_invalid", [False, True])
def test_partial_context_recognition_is_bounded_and_aligns_only_final_model_text(
    tmp_path: Any,
    monkeypatch: Any,
    second_pass_invalid: bool,
) -> None:
    import hashlib
    import wave

    from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity

    path = tmp_path / "source.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\x00\x00" * 480000)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    identity = AudioIdentity("fixture", digest, "fixture-asr", digest, 30_000_000, 0, 30_000_000)
    adapter = adapter_returning([])
    adapter.settings = AsrSettings(chunk_us=26_000_000)
    calls = []

    def decode(audio: Any, **kwargs: Any) -> Any:
        calls.append(len(audio))

        def word(text: str, start: float, end: float) -> Any:
            return SimpleNamespace(word=text, start=start, end=end, probability=0.8)

        if len(calls) == 1 or second_pass_invalid:
            endpoint = len(audio) / 16000 - 0.05
            words = [
                word(" word", 1.0, 2.0),
                word(" U", endpoint, endpoint),
                word(".S.", endpoint, endpoint + 0.02),
            ]
        elif len(calls) == 2:
            words = [word(" word", 1.0, 2.0), word(" Academy", 28.0, 29.0)]
        else:
            words = [word(" Academy", 4.0, 5.0)]
        segment = SimpleNamespace(text="".join(w.word for w in words), words=words)
        return iter([segment]), SimpleNamespace(language="en", language_probability=0.9)

    adapter.model = SimpleNamespace(transcribe=decode)
    monkeypatch.setattr(
        adapter, "_language_regions", lambda wav, duration, check: [(0, duration, "en", 0.9)]
    )
    monkeypatch.setattr(whisper, "get_speech_timestamps", lambda *args: [])
    if second_pass_invalid:
        with pytest.raises(TranscriptionError):
            adapter.transcribe(str(path), identity)
        assert calls == [448000, 480000]
    else:
        result = adapter.transcribe(str(path), identity)
        assert [w.text for w in result.words] == [" word", " Academy"]
        assert [(w.start_us, w.end_us) for w in result.words] == [
            (1_000_000, 2_000_000),
            (28_000_000, 29_000_000),
        ]
        assert calls == [448000, 480000, 96000]
