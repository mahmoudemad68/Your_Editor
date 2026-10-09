"""Orchestration independent of Silero, filesystem, queue, storage and frameworks."""

from typing import BinaryIO

from editagent_ai_worker.domain.analysis.voice_activity import (
    AudioIdentity,
    Cancellation,
    IVoiceActivityDetector,
    SpeechAnalysis,
    VadConfiguration,
)


def analyse_speech(
    detector: IVoiceActivityDetector,
    pcm: BinaryIO,
    source: AudioIdentity,
    configuration: VadConfiguration,
    cancellation: Cancellation | None = None,
) -> SpeechAnalysis:
    return detector.detect(pcm, source, configuration, cancellation)
