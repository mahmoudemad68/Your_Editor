"""Read-only ASR qualification preflight. No native import, network, installation or inference."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Any

from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.asr_model import (
    model_identity,
    required_models,
    verify_asr_model,
)
from editagent_ai_worker.infrastructure.config import (
    ASR_NATIVE_PROFILE,
    asr_native_overrides_conflict,
)

DEPENDENCIES = {
    "numpy": "2.4.6",
    "ctranslate2": "4.8.2",
    "faster-whisper": "1.2.1",
    "onnxruntime": "1.31.0",
    "av": "18.1.0",
}


def bounded_read(path: Path) -> str:
    with path.open(encoding="ascii") as stream:
        result = stream.read(2 * 1024 * 1024 + 1)
    if len(result) > 2 * 1024 * 1024:
        raise ValueError("Resource description exceeds bound")
    return result


def cgroup_limits(root: Path = Path("/")) -> dict[str, Any]:
    """Read v2 leaf AND visible ancestors; unavailable evidence stays unknown."""
    try:
        memberships = [
            line[3:]
            for line in bounded_read(root / "proc/self/cgroup").splitlines()
            if line.startswith("0::")
        ]
        if len(memberships) != 1:
            raise ValueError("Unknown cgroup membership")
        membership = memberships[0]
        if not membership.startswith("/") or ".." in Path(membership).parts:
            raise ValueError("Invalid cgroup membership")
        mount = root / "sys/fs/cgroup"
        leaf = mount / membership.lstrip("/")
        mounts = []
        for line in bounded_read(root / "proc/self/mountinfo").splitlines():
            fields = line.split()
            if len(fields) >= 10 and fields[4] == "/sys/fs/cgroup":
                separator = fields.index("-")
                if (
                    separator >= 6
                    and len(fields) == separator + 4
                    and fields[separator + 1] == "cgroup2"
                ):
                    mounts.append(fields[3])
        if mounts != ["/"]:
            raise ValueError("Unknown cgroup mount")
        quotas: list[float] = []
        memories: list[int] = []
        pids: list[int] = []
        # Do not assume a hidden/missing nested cgroup means unlimited resources.
        if not (leaf / "cpu.max").is_file():
            raise ValueError("Cgroup path is not visible")
        for current in (leaf, *leaf.parents):
            if current != mount and mount not in current.parents:
                break
            if current.is_symlink():
                raise ValueError("Untrustworthy cgroup path")
            files = [current / name for name in ("cpu.max", "memory.max", "pids.max")]
            if any(path.is_symlink() for path in files):
                raise ValueError("Untrustworthy controller file")
            if (
                current == mount
                and leaf != mount
                and mounts[0] == "/"
                and not any(path.exists() for path in files)
                and {"cpu", "memory", "pids"}
                <= set(bounded_read(current / "cgroup.controllers").split())
            ):
                # The genuine v2 hierarchy root has no resource-controller max
                # files. A delegated/bind-mounted root or missing intermediate
                # files cannot establish this exception. Retain child bounds.
                break
            quota, period = bounded_read(current / "cpu.max").split()
            period_value = positive_limit(period)
            if quota != "max":
                quotas.append(positive_limit(quota) / period_value)
            for name, target in (("memory.max", memories), ("pids.max", pids)):
                value = bounded_read(current / name).strip()
                if value != "max":
                    target.append(positive_limit(value))
        return {
            "version": 2,
            "quotaCpus": min(quotas) if quotas else None,
            "memoryBytes": min(memories) if memories else None,
            "pids": min(pids) if pids else None,
            "visibleAncestorsChecked": True,
        }
    except (OSError, UnicodeError, ValueError, IndexError):
        return {
            "version": None,
            "quotaCpus": None,
            "memoryBytes": None,
            "pids": None,
            "visibleAncestorsChecked": False,
        }


def positive_limit(value: str) -> int:
    """Kernel limits are bounded positive decimal integers, never signed/float text."""
    if not value.isascii() or not value.isdecimal() or not 0 < int(value) < 2**64:
        raise ValueError("Invalid resource limit")
    return int(value)


def assess(evidence: dict[str, Any]) -> dict[str, Any]:
    blockers = []
    unsupported = []
    if evidence["system"] != "Linux":
        unsupported.append("linux_required")
    if evidence["architecture"] not in {"x86_64", "amd64"}:
        unsupported.append("x86_64_required")
    if evidence["cpuCapabilities"] != {"avx2": True, "fma": True}:
        unsupported.append("verified_avx2_fma_required")
    if evidence["pythonMinor"] != "3.11" or evidence["libc"]["name"] != "glibc":
        blockers.append("runtime_not_qualified")
    if evidence["wsl"]:
        blockers.append("wsl_is_diagnostic_only")
    if not evidence["container"]:
        blockers.append("production_container_required")
    limits = evidence["cgroup"]
    if (
        limits.get("version") != 2
        or limits.get("visibleAncestorsChecked") is not True
        or limits["quotaCpus"] != 2
        or limits["memoryBytes"] != 3 * 1024**3
        or limits["pids"] != 128
    ):
        blockers.append("resource_profile_not_qualified")
    if evidence["affinityCpus"] < 2:
        blockers.append("cpu_affinity_insufficient")
    if evidence["dependencies"] != DEPENDENCIES:
        blockers.append("dependency_versions_not_qualified")
    if (
        not evidence["configurationValid"]
        or not evidence["configurationProfileMatches"]
        or evidence["device"] != "cpu"
        or evidence["timeoutMs"] != 600000
    ):
        blockers.append("configuration_not_qualified")
    if evidence["nativeOverridesConflict"]:
        blockers.append("native_profile_conflict")
    if not evidence["modelsVerified"]:
        blockers.append("model_bundles_not_verified")
    if evidence["freeWorkspaceBytes"] is None or evidence["freeWorkspaceBytes"] < 64 * 1024**2:
        blockers.append("workspace_headroom_below_recommendation")
    return {
        "status": "UNSUPPORTED"
        if unsupported
        else "NOT_QUALIFIED"
        if blockers
        else "READY_FOR_QUALIFICATION",
        "blockers": unsupported + blockers,
        "performanceGuaranteed": False,
        "nativeLibrariesLoaded": False,
        "deadlineMs": 600000,
        "resourceAssurance": {
            "scope": "visible_cgroup_namespace_only",
            "visibleProfileMatches": "resource_profile_not_qualified" not in blockers,
            "hostParentLimits": "NOT_VERIFIED",
            "operatorVerificationRequired": True,
            "limitation": "Stricter host, pod or parent-slice limits may be invisible.",
        },
    }


def collect(*, verify_models: bool = False) -> dict[str, Any]:
    system = platform.system()
    flags: list[set[str]] = []
    try:
        cpuinfo = bounded_read(Path("/proc/cpuinfo"))
        flags = [
            set(line.partition(":")[2].split())
            for line in cpuinfo.splitlines()
            if line.partition(":")[0].strip() == "flags"
        ]
    except (OSError, UnicodeError, ValueError):
        pass
    common = set.intersection(*flags) if flags else set()
    dependencies: dict[str, str | None] = {}
    for name in DEPENDENCIES:
        try:
            dependencies[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            dependencies[name] = None
    configuration_valid = True
    models_verified = False
    device = "unknown"
    timeout_ms = None
    model = "unknown"
    threads = None
    profile_matches = False
    try:
        settings = AsrSettings()
        device, timeout_ms, model, threads = (
            settings.device,
            settings.timeout_ms,
            settings.model,
            settings.cpu_threads,
        )
        profile_matches = settings.cpu_threads in {1, 2} and all(
            getattr(settings, key) == value
            for key, value in {
                "compute_type": "int8",
                "beam_size": 5,
                "seed": 0,
                "chunk_us": 24000000,
                "overlap_us": 2000000,
                "speech_threshold": 0.5,
                "negative_threshold": 0.35,
                "min_silence_ms": 200,
                "speech_padding_ms": 100,
            }.items()
        )
        if verify_models:
            for name in required_models(model):
                verify_asr_model(settings.model_root / name, name)
            models_verified = True
    except Exception:
        # No Pydantic input, model path, private environment or exception text in output.
        configuration_valid = False
    try:
        free = shutil.disk_usage(Path("/tmp") if system == "Linux" else Path.cwd()).free
    except OSError:
        free = None
    affinity = (
        len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count() or 0
    )
    libc_name, libc_version = platform.libc_ver()
    evidence = {
        "system": system,
        "architecture": platform.machine().lower(),
        "pythonMinor": f"{sys.version_info.major}.{sys.version_info.minor}",
        "pythonVersion": platform.python_version(),
        "libc": {"name": libc_name, "version": libc_version},
        "wsl": "microsoft" in platform.release().lower(),
        "container": Path("/.dockerenv").is_file(),
        "cpuCapabilities": {"avx2": "avx2" in common, "fma": "fma" in common},
        "logicalCpus": os.cpu_count(),
        "affinityCpus": affinity,
        "cgroup": cgroup_limits()
        if system == "Linux"
        else {"version": None, "quotaCpus": None, "memoryBytes": None, "pids": None},
        "dependencies": dependencies,
        "configurationValid": configuration_valid,
        "configurationProfileMatches": profile_matches,
        "device": device,
        "timeoutMs": timeout_ms,
        "model": model,
        "cpuThreads": threads,
        "nativeProfile": ASR_NATIVE_PROFILE,
        "nativeOverridesConflict": asr_native_overrides_conflict(),
        "modelsVerified": models_verified,
        "expectedModels": {name: model_identity(name) for name in ("tiny", "small")},
        "freeWorkspaceBytes": free,
    }
    return {
        "schemaVersion": 1,
        "role": "READ_ONLY_PREFLIGHT_NOT_INFERENCE_QUALIFICATION",
        **evidence,
        **assess(evidence),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verify-models",
        action="store_true",
        help="Read and hash existing bundles; never acquires missing files",
    )
    args = parser.parse_args()
    report = collect(verify_models=args.verify_models)
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "READY_FOR_QUALIFICATION" else 2


if __name__ == "__main__":
    raise SystemExit(main())
