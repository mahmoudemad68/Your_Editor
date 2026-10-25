"""Local acoustic language observations; never word-language or calibrated accuracy."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite


@dataclass(frozen=True)
class LanguageObservation:
    start_us: int
    end_us: int
    model: str
    probabilities: tuple[tuple[str, float], ...]
    base: bool = False


@dataclass(frozen=True)
class LanguageSegment:
    start_us: int
    end_us: int
    model: str
    status: str
    languages: tuple[str, ...] = ()
    confidence: float | None = None


def summarize_language_observations(
    observations: list[LanguageObservation], offset_us: int
) -> tuple[LanguageSegment, ...]:
    """Annotate only existing base probe contexts. Borrowed prompts are not evidence.

    Conflicting confident overlapping probes mean mixed/ambiguous context, not
    independently established code-switch boundaries. No text is an input.
    """
    result = []

    def strongest(observation: LanguageObservation) -> tuple[str, float] | None:
        values = observation.probabilities
        if (
            observation.end_us - observation.start_us < 1_000_000
            or not values
            or any(
                not language.isascii()
                or not language.isalpha()
                or not language.islower()
                or not 2 <= len(language) <= 3
                or not isfinite(value)
                or not 0 <= value <= 1
                for language, value in values
            )
        ):
            return None
        ordered = sorted(values, key=lambda item: (-item[1], item[0]))
        if ordered[0][1] < 0.5 or (len(ordered) > 1 and ordered[0][1] == ordered[1][1]):
            return None
        return ordered[0]

    classified = [(item, strongest(item)) for item in observations]
    for base, own in ((item, strong) for item, strong in classified if item.base):
        if not 0 <= base.start_us < base.end_us or base.end_us - base.start_us > 4_000_000:
            raise ValueError("Invalid observed language context")
        languages = (
            sorted(
                {
                    strong[0]
                    for item, strong in classified
                    if item.model == base.model
                    and max(item.start_us, base.start_us) < min(item.end_us, base.end_us)
                    and strong is not None
                }
            )
            if own is not None
            else []
        )
        status = "unknown" if own is None else "mixed" if len(languages) > 1 else "dominant"
        result.append(
            LanguageSegment(
                offset_us + base.start_us,
                offset_us + base.end_us,
                base.model,
                status,
                tuple(languages),
                own[1] if own is not None and status == "dominant" else None,
            )
        )
    return tuple(result)
