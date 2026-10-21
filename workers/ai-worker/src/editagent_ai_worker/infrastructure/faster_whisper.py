"""Offline bounded-window Faster-Whisper adapter. No remote code or runtime downloads."""

from __future__ import annotations

import hashlib
import importlib.metadata
import time
import unicodedata
import wave
from collections.abc import Callable
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import ctranslate2  # type: ignore[import-untyped]
import numpy as np
from faster_whisper import WhisperModel  # type: ignore[import-untyped]
from faster_whisper.tokenizer import Tokenizer  # type: ignore[import-untyped]
from faster_whisper.transcribe import merge_punctuations  # type: ignore[import-untyped]
from faster_whisper.vad import VadOptions, get_speech_timestamps  # type: ignore[import-untyped]

from editagent_ai_worker.domain.analysis.transcription import (
    Transcript,
    TranscriptionCancelled,
    TranscriptionError,
    TranscriptionTimeout,
    Word,
)
from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity, Cancellation
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.asr_features import DeterministicFeatureExtractor
from editagent_ai_worker.infrastructure.asr_model import model_identity, verify_asr_model
from editagent_ai_worker.infrastructure.config import (
    ASR_NATIVE_ENVIRONMENT,
    ASR_NATIVE_PROFILE,
    ConfigurationError,
    require_asr_native_environment,
)
from editagent_ai_worker.infrastructure.vad_audio import verify_audio_file, wav_parameters

ASR_ALGORITHM = "ct2-contextual-v19"


def uncovered_speech(audio: Any, words: list[Any], options: Any) -> list[tuple[int, int]]:
    """Original PCM speech with at least one second of unexplained word coverage.

    VAD alone is not proof of lexical speech. Callers must independently decode
    these bounded ranges before treating missing words as an integrity failure.
    """
    gaps: list[tuple[int, int]] = []
    for region in get_speech_timestamps(audio, options):
        cursor = int(region["start"])
        end = int(region["end"])
        for word in words:
            lower = int(Decimal(str(word.start)) * 16000)
            upper = int(Decimal(str(word.end)) * 16000)
            if upper <= cursor or lower >= end:
                continue
            if lower - cursor >= 16000:
                gaps.append((cursor, lower))
            cursor = max(cursor, upper)
        if end - cursor >= 16000:
            gaps.append((cursor, end))
    return gaps


