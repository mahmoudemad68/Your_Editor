"""Canonical speech section; integer microseconds internally, decimal strings in JSON."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import BinaryIO, Protocol

MAX_DURATION_US = 1_800_000_000  # Existing MediaAsset/SRS thirty-minute limit.
SAMPLE_RATE = 16_000
WINDOW_SAMPLES = 512


class VadError(Exception):
    """Non-secret failure at the perception boundary."""


class InvalidAudio(VadError):
    """Permanent invalid/corrupt/unsupported input or identity mismatch."""


class VadModelError(VadError):
    """Model/configuration failure: do not retry until configuration is repaired."""


class VadCancelled(VadError):
    """Caller cancelled; no successful result is returned."""


class VadTimeout(VadError):
    """Resource deadline exhausted; caller chooses bounded retry policy."""


def integer(value: int, lower: int, upper: int) -> None:
    if type(value) is not int or not lower <= value <= upper:
        raise ValueError("Integer is outside the supported range")


def probability(value: float) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Probability must be numeric")
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("Probability must be finite and in [0,1]")


@dataclass(frozen=True)
class VadConfiguration:
    speech_threshold: float
    negative_threshold: float
    min_speech_us: int
    min_silence_us: int
    padding_us: int

    def __post_init__(self) -> None:
        probability(self.speech_threshold)
        probability(self.negative_threshold)
        if not 0 < self.negative_threshold < self.speech_threshold < 1:
            raise ValueError("Hysteresis requires 0 < negative threshold < speech threshold < 1")
        integer(self.min_speech_us, 1, MAX_DURATION_US)
        integer(self.min_silence_us, 1, MAX_DURATION_US)
        integer(self.padding_us, 0, 1_000_000)


@dataclass(frozen=True)
class AudioIdentity:
    source_id: str
    source_sha256: str
    artifact_id: str
    audio_sha256: str
    source_duration_us: int
    scope_start_us: int
    scope_end_us: int

    def __post_init__(self) -> None:
        for value in (self.source_id, self.artifact_id):
            if not isinstance(value, str) or not re.fullmatch(
                r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", value
            ):
                raise ValueError("Invalid logical audio/source identity")
        for value in (self.source_sha256, self.audio_sha256):
            if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
                raise ValueError("Audio and source require SHA-256 identity")
        integer(self.source_duration_us, 1, MAX_DURATION_US)
        integer(self.scope_start_us, 0, self.source_duration_us)
        integer(self.scope_end_us, 1, self.source_duration_us)
        if self.scope_start_us >= self.scope_end_us:
            raise ValueError("Scope must be positive and inside source")

    @property
    def duration_us(self) -> int:
        return self.scope_end_us - self.scope_start_us

    @property
    def sample_count(self) -> int:
        return (self.duration_us * SAMPLE_RATE + 999_999) // 1_000_000


@dataclass(frozen=True)
class SpeechRegion:
    start_us: int
    end_us: int
    confidence: float

    def __post_init__(self) -> None:
        integer(self.start_us, 0, MAX_DURATION_US)
        integer(self.end_us, 1, MAX_DURATION_US)
        if self.start_us >= self.end_us:
            raise ValueError("Speech region must have positive duration")
        probability(self.confidence)


@dataclass(frozen=True)
class InferenceProvenance:
    adapter_version: str
    model_name: str
    model_version: str
    model_sha256: str
    runtime: str
    runtime_version: str
    numpy_version: str
    normalized_pcm_sha256: str
    configuration: VadConfiguration
    sample_rate: int = SAMPLE_RATE
    window_samples: int = WINDOW_SAMPLES
    context_samples: int = 64
    threads: int = 1
    device: str = "cpu"
    confidence_aggregation: str = "sample_weighted_mean_in_padded_region"

    def __post_init__(self) -> None:
        for value in (
            self.adapter_version,
            self.model_name,
            self.model_version,
            self.runtime,
            self.runtime_version,
            self.numpy_version,
        ):
            if not isinstance(value, str) or not re.fullmatch(
                r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", value
            ):
                raise ValueError("Invalid inference provenance identity")
        for digest in (self.model_sha256, self.normalized_pcm_sha256):
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("Inference provenance requires SHA-256 identities")
        if (
            self.sample_rate,
            self.window_samples,
            self.context_samples,
            self.threads,
            self.device,
            self.confidence_aggregation,
        ) != (16000, 512, 64, 1, "cpu", "sample_weighted_mean_in_padded_region"):
            raise ValueError("Unsupported inference layout or confidence convention")


@dataclass(frozen=True)
class SpeechAnalysis:
    source: AudioIdentity
    regions: tuple[SpeechRegion, ...]
    provenance: InferenceProvenance

    def __post_init__(self) -> None:
        previous = self.source.scope_start_us
        for region in self.regions:
            if region.start_us < previous or region.end_us > self.source.scope_end_us:
                raise ValueError("Speech regions must be ordered, disjoint and inside scope")
            previous = region.end_us


class Cancellation(Protocol):
    def is_set(self) -> bool: ...


class IVoiceActivityDetector(Protocol):
    """Stream normalized mono signed PCM16LE; no model/framework objects cross this port.

    The stream contains exactly source.sample_count samples for the declared scope.
    Audio identity refers to the persisted/staged audio artifact; normalized PCM has its own hash.
    """

    def detect(
        self,
        pcm: BinaryIO,
        source: AudioIdentity,
        configuration: VadConfiguration,
        cancellation: Cancellation | None = None,
    ) -> SpeechAnalysis: ...
