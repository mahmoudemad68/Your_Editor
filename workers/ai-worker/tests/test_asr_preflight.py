"""Read-only preflight is eligibility evidence, never inference qualification."""

import copy
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from editagent_ai_worker.infrastructure.asr_preflight import DEPENDENCIES, assess, cgroup_limits


def profile() -> dict[str, Any]:
    return {
        "system": "Linux",
        "architecture": "x86_64",
        "pythonMinor": "3.11",
        "libc": {"name": "glibc"},
        "cpuCapabilities": {"avx2": True, "fma": True},
        "wsl": False,
        "container": True,
        "cgroup": {"quotaCpus": 2, "memoryBytes": 3 * 1024**3, "pids": 128},
        "affinityCpus": 2,
        "dependencies": dict(DEPENDENCIES),
        "configurationValid": True,
        "configurationProfileMatches": True,
        "device": "cpu",
        "timeoutMs": 600000,
        "nativeOverridesConflict": False,
        "modelsVerified": True,
        "freeWorkspaceBytes": 1024**3,
    }


def test_preflight_never_asserts_inference_acceptance() -> None:
    value = profile()
    original = copy.deepcopy(value)
    result = assess(value)
    assert result["status"] == "READY_FOR_QUALIFICATION"
    assert result["performanceGuaranteed"] is False
    assert result["nativeLibrariesLoaded"] is False
    assert value == original


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("system", "Windows"),
        ("architecture", "aarch64"),
        ("wsl", True),
        ("container", False),
        ("modelsVerified", False),
        ("device", "cuda"),
        ("timeoutMs", 600001),
        ("nativeOverridesConflict", True),
        ("freeWorkspaceBytes", 1),
    ],
)
def test_unqualified_inputs_cannot_pass(key: str, value: Any) -> None:
    evidence = profile()
    evidence[key] = value
    assert assess(evidence)["status"] != "READY_FOR_QUALIFICATION"


def test_ancestor_cgroup_limits_and_unknown_evidence(tmp_path: Path) -> None:
    proc = tmp_path / "proc/self"
    proc.mkdir(parents=True)
    (proc / "cgroup").write_text("0::/child\n")
    mount = tmp_path / "sys/fs/cgroup"
    child = mount / "child"
    child.mkdir(parents=True)
    for folder, cpu, memory in [
        (mount, "100000 100000", "1073741824"),
        (child, "200000 100000", "3221225472"),
    ]:
        (folder / "cpu.max").write_text(cpu)
        (folder / "memory.max").write_text(memory)
        (folder / "pids.max").write_text("128")
    assert cgroup_limits(tmp_path)["quotaCpus"] == 1
    assert cgroup_limits(tmp_path)["memoryBytes"] == 1073741824
    (child / "cpu.max").unlink()
    assert cgroup_limits(tmp_path)["quotaCpus"] is None


def test_collection_does_not_initialize_native_libraries_or_expose_private_settings(
    tmp_path: Path,
) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-B",
            "-c",
            "import json,os,sys; "
            "from editagent_ai_worker.infrastructure.asr_preflight import collect; "
            "before=dict(os.environ); value=collect(verify_models=True); "
            "assert dict(os.environ)==before; "
            "assert not ({'numpy','ctranslate2','faster_whisper'} & set(sys.modules)); "
            "print(json.dumps(value))",
        ],
        env={
            **os.environ,
            "EDITAGENT_ASR_MODEL_ROOT": str(tmp_path / "private-missing-model"),
            "DATABASE_URL": "private-credential",
        },
        text=True,
        capture_output=True,
        check=True,
        timeout=20,
    )
    assert "private" not in result.stdout
    assert json.loads(result.stdout)["modelsVerified"] is False
    assert not (tmp_path / "private-missing-model").exists()
