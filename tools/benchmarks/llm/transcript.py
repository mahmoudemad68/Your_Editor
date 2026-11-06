"""Deterministic synthetic transcript. It is not a recording of a person."""

from __future__ import annotations

from pathlib import Path

DURATION_SECONDS = 600.0
WORDS_PER_SECOND = 2.5
VOCABULARY = ("speaker", "frame", "caption", "topic", "cut")


def build_transcript(duration_seconds: float = DURATION_SECONDS) -> str:
    count = int(duration_seconds * WORDS_PER_SECOND)
    words = [
        f"{VOCABULARY[index % len(VOCABULARY)]}{index:04d}" for index in range(count)
    ]
    return " ".join(words)


def load_transcript() -> str:
    path = Path(__file__).resolve().parent / "fixtures" / "transcript_10min.txt"
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    return build_transcript()
