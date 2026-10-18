"""Keep test failures private and publish only aggregate counts/status.

Reporting never changes a test outcome or its assertions. Detailed runtime
introspection is intentionally absent from this repository reporting hook.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from editagent_ai_worker.infrastructure.config import configure_asr_native_environment

ROOT = Path(__file__).resolve().parents[3]
PRIVATE_ASR_TESTS = {
    "test_real_asr.py",
    "test_real_multilingual_asr.py",
    "test_asr_native_configuration.py",
}


def pytest_sessionstart(session: pytest.Session) -> None:
    configure_asr_native_environment()


_PUBLIC_COUNTS: dict[str, int] = {"passed": 0, "failed": 0, "skipped": 0}


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
            f"Real inference test failed (case {identity}); "
            "raw diagnostics retained locally and excluded from publication."
        )


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    directory = ROOT / ".local/asr-public"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "test-summary.json").write_text(
        json.dumps({"exitStatus": int(exitstatus), "tests": _PUBLIC_COUNTS}, sort_keys=True),
        encoding="utf-8",
    )
