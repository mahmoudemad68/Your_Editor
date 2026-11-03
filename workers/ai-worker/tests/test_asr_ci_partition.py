"""Execution partitioning must retain every real-inference acceptance test."""

import os
import re
import runpy
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE = runpy.run_path(str(Path(__file__).resolve().parents[3] / "tools/asr/test_partition.py"))


def test_every_real_case_is_assigned_exactly_once_and_new_tests_remain_included() -> None:
    prefix = "tests/test_real_multilingual_asr.py::"
    ids = [
        "tests/test_real_asr.py::test_real_cpu_word_timestamps_language_and_repeatability[en]",
        prefix + "test_real_native_kernel_alignment_and_fresh_reused_state[1]",
        prefix + "test_real_multilingual_content_and_reused_process_determinism[1-tiny]",
        prefix + "test_full_minute_languages_remain_identical_after_reusing_native_state[1]",
        prefix + "test_full_minute_languages_remain_identical_after_reusing_native_state[2]",
        prefix + "test_original_ten_minute_recording_preserves_complete_bounded_word_output[small]",
        prefix + "test_new_real_regression",
        "tests/test_real_model_reuse.py::test_cross_model_reuse_preserves_complete_original_transcript",
    ]
    groups = MODULE["partition"](ids)
    flattened = [node for group in groups.values() for node in group]
    assert len(flattened) == len(ids) and set(flattened) == set(ids)
    assert len(set(flattened)) == len(flattened)
    assert groups["alignment"] == [ids[0], ids[-2]]
    assert ids[-1] in groups["long-input"]
    assert all(groups[name] for name in MODULE["SHARDS"])


@pytest.mark.parametrize("ids", [[], ["invalid.py::test"], ["tests/test_real_asr.py::test"] * 2])
def test_empty_ambiguous_or_unexpected_collections_fail_closed(ids: list[str]) -> None:
    with pytest.raises(ValueError):
        MODULE["partition"](ids)


def test_unplanned_thread_configuration_cannot_silently_drop_repeatability_coverage() -> None:
    with pytest.raises(ValueError):
        MODULE["shard_for"](
            "tests/test_real_multilingual_asr.py::"
            "test_full_minute_languages_remain_identical_after_reusing_native_state[3]"
        )


def test_required_ci_gate_includes_every_partition_and_cannot_ignore_real_inference() -> None:
    root = Path(__file__).resolve().parents[3]
    workflow = (root / ".github/workflows/ci.yml").read_text()
    matrix = re.search(r"        shard:\n((?:          - [a-z-]+\n)+)", workflow)
    assert matrix is not None
    configured = [line.strip()[2:] for line in matrix.group(1).splitlines()]
    assert tuple(configured) == MODULE["SHARDS"]
    gate = workflow.split("\n  ci:\n", 1)[1]
    needs = re.search(r"^    needs: \[([^\]]+)\]$", gate, re.MULTILINE)
    assert needs is not None
    assert {name.strip() for name in needs.group(1).split(",")} == {
        "storage-admission",
        "repository",
        "real-asr",
        "seaweedfs-product",
    }
    assert "if: ${{ always() }}" in gate
    assert 'test "$REPOSITORY_RESULT" = success' in gate
    assert 'test "$REAL_ASR_RESULT" = success' in gate
    assert 'test "$ADMISSION_RESULT" = success' in gate
    assert 'test "$SEAWEEDFS_RESULT" = success' in gate
    for binding in (
        "needs.storage-admission.result",
        "needs.seaweedfs-product.result",
        "needs.repository.result",
        "needs['real-asr'].result",
    ):
        assert binding in gate
    assert '--shard "${{ matrix.shard }}"' in workflow


@pytest.mark.parametrize("candidate", [False, True])
@pytest.mark.parametrize(
    "failed_job",
    [None, "REPOSITORY_RESULT", "REAL_ASR_RESULT", "ADMISSION_RESULT", "SEAWEEDFS_RESULT"],
)
@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped"])
def test_actual_required_gate_fails_on_each_mandatory_job(
    candidate: bool, failed_job: str | None, result: str
) -> None:
    workflow = (Path(__file__).resolve().parents[3] / ".github/workflows/ci.yml").read_text()
    gate = workflow.split("\n  ci:\n", 1)[1]
    match = re.search(r"        run: \|\n((?:          [^\n]*\n)+)", gate)
    assert match is not None
    script = "\n".join(line[10:] for line in match.group(1).splitlines())
    shell = shutil.which("sh") or (
        "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else "/bin/sh"
    )
    environment = {**os.environ, "CANDIDATE_EVENT": "true" if candidate else "false"}
    for key in ("REPOSITORY_RESULT", "REAL_ASR_RESULT", "ADMISSION_RESULT", "SEAWEEDFS_RESULT"):
        environment[key] = result if failed_job == key else "success"
    execution = subprocess.run(
        [shell, "-e", "-c", script],
        env=environment,
        capture_output=True,
        timeout=10,
        check=False,
    )
    mandatory = failed_job in {"REPOSITORY_RESULT", "REAL_ASR_RESULT"} or (
        candidate and failed_job is not None
    )
    assert (execution.returncode != 0) is mandatory, execution.stderr
