"""ASR port: source-coordinate values without model/runtime dependencies."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from .voice_activity import AudioIdentity, Cancellation, integer, probability


class TranscriptionError(Exception):
    """Safe perception boundary failure."""


class TranscriptionTimeout(TranscriptionError):
    """Declared inference deadline expired."""


class TranscriptionAlignmentError(TranscriptionError):
    """Recognized words lack defensible complete timing; never a successful transcript."""


class TranscriptionBoundaryError(TranscriptionAlignmentError):
    """Owned chunk words cannot be reconciled without altering lexical evidence."""


class TranscriptionLanguageError(TranscriptionAlignmentError):
    """Conflicting original-PCM language evidence requires bounded redetection."""


class TranscriptionUnavailable(TranscriptionError):
    """Pinned model/runtime cannot execute; operator action is required."""


class TranscriptionCancelled(TranscriptionError):
    """Cancellation forbids successful persistence."""


@dataclass(frozen=True)
class Word:
    text: str
    start_us: int
    end_us: int
    confidence: float

    def __post_init__(self) -> None:
        if not isinstance(self.text, str) or not self.text.strip() or len(self.text) > 256:
            raise ValueError("Invalid transcript word")
        self.text.encode("utf-8", errors="strict")
        integer(self.start_us, 0, 1_800_000_000)
        integer(self.end_us, 1, 1_800_000_000)
        if self.start_us >= self.end_us:
            raise ValueError("Word has no trustworthy positive interval")
        probability(self.confidence)


@dataclass(frozen=True)
class Transcript:
    language: str
    language_confidence: float
    words: tuple[Word, ...]

    def __post_init__(self) -> None:
        if (
            not self.language.isascii()
            or not self.language.isalpha()
            or not 2 <= len(self.language) <= 3
        ):
            raise ValueError("Invalid detected language")
        probability(self.language_confidence)
        previous = 0
        for word in self.words:
            if word.start_us < previous:
                raise ValueError("Transcript words overlap or are unordered")
            previous = word.end_us
        if len(self.words) > 54_000:
            raise ValueError("Transcript exceeds contract word limit")


class ITranscriber(Protocol):
    def transcribe(
        self,
        audio_path: str,
        source: AudioIdentity,
        cancellation: Cancellation | None = None,
        progress: Callable[[int, int], None] | None = None,
    ) -> Transcript: ...