def microseconds(value: Any, sample_offset: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TranscriptionError("Invalid ASR timestamp")
    n = Decimal(str(value))
    if not n.is_finite() or n < 0 or type(sample_offset) is not int or sample_offset < 0:
        raise TranscriptionError("Invalid ASR timestamp")
    # Round once after adding the exact 16 kHz sample offset (62.5 us/sample).
    total = n * 1_000_000 + Decimal(sample_offset) * 1_000_000 / 16000
    return int(total.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def same_context_word(left: str, right: str) -> bool:
    """Anchor identity tolerates ASCII capitalization, never changes output text.

    A new context may start with a capitalized proper name. Wider Unicode
    case-folding (for example sharp-s to ss), punctuation and spelling changes
    do not establish the same lexical anchor.
    """

    def key(text: str) -> str:
        return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in text.strip())

    return key(left) == key(right)


def attach_boundary_punctuation(words: list[Any]) -> list[Any]:
    """A zero-time punctuation token belongs to its exactly touching lexical word.

    Preserve every character and the lexical word's original interval/probability.
    This never repairs a zero-length lexical token or changes a media boundary.
    """
    result: list[Any] = []
    for word in words:
        punctuation = word.word.strip()
        if (
            punctuation
            and all(unicodedata.category(char).startswith("P") for char in punctuation)
            and word.start == word.end
            and result
            and result[-1].start < result[-1].end == word.start
        ):
            previous = result[-1]
            result[-1] = SimpleNamespace(
                word=previous.word + word.word,
                start=previous.start,
                end=previous.end,
                probability=previous.probability,
            )
        else:
            result.append(word)
    return result


def merge_native_alignment_evidence(
    words: list[Any], alignments: list[list[Any]], duration: float
) -> list[Any] | None:
    """Repair only from native intervals with exact lexical and temporal anchors.

    Different attention-filter widths can collapse different words. A complete
    alignment need not be thrown away just because a word outside the repair
    has zero duration. Every replacement is an unchanged, positive native
    interval, bounded by the untouched neighboring words. No clock or lexical
    value is estimated, and repeated phrases keep their original word indices.
    """
    repaired = [
        SimpleNamespace(
            word=word.word,
            start=float(word.start),
            end=float(word.end),
            probability=float(word.probability),
        )
        for word in words
    ]
    lexical = [word.word for word in repaired]
    candidates = [candidate for candidate in alignments if [w.word for w in candidate] == lexical]

    def valid(word: Any) -> bool:
        return bool(0 <= word.start < word.end <= duration)

    def anchored(candidate: Any, original: Any) -> bool:
        return (
            valid(candidate)
            and valid(original)
            and bool(max(candidate.start, original.start) < min(candidate.end, original.end))
        )

    for index, word in enumerate(repaired):
        if valid(word) and (index == 0 or repaired[index - 1].end <= word.start):
            continue
        found = False
        for radius in (0, 1, 2, 3, 4, 6, 8):
            left, right = max(0, index - radius), min(len(repaired), index + radius + 1)
            # Expanding a patch must not make an available anchor disappear.
            # Source boundaries substitute only for a genuinely first/last word.
            if (index > 0 and left == 0) or (index + 1 < len(repaired) and right == len(repaired)):
                continue
            for candidate in candidates:
                patch = candidate[left:right]
                if not all(valid(w) for w in patch) or any(
                    a.end > b.start for a, b in zip(patch, patch[1:], strict=False)
                ):
                    continue
                if left and (
                    not anchored(candidate[left - 1], repaired[left - 1])
                    or patch[0].start < repaired[left - 1].end
                ):
                    continue
                if right < len(repaired) and (
                    not anchored(candidate[right], repaired[right])
                    or patch[-1].end > repaired[right].start
                ):
                    continue
                repaired[left:right] = patch
                found = True
                break
            if found:
                break
        if not found:
            return None
    if [word.word for word in repaired] != lexical or not all(valid(w) for w in repaired):
        return None
    if any(a.end > b.start for a, b in zip(repaired, repaired[1:], strict=False)):
        return None
    return repaired


def merge_owned_words(
    chunks: list[tuple[int, int, tuple[Word, ...]]], source: AudioIdentity
) -> tuple[Word, ...]:
    """Own whole words by midpoint in disjoint cores; never clip their boundaries.

    Context overlap may repeat words. Only the owning core supplies a word. If independently
    decoded owning words conflict, fail rather than remove text or fabricate timestamps.
    """
    words: list[Word] = []
    last_chunk = -1
    for chunk_index, (lower, upper, candidates) in enumerate(chunks):
        for word in candidates:
            midpoint = word.start_us + word.end_us
            if not 2 * lower <= midpoint < 2 * upper:
                continue
            if word.start_us < source.scope_start_us or word.end_us > source.scope_end_us:
                raise TranscriptionError("ASR word lies outside verified source scope")
            origin = chunk_index
            if words and word.start_us < words[-1].end_us:
                if last_chunk != chunk_index and chunk_index > 0:
                    # Choose an existing complete alignment from shared original PCM,
                    # rather than clipping words at independently rounded chunk joins.
                    alternatives = [
                        candidate
                        for candidate in chunks[chunk_index - 1][2]
                        if candidate.text.strip() == word.text.strip()
                        and candidate.start_us < word.end_us
                        and word.start_us < candidate.end_us
                        and candidate.start_us >= words[-1].end_us
                        and source.scope_start_us <= candidate.start_us
                        and candidate.end_us <= source.scope_end_us
                    ]
                    if len(alternatives) == 1:
                        word = alternatives[0]
                        origin = chunk_index - 1
                    elif word.text.strip() == words[-1].text.strip():
                        # Two views of the same boundary word, with overlapping evidence.
                        continue
                    else:
                        raise TranscriptionError(
                            "ASR chunk boundary requires trustworthy realignment"
                        )
                else:
                    raise TranscriptionError("ASR chunk boundary requires trustworthy realignment")
            words.append(word)
            last_chunk = origin
    return tuple(words)


class FasterWhisperAdapter:
    def __init__(self, settings: AsrSettings) -> None:
        try:
            require_asr_native_environment()
        except ConfigurationError as exc:
            raise TranscriptionError("ASR native execution profile is invalid") from exc
        self.settings = settings
        ctranslate2.set_random_seed(settings.seed)
        self.model_identity = verify_asr_model(settings.model_path, settings.model)
        self._alignment_model: Any = None
        self.device = settings.device
        self.compute_type = settings.compute_type
        try:
            self.model = self._load(self.device, self.compute_type)
        except Exception as exc:
            if settings.device != "cuda" or not settings.cpu_fallback:
                raise TranscriptionError("ASR runtime initialization failed") from exc
            self.device, self.compute_type = "cpu", "int8"
            try:
                self.model = self._load(self.device, self.compute_type)
            except Exception as fallback:
                raise TranscriptionError("ASR CPU fallback initialization failed") from fallback

    def _load(self, device: str, compute_type: str) -> Any:
        model = WhisperModel(
            str(self.settings.model_path.resolve()),
            device=device,
            compute_type=compute_type,
            cpu_threads=self.settings.cpu_threads,
            num_workers=1,
            local_files_only=True,
        )
        model.feature_extractor = DeterministicFeatureExtractor(
            feature_size=model.feature_extractor.mel_filters.shape[0]
        )
        return model

    def _vad_options(self) -> Any:
        return VadOptions(
            threshold=self.settings.speech_threshold,
            neg_threshold=self.settings.negative_threshold,
            min_speech_duration_ms=0,
            max_speech_duration_s=self.settings.chunk_us / 1_000_000,
            min_silence_duration_ms=self.settings.min_silence_ms,
            speech_pad_ms=self.settings.speech_padding_ms,
        )

    def _language_regions(
        self, wav: Any, duration_us: int, check: Callable[[], None]
    ) -> list[tuple[int, int, str | None, float]]:
        """Two-pass streaming plan; language evidence is not a whole-file prompt.

        Every four-second source cell is inspected independently. Only cells
        containing Silero speech contribute language evidence. Weak evidence is
        resolved from adjacent evidence, never by assuming English. PCM is never
        concatenated or removed from the later decoding windows.
        """
        cells: list[tuple[int, int, str | None, dict[str, float]]] = []
        for lower in range(0, duration_us, 4_000_000):
            check()
            upper = min(duration_us, lower + 4_000_000)
            start = lower * 16000 // 1_000_000
            end = min(wav.getnframes(), (upper * 16000 + 999999) // 1_000_000)
            wav.setpos(start)
            pcm = np.frombuffer(wav.readframes(end - start), dtype="<i2").astype(np.float32)
            pcm /= 32768
            language = None
            probabilities: dict[str, float] = {}
            speech = get_speech_timestamps(pcm, self._vad_options())
            if speech:
                # The supported CT2 encoder accepts the actual feature length.
                # Language probes need no artificial 30-second padded encoder
                # window; retain that normal FW context for transcription.
                encoded = self.model.encode(self.model.feature_extractor(pcm))
                native = self.model.model.detect_language(encoded)[0]
                probabilities = {str(token)[2:-2]: float(value) for token, value in native}
                detected = str(native[0][0])[2:-2]
                probability = float(native[0][1])
                if probability >= 0.5:
                    language = str(detected)
            cells.append((lower, upper, language, probabilities))
        # An uncertain/silent cell borrows a neighboring language only to give
        # the decoder a prompt; VAD still determines whether it contains speech.
        known = [(i, cell[2]) for i, cell in enumerate(cells) if cell[2] is not None]
        regions: list[tuple[int, int, str | None, float]] = []
        for i, (lower, upper, language, probabilities) in enumerate(cells):
            if language is None and known:
                language = min(known, key=lambda item: (abs(item[0] - i), item[0]))[1]
            probability = probabilities.get(language, 0.0) if language is not None else 0.0
            if regions and regions[-1][2] == language:
                start, _, _, previous_probability = regions[-1]
                probability = (
                    previous_probability * (lower - start) + probability * (upper - lower)
                ) / (upper - start)
                regions[-1] = (start, upper, language, probability)
            else:
                regions.append((lower, upper, language, probability))
        return regions

    def _decode_window(
        self,
        audio: Any,
        language: str | None,
        check: Callable[[], None],
        *,
        stitch_speech: bool = True,
    ) -> tuple[list[Any], Any]:
        check()
        segments, info = self.model.transcribe(
            audio,
            word_timestamps=True,
            language=language,
            beam_size=self.settings.beam_size,
            temperature=0.0,
            condition_on_previous_text=False,
            vad_filter=stitch_speech,
            vad_parameters={
                "threshold": self.settings.speech_threshold,
                "neg_threshold": self.settings.negative_threshold,
                "min_speech_duration_ms": 0,
                "max_speech_duration_s": self.settings.chunk_us / 1_000_000,
                "min_silence_duration_ms": self.settings.min_silence_ms,
                "speech_pad_ms": self.settings.speech_padding_ms,
            },
        )
        decoded = []
        for segment in segments:
            check()
            if segment.text.strip() and not segment.words:
                raise TranscriptionError("ASR text has no word alignment")
            decoded.append(segment)
        check()
        return decoded, info

    def _alignment_state(
        self, segments: list[Any], audio: Any
    ) -> tuple[list[Any], str, bool, bool]:
        words = attach_boundary_punctuation(
            [word for segment in segments for word in segment.words or []]
        )
        text = "".join(segment.text for segment in segments)
        previous = 0.0
        duration = len(audio) / 16000
        valid = "".join(w.word for w in words).strip() == text.strip()
        right_edge_failure = False
        for word in words:
            if word.start < previous or not 0 <= word.start < word.end <= duration:
                valid = False
                if word.end >= duration - self.settings.overlap_us / 1_000_000:
                    right_edge_failure = True
            previous = word.end
        return words, text, valid, right_edge_failure

    def _continued_pcm(
        self,
        wav: Any,
        first: int,
        initial_end: int,
        language_end: int,
        original: Any,
        check: Callable[[], None],
    ) -> Any:
        check()
        last = min(
            wav.getnframes(),
            (language_end * 16000 + 999999) // 1_000_000,
            first + 480000,
            initial_end + self.settings.overlap_us * 16000 // 1_000_000,
        )
        if last <= initial_end:
            return None
        wav.setpos(first)
        raw = wav.readframes(last - first)
        if len(raw) != 2 * (last - first):
            raise TranscriptionError("Truncated ASR continuation PCM")
        continued = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
        if not np.array_equal(continued[: len(original)], original):
            raise TranscriptionError("ASR continuation source prefix changed")
        return continued

    def _aligned_chunk(
        self,
        segments: list[Any],
        audio: Any,
        language: str,
        check: Callable[[], None] | None = None,
    ) -> list[Any]:
        try:
            return self._primary_aligned_chunk(segments, audio, language, check)
        except (TranscriptionCancelled, TranscriptionTimeout):
            raise
        except TranscriptionError as primary:
            if self.settings.model != "tiny":
                raise
            try:
                return self._fallback_alignment(segments, audio, language, check)
            except (TranscriptionCancelled, TranscriptionTimeout):
                raise
            except TranscriptionError as fallback:
                raise primary from fallback

    def _fallback_alignment(
        self,
        segments: list[Any],
        audio: Any,
        language: str,
        check: Callable[[], None] | None,
    ) -> list[Any]:
        """Bounded small-model alignment supplies anchored timings, never decoder text.

        Tiny's attention can collapse a genuine word on supported CPU kernels.
        The immutable small model is used only for forced alignment. Every
        complete context must retain the exact indexed lexical sequence with
        positive ordered native intervals. Decoder probabilities are preserved.
        No small-model transcription or guessed duration occurs.
        """
        if check is not None:
            check()
        words, text, _, _ = self._alignment_state(segments, audio)
        if not 0 < len(audio) <= 480000 or "".join(w.word for w in words).strip() != text.strip():
            raise TranscriptionError("ASR fallback has no complete bounded lexical evidence")
        if self._alignment_model is None:
            path = self.settings.model_root / "small"
            verify_asr_model(path, "small")
            if check is not None:
                check()
            try:
                model = WhisperModel(
                    str(path.resolve()),
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=self.settings.cpu_threads,
                    num_workers=1,
                    local_files_only=True,
                )
                model.feature_extractor = DeterministicFeatureExtractor(
                    feature_size=model.feature_extractor.mel_filters.shape[0]
                )
                self._alignment_model = model
            except Exception as exc:
                raise TranscriptionError("Pinned ASR alignment model is unavailable") from exc
        if check is not None:
            check()
        candidate = self._primary_aligned_chunk(
            segments,
            audio,
            language,
            check,
            alignment_model=self._alignment_model,
            maximum_encodes=24,
        )
        _, _, valid, _ = self._alignment_state([SimpleNamespace(text=text, words=candidate)], audio)
        if not valid or [w.word for w in candidate] != [w.word for w in words]:
            raise TranscriptionError("ASR words require trustworthy realignment")
        if check is not None:
            check()
        return [
            SimpleNamespace(word=w.word, start=w.start, end=w.end, probability=original.probability)
            for w, original in zip(candidate, words, strict=True)
        ]

    def close(self) -> None:
        """Release both native models when an adapter outlives a single request."""
        failures = []
        for model in (self._alignment_model, self.model):
            if model is not None:
                try:
                    model.model.unload_model()
                except Exception as exc:
                    failures.append(exc)
        if failures:
            raise TranscriptionError("ASR native model cleanup failed") from failures[0]
        self._alignment_model = None

    def _primary_aligned_chunk(
        self,
        segments: list[Any],
        audio: Any,
        language: str,
        check: Callable[[], None] | None = None,
        *,
        alignment_model: Any = None,
        maximum_encodes: int | None = None,
    ) -> list[Any]:
        """Supported CT2 forced alignment preserves complete recognized text.

        Native zero/overlapping word intervals cannot be published. The bounded original PCM
        and complete segment text are re-aligned; no lexical words or positive boundaries are
        fabricated. Unresolved alignment still fails closed. Context is at most thirty seconds.
        """
        if alignment_model is None:
            alignment_model = self.model
        if maximum_encodes is None:
            maximum_encodes = 8 if self.settings.model == "tiny" else 32
        words, text, valid, _ = self._alignment_state(segments, audio)
        if valid:
            return words
        tokenizer = Tokenizer(
            alignment_model.hf_tokenizer,
            alignment_model.model.is_multilingual,
            task="transcribe",
            language=language,
        )

        alignment_encodes = 0
        full_evidence: list[list[Any]] = []

        def force(
            content: str, pcm: Any, retain: bool = False, reference: list[Any] | None = None
        ) -> list[Any] | None:
            nonlocal alignment_encodes
            if check is not None:
                check()
            alignment_encodes += 1
            if alignment_encodes > maximum_encodes:
                raise TranscriptionError("ASR trustworthy realignment resource bound exceeded")
            # CT2 supports variable-length encoder input. Artificial 30s padding
            # changes cross-attention evidence for short local speech and can
            # collapse real lexical words into zero-length alignment bins.
            # Align only the actual, bounded source features; no audio/time is
            # invented to satisfy the word contract.
            features = alignment_model.feature_extractor(pcm)
            # Faster-Whisper's 160-sample end padding adds one feature column
            # at exactly 30 seconds. Match its decoder's model-length trim:
            # retain the complete source window, excluding only that overflow
            # column. Short alignment windows remain unpadded and unchanged.
            if features.shape[-1] > 3000:
                features = features[..., :3000]
            encoded = alignment_model.encode(features)
            evidence = []
            for width in (7, 5, 3, 1):
                if check is not None:
                    check()
                alignment = alignment_model.find_alignment(
                    tokenizer,
                    [tokenizer.encode(content)],
                    encoded,
                    min(3000, (len(pcm) + 159) // 160),
                    median_filter_width=width,
                )[0]
                merge_punctuations(alignment, "\"'“¿([{-", "\"'.。,，!！?？:：”)]}、")
                result = [
                    SimpleNamespace(
                        word=w["word"],
                        start=float(w["start"]),
                        end=float(w["end"]),
                        probability=float(w["probability"]),
                    )
                    for w in alignment
                    if w["word"]
                ]
                result = attach_boundary_punctuation(result)
                if "".join(w.word for w in result).strip() != content.strip():
                    raise TranscriptionError("Alignment changed complete transcript text")
                if retain:
                    full_evidence.append(result)
                evidence.append(result)
                if all(0 <= w.start < w.end <= len(pcm) / 16000 for w in result) and all(
                    a.end <= b.start for a, b in zip(result, result[1:], strict=False)
                ):
                    return result
            # Local attention windows can collapse different words at different
            # filter widths too. Preserve their observed intervals until every
            # candidate has been checked; a defect elsewhere must not discard
            # an anchored, positive native interval for the word being repaired.
            if reference is not None:
                return merge_native_alignment_evidence(reference, evidence, len(pcm) / 16000)
            return None

        def repair_native() -> list[Any] | None:
            if "".join(w.word for w in words).strip() != text.strip():
                return None
            repaired = [
                SimpleNamespace(
                    word=w.word,
                    start=float(w.start),
                    end=float(w.end),
                    probability=float(w.probability),
                )
                for w in words
            ]
            for i, word in enumerate(repaired):
                if 0 <= word.start < word.end <= len(audio) / 16000 and (
                    i == 0 or repaired[i - 1].end <= word.start
                ):
                    continue
                found = False
                for neighbours in (2, 3, 4, 6, 8):
                    if found:
                        break
                    left = max(0, i - neighbours)
                    right = min(len(repaired), i + neighbours + 1)
                    for padding in (6400, 16000, 32000):
                        lower = max(0, int(Decimal(str(repaired[left].start)) * 16000) - padding)
                        upper = min(
                            len(audio),
                            int(Decimal(str(repaired[right - 1].end)) * 16000) + padding,
                        )
                        if not lower < upper or upper - lower > 480000:
                            continue
                        content = "".join(w.word for w in repaired[left:right])
                        reference = [
                            SimpleNamespace(
                                word=w.word,
                                start=w.start - lower / 16000,
                                end=w.end - lower / 16000,
                                probability=w.probability,
                            )
                            for w in repaired[left:right]
                        ]
                        part = force(content, audio[lower:upper], reference=reference)
                        if part is None or [w.word.strip() for w in part] != [
                            w.word.strip() for w in repaired[left:right]
                        ]:
                            continue
                        for candidate in part:
                            candidate.start += lower / 16000
                            candidate.end += lower / 16000
                        if (left > 0 and part[0].start < repaired[left - 1].end) or (
                            right < len(repaired) and part[-1].end > repaired[right].start
                        ):
                            continue
                        repaired[left:right] = part
                        found = True
                        break
                if not found:
                    return None
            if all(0 <= w.start < w.end <= len(audio) / 16000 for w in repaired) and all(
                a.end <= b.start for a, b in zip(repaired, repaired[1:], strict=False)
            ):
                return repaired
            return None

        result = force(text, audio, retain=True)
        if result is not None:
            return result
        if "".join(w.word for w in words).strip() == text.strip():
            result = merge_native_alignment_evidence(words, full_evidence, len(audio) / 16000)
            if result is not None:
                return result
        # Long-context attention can collapse a short word into one 20ms bin.
        # Re-align complete segment text using its original local PCM plus context,
        # never synthetic epsilon durations or a model-generated reference transcript.
        localized = []
        for segment in segments:
            lower = max(0, int(Decimal(str(segment.start)) * 16000) - 16000)
            upper = min(len(audio), int(Decimal(str(segment.end)) * 16000) + 16000)
            if not lower < upper or upper - lower > 480000:
                raise TranscriptionError("Invalid local alignment context")
            part = force(segment.text, audio[lower:upper])
            if part is None:
                repaired = repair_native()
                if repaired is not None:
                    return repaired
                raise TranscriptionError("ASR words require trustworthy realignment")
            for word in part:
                word.start += lower / 16000
                word.end += lower / 16000
            localized.extend(part)
        if "".join(w.word for w in localized).strip() != text.strip() or any(
            a.end > b.start for a, b in zip(localized, localized[1:], strict=False)
        ):
            repaired = repair_native()
            if repaired is not None:
                return repaired
            raise TranscriptionError("ASR local alignment violates transcript integrity")
        return localized

    def _reconcile_overlaps(
        self,
        chunks: list[tuple[int, int, tuple[Word, ...]]],
        languages: list[str],
        wav: Any,
        source: AudioIdentity,
        check: Callable[[], None],
    ) -> list[tuple[int, int, tuple[Word, ...]]]:
        """Recover recognized boundary words using bounded native evidence.

        A context can omit an owned word or disagree about its positive timing.
        Normally two spelling-preserving lexical/temporal anchors establish the
        shared sequence without replacing owned text. A unique-anchor fallback
        can select a strictly dominant, more complete prefix of the SAME audio;
        unrelated owned text is never skipped. Re-align on bounded original PCM,
        never guessed spans or replacement recognition.
        """
        chunks = list(chunks)
        for index in range(1, len(chunks)):
            check()
            if languages[index - 1] != languages[index] or not self.settings.overlap_us:
                continue
            boundary = chunks[index][0]
            lower = boundary - self.settings.overlap_us
            upper = boundary + self.settings.overlap_us
            left, right = chunks[index - 1][2], chunks[index][2]
            li = [i for i, w in enumerate(left) if w.end_us > lower and w.start_us < upper]
            ri = [i for i, w in enumerate(right) if w.end_us > lower and w.start_us < upper]
            if not li or not ri:
                continue
            tail, head = left[li[0] : li[-1] + 1], right[ri[0] : ri[-1] + 1]
            matches = []
            # Leading context belongs to the previous core. Its independently
            # decoded capitalization must not prevent two later lexical
            # temporal anchors from establishing the shared sequence. Never
            # skip an owned word or normalize the selected decoder text.
            for tail_end in range(len(tail), 1, -1):
                # The left decoder can punctuate an unfinished context word
                # differently. Only trailing words owned by the RIGHT core may
                # be excluded from anchor search; retain every left-owned word.
                if (
                    tail_end < len(tail)
                    and tail[tail_end].start_us + tail[tail_end].end_us < 2 * boundary
                ):
                    break
                for head_offset in range(len(head)):
                    check()
                    if (
                        head_offset
                        and head[head_offset - 1].start_us + head[head_offset - 1].end_us
                        >= 2 * boundary
                    ):
                        break
                    for count in range(2, min(tail_end, len(head) - head_offset) + 1):
                        if all(
                            same_context_word(a.text, b.text)
                            and max(a.start_us, b.start_us) < min(a.end_us, b.end_us)
                            for a, b in zip(
                                tail[tail_end - count : tail_end],
                                head[head_offset : head_offset + count],
                                strict=True,
                            )
                        ):
                            matches.append(
                                (
                                    count,
                                    head_offset,
                                    tail_end,
                                    all(
                                        a.text.strip() == b.text.strip()
                                        for a, b in zip(
                                            tail[tail_end - count : tail_end],
                                            head[head_offset : head_offset + count],
                                            strict=True,
                                        )
                                    ),
                                )
                            )
            if not matches:
                # Two contexts may disagree about the same spoken prefix,
                # rather than merely omit a word. Do not throw away a more
                # complete, strictly stronger native hypothesis just because
                # the shorter decoder replaced two words with one. This path
                # accepts ONLY a unique exact temporal anchor, complete time
                # coverage of the competing prefix, and strict confidence
                # dominance for EVERY replacement word. It cannot skip an
                # unrelated owned word or choose between repeated anchors.
                dominant = self._dominant_boundary_prefix(tail, head, boundary)
                if dominant is None:
                    continue
                matches = [(1, dominant[0], dominant[1], True)]
            # Existing exact anchors are stronger evidence than case-only
            # aliases. Use the latter only when no exact pair is available;
            # never create ambiguity in an already established exact sequence.
            if any(item[3] for item in matches):
                matches = [item for item in matches if item[3]]
            count = max(item[0] for item in matches)
            offsets = [(offset, end) for size, offset, end, _ in matches if size == count]
            if len(offsets) != 1:
                raise TranscriptionError("ASR overlap has ambiguous temporal anchors")
            head_offset, tail_end = offsets[0]
            head = head[head_offset:]
            prefix = tail[: tail_end - count]
            # Keep the owning left decoder's original spelling/capitalization
            # for shared left-owned anchors. No case normalization is emitted.
            head = (
                tuple(
                    a if a.start_us + a.end_us < 2 * boundary and a.text != b.text else b
                    for a, b in zip(tail[tail_end - count : tail_end], head[:count], strict=True)
                )
                + head[count:]
            )
            missing = [
                w
                for w in prefix
                if w.start_us + w.end_us >= 2 * boundary
                and not any(
                    w.text.strip() == other.text.strip()
                    and max(w.start_us, other.start_us) < min(w.end_us, other.end_us)
                    for other in head
                )
            ]
            owned_left = [
                w for w in tail if 2 * chunks[index - 1][0] <= w.start_us + w.end_us < 2 * boundary
            ]
            owned_right = [
                w for w in head if 2 * boundary <= w.start_us + w.end_us < 2 * chunks[index][1]
            ]
            collision = bool(
                owned_left and owned_right and owned_left[-1].end_us > owned_right[0].start_us
            )
            if not missing and not collision:
                continue
            combined = [*prefix, *head]
            padding = 0 if collision else 1_000_000
            first = max(
                0,
                (min(w.start_us for w in combined) - source.scope_start_us - padding)
                * 16000
                // 1_000_000,
            )
            last = min(
                wav.getnframes(),
                (
                    (max(w.end_us for w in combined) - source.scope_start_us + padding) * 16000
                    + 999999
                )
                // 1_000_000,
            )
            # Context padding must not bring an untouched neighboring word
            # into this alignment hypothesis. Bound actual PCM at its existing
            # outside anchors before native inference, rather than clipping or
            # shifting the inferred word intervals afterwards. Round inward to
            # whole samples so no read crosses either immutable time boundary.
            if li[0]:
                first = max(
                    first,
                    ((left[li[0] - 1].end_us - source.scope_start_us) * 16000 + 999999)
                    // 1_000_000,
                )
            if ri[-1] + 1 < len(right):
                last = min(
                    last,
                    (right[ri[-1] + 1].start_us - source.scope_start_us) * 16000 // 1_000_000,
                )
            if not first < last or last - first > 480000:
                raise TranscriptionError("ASR boundary alignment context is invalid")
            wav.setpos(first)
            raw = wav.readframes(last - first)
            if len(raw) != 2 * (last - first):
                raise TranscriptionError("Truncated boundary alignment PCM")
            audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
            offset = Decimal(first) / 16000 + Decimal(source.scope_start_us) / 1_000_000
            candidates = [
                SimpleNamespace(
                    word=w.text,
                    start=float(Decimal(w.start_us) / 1_000_000 - offset),
                    end=float(Decimal(w.end_us) / 1_000_000 - offset),
                    probability=w.confidence,
                )
                for w in combined
            ]
            segment = SimpleNamespace(
                text="".join(w.text for w in combined),
                words=candidates,
                start=0,
                end=len(audio) / 16000,
            )
            aligned = self._aligned_chunk([segment], audio, languages[index], check)
            if [w.word for w in aligned] != [w.text for w in combined]:
                raise TranscriptionError("ASR boundary alignment changed indexed decoder text")
            repaired = tuple(
                Word(
                    w.word,
                    source.scope_start_us + microseconds(w.start, first),
                    source.scope_start_us + microseconds(w.end, first),
                    float(w.probability),
                )
                for w in aligned
            )
            if (
                not repaired
                or (li[0] and repaired[0].start_us < left[li[0] - 1].end_us)
                or (ri[-1] + 1 < len(right) and repaired[-1].end_us > right[ri[-1] + 1].start_us)
            ):
                raise TranscriptionError("ASR boundary alignment violates outside anchors")
            chunks[index - 1] = (
                *chunks[index - 1][:2],
                (*left[: li[0]], *repaired, *left[li[-1] + 1 :]),
            )
            chunks[index] = (*chunks[index][:2], (*right[: ri[0]], *repaired, *right[ri[-1] + 1 :]))
        return chunks

    @staticmethod
    def _dominant_boundary_prefix(
        tail: tuple[Word, ...], head: tuple[Word, ...], boundary: int
    ) -> tuple[int, int] | None:
        """Select a strictly dominant native hypothesis for the SAME audio.

        Confidence is relative decoder evidence, not statistical certainty.
        No text or timestamp is invented. Original-PCM/outside-anchor checks in
        the caller still apply. Ordinary two-anchor reconciliation takes priority.
        """
        anchors = [
            (i, j)
            for i, a in enumerate(tail)
            for j, b in enumerate(head)
            if a.text.strip() == b.text.strip()
            and max(a.start_us, b.start_us) < min(a.end_us, b.end_us)
        ]
        if len(anchors) != 1:
            return None
        i, j = anchors[0]
        anchor = head[j]
        if (
            i != len(tail) - 1
            or sum(w.text.strip() == anchor.text.strip() for w in tail) != 1
            or sum(w.text.strip() == anchor.text.strip() for w in head) != 1
        ):
            return None
        replacement = [w for w in tail[:i] if w.start_us + w.end_us >= 2 * boundary]
        competing = [w for w in head[:j] if w.start_us + w.end_us >= 2 * boundary]
        if not competing or len(replacement) <= len(competing):
            return None
        if min(w.confidence for w in replacement) <= max(w.confidence for w in competing):
            return None
        # Require full interval coverage, not merely intersecting midpoints.
        # A different non-overlapping word must never be discarded to find an
        # anchor. Either existing alignment of the same shared word supplies
        # coverage evidence; emitted spelling/timing still follows ownership.
        evidence = sorted([*replacement, tail[i], anchor], key=lambda w: w.start_us)
        for word in competing:
            cursor = word.start_us
            for observed in evidence:
                if observed.end_us <= cursor:
                    continue
                if observed.start_us > cursor:
                    return None
                cursor = max(cursor, observed.end_us)
                if cursor >= word.end_us:
                    break
            if cursor < word.end_us:
                return None
        return j, i + 1

    @staticmethod
    def _unrepresented_words(
        candidates: list[Any],
        words: list[Any],
        start: int,
        lower: int,
        upper: int,
        last_match: int = -1,
        *,
        intersect_gap: bool = False,
    ) -> tuple[list[int], int]:
        """Ordered lexical AND original-PCM evidence, including repeated words."""
        missing = []
        for index, word in enumerate(candidates):
            text = word.word.strip()
            if not text:
                continue
            first = Decimal(start) / 16000 + Decimal(str(word.start))
            last = Decimal(start) / 16000 + Decimal(str(word.end))
            matches = [
                position
                for position, represented in enumerate(words)
                if position > last_match
                and represented.word.strip() == text
                and max(first, Decimal(str(represented.start)))
                < min(last, Decimal(str(represented.end)))
            ]
            if matches:
                last_match = matches[0]
            elif (
                max(first * 16000, Decimal(lower)) < min(last * 16000, Decimal(upper))
                if intersect_gap
                else Decimal(lower) <= (first + last) * 8000 < Decimal(upper)
            ):
                missing.append(index)
        return missing, last_match

    def _coverage_evidence(
        self, audio: Any, words: list[Any], check: Callable[[], None]
    ) -> list[tuple[int, int, int, int, Any, str]]:
        evidence = []
        for lower, upper in uncovered_speech(audio, words, self._vad_options()):
            check()
            start = max(0, lower - 16000)
            end = min(len(audio), upper + 16000)
            # Every original window is <=30 seconds; no unbounded second pass.
            segments, info = self.model.transcribe(
                audio[start:end],
                language=None,
                word_timestamps=True,
                temperature=0.0,
                beam_size=self.settings.beam_size,
                condition_on_previous_text=False,
                vad_filter=False,
            )
            last_match = -1
            for segment in segments:
                check()
                # A second real decode, not VAD/noise alone, establishes that
                # lexical speech was omitted. Do not publish a partial result.
                if segment.avg_logprob < -1.0 or segment.no_speech_prob >= 0.6:
                    continue
                if segment.text.strip() and not segment.words:
                    raise TranscriptionError("ASR recognized speech lacks complete word coverage")
                missing, last_match = self._unrepresented_words(
                    segment.words or [],
                    words,
                    start,
                    lower,
                    upper,
                    last_match,
                    intersect_gap=True,
                )
                if missing:
                    evidence.append((start, end, lower, upper, segment, str(info.language)))
        return evidence

    def _recover_coverage(
        self, audio: Any, words: list[Any], check: Callable[[], None]
    ) -> list[Any]:
        """One bounded source-backed recovery pass; never infer durations or text.

        Short independent decodes can recover a disfluent/repeated utterance
        absent from the long-context hypothesis. Keep only native lexical
        observations owned by an uncovered speech interval. The entire decoded
        segment must have trustworthy alignment; existing words are immutable
        outside anchors. Ambiguous overlap still fails closed. The ordinary
        independent completeness check runs again after these additions.
        """
        represented = list(words)
        additions = []
        for start, end, lower, upper, segment, language in self._coverage_evidence(
            audio, words, check
        ):
            check()
            aligned, _, valid, _ = self._alignment_state([segment], audio[start:end])
            if not valid:
                raise TranscriptionError("ASR coverage hypothesis has no trustworthy native timing")
            # Retain whole native words crossing a VAD edge too. Midpoint-only
            # recovery could drop the first lexical word in a recovered phrase.
            # Existing outside anchors still forbid overlap or guessed timing.
            missing, _ = self._unrepresented_words(
                aligned, represented, start, lower, upper, intersect_gap=True
            )
            if not missing:
                continue
            selected = [aligned[index] for index in missing]
            origin = Decimal(start) / 16000
            first_midpoint = (
                origin + (Decimal(str(selected[0].start)) + Decimal(str(selected[0].end))) / 2
            )
            last_midpoint = (
                origin + (Decimal(str(selected[-1].start)) + Decimal(str(selected[-1].end))) / 2
            )
            left = [w for w in represented if Decimal(str(w.end)) <= first_midpoint]
            right = [w for w in represented if Decimal(str(w.start)) >= last_midpoint]
            if len(left) + len(right) != len(represented):
                raise TranscriptionError("ASR coverage repair crosses existing word evidence")
            # Independently decoded neighbors can overlap at a short-context
            # edge. Bound the ORIGINAL PCM by immutable outside words, then
            # align the complete missing phrase, rather than clipping inferred
            # intervals or discarding its first word.
            first_sample, last_sample = start, end
            if left:
                first_sample = max(
                    first_sample,
                    int(
                        (Decimal(str(left[-1].end)) * 16000).to_integral_value(
                            rounding="ROUND_CEILING"
                        )
                    ),
                )
            if right:
                last_sample = min(
                    last_sample,
                    int(
                        (Decimal(str(right[0].start)) * 16000).to_integral_value(
                            rounding="ROUND_FLOOR"
                        )
                    ),
                )
            if not first_sample < last_sample:
                raise TranscriptionError("ASR coverage repair has no bounded source context")
            patch_origin = Decimal(first_sample) / 16000
            segment = SimpleNamespace(
                text="".join(w.word for w in selected),
                start=0,
                end=(last_sample - first_sample) / 16000,
                words=[
                    SimpleNamespace(
                        word=w.word,
                        start=float(origin + Decimal(str(w.start)) - patch_origin),
                        end=float(origin + Decimal(str(w.end)) - patch_origin),
                        probability=float(w.probability),
                    )
                    for w in selected
                ],
            )
            patch = self._aligned_chunk([segment], audio[first_sample:last_sample], language, check)
            if [w.word for w in patch] != [w.word for w in selected]:
                raise TranscriptionError("ASR coverage alignment changed complete missing text")
            for word, original in zip(patch, selected, strict=True):
                first = patch_origin + Decimal(str(word.start))
                last = patch_origin + Decimal(str(word.end))
                if any(
                    max(first, Decimal(str(w.start))) < min(last, Decimal(str(w.end)))
                    for w in represented
                ):
                    raise TranscriptionError("ASR coverage repair violates outside anchors")
                candidate = SimpleNamespace(
                    word=word.word, start=first, end=last, probability=float(original.probability)
                )
                additions.append(candidate)
                represented.append(candidate)
                represented.sort(key=lambda w: (w.start, w.end))
        return additions

    def _verify_coverage(self, audio: Any, words: list[Any], check: Callable[[], None]) -> None:
        if self._coverage_evidence(audio, words, check):
            raise TranscriptionError("ASR recognized speech lacks complete word coverage")

    def transcribe(
        self,
        audio_path: str,
        source: AudioIdentity,
        cancellation: Cancellation | None = None,
        progress: Callable[[int, int], None] | None = None,
    ) -> Transcript:
        deadline = time.monotonic() + self.settings.timeout_ms / 1000

        def check() -> None:
            if cancellation is not None and cancellation.is_set():
                raise TranscriptionCancelled("Transcription cancelled")
            if time.monotonic() >= deadline:
                raise TranscriptionTimeout("Transcription deadline exceeded")

        check()
        path = Path(audio_path)
        verify_audio_file(path, source, check)
        if wav_parameters(path, source) != (16000, 1, 2):
            raise TranscriptionError("Transcription requires verified canonical mono PCM16 WAV")
        chunks: list[tuple[int, int, tuple[Word, ...]]] = []
        chunk_languages: list[str] = []
        languages: dict[str, tuple[int, float]] = {}
        with wave.open(str(path), "rb") as wav:
            if wav.getnframes() < 1:
                raise TranscriptionError("Canonical audio is empty")
            try:
                regions = self._language_regions(wav, source.duration_us, check)
            except TranscriptionError:
                raise
            except Exception as exc:
                raise TranscriptionError("ASR language segmentation failed") from exc
            windows = [
                (
                    core,
                    min(region_end, core + self.settings.chunk_us),
                    max(region_start, core - self.settings.overlap_us),
                    min(region_end, core + self.settings.chunk_us + self.settings.overlap_us),
                    detected_language,
                    language_probability,
                    region_end,
                )
                for region_start, region_end, detected_language, language_probability in regions
                for core in range(region_start, region_end, self.settings.chunk_us)
            ]
            for (
                core,
                end,
                lower,
                upper,
                detected_language,
                language_probability,
                region_end,
            ) in windows:
                check()
                start_sample = lower * 16000 // 1_000_000
                # Verified WAV duration may differ by at most one PCM sample
                # from integer source time. Never read a nonexistent final
                # sample or pad missing source content to satisfy rounding.
                end_sample = min(wav.getnframes(), (upper * 16000 + 999_999) // 1_000_000)
                wav.setpos(start_sample)
                raw = wav.readframes(end_sample - start_sample)
                if len(raw) != 2 * (end_sample - start_sample):
                    raise TranscriptionError("Truncated canonical audio")
                audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
                try:
                    decoded, info = self._decode_window(audio, detected_language, check)
                    _, _, valid, right_edge_failure = self._alignment_state(decoded, audio)
                    retried = False
                    if not valid and right_edge_failure:
                        continued = self._continued_pcm(
                            wav, start_sample, end_sample, region_end, audio, check
                        )
                        if continued is not None:
                            audio = continued
                            decoded, info = self._decode_window(
                                audio, detected_language, check, stitch_speech=False
                            )
                            retried = True
                    candidates = []
                    try:
                        aligned = self._aligned_chunk(decoded, audio, str(info.language), check)
                    except (TranscriptionCancelled, TranscriptionTimeout):
                        raise
                    except TranscriptionError as alignment_failure:
                        if retried:
                            raise
                        # Exhaust trustworthy timing evidence before replacing
                        # a recoverable hypothesis. VAD stitching can collapse
                        # an entire terminal phrase. One actual contiguous-PCM
                        # decode may provide a valid complete native hypothesis;
                        # never post-filter tokens or invent positive timing.
                        decoded, info = self._decode_window(
                            audio, detected_language, check, stitch_speech=False
                        )
                        _, _, retry_valid, _ = self._alignment_state(decoded, audio)
                        if not retry_valid:
                            raise alignment_failure
                        # Native-valid timing requires zero additional encodes,
                        # preserving the existing total alignment resource bound.
                        aligned = self._aligned_chunk(decoded, audio, str(info.language), check)
                    for word in aligned:
                        check()
                        candidates.append(
                            Word(
                                word.word,
                                source.scope_start_us + microseconds(word.start, start_sample),
                                source.scope_start_us + microseconds(word.end, start_sample),
                                float(word.probability),
                            )
                        )
                    language = str(info.language)
                    chunk_languages.append(language)
                    weight = sum(
                        max(
                            0,
                            min(w.end_us, source.scope_start_us + end)
                            - max(w.start_us, source.scope_start_us + core),
                        )
                        for w in candidates
                    )
                    if weight:
                        count, probability_sum = languages.get(language, (0, 0.0))
                        languages[language] = (
                            count + weight,
                            probability_sum
                            + (
                                language_probability
                                if detected_language is not None
                                else float(info.language_probability)
                            )
                            * weight,
                        )
                    chunks.append(
                        (
                            source.scope_start_us + core,
                            source.scope_start_us + end,
                            tuple(candidates),
                        )
                    )
                    if progress is not None:
                        progress(end, source.duration_us)
                except TranscriptionError:
                    raise
                except Exception as exc:
                    raise TranscriptionError("ASR input or inference failed") from exc
            chunks = self._reconcile_overlaps(chunks, chunk_languages, wav, source, check)
            merged = merge_owned_words(chunks, source)
            # Judge complete canonical ownership, not an individual context's
            # partial view. Whole words from neighboring cores remain evidence.
            for _, _, lower, upper, _, _, _ in windows:
                check()
                first = lower * 16000 // 1_000_000
                last = min(wav.getnframes(), (upper * 16000 + 999999) // 1_000_000)
                wav.setpos(first)
                raw = wav.readframes(last - first)
                if len(raw) != 2 * (last - first):
                    raise TranscriptionError("Truncated coverage PCM")
                audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
                offset = Decimal(source.scope_start_us) / 1_000_000 + Decimal(first) / 16000
                represented = [
                    SimpleNamespace(
                        word=w.text,
                        start=Decimal(w.start_us) / 1_000_000 - offset,
                        end=Decimal(w.end_us) / 1_000_000 - offset,
                    )
                    for w in merged
                    if w.end_us > source.scope_start_us + lower
                    and w.start_us < source.scope_start_us + upper
                ]
                additions = self._recover_coverage(audio, represented, check)
                if additions:
                    recovered = tuple(
                        Word(
                            word.word,
                            int(
                                ((word.start + offset) * 1_000_000).quantize(
                                    Decimal(1), rounding=ROUND_HALF_UP
                                )
                            ),
                            int(
                                ((word.end + offset) * 1_000_000).quantize(
                                    Decimal(1), rounding=ROUND_HALF_UP
                                )
                            ),
                            word.probability,
                        )
                        for word in additions
                    )
                    merged = tuple(sorted((*merged, *recovered), key=lambda w: w.start_us))
                    represented = sorted((*represented, *additions), key=lambda w: w.start)
                self._verify_coverage(audio, represented, check)
        check()
        if not merged:
            return Transcript("und", 0.0, ())
        language = max(sorted(languages), key=lambda key: languages[key][0])
        duration, total_probability = languages[language]
        try:
            return Transcript(language, total_probability / duration, merged)
        except ValueError as exc:
            raise TranscriptionError("ASR output violates word integrity") from exc

    def parameters(self) -> dict[str, Any]:
        settings = self.settings.model_dump(mode="json", exclude={"model_root"})
        settings.update(
            {
                "effectiveDevice": self.device,
                "effectiveComputeType": self.compute_type,
                "temperature": 0,
                "conditionOnPreviousText": False,
                "workers": 1,
                "alignmentAlgorithm": ASR_ALGORITHM,
                "nativeCpuProfile": ASR_NATIVE_PROFILE,
                "nativeCpuEnvironment": dict(ASR_NATIVE_ENVIRONMENT),
                "featureProjection": "frequency-ordered-float32-v1",
                "languageDetectionWindowUs": 4000000,
                "languageDetectionMinimumProbability": 0.5,
                "languageDetection": "original-pcm-region-redetection-v1",
                "languageDetectionEncoder": "native-unpadded-log-mel-v1",
                "speechCoverage": "owned-word-union-temporal-lexical-decode-v3",
                "speechCoverageRecovery": "single-pass-native-gap-alignment-v1",
                "maximumCoverageRecoveryPassesPerWindow": 1,
                "maximumCoverageAlignmentEncodesPerGap": 32,
                "overlapReconciliation": "two-temporal-anchors-original-pcm-v1",
                "overlapAnchorIdentity": "ascii-case-only-exact-spelling-original-pcm-v1",
                "overlapCompetingPrefix": (
                    "unique-exact-anchor-full-native-coverage-strict-confidence-v1"
                ),
                "zeroTimePunctuation": "append-to-exactly-touching-lexical-word",
                "alignmentContextMaxUs": 30000000,
                "recognitionContextMaxUs": 30000000,
                "recognitionContinuation": "same-language-original-pcm-unstitched-once-v2",
                "recognitionContinuationMaxUs": self.settings.overlap_us,
                "maximumRecognitionPassesPerWindow": 2,
                "maximumAlignmentEncodesPerWindow": 32,
                "maximumPrimaryAlignmentEncodesPerWindow": 8
                if self.settings.model == "tiny"
                else 32,
                "maximumFallbackAlignmentEncodesPerWindow": 24
                if self.settings.model == "tiny"
                else 0,
                "alignmentFallbackModel": model_identity("small")
                if self.settings.model == "tiny"
                else None,
                "alignmentFallbackDevice": "cpu" if self.settings.model == "tiny" else None,
                "alignmentFallbackComputeType": "int8" if self.settings.model == "tiny" else None,
                "alignmentFallbackConfidence": "preserve-decoder-probabilities",
                "alignmentFallbackEvidence": "complete-context-exact-index-native-alignment-v1",
                "localAlignmentPaddingUs": 1000000,
                "wordAlignmentPaddingUs": [400000, 1000000, 2000000],
                "wordAlignmentNeighbours": [2, 3, 4, 6, 8],
                "alignmentFilterWidths": [7, 5, 3, 1],
                "alignmentEvidence": "exact-word-index-native-interval-two-anchor-v1",
            }
        )
        return settings

    def provenance(self, source: AudioIdentity) -> dict[str, Any]:
        import json

        settings = self.parameters()
        return {
            "analyzer": "faster-whisper",
            "analyzerVersion": "us201-v1",
            "sourceSha256": source.source_sha256,
            "inputArtifactId": source.artifact_id,
            "inputSha256": source.audio_sha256,
            "configurationSha256": hashlib.sha256(
                json.dumps(settings, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
            "runtime": "ctranslate2",
            "runtimeVersion": importlib.metadata.version("ctranslate2"),
            "model": self.model_identity,
        }
