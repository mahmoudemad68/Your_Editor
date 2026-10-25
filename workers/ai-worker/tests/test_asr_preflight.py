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
from editagent_ai_worker.infrastructure.config import (
    ASR_NATIVE_ENVIRONMENT,
    ASR_NATIVE_RESERVED_ENVIRONMENT,
    asr_native_overrides_conflict,
)


def profile() -> dict[str, Any]:
    return {
        "system": "Linux",
        "architecture": "x86_64",
        "pythonMinor": "3.11",
        "libc": {"name": "glibc"},
        "cpuCapabilities": {"avx2": True, "fma": True},
        "wsl": False,
        "container": True,
        "cgroup": {
            "version": 2,
            "quotaCpus": 2,
            "memoryBytes": 3 * 1024**3,
            "pids": 128,
            "visibleAncestorsChecked": True,
        },
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
    assert result["resourceAssurance"] == {
        "scope": "visible_cgroup_namespace_only",
        "visibleProfileMatches": True,
        "hostParentLimits": "NOT_VERIFIED",
        "operatorVerificationRequired": True,
        "limitation": "Stricter host, pod or parent-slice limits may be invisible.",
    }
    assert value == original


def test_caller_supplied_host_claim_cannot_upgrade_resource_assurance() -> None:
    value = profile()
    value["hostParentLimits"] = "VERIFIED"
    value["resourceAttestation"] = {"trusted": True, "quotaCpus": 2}
    result = assess(value)
    assert result["resourceAssurance"]["hostParentLimits"] == "NOT_VERIFIED"
    value["cgroup"]["quotaCpus"] = 1
    assert assess(value)["status"] == "NOT_QUALIFIED"


def test_native_override_probe_is_read_only_at_configuration_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in (*ASR_NATIVE_ENVIRONMENT, *ASR_NATIVE_RESERVED_ENVIRONMENT):
        monkeypatch.delenv(key, raising=False)
    assert asr_native_overrides_conflict() is False
    for key, value in ASR_NATIVE_ENVIRONMENT.items():
        monkeypatch.setenv(key, value)
    before = dict(os.environ)
    assert asr_native_overrides_conflict() is False
    assert dict(os.environ) == before
    monkeypatch.setenv("CT2_FORCE_CPU_ISA", "unsupported")
    assert asr_native_overrides_conflict() is True
    monkeypatch.setenv("CT2_FORCE_CPU_ISA", ASR_NATIVE_ENVIRONMENT["CT2_FORCE_CPU_ISA"])
    monkeypatch.setenv("MKL_CBWR", "unsupported")
    before = dict(os.environ)
    assert asr_native_overrides_conflict() is True
    assert dict(os.environ) == before


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
    (proc / "mountinfo").write_text("1 0 0:1 / /sys/fs/cgroup ro - cgroup2 cgroup rw\n")
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


def hierarchy(tmp_path: Path, membership: str = "/group/child") -> Path:
    proc = tmp_path / "proc/self"
    proc.mkdir(parents=True)
    (proc / "cgroup").write_text(f"0::{membership}\n")
    (proc / "mountinfo").write_text("1 0 0:1 / /sys/fs/cgroup ro - cgroup2 cgroup rw\n")
    mount = tmp_path / "sys/fs/cgroup"
    leaf = mount / membership.lstrip("/")
    leaf.mkdir(parents=True)
    for folder in (leaf, *leaf.parents):
        if folder == mount:
            break
        (folder / "cpu.max").write_text("200000 100000")
        (folder / "memory.max").write_text("3221225472")
        (folder / "pids.max").write_text("128")
    (mount / "cgroup.controllers").write_text("cpu memory pids io")
    return mount


def test_host_namespace_genuine_root_preserves_restrictive_ancestor_limits(tmp_path: Path) -> None:
    mount = hierarchy(tmp_path)
    (mount / "group/cpu.max").write_text("100000 100000")
    (mount / "group/memory.max").write_text("1073741824")
    (mount / "group/pids.max").write_text("64")
    assert cgroup_limits(tmp_path) == {
        "version": 2,
        "quotaCpus": 1,
        "memoryBytes": 1073741824,
        "pids": 64,
        "visibleAncestorsChecked": True,
    }
    value = profile()
    value["cgroup"] = cgroup_limits(tmp_path)
    assert assess(value)["status"] == "NOT_QUALIFIED"


def test_private_namespace_reads_its_root_limits(tmp_path: Path) -> None:
    mount = hierarchy(tmp_path, "/")
    for name, value in [
        ("cpu.max", "200000 100000"),
        ("memory.max", "3221225472"),
        ("pids.max", "128"),
    ]:
        (mount / name).write_text(value)
    evidence = profile()
    evidence["cgroup"] = cgroup_limits(tmp_path)
    assert assess(evidence)["status"] == "READY_FOR_QUALIFICATION"


@pytest.mark.parametrize(
    "defect",
    [
        "missing_leaf",
        "missing_parent",
        "partial_root",
        "private_missing",
        "delegated_root",
        "missing_mount",
        "wrong_fs",
        "missing_controllers",
        "hidden",
        "traversal",
        "v1",
        "duplicate",
    ],
)
def test_missing_or_hidden_hierarchy_is_unknown(tmp_path: Path, defect: str) -> None:
    mount = hierarchy(tmp_path)
    proc = tmp_path / "proc/self"
    if defect == "missing_leaf":
        (mount / "group/child/cpu.max").unlink()
    elif defect == "missing_parent":
        (mount / "group/memory.max").unlink()
    elif defect == "partial_root":
        (mount / "cpu.max").write_text("max 100000")
    elif defect == "private_missing":
        (proc / "cgroup").write_text("0::/\n")
    elif defect == "delegated_root":
        (proc / "mountinfo").write_text("1 0 0:1 /hidden /sys/fs/cgroup ro - cgroup2 cgroup rw\n")
    elif defect == "missing_mount":
        (proc / "mountinfo").unlink()
    elif defect == "wrong_fs":
        (proc / "mountinfo").write_text("1 0 0:1 / /sys/fs/cgroup ro - cgroup cgroup rw\n")
    elif defect == "missing_controllers":
        (mount / "cgroup.controllers").write_text("cpu memory")
    else:
        (proc / "cgroup").write_text(
            {
                "hidden": "0::/invisible\n",
                "traversal": "0::/../group\n",
                "v1": "1:cpu:/group\n",
                "duplicate": "0::/group\n0::/group/child\n",
            }[defect]
        )
    result = cgroup_limits(tmp_path)
    assert result["visibleAncestorsChecked"] is False
    assert all(result[key] is None for key in ("quotaCpus", "memoryBytes", "pids"))
    evidence = profile()
    evidence["cgroup"] = result
    assert assess(evidence)["status"] == "NOT_QUALIFIED"


@pytest.mark.parametrize(
    "name,value",
    [
        ("cpu.max", "0 100000"),
        ("cpu.max", "200000 0"),
        ("cpu.max", "max"),
        ("cpu.max", "nan 100000"),
        ("cpu.max", "+200000 100000"),
        ("memory.max", "-1"),
        ("memory.max", "18446744073709551616"),
        ("pids.max", "0"),
        ("pids.max", "128 extra"),
    ],
)
def test_malformed_ancestor_cannot_grant_qualification(
    tmp_path: Path, name: str, value: str
) -> None:
    mount = hierarchy(tmp_path)
    (mount / "group" / name).write_text(value)
    assert cgroup_limits(tmp_path)["visibleAncestorsChecked"] is False


def test_unlimited_ancestors_do_not_erase_finite_child_limits(tmp_path: Path) -> None:
    mount = hierarchy(tmp_path)
    for name, value in [("cpu.max", "max 100000"), ("memory.max", "max"), ("pids.max", "max")]:
        (mount / "group" / name).write_text(value)
    evidence = profile()
    evidence["cgroup"] = cgroup_limits(tmp_path)
    assert assess(evidence)["status"] == "READY_FOR_QUALIFICATION"
    evidence["cgroup"]["visibleAncestorsChecked"] = False
    assert assess(evidence)["status"] == "NOT_QUALIFIED"


def test_delegated_mount_cannot_hide_unknown_ancestors_even_with_valid_root_limits(
    tmp_path: Path,
) -> None:
    mount = hierarchy(tmp_path)
    for name, value in [
        ("cpu.max", "200000 100000"),
        ("memory.max", "3221225472"),
        ("pids.max", "128"),
    ]:
        (mount / name).write_text(value)
    (tmp_path / "proc/self/mountinfo").write_text(
        "1 0 0:1 /hidden /sys/fs/cgroup ro - cgroup2 cgroup rw\n"
    )
    assert cgroup_limits(tmp_path)["visibleAncestorsChecked"] is False
    evidence = profile()
    evidence["cgroup"]["version"] = 1
    assert assess(evidence)["status"] == "NOT_QUALIFIED"


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
