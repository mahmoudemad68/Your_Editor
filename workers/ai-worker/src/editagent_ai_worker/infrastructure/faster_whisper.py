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
from editagent_ai_worker.infrastructure.asr_model import verify_asr_model
from editagent_ai_worker.infrastructure.config import (
    ASR_NATIVE_ENVIRONMENT,
    ASR_NATIVE_PROFILE,
    ConfigurationError,
    require_asr_native_environment,
)
from editagent_ai_worker.infrastructure.vad_audio import verify_audio_file, wav_parameters

ASR_ALGORITHM = "ct2-contextual-v12"


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
        self, audio: Any, language: str | None, check: Callable[[], None]
    ) -> tuple[list[Any], Any]:
        check()
        segments, info = self.model.transcribe(
            audio,
            word_timestamps=True,
            language=language,
            beam_size=self.settings.beam_size,
            temperature=0.0,
            condition_on_previous_text=False,
            vad_filter=True,
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
        """Supported CT2 forced alignment preserves complete recognized text.

        Native zero/overlapping word intervals cannot be published. The bounded original PCM
        and complete segment text are re-aligned; no lexical words or positive boundaries are
        fabricated. Unresolved alignment still fails closed. Context is at most thirty seconds.
        """
        words, text, valid, _ = self._alignment_state(segments, audio)
        if valid:
            return words
        tokenizer = Tokenizer(
            self.model.hf_tokenizer,
            self.model.model.is_multilingual,
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
            if alignment_encodes > 32:
                raise TranscriptionError("ASR trustworthy realignment resource bound exceeded")
            # CT2 supports variable-length encoder input. Artificial 30s padding
            # changes cross-attention evidence for short local speech and can
            # collapse real lexical words into zero-length alignment bins.
            # Align only the actual, bounded source features; no audio/time is
            # invented to satisfy the word contract.
            encoded = self.model.encode(self.model.feature_extractor(pcm))
            evidence = []
            for width in (7, 5, 3, 1):
                if check is not None:
                    check()
                alignment = self.model.find_alignment(
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
        """Recover recognized boundary words using two shared temporal anchors.

        A context can recognize a word whose midpoint belongs to the next core,
        while that core omits it. A maximal suffix/prefix match of at least two
        overlapping lexical anchors establishes sequence ownership. Re-align
        the complete joined text on original PCM; never insert guessed spans,
        replace differing text, or discard an unresolved recognized word.
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
            matches = [
                count
                for count in range(2, min(len(tail), len(head)) + 1)
                if all(
                    a.text.strip() == b.text.strip()
                    and max(a.start_us, b.start_us) < min(a.end_us, b.end_us)
                    for a, b in zip(tail[-count:], head[:count], strict=True)
                )
            ]
            if not matches:
                continue
            count = max(matches)
            prefix = tail[:-count]
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
            if not missing:
                continue
            combined = [*prefix, *head]
            first = max(
                0,
                (min(w.start_us for w in combined) - source.scope_start_us - 1_000_000)
                * 16000
                // 1_000_000,
            )
            last = min(
                wav.getnframes(),
                (max(w.end_us for w in combined) - source.scope_start_us + 1_000_000)
                * 16000
                // 1_000_000,
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

    def _verify_coverage(self, audio: Any, words: list[Any], check: Callable[[], None]) -> None:
        for lower, upper in uncovered_speech(audio, words, self._vad_options()):
            check()
            start = max(0, lower - 16000)
            end = min(len(audio), upper + 16000)
            # Every original window is <=30 seconds; no unbounded second pass.
            segments, _ = self.model.transcribe(
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
                for word in segment.words or []:
                    text = word.word.strip()
                    if not text:
                        continue
                    first = Decimal(start) / 16000 + Decimal(str(word.start))
                    last = Decimal(start) / 16000 + Decimal(str(word.end))
                    # Independent short-context alignment can extend an already
                    # represented word into the apparent gap. Require BOTH exact
                    # lexical identity and intersecting original-PCM intervals;
                    # matching text elsewhere is not evidence. Ordered one-to-one
                    # matching cannot hide an additional repeated word.
                    matches = [
                        index
                        for index, represented in enumerate(words)
                        if index > last_match
                        and represented.word.strip() == text
                        and max(first, Decimal(str(represented.start)))
                        < min(last, Decimal(str(represented.end)))
                    ]
                    if matches:
                        last_match = matches[0]
                        continue
                    if Decimal(lower) <= (first + last) * 8000 < Decimal(upper):
                        raise TranscriptionError(
                            "ASR recognized speech lacks complete word coverage"
                        )

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
                    if not valid and right_edge_failure:
                        continued = self._continued_pcm(
                            wav, start_sample, end_sample, region_end, audio, check
                        )
                        if continued is not None:
                            # A clipped context can hypothesize an unfinished word.
                            # Re-recognize actual additional source once, instead of
                            # assigning invented durations to that early hypothesis.
                            # Alignment below retains ALL final recognized text.
                            audio = continued
                            decoded, info = self._decode_window(audio, detected_language, check)
                    candidates = []
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
                "overlapReconciliation": "two-temporal-anchors-original-pcm-v1",
                "zeroTimePunctuation": "append-to-exactly-touching-lexical-word",
                "alignmentContextMaxUs": 30000000,
                "recognitionContextMaxUs": 30000000,
                "recognitionContinuation": "same-language-original-pcm-redecode-once-v1",
                "recognitionContinuationMaxUs": self.settings.overlap_us,
                "maximumRecognitionPassesPerWindow": 2,
                "maximumAlignmentEncodesPerWindow": 32,
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
