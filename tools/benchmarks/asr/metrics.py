"""Timing and quality metrics for the US-105 ASR and VAD spike.

Quality numbers are computed only from caller-supplied references. This module
does not download audio, transcripts, or model weights.
"""

from __future__ import annotations

import re
import unicodedata

CP1_AUDIO_SECONDS = 600.0
CP1_LIMIT_SECONDS = 180.0
CP1_LIMIT_RTF = CP1_LIMIT_SECONDS / CP1_AUDIO_SECONDS

_ENGLISH_DROP = re.compile(r"[^a-z0-9'\s]+")
_ARABIC_DIACRITICS = re.compile(r"[\u0640\u064b-\u0652\u0670]")
_ARABIC_KEEP = re.compile(r"[^\u0600-\u06ff\s]+")
_ARABIC_FOLDS = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ة": "ه"})


def real_time_factor(audio_seconds: float, elapsed_seconds: float) -> float:
    if audio_seconds <= 0:
        raise ValueError("audio_seconds must be positive")
    if elapsed_seconds < 0:
        raise ValueError("elapsed_seconds must be zero or positive")
    return elapsed_seconds / audio_seconds


def throughput(audio_seconds: float, elapsed_seconds: float) -> float | None:
    if audio_seconds < 0:
        raise ValueError("audio_seconds must be zero or positive")
    if elapsed_seconds < 0:
        raise ValueError("elapsed_seconds must be zero or positive")
    if elapsed_seconds == 0:
        return None
    return audio_seconds / elapsed_seconds


def median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2


def normalize_words(text: str, language: str) -> list[str]:
    """Normalize a transcript before WER.

    English: Unicode casefold, drop punctuation other than apostrophes, collapse
    whitespace.

    Arabic: remove tatweel and harakat, fold alef variants to ا, ى to ي, and
    ة to ه, then drop characters outside the Arabic block.
    """

    language_code = language.strip().lower()
    if language_code in {"en", "english"}:
        folded = unicodedata.normalize("NFKC", text).casefold()
        cleaned = _ENGLISH_DROP.sub(" ", folded)
        return [token for token in cleaned.split() if token]
    if language_code in {"ar", "arabic"}:
        folded = unicodedata.normalize("NFKC", text).translate(_ARABIC_FOLDS)
        without_marks = _ARABIC_DIACRITICS.sub("", folded)
        cleaned = _ARABIC_KEEP.sub(" ", without_marks)
        return [token for token in cleaned.split() if token]
    raise ValueError(f"unsupported language: {language}")


