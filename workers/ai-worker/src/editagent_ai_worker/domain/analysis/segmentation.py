"""Deterministic hysteresis, integer boundary conversion and confidence aggregation."""

from collections.abc import Iterable
from dataclasses import dataclass

from editagent_ai_worker.domain.analysis.voice_activity import (
    SAMPLE_RATE,
    AudioIdentity,
    SpeechRegion,
    VadConfiguration,
    integer,
    probability,
)


@dataclass(frozen=True)
class WindowProbability:
    start_sample: int
    end_sample: int
    probability: float

    def __post_init__(self) -> None:
        integer(self.start_sample, 0, 28_800_000)
        integer(self.end_sample, self.start_sample + 1, 28_800_000)
        probability(self.probability)


def speech_regions(
    windows: Iterable[WindowProbability], source: AudioIdentity, config: VadConfiguration
) -> tuple[SpeechRegion, ...]:
    frames = tuple(windows)
    previous = 0
    for frame in frames:
        if frame.start_sample != previous or frame.end_sample > source.sample_count:
            raise ValueError("Inference windows must cover the scope consecutively")
        previous = frame.end_sample
    if previous != source.sample_count:
        raise ValueError("Inference windows must cover the complete scope")
    min_speech = (config.min_speech_us * SAMPLE_RATE + 999_999) // 1_000_000
    min_silence = (config.min_silence_us * SAMPLE_RATE + 999_999) // 1_000_000
    padding = (config.padding_us * SAMPLE_RATE + 999_999) // 1_000_000
    raw: list[tuple[int, int]] = []
    start: int | None = None
    silence_start: int | None = None
    for frame in frames:
        if start is None:
            if frame.probability >= config.speech_threshold:
                start = frame.start_sample
        elif frame.probability >= config.negative_threshold:
            silence_start = None
        else:
            if silence_start is None:
                silence_start = frame.start_sample
            if frame.end_sample - silence_start >= min_silence:
                if silence_start - start >= min_speech:
                    raw.append((start, silence_start))
                start = silence_start = None
    if start is not None:
        end = silence_start if silence_start is not None else source.sample_count
        if end - start >= min_speech:
            raw.append((start, end))
    merged: list[tuple[int, int]] = []
    for start, end in raw:
        a, b = max(0, start - padding), min(source.sample_count, end + padding)
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
        else:
            merged.append((a, b))
    # Linear sweep: never O(regions * audio windows), even for alternating long audio.
    result: list[SpeechRegion] = []
    cursor = 0
    for start, end in merged:
        while cursor < len(frames) and frames[cursor].end_sample <= start:
            cursor += 1
        i, weighted, samples = cursor, 0.0, 0
        while i < len(frames) and frames[i].start_sample < end:
            frame = frames[i]
            count = min(end, frame.end_sample) - max(start, frame.start_sample)
            weighted += frame.probability * count
            samples += count
            i += 1
        a = source.scope_start_us + start * 1_000_000 // SAMPLE_RATE
        b = min(source.scope_end_us, source.scope_start_us + end * 1_000_000 // SAMPLE_RATE)
        if a < b:
            result.append(SpeechRegion(a, b, min(1.0, max(0.0, weighted / samples))))
    return tuple(result)
