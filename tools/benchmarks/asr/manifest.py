"""Dataset manifest contract for the US-105 benchmark.

The example manifest ships with no clips. Callers supply licensed audio outside
git. This module checks the document and, when a dataset root is given, that
paths stay inside that root.
"""

from __future__ import annotations

import json
from pathlib import Path

MINIMUM_TOTAL_SECONDS = 600.0
LANGUAGE_CODES = {"en": "en", "english": "en", "ar": "ar", "arabic": "ar"}
REQUIRED_FIELDS = (
    "id",
    "audio_path",
    "language",
    "duration_seconds",
    "source",
    "license",
    "transcript_path",
)


def language_code(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("language must be a string")
    code = LANGUAGE_CODES.get(value.strip().lower())
    if code is None:
        raise ValueError("language must be English or Arabic")
    return code


def resolve_under(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError("path must be a non-empty relative path")
    parts = Path(relative).parts
    if (
        relative.startswith(("/", "\\"))
        or Path(relative).is_absolute()
        or ".." in parts
    ):
        raise ValueError(f"path escapes the dataset root: {relative}")
    candidate = (root / relative).resolve()
    root_resolved = root.resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise ValueError(f"path escapes the dataset root: {relative}")
    return candidate


def load_manifest(path: Path) -> dict[str, object]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise TypeError("manifest must be a JSON object")
    return document


def validate_manifest(
    document: dict[str, object],
    dataset_root: Path | None = None,
    require_files: bool = False,
) -> dict[str, object]:
    errors: list[str] = []
    clips = document.get("clips")
    if not isinstance(clips, list):
        return {
            "ok": False,
            "errors": ["clips must be a list"],
            "clips": [],
            "total_duration_seconds": 0.0,
            "duration_by_language": {"en": 0.0, "ar": 0.0},
            "meets_minimum_total": False,
            "word_timestamp_clips": 0,
            "vad_reference_clips": 0,
        }
    seen: set[str] = set()
    normalized: list[dict[str, object]] = []
    totals = {"en": 0.0, "ar": 0.0}
    word_clips = 0
    vad_clips = 0
    for index, raw in enumerate(clips):
        prefix = f"clips[{index}]"
        if not isinstance(raw, dict):
            errors.append(f"{prefix} must be an object")
            continue
        missing = [field for field in REQUIRED_FIELDS if field not in raw]
        if missing:
            errors.append(f"{prefix} missing {', '.join(missing)}")
            continue
        clip_id = raw["id"]
        if not isinstance(clip_id, str) or not clip_id.strip():
            errors.append(f"{prefix}.id must be a non-empty string")
            continue
        if clip_id in seen:
            errors.append(f"duplicate clip id {clip_id}")
            continue
        seen.add(clip_id)
        try:
            code = language_code(raw["language"])
        except (TypeError, ValueError) as exc:
            errors.append(f"{prefix}.language: {exc}")
            continue
        duration = raw["duration_seconds"]
        if (
            isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or duration <= 0
        ):
            errors.append(f"{prefix}.duration_seconds must be a positive number")
            continue
        for field in ("source", "license"):
            value = raw[field]
            if not isinstance(value, str) or not value.strip():
                errors.append(
                    f"{prefix}.{field} must describe the recording and its license"
                )
        audio_path = str(raw["audio_path"])
        transcript_path = str(raw["transcript_path"])
        word_path = raw.get("word_timestamps_path")
        vad_path = raw.get("speech_intervals_path")
        try:
            if dataset_root is not None:
                audio_resolved = resolve_under(dataset_root, audio_path)
                transcript_resolved = resolve_under(dataset_root, transcript_path)
                if require_files and not audio_resolved.is_file():
                    errors.append(f"{prefix} audio file is missing: {audio_path}")
                if require_files and not transcript_resolved.is_file():
                    errors.append(
                        f"{prefix} transcript file is missing: {transcript_path}"
                    )
                if isinstance(word_path, str) and word_path.strip():
                    word_resolved = resolve_under(dataset_root, word_path)
                    if require_files and not word_resolved.is_file():
                        errors.append(
                            f"{prefix} word timestamp file is missing: {word_path}"
                        )
                if isinstance(vad_path, str) and vad_path.strip():
                    vad_resolved = resolve_under(dataset_root, vad_path)
                    if require_files and not vad_resolved.is_file():
                        errors.append(
                            f"{prefix} speech interval file is missing: {vad_path}"
                        )
            else:
                resolve_under(Path("/dataset"), audio_path)
                resolve_under(Path("/dataset"), transcript_path)
        except ValueError as exc:
            errors.append(f"{prefix}: {exc}")
            continue
        if isinstance(word_path, str) and word_path.strip():
            word_clips += 1
        if isinstance(vad_path, str) and vad_path.strip():
            vad_clips += 1
        totals[code] += float(duration)
        normalized.append(
            {
                "id": clip_id,
                "audio_path": audio_path,
                "language": code,
                "duration_seconds": float(duration),
                "source": raw["source"],
                "license": raw["license"],
                "transcript_path": transcript_path,
                "word_timestamps_path": word_path
                if isinstance(word_path, str) and word_path
                else None,
                "speech_intervals_path": vad_path
                if isinstance(vad_path, str) and vad_path
                else None,
            }
        )
    total = totals["en"] + totals["ar"]
    return {
        "ok": not errors,
        "errors": errors,
        "clips": normalized,
        "total_duration_seconds": total,
        "duration_by_language": totals,
        "meets_minimum_total": total >= MINIMUM_TOTAL_SECONDS,
        "word_timestamp_clips": word_clips,
        "vad_reference_clips": vad_clips,
    }
