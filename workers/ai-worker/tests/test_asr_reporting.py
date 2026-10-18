"""Public test reporting never exports local transcription/CPU diagnostics."""

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import conftest as reporting


@pytest.mark.parametrize(
    "filename",
    [
        "test_real_multilingual_asr.py",
        "test_real_model_reuse.py",
        "test_asr_native_configuration.py",
    ],
)
def test_real_failure_reporting_preserves_private_traceback_without_publishing_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, filename: str
) -> None:
    original_counts = reporting._PUBLIC_COUNTS
    with monkeypatch.context() as patch:
        patch.setattr(reporting, "ROOT", tmp_path)
        patch.setattr(reporting, "_PUBLIC_COUNTS", {"passed": 0, "failed": 0, "skipped": 0})
        sensitive = "private-source-word and private-native-setting"
        result: Any = SimpleNamespace(
            when="call",
            outcome="failed",
            failed=True,
            passed=False,
            longreprtext=sensitive,
            sections=[("Captured stderr call", sensitive)],
        )
        item: Any = SimpleNamespace(path=Path(filename), nodeid="real-case")
        hook = reporting.pytest_runtest_makereport(item, None)  # type: ignore[arg-type]
        next(hook)
        with pytest.raises(StopIteration):
            hook.send(SimpleNamespace(get_result=lambda: result))
        identity = hashlib.sha256(b"real-case").hexdigest()[:16]
        assert sensitive not in result.longrepr
        assert identity in result.longrepr
        assert result.sections == []
        assert json.loads(
            (tmp_path / f".local/asr-batch/private-output-{identity}.json").read_text()
        ) == [["Captured stderr call", sensitive]]
        assert (
            tmp_path / f".local/asr-batch/private-traceback-{identity}.txt"
        ).read_text() == sensitive
        reporting.pytest_sessionfinish(None, 1)  # type: ignore[arg-type]
        public = tmp_path / ".local/asr-public/test-summary.json"
        assert json.loads(public.read_text()) == {
            "exitStatus": 1,
            "tests": {"passed": 0, "failed": 1, "skipped": 0},
        }
        assert sensitive not in public.read_text()
        assert sorted(p.name for p in public.parent.iterdir()) == ["test-summary.json"]
    assert reporting._PUBLIC_COUNTS is original_counts


def test_ci_artifact_allowlist_excludes_raw_native_evidence() -> None:
    workflow = (Path(__file__).resolve().parents[3] / ".github/workflows/ci.yml").read_text()
    assert "            .local/asr-batch/\n" not in workflow
    assert "            .local/asr-public/test-summary.json\n" in workflow
    assert "            .local/asr-batch/container-evidence.json\n" not in workflow
    assert "            .local/render-batch/\n" not in workflow


@pytest.mark.parametrize(
    "message,expected",
    [
        ("ASR words require trustworthy realignment", "alignment_unverified"),
        ("ASR recognized speech lacks complete word coverage", "speech_coverage"),
        ("ASR words require trustworthy realignment private-input", "transcription"),
        ("unknown-private-input", "transcription"),
    ],
)
def test_failure_categories_never_publish_unknown_exception_details(
    message: str, expected: str
) -> None:
    from editagent_ai_worker.domain.analysis.transcription import TranscriptionError

    call = SimpleNamespace(excinfo=SimpleNamespace(value=TranscriptionError(message)))
    assert reporting._failure_category(call) == expected


@pytest.mark.parametrize(
    "path,expected",
    [
        ("untrusted-prefix/test_real_model_reuse.py", "test_real_model_reuse.py:11"),
        ("untrusted-prefix/faster_whisper.py", "faster_whisper.py:11"),
        ("untrusted-prefix/untrusted-key.py", "unavailable"),
    ],
)
def test_failure_location_never_exports_untrusted_path_components(path: str, expected: str) -> None:
    call = SimpleNamespace(
        excinfo=SimpleNamespace(traceback=[SimpleNamespace(path=path, lineno=10)])
    )
    assert reporting._failure_location(call) == expected
