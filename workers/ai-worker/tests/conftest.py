"""Keep test failures private and publish only aggregate counts/status.

Reporting never changes a test outcome or its assertions. Detailed runtime
introspection is intentionally absent from this repository reporting hook.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from subprocess import TimeoutExpired
from typing import Any

import pytest

from editagent_ai_worker.domain.analysis.transcription import (
    TranscriptionCancelled,
    TranscriptionError,
    TranscriptionTimeout,
)
from editagent_ai_worker.infrastructure.config import configure_asr_native_environment

ROOT = Path(__file__).resolve().parents[3]
PRIVATE_ASR_TESTS = {
    "test_real_asr.py",
    "test_real_multilingual_asr.py",
    "test_real_model_reuse.py",
    "test_asr_native_configuration.py",
}


def pytest_sessionstart(session: pytest.Session) -> None:
    configure_asr_native_environment()


_PUBLIC_COUNTS: dict[str, int] = {"passed": 0, "failed": 0, "skipped": 0}


_SAFE_FAILURES = {
    "ASR words require trustworthy realignment": "alignment_unverified",
    "ASR trustworthy realignment resource bound exceeded": "alignment_budget",
    "ASR fallback has no complete bounded lexical evidence": "lexical_alignment_unverified",
    "ASR recognized speech lacks complete word coverage": "speech_coverage",
    "ASR boundary alignment violates outside anchors": "boundary_anchors",
    "ASR overlap has ambiguous temporal anchors": "boundary_ambiguity",
    "ASR boundary alignment changed indexed decoder text": "boundary_lexical",
    "ASR coverage hypothesis has no trustworthy native timing": "coverage_alignment",
    "ASR input or inference failed": "native_failure",
    "ASR output violates word integrity": "output_integrity",
}


def _failure_category(call: Any) -> str:
    """Only fixed categories cross the public boundary; never exception operands."""
    error = getattr(getattr(call, "excinfo", None), "value", None)
    if isinstance(error, TranscriptionTimeout):
        return "inference_deadline"
    if isinstance(error, TranscriptionCancelled):
        return "cancelled"
    if isinstance(error, TranscriptionError):
        return _SAFE_FAILURES.get(str(error), "transcription")
    if isinstance(error, AssertionError):
        return "assertion"
    if isinstance(error, TimeoutExpired):
        return "subprocess_deadline"
    return "unclassified"


def _failure_location(call: Any) -> str:
    """Expose only allowlisted repository basenames and bounded code line numbers."""
    entries = getattr(getattr(call, "excinfo", None), "traceback", ())
    allowed = {"faster_whisper.py", *PRIVATE_ASR_TESTS}
    for entry in reversed(entries):
        name = Path(str(entry.path)).name
        line = entry.lineno
        if name in allowed and type(line) is int and 0 <= line < 100_000:
            return f"{name}:{line + 1}"
    return "unavailable"


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[Any]) -> Any:
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" or (report.when == "setup" and not report.passed):
        _PUBLIC_COUNTS[report.outcome] += 1
    if report.failed and item.path.name in PRIVATE_ASR_TESTS:
        # Save the original traceback locally before removing source-derived
        # assertion operands and native details from public terminal reporting.
        directory = ROOT / ".local/asr-batch"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        identity = hashlib.sha256(item.nodeid.encode()).hexdigest()[:16]
        (directory / f"private-traceback-{identity}.txt").write_text(
            report.longreprtext, encoding="utf-8"
        )
        (directory / f"private-output-{identity}.json").write_text(
            json.dumps(report.sections, ensure_ascii=False), encoding="utf-8"
        )
        # Pytest prints captured stdout/stderr separately from longrepr. Both
        # must stay private, including native diagnostics emitted below Python.
        report.sections = []
        report.longrepr = (
            f"Real inference test failed (case {identity}; category {_failure_category(call)}; "
            f"location {_failure_location(call)}); "
            "raw diagnostics retained locally and excluded from publication."
        )


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    directory = ROOT / ".local/asr-public"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "test-summary.json").write_text(
        json.dumps({"exitStatus": int(exitstatus), "tests": _PUBLIC_COUNTS}, sort_keys=True),
        encoding="utf-8",
    )
