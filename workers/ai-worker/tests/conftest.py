"""Bounded real-inference failure evidence; never changes a test or model outcome.

Only the licensed ASR fixture tests are eligible. No environment values, local
paths or arbitrary test input are exported. CI uploads the existing asr-batch
artifact even when a test fails, so native CPU differences can be reproduced.
"""

from __future__ import annotations

import dataclasses
import hashlib
import importlib.metadata
import json
import math
import platform
from pathlib import Path
from typing import Any

import pytest


def _runtime_identity() -> dict[str, Any]:
    cpu: dict[str, str] = {}
    if Path("/proc/cpuinfo").exists():
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            key, _, value = line.partition(":")
            if key.strip() in {"vendor_id", "model name", "flags"}:
                cpu.setdefault(key.strip(), value.strip())
    return {
        "python": platform.python_version(),
        "machine": platform.machine(),
        "libc": platform.libc_ver(),
        "cpu": cpu,
        "libraries": {
            name: importlib.metadata.version(name)
            for name in ("numpy", "ctranslate2", "faster-whisper")
        },
    }


def pytest_sessionstart(session: pytest.Session) -> None:
    directory = Path(__file__).resolve().parents[3] / ".local/asr-batch"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "native-runtime.json").write_text(
        json.dumps(_runtime_identity(), sort_keys=True), encoding="utf-8"
    )


def _number(value: Any) -> float | str:
    number = float(value)
    return number if math.isfinite(number) else str(number)


def _word(word: Any) -> dict[str, Any]:
    return {
        "text": getattr(word, "word", getattr(word, "text", "")),
        "start": _number(getattr(word, "start", getattr(word, "start_us", 0))),
        "end": _number(getattr(word, "end", getattr(word, "end_us", 0))),
        "confidence": _number(getattr(word, "probability", getattr(word, "confidence", 0))),
    }


def pytest_exception_interact(
    node: pytest.Item, call: pytest.CallInfo[Any], report: pytest.TestReport
) -> None:
    if node.path.name not in {"test_real_asr.py", "test_real_multilingual_asr.py"}:
        return
    if call.excinfo is None or not report.failed:
        return
    frames: list[dict[str, Any]] = []
    for entry in call.excinfo.traceback:
        values = entry.frame.f_locals
        frame: dict[str, Any] = {"function": entry.frame.code.name}
        for key in ("core", "end", "lower", "upper", "start_sample", "end_sample", "region_end"):
            if type(values.get(key)) is int:
                frame[key] = values[key]
        if "audio" in values:
            audio = values["audio"]
            if hasattr(audio, "tobytes"):
                frame["pcmSamples"] = len(audio)
                frame["float32PcmSha256"] = hashlib.sha256(audio.tobytes()).hexdigest()
        if isinstance(values.get("segments"), list):
            frame["segments"] = [
                {
                    "text": segment.text,
                    "start": _number(segment.start),
                    "end": _number(segment.end),
                    "words": [_word(word) for word in segment.words or []],
                }
                for segment in values["segments"][:100]
            ]
        if isinstance(values.get("words"), list):
            frame["words"] = [_word(word) for word in values["words"][:1000]]
        result = values.get("result")
        if result is not None and dataclasses.is_dataclass(result) and not isinstance(result, type):
            frame["result"] = dataclasses.asdict(result)
        if len(frame) > 1:
            frames.append(frame)
    directory = Path(__file__).resolve().parents[3] / ".local/asr-batch"
    directory.mkdir(parents=True, exist_ok=True)
    identity = hashlib.sha256(node.nodeid.encode()).hexdigest()[:16]
    (directory / f"native-failure-{identity}.json").write_text(
        json.dumps(
            {
                "kind": "licensed fixture failure diagnostics; not gold annotations",
                "test": node.name,
                **_runtime_identity(),
                "frames": frames,
            },
            ensure_ascii=False,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
