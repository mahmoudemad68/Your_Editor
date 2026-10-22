"""Test-only original-source preparation and production-container resource measurement.

Native words leave this process only on its captured private stdout. The host
qualifier publishes an explicit numeric/control-field allowlist, never this payload.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.metadata
import io
import json
import os
import platform
import sys
import time
from collections.abc import Callable
from pathlib import Path
from types import FrameType
from typing import TypedDict


class ResourceSnapshot(TypedDict):
    cpuQuotaUs: int
    cpuPeriodUs: int
    memoryLimitBytes: int
    memoryPeakBytes: int
    pidsLimit: int
    cpu: dict[str, int]
    memoryEvents: dict[str, int]
    logicalCpus: int
    affinityCpus: int


def cpu_dispatch_evidence(cpuinfo: str) -> dict[str, object]:
    """Bounded CPU taxonomy only; no names, unique IDs or arbitrary fields."""
    records: list[dict[str, object]] = []
    for block in cpuinfo.split("\n\n"):
        fields = dict(line.split(":", 1) for line in block.splitlines() if ":" in line)
        fields = {key.strip(): value.strip() for key, value in fields.items()}
        if "processor" not in fields:
            continue
        vendor = fields["vendor_id"]
        record: dict[str, object] = {
            "vendor": vendor if vendor in {"GenuineIntel", "AuthenticAMD"} else "other"
        }
        for key in ("cpu family", "model", "stepping"):
            value = int(fields[key])
            if not 0 <= value <= 4095:
                raise ValueError("Invalid CPU taxonomy")
            record[key.replace("cpu ", "")] = value
        records.append(record)
    if not records:
        raise ValueError("CPU taxonomy is unavailable")
    return {**records[0], "uniform": all(record == records[0] for record in records)}


def numerical_runtime_evidence() -> dict[str, object]:
    """Compare numerical stacks using public synthetic PCM, never speech output.

    Equal package versions and ISA declarations do not establish equal feature
    arithmetic across system libraries. This records actual preprocessing on a
    fixed integer signal. Fingerprint equality is diagnostic evidence, not proof
    of deterministic decoding. No environment values or machine paths leave here.
    The caller must establish the native profile before importing NumPy.
    """
    import ctranslate2  # type: ignore[import-untyped]
    import faster_whisper  # type: ignore[import-untyped]
    import numpy as np
    from editagent_ai_worker.infrastructure.asr_features import (
        DeterministicFeatureExtractor,
        numpy_cpu_kernels,
    )
    from editagent_ai_worker.infrastructure.config import require_asr_native_environment

    require_asr_native_environment()
    # Every sample is exactly representable; constructing the probe calls no
    # sine/logarithm or system-dependent random-number generator.
    integers = (np.arange(16000, dtype=np.int32) * 197) % 65536 - 32768
    pcm = integers.astype(np.float32) / 32768
    extractor = DeterministicFeatureExtractor()
    window = np.hanning(extractor.n_fft + 1)[:-1].astype(np.float32)
    spectrum = extractor.stft(
        np.pad(pcm, (0, 160)),
        extractor.n_fft,
        extractor.hop_length,
        window=window,
        return_complex=True,
    ).astype(np.complex64)
    features = extractor(pcm)
    # Only installed, immutable package bytes are read, not paths from a job.
    extension = Path(ctranslate2._ext.__file__)
    graph = Path(faster_whisper.__file__).parent / "assets" / "silero_vad_v6.onnx"
    libc, libc_version = platform.libc_ver()
    with extension.open("rb") as stream:
        extension_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    return {
        "schemaVersion": 2,
        "probe": "integer-ramp-pcm16-16000-v1",
        "python": platform.python_version(),
        "libc": {"name": libc, "version": libc_version},
        "machine": platform.machine(),
        "cpu": cpu_dispatch_evidence(Path("/proc/cpuinfo").read_text(encoding="ascii")),
        "packages": {
            name: importlib.metadata.version(name)
            for name in ("numpy", "ctranslate2", "faster-whisper", "onnxruntime", "av")
        },
        "ctranslate2ExtensionSha256": extension_sha256,
        "vadGraphSha256": hashlib.sha256(graph.read_bytes()).hexdigest(),
        "numpyKernels": numpy_cpu_kernels(),
        "synthetic": {
            "pcmFloat32Sha256": hashlib.sha256(pcm.tobytes()).hexdigest(),
            "melFiltersFloat32Sha256": hashlib.sha256(
                extractor.mel_filters.tobytes()
            ).hexdigest(),
            "hannFloat32Sha256": hashlib.sha256(window.tobytes()).hexdigest(),
            "stftComplex64Sha256": hashlib.sha256(spectrum.tobytes()).hexdigest(),
            "logMelFloat32Sha256": hashlib.sha256(features.tobytes()).hexdigest(),
        },
    }


def prepare(repository: Path, directory: Path) -> None:
    from editagent_ai_worker.infrastructure.config import (
        configure_asr_native_environment,
    )

    configure_asr_native_environment()
    from faster_whisper.audio import decode_audio  # type: ignore[import-untyped]

    fixtures = repository / "tests/fixtures/asr"
    manifest = json.loads((fixtures / "manifest.json").read_text(encoding="utf-8"))
    entry = next(
        f for f in manifest["fixtures"] if f["file"] == "en-original-ten-minute.flac"
    )
    source = fixtures / entry["file"]
    if (
        source.is_symlink()
        or hashlib.sha256(source.read_bytes()).hexdigest() != entry["sha256"]
    ):
        raise ValueError("Original licensed fixture identity mismatch")
    audio = decode_audio(str(source), sampling_rate=16000)
    if len(audio) != 600 * 16000:
        raise ValueError("Original fixture is not ten minutes")
    samples = (audio * 32768).astype("<i2").tobytes()
    canonical = entry["canonicalWav"]
    if hashlib.sha256(samples).hexdigest() != canonical["pcmSha256"]:
        raise ValueError("Original PCM identity mismatch")
    data = bytes.fromhex(canonical["headerHex"]) + samples
    if (
        len(data) != canonical["sizeBytes"]
        or hashlib.sha256(data).hexdigest() != canonical["sha256"]
    ):
        raise ValueError("Canonical original WAV identity mismatch")
    # A dedicated, caller-created temporary directory contains only approved inputs.
    with (directory / "audio.wav").open("xb") as stream:
        stream.write(data)
    identity = {
        "source_id": entry["sourceId"],
        "source_sha256": entry["sourceSha256"],
        "artifact_id": "original-600s-regression",
        "audio_sha256": canonical["sha256"],
        "source_duration_us": 615428000,
        "scope_start_us": 0,
        "scope_end_us": 600000000,
    }
    with (directory / "identity.json").open("x", encoding="utf-8") as stream:
        json.dump(identity, stream)
    for name in ("audio.wav", "identity.json"):
        (directory / name).chmod(0o444)
    directory.chmod(0o755)


def cgroup_snapshot(root: Path = Path("/sys/fs/cgroup")) -> ResourceSnapshot:
    def read(name: str) -> str:
        with (root / name).open(encoding="ascii") as stream:
            value = stream.read(4097)
        if len(value) > 4096:
            raise ValueError("Resource evidence exceeds bound")
        return value.strip()

    quota = read("cpu.max").split()
    if len(quota) != 2 or quota[0] == "max":
        raise ValueError("Finite CPU quota is required")
    cpu = {
        key: int(value)
        for key, value in (line.split() for line in read("cpu.stat").splitlines())
    }
    memory_events = {
        key: int(value)
        for key, value in (line.split() for line in read("memory.events").splitlines())
    }
    return {
        "cpuQuotaUs": int(quota[0]),
        "cpuPeriodUs": int(quota[1]),
        "memoryLimitBytes": int(read("memory.max")),
        "memoryPeakBytes": int(read("memory.peak")),
        "pidsLimit": int(read("pids.max")),
        "cpu": cpu,
        "memoryEvents": memory_events,
        "logicalCpus": os.cpu_count() or 0,
        "affinityCpus": len(os.sched_getaffinity(0)),
    }


def phase_profiler(
    phases: dict[str, dict[str, float | int]],
) -> Callable[[FrameType, str, object], None]:
    """Identical non-operand timing instrumentation in both execution stacks."""
    started: dict[int, int] = {}
    measured = {
        "_load",
        "_language_regions",
        "_decode_window",
        "_primary_aligned_chunk",
        "_fallback_alignment",
        "_reconcile_overlaps",
        "_recover_coverage",
    }

    def profile(frame: FrameType, event: str, _arg: object) -> None:
        # Read code identity only, never inference arguments, locals or output.
        code = frame.f_code
        if code.co_name not in measured or not code.co_filename.endswith(
            "/faster_whisper.py"
        ):
            return
        if event == "call":
            started[id(frame)] = time.perf_counter_ns()
        elif event == "return" and id(frame) in started:
            elapsed = (time.perf_counter_ns() - started.pop(id(frame))) / 1_000_000
            entry = phases.setdefault(code.co_name, {"calls": 0, "wallTimeMs": 0.0})
            entry["calls"] += 1
            entry["wallTimeMs"] += elapsed

    return profile


def measure() -> int:
    from editagent_ai_worker.composition.transcribe import main as transcribe

    before = cgroup_snapshot()
    if (
        before["cpuQuotaUs"] != 2 * before["cpuPeriodUs"]
        or before["memoryLimitBytes"] != 3 * 1024**3
        or before["pidsLimit"] != 128
    ):
        raise ValueError("Production qualification resource profile differs")
    sys.argv = [
        "transcribe",
        "--audio",
        "/qualification/audio.wav",
        "--identity",
        "/qualification/identity.json",
    ]
    captured = io.StringIO()
    phases: dict[str, dict[str, float | int]] = {}
    sys.setprofile(phase_profiler(phases))
    try:
        with contextlib.redirect_stdout(captured):
            status = transcribe()
    finally:
        sys.setprofile(None)
    content = captured.getvalue()
    if len(content) > 16_000_000:
        raise ValueError("Native result exceeds private output bound")
    print(
        json.dumps(
            {
                "worker": json.loads(content),
                "before": before,
                "after": cgroup_snapshot(),
                "phases": phases,
                "numericalRuntime": numerical_runtime_evidence(),
                "versions": {
                    name: importlib.metadata.version(name)
                    for name in ("numpy", "ctranslate2", "faster-whisper")
                },
            }
        )
    )
    return status


def host_control(directory: Path) -> int:
    """Same-host diagnostic only: never impersonate Docker/cgroup qualification."""
    from editagent_ai_worker.composition.transcribe import main as transcribe

    sys.argv = [
        sys.argv[0],
        "--audio",
        str(directory / "audio.wav"),
        "--identity",
        str(directory / "identity.json"),
    ]
    captured = io.StringIO()
    phases: dict[str, dict[str, float | int]] = {}
    sys.setprofile(phase_profiler(phases))
    try:
        with contextlib.redirect_stdout(captured):
            status = transcribe()
    finally:
        sys.setprofile(None)
    content = captured.getvalue()
    if len(content) > 16_000_000:
        raise ValueError("Native result exceeds private output bound")
    print(
        json.dumps(
            {
                "worker": json.loads(content),
                "phases": phases,
                "numericalRuntime": numerical_runtime_evidence(),
                "logicalCpus": os.cpu_count(),
                "affinityCpus": len(os.sched_getaffinity(0)),
            }
        )
    )
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "measure", "host-control"))
    parser.add_argument("--repository", type=Path)
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    if args.mode == "host-control":
        if args.directory is None or not args.directory.is_dir():
            raise ValueError("Dedicated prepared input directory is required")
        return host_control(args.directory)
    if args.mode == "prepare":
        if (
            args.repository is None
            or args.directory is None
            or not args.directory.is_dir()
        ):
            raise ValueError("Dedicated preparation directory is required")
        prepare(args.repository, args.directory)
        return 0
    return measure()


if __name__ == "__main__":
    # The host captures both stdout/stderr privately, including genuine failure causes.
    raise SystemExit(main())