def edit_counts(reference: list[str], hypothesis: list[str]) -> tuple[int, int, int]:
    """Return substitutions, deletions, and insertions for token sequences."""

    rows = len(reference) + 1
    cols = len(hypothesis) + 1
    costs = [[0] * cols for _ in range(rows)]
    substitutions = [[0] * cols for _ in range(rows)]
    deletions = [[0] * cols for _ in range(rows)]
    insertions = [[0] * cols for _ in range(rows)]
    for i in range(1, rows):
        costs[i][0] = i
        deletions[i][0] = i
    for j in range(1, cols):
        costs[0][j] = j
        insertions[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            if reference[i - 1] == hypothesis[j - 1]:
                costs[i][j] = costs[i - 1][j - 1]
                substitutions[i][j] = substitutions[i - 1][j - 1]
                deletions[i][j] = deletions[i - 1][j - 1]
                insertions[i][j] = insertions[i - 1][j - 1]
                continue
            options = (
                (
                    costs[i - 1][j - 1] + 1,
                    substitutions[i - 1][j - 1] + 1,
                    deletions[i - 1][j - 1],
                    insertions[i - 1][j - 1],
                ),
                (
                    costs[i - 1][j] + 1,
                    substitutions[i - 1][j],
                    deletions[i - 1][j] + 1,
                    insertions[i - 1][j],
                ),
                (
                    costs[i][j - 1] + 1,
                    substitutions[i][j - 1],
                    deletions[i][j - 1],
                    insertions[i][j - 1] + 1,
                ),
            )
            best = min(options, key=lambda item: (item[0], item[1], item[2], item[3]))
            costs[i][j], substitutions[i][j], deletions[i][j], insertions[i][j] = best
    return substitutions[-1][-1], deletions[-1][-1], insertions[-1][-1]


def word_error_rate(
    reference: str, hypothesis: str, language: str
) -> dict[str, float | int | None]:
    reference_words = normalize_words(reference, language)
    hypothesis_words = normalize_words(hypothesis, language)
    if not reference_words:
        return {
            "wer": None,
            "substitutions": None,
            "deletions": None,
            "insertions": None,
            "reference_words": 0,
            "hypothesis_words": len(hypothesis_words),
            "reason": "reference transcript is empty after normalization",
        }
    substitutions, deletions, insertions = edit_counts(
        reference_words, hypothesis_words
    )
    return {
        "wer": (substitutions + deletions + insertions) / len(reference_words),
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "reference_words": len(reference_words),
        "hypothesis_words": len(hypothesis_words),
        "reason": None,
    }


def _alignment_pairs(
    reference: list[dict[str, float | str]],
    hypothesis: list[dict[str, float | str]],
    language: str,
) -> list[tuple[dict[str, float | str], dict[str, float | str]]]:
    """Align words monotonically and keep pairs whose normalized tokens match.

    Substitutions, insertions, and deletions are not given a timestamp error.
    Matching uses the same token normalization as WER.
    """

    ref_tokens = [normalize_words(str(item["word"]), language) for item in reference]
    hyp_tokens = [normalize_words(str(item["word"]), language) for item in hypothesis]
    ref_keys = [item[0] if len(item) == 1 else "" for item in ref_tokens]
    hyp_keys = [item[0] if len(item) == 1 else "" for item in hyp_tokens]
    rows = len(reference) + 1
    cols = len(hypothesis) + 1
    scores = [[0] * cols for _ in range(rows)]
    for i in range(1, rows):
        for j in range(1, cols):
            match = ref_keys[i - 1] != "" and ref_keys[i - 1] == hyp_keys[j - 1]
            diagonal = scores[i - 1][j - 1] + (1 if match else 0)
            scores[i][j] = max(diagonal, scores[i - 1][j], scores[i][j - 1])
    pairs: list[tuple[dict[str, float | str], dict[str, float | str]]] = []
    i = len(reference)
    j = len(hypothesis)
    while i > 0 and j > 0:
        match = ref_keys[i - 1] != "" and ref_keys[i - 1] == hyp_keys[j - 1]
        if match and scores[i][j] == scores[i - 1][j - 1] + 1:
            pairs.append((reference[i - 1], hypothesis[j - 1]))
            i -= 1
            j -= 1
        elif scores[i][j] == scores[i - 1][j]:
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


def word_timestamp_errors(
    reference: list[dict[str, float | str]],
    hypothesis: list[dict[str, float | str]],
    language: str,
) -> dict[str, float | int | None]:
    if not reference:
        return {
            "status": "INSUFFICIENT_REFERENCE",
            "matched_words": 0,
            "median_abs_start_error_seconds": None,
            "median_abs_end_error_seconds": None,
            "reported_pass": False,
        }
    pairs = _alignment_pairs(reference, hypothesis, language)
    start_errors = [
        abs(float(hyp["start"]) - float(ref["start"])) for ref, hyp in pairs
    ]
    end_errors = [abs(float(hyp["end"]) - float(ref["end"])) for ref, hyp in pairs]
    return {
        "status": "EVALUATED",
        "matched_words": len(pairs),
        "reference_words": len(reference),
        "median_abs_start_error_seconds": median(start_errors),
        "median_abs_end_error_seconds": median(end_errors),
        "reported_pass": None,
    }


def _contains(intervals: list[tuple[float, float]], instant: float) -> bool:
    return any(start <= instant < end for start, end in intervals)


def _interval_iou(left: tuple[float, float], right: tuple[float, float]) -> float:
    start = max(left[0], right[0])
    end = min(left[1], right[1])
    intersection = max(0.0, end - start)
    union = max(left[1], right[1]) - min(left[0], right[0])
    if union <= 0:
        return 0.0
    return intersection / union


def vad_scores(
    reference: list[tuple[float, float]] | None,
    hypothesis: list[tuple[float, float]],
    sample_seconds: float = 0.01,
) -> dict[str, float | int | str | None | bool]:
    """Score speech frames at a fixed grid and matched interval boundaries.

    A frame at the center of each sample is speech when an interval covers it.
    Precision, recall, and F1 use those frames. Two empty interval lists agree,
    so precision, recall, and F1 are 1. A missing reference is not a pass.
    """

    if reference is None:
        return {
            "status": "INSUFFICIENT_REFERENCE",
            "precision": None,
            "recall": None,
            "f1": None,
            "matched_intervals": 0,
            "median_abs_start_error_seconds": None,
            "median_abs_end_error_seconds": None,
            "reported_pass": False,
        }
    if sample_seconds <= 0:
        raise ValueError("sample_seconds must be positive")
    horizon = 0.0
    for start, end in [*reference, *hypothesis]:
        horizon = max(horizon, end)
    if horizon == 0:
        precision = recall = f1 = 1.0
        frame_count = 0
    else:
        steps = int(horizon / sample_seconds)
        if steps * sample_seconds < horizon:
            steps += 1
        true_positive = false_positive = false_negative = 0
        for index in range(steps):
            instant = (index + 0.5) * sample_seconds
            expected = _contains(reference, instant)
            predicted = _contains(hypothesis, instant)
            if expected and predicted:
                true_positive += 1
            elif predicted:
                false_positive += 1
            elif expected:
                false_negative += 1
        precision = (
            true_positive / (true_positive + false_positive)
            if true_positive + false_positive
            else (1.0 if false_negative == 0 else 0.0)
        )
        recall = (
            true_positive / (true_positive + false_negative)
            if true_positive + false_negative
            else (1.0 if false_positive == 0 else 0.0)
        )
        f1 = (
            2 * precision * recall / (precision + recall) if precision + recall else 0.0
        )
        frame_count = steps
    remaining = reference.copy()
    start_errors: list[float] = []
    end_errors: list[float] = []
    for predicted in hypothesis:
        best_index = None
        best_iou = 0.5
        for index, expected in enumerate(remaining):
            score = _interval_iou(expected, predicted)
            if score >= best_iou:
                best_iou = score
                best_index = index
        if best_index is None:
            continue
        expected = remaining.pop(best_index)
        start_errors.append(abs(predicted[0] - expected[0]))
        end_errors.append(abs(predicted[1] - expected[1]))
    return {
        "status": "EVALUATED",
        "sample_seconds": sample_seconds,
        "frames": frame_count,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "matched_intervals": len(start_errors),
        "median_abs_start_error_seconds": median(start_errors),
        "median_abs_end_error_seconds": median(end_errors),
        "reported_pass": None,
    }


def cp1_asr_observation(
    audio_seconds: float, elapsed_seconds: float
) -> dict[str, object]:
    """Compare an observed timing with the CP1 rate. Formal CP1 stays open."""

    result: dict[str, object] = {
        "criterion": (
            "Transcribe 10 minutes of speech in at most 3 minutes on the reference GPU, "
            "or select a viable CPU model"
        ),
        "limit_rtf": CP1_LIMIT_RTF,
        "formal_cp1": "NOT_VERIFIED",
        "observed_audio_seconds": audio_seconds,
        "observed_elapsed_seconds": elapsed_seconds,
    }
    if audio_seconds < CP1_AUDIO_SECONDS:
        result["observed_rtf"] = None
        result["observed_pass"] = None
        result["reason"] = "measured audio is shorter than 10 minutes"
        return result
    observed = real_time_factor(audio_seconds, elapsed_seconds)
    result["observed_rtf"] = observed
    result["observed_pass"] = observed <= CP1_LIMIT_RTF
    result["reason"] = None
    return result
