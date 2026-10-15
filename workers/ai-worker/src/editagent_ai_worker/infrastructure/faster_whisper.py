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
from faster_whisper.audio import pad_or_trim  # type: ignore[import-untyped]
from faster_whisper.tokenizer import Tokenizer  # type: ignore[import-untyped]
from faster_whisper.transcribe import merge_punctuations  # type: ignore[import-untyped]

from editagent_ai_worker.domain.analysis.transcription import (
    Transcript,
    TranscriptionCancelled,
    TranscriptionError,
    TranscriptionTimeout,
    Word,
)
from editagent_ai_worker.domain.analysis.voice_activity import AudioIdentity, Cancellation
from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.asr_model import verify_asr_model
from editagent_ai_worker.infrastructure.vad_audio import verify_audio_file, wav_parameters


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
        return WhisperModel(
            str(self.settings.model_path.resolve()),
            device=device,
            compute_type=compute_type,
            cpu_threads=self.settings.cpu_threads,
            num_workers=1,
            local_files_only=True,
        )

    def _aligned_chunk(self, segments: list[Any], audio: Any, language: str) -> list[Any]:
        """Supported CT2 forced alignment preserves complete recognized text.

        Native zero/overlapping word intervals cannot be published. The bounded original PCM
        and complete segment text are re-aligned; no lexical words or positive boundaries are
        fabricated. Unresolved alignment still fails closed. Context is at most thirty seconds.
        """
        words = attach_boundary_punctuation(
            [word for segment in segments for word in segment.words or []]
        )
        text = "".join(segment.text for segment in segments)
        previous = 0.0
        valid = "".join(w.word for w in words).strip() == text.strip()
        for word in words:
            if word.start < previous or word.start >= word.end:
                valid = False
            previous = word.end
        if valid:
            return words
        tokenizer = Tokenizer(
            self.model.hf_tokenizer,
            self.model.model.is_multilingual,
            task="transcribe",
            language=language,
        )

        def force(content: str, pcm: Any) -> list[Any] | None:
            encoded = self.model.encode(pad_or_trim(self.model.feature_extractor(pcm)))
            for width in (7, 5, 3, 1):
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
                if all(w.start < w.end for w in result):
                    return result
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
                if word.start < word.end and (i == 0 or repaired[i - 1].end <= word.start):
                    continue
                for neighbours in (2, 3, 4):
                    left = max(0, i - neighbours)
                    right = min(len(repaired), i + neighbours + 1)
                    lower = max(0, int(Decimal(str(repaired[left].start)) * 16000) - 6400)
                    upper = min(
                        len(audio), int(Decimal(str(repaired[right - 1].end)) * 16000) + 6400
                    )
                    if not lower < upper or upper - lower > 480000:
                        continue
                    content = "".join(w.word for w in repaired[left:right])
                    part = force(content, audio[lower:upper])
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
                    break
                else:
                    return None
            if all(w.start < w.end for w in repaired) and all(
                a.end <= b.start for a, b in zip(repaired, repaired[1:], strict=False)
            ):
                return repaired
            return None

        result = force(text, audio)
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
        languages: dict[str, tuple[int, float]] = {}
        with wave.open(str(path), "rb") as wav:
            if wav.getnframes() < 1:
                raise TranscriptionError("Canonical audio is empty")
            for core in range(0, source.duration_us, self.settings.chunk_us):
                check()
                end = min(source.duration_us, core + self.settings.chunk_us)
                lower = max(0, core - self.settings.overlap_us)
                upper = min(source.duration_us, end + self.settings.overlap_us)
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
                    segments, info = self.model.transcribe(
                        audio,
                        word_timestamps=True,
                        language=None,
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
                    candidates = []
                    for word in self._aligned_chunk(decoded, audio, str(info.language)):
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
                            probability_sum + float(info.language_probability) * weight,
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
        check()
        if not any(chunk[2] for chunk in chunks):
            return Transcript("und", 0.0, ())
        language = max(sorted(languages), key=lambda key: languages[key][0])
        duration, total_probability = languages[language]
        try:
            return Transcript(
                language, total_probability / duration, merge_owned_words(chunks, source)
            )
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
                "alignmentAlgorithm": "ct2-contextual-v5",
                "zeroTimePunctuation": "append-to-exactly-touching-lexical-word",
                "alignmentContextMaxUs": 30000000,
                "localAlignmentPaddingUs": 1000000,
                "wordAlignmentPaddingUs": 400000,
                "wordAlignmentNeighbours": [2, 3, 4],
                "alignmentFilterWidths": [7, 5, 3, 1],
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
