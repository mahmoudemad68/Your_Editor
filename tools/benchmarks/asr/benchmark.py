"""Faster-Whisper benchmark runner for the US-105 spike.

Planned configurations are always recorded. Unsupported and skipped cases stay
in the result files. Model weights are imported only when a run is executed.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import json
import platform
import subprocess
import sys
import time
import zipfile
from collections.abc import Callable
from pathlib import Path

from manifest import load_manifest, validate_manifest
from metrics import cp1_asr_observation, real_time_factor, throughput

GPU_CONFIGS = (
    ("small", "int8"),
    ("small", "float16"),
    ("medium", "int8"),
    ("medium", "float16"),
    ("large-v3", "int8"),
    ("large-v3", "float16"),
)
CPU_INT8_CONFIGS = (
    ("small", "int8"),
    ("medium", "int8"),
    ("large-v3", "int8"),
)
CPU_FLOAT16_MODELS = ("small", "medium", "large-v3")
LANGUAGES = ("en", "ar")


def planned_configurations() -> list[dict[str, str]]:
    plan: list[dict[str, str]] = []
    for model, compute_type in GPU_CONFIGS:
        plan.append({"model": model, "compute_type": compute_type, "device": "cuda"})
    for model, compute_type in CPU_INT8_CONFIGS:
        plan.append({"model": model, "compute_type": compute_type, "device": "cpu"})
    for model in CPU_FLOAT16_MODELS:
        plan.append({"model": model, "compute_type": "float16", "device": "cpu"})
    return plan


def classify_configuration(
    device: str,
    compute_type: str,
    probe: dict[str, object],
    include_cpu: bool,
) -> tuple[str, str | None]:
    if device == "cpu" and compute_type == "float16":
        return "UNSUPPORTED", "float16 is not supported on CPU"
    if device == "cuda" and not probe.get("gpu_available"):
        reason = str(probe.get("probe_error") or "CUDA device is not available")
        return "UNSUPPORTED", reason
    if compute_type == "float16" and device == "cuda" and not probe.get("cuda_float16"):
        return "UNSUPPORTED", "float16 is not supported on the detected CUDA device"
    if device == "cpu" and not include_cpu:
        return "SKIPPED", "CPU benchmarks were not requested"
    return "READY", None


def build_plan_records(
    probe: dict[str, object],
    languages: tuple[str, ...] = LANGUAGES,
    include_cpu: bool = False,
    present_languages: set[str] | None = None,
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    available = set(languages) if present_languages is None else present_languages
    for config in planned_configurations():
        status, reason = classify_configuration(
            config["device"],
            config["compute_type"],
            probe,
            include_cpu,
        )
        for language in languages:
            record_status = status
            record_reason = reason
            if language not in available and status == "READY":
                record_status = "SKIPPED"
                record_reason = f"no {language} clips in the manifest"
            records.append(
                {
                    "model": config["model"],
                    "device": config["device"],
                    "compute_type": config["compute_type"],
                    "language": language,
                    "status": record_status,
                    "reason": record_reason,
                }
            )
    return records


def apply_execution_budget(
    records: list[dict[str, object]],
    budget_seconds: float | None,
    elapsed_seconds: float,
) -> list[dict[str, object]]:
    if budget_seconds is None or elapsed_seconds < budget_seconds:
        return records
    updated: list[dict[str, object]] = []
    for record in records:
        if record["status"] == "READY":
            updated.append(
                {
                    **record,
                    "status": "SKIPPED",
                    "reason": "execution budget exhausted",
                }
            )
        else:
            updated.append(record)
    return updated


def run_id_for(
    record: dict[str, object], repeat_index: int | None, warmup: bool
) -> str:
    parts = [
        str(record["model"]),
        str(record["compute_type"]),
        str(record["device"]),
        str(record["language"]),
    ]
    if warmup:
        parts.append("warmup")
    elif repeat_index is not None:
        parts.append(f"measured-{repeat_index}")
    return "-".join(parts)


def empty_measurements() -> dict[str, object]:
    return {
        "audio_seconds": None,
        "init_seconds": None,
        "inference_seconds": None,
        "real_time_factor": None,
        "throughput": None,
        "peak_rss_bytes": None,
        "peak_vram_bytes": None,
    }


def measurement_fields(
    audio_seconds: float, init_seconds: float, inference_seconds: float
) -> dict[str, object]:
    return {
        "audio_seconds": audio_seconds,
        "init_seconds": init_seconds,
        "inference_seconds": inference_seconds,
        "real_time_factor": real_time_factor(audio_seconds, inference_seconds),
        "throughput": throughput(audio_seconds, inference_seconds),
    }


def serialize_result(record: dict[str, object]) -> str:
    return json.dumps(record, indent=2, sort_keys=True) + "\n"


def write_result(directory: Path, record: dict[str, object]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{record['run_id']}.json"
    path.write_text(serialize_result(record), encoding="utf-8")
    return path


def read_peak_rss_bytes() -> int | None:
    status = Path("/proc/self/status")
    if not status.is_file():
        return None
    for line in status.read_text(encoding="utf-8").splitlines():
        if line.startswith("VmHWM:"):
            return int(line.split()[1]) * 1024
    return None


def parse_nvidia_smi_values(line: str) -> list[str]:
    return [part.strip() for part in line.split(",")]


def parse_cuda_version(text: str) -> str | None:
    for line in text.splitlines():
        if "CUDA Version" in line:
            marker = "CUDA Version:"
            index = line.find(marker)
            if index >= 0:
                return line[index + len(marker) :].strip().split()[0]
    return None


def query_nvidia_smi() -> dict[str, object]:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,driver_version,memory.used",
                "--format=csv,noheader,nounits",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "reason": str(exc)}
    if completed.returncode != 0 or not completed.stdout.strip():
        return {
            "available": False,
            "reason": completed.stderr.strip() or "nvidia-smi returned no GPU",
        }
    first = parse_nvidia_smi_values(completed.stdout.splitlines()[0])
    header = subprocess.run(
        ["nvidia-smi"],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    used = float(first[3]) * 1024 * 1024 if len(first) > 3 and first[3] else None
    total = float(first[1]) * 1024 * 1024 if len(first) > 1 and first[1] else None
    return {
        "available": True,
        "name": first[0] if first else None,
        "memory_total_bytes": total,
        "memory_used_bytes": used,
        "driver_version": first[2] if len(first) > 2 else None,
        "cuda_version": parse_cuda_version(header.stdout),
    }


def collect_hardware(commit_sha: str) -> dict[str, object]:
    versions: dict[str, str | None] = {}
    for module_name, key in (
        ("faster_whisper", "faster_whisper"),
        ("ctranslate2", "ctranslate2"),
        ("silero_vad", "silero_vad"),
    ):
        try:
            module = __import__(module_name)
            versions[key] = getattr(module, "__version__", None)
        except (ImportError, AttributeError):
            versions[key] = None
    return {
        "commit_sha": commit_sha,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "processor": platform.processor(),
        "libraries": versions,
        "gpu": query_nvidia_smi(),
    }


def probe_devices() -> dict[str, object]:
    probe: dict[str, object] = {
        "gpu_available": False,
        "cuda_float16": False,
        "cpu_float16": False,
        "probe_error": None,
    }
    try:
        import ctranslate2
    except ImportError as exc:
        probe["probe_error"] = f"ctranslate2 is not available: {exc}"
        return probe
    try:
        count = int(ctranslate2.get_cuda_device_count())
    except (AttributeError, OSError, RuntimeError, ValueError) as exc:
        probe["probe_error"] = str(exc)
        return probe
    probe["gpu_available"] = count > 0
    if count > 0:
        try:
            supported = ctranslate2.get_supported_compute_types("cuda", 0)
            probe["cuda_float16"] = "float16" in set(supported)
        except (AttributeError, OSError, RuntimeError, ValueError, TypeError) as exc:
            probe["cuda_float16"] = False
            probe["probe_error"] = str(exc)
    return probe


def _library_versions() -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for module_name in ("faster_whisper", "ctranslate2", "silero_vad"):
        try:
            module = __import__(module_name)
            versions[module_name] = getattr(module, "__version__", None)
        except (ImportError, AttributeError):
            versions[module_name] = None
    return versions


def call_with_timeout(
    action: Callable[[], dict[str, object]], seconds: float | None
) -> dict[str, object]:
    """Run action and raise TimeoutError when the limit is exceeded.

    A native inference call that ignores thread cancellation can continue in
    the background after TimeoutError. The result record still says FAILED.
    """

    if seconds is None:
        return action()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(action)
        return future.result(timeout=seconds)


def transcribe_file(
    model: object, audio_path: Path, language: str
) -> dict[str, object]:
    segments, _info = model.transcribe(
        str(audio_path),
        language=language,
        word_timestamps=True,
        without_timestamps=False,
        vad_filter=False,
    )
    texts: list[str] = []
    words: list[dict[str, float | str]] = []
    for segment in segments:
        texts.append(segment.text)
        for word in segment.words or []:
            words.append(
                {"word": word.word, "start": float(word.start), "end": float(word.end)}
            )
    return {"text": "".join(texts).strip(), "words": words}


def detect_speech(audio_path: Path) -> list[dict[str, float]]:
    from silero_vad import get_speech_timestamps, load_silero_vad, read_audio

    model = load_silero_vad()
    audio = read_audio(str(audio_path))
    stamps = get_speech_timestamps(audio, model, return_seconds=True)
    return [
        {"start": float(item["start"]), "end": float(item["end"])} for item in stamps
    ]


def _load_model(
    model_name: str, device: str, compute_type: str
) -> tuple[object, float]:
    from faster_whisper import WhisperModel

    started = time.perf_counter()
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    return model, time.perf_counter() - started


def run_benchmark(
    manifest_path: Path,
    dataset_root: Path,
    output_dir: Path,
    commit_sha: str,
    include_cpu: bool = False,
    repeats: int = 1,
    warmup: int = 1,
    clip_timeout_seconds: float | None = None,
    budget_seconds: float | None = None,
    probe: dict[str, object] | None = None,
    transcribe: Callable[..., dict[str, object]] | None = None,
    clock: Callable[[], float] | None = None,
) -> list[dict[str, object]]:
    if repeats < 1:
        raise ValueError("repeats must be at least 1")
    if warmup < 0:
        raise ValueError("warmup must be zero or positive")
    document = load_manifest(manifest_path)
    checked = validate_manifest(
        document, dataset_root, require_files=transcribe is None
    )
    if not checked["ok"]:
        raise ValueError("manifest is invalid: " + "; ".join(checked["errors"]))
    if not checked["meets_minimum_total"]:
        raise ValueError("manifest audio is shorter than 10 minutes")
    device_probe = probe if probe is not None else probe_devices()
    present = {clip["language"] for clip in checked["clips"]}
    records = build_plan_records(
        device_probe, include_cpu=include_cpu, present_languages=present
    )
    runs_dir = output_dir / "runs"
    hypotheses = output_dir / "hypotheses"
    versions = _library_versions()
    mono = clock or time.monotonic
    session_started = mono()
    written: list[dict[str, object]] = []
    loaded: dict[tuple[str, str, str], tuple[object, float]] = {}

    for record in records:
        elapsed = mono() - session_started
        gated = apply_execution_budget([record], budget_seconds, elapsed)[0]
        base = {
            "commit_sha": commit_sha,
            "model": gated["model"],
            "device": gated["device"],
            "compute_type": gated["compute_type"],
            "language": gated["language"],
            "faster_whisper_version": versions.get("faster_whisper"),
            "ctranslate2_version": versions.get("ctranslate2"),
            "silero_vad_version": versions.get("silero_vad"),
            **empty_measurements(),
        }
        if gated["status"] != "READY":
            payload = {
                **base,
                "run_id": run_id_for(gated, None, False),
                "status": gated["status"],
                "reason": gated["reason"],
                "measured": False,
                "repeat_index": None,
                "warmup": False,
            }
            write_result(runs_dir, payload)
            written.append(payload)
            continue
        clips = [
            clip for clip in checked["clips"] if clip["language"] == gated["language"]
        ]
        key = (str(gated["model"]), str(gated["device"]), str(gated["compute_type"]))
        try:
            if key not in loaded:
                if transcribe is None:
                    loaded[key] = _load_model(key[0], key[1], key[2])
                else:
                    loaded[key] = (object(), 0.0)
            model, init_seconds = loaded[key]
        except (ImportError, OSError, RuntimeError, ValueError) as exc:
            payload = {
                **base,
                "run_id": run_id_for(gated, None, False),
                "status": "FAILED",
                "reason": f"model initialization failed: {exc}",
                "measured": False,
                "repeat_index": None,
                "warmup": False,
            }
            write_result(runs_dir, payload)
            written.append(payload)
            continue
        passes = [("warmup", index, False) for index in range(warmup)]
        passes += [("measured", index, True) for index in range(1, repeats + 1)]
        for _label, index, measured in passes:
            if (
                budget_seconds is not None
                and mono() - session_started >= budget_seconds
            ):
                payload = {
                    **base,
                    "run_id": run_id_for(
                        gated, None if not measured else index, not measured
                    ),
                    "status": "SKIPPED",
                    "reason": "execution budget exhausted",
                    "measured": False,
                    "repeat_index": index if measured else None,
                    "warmup": not measured,
                }
                write_result(runs_dir, payload)
                written.append(payload)
                continue
            started = time.perf_counter()
            audio_seconds = 0.0
            failure = None
            for clip in clips:
                audio_seconds += float(clip["duration_seconds"])

                def _run(
                    clip: dict[str, object] = clip,
                    model: object = model,
                ) -> dict[str, object]:
                    if transcribe is None:
                        return transcribe_file(
                            model,
                            dataset_root / str(clip["audio_path"]),
                            str(clip["language"]),
                        )
                    return transcribe(clip)

                try:
                    hypothesis = call_with_timeout(_run, clip_timeout_seconds)
                    if measured:
                        destination = (
                            hypotheses
                            / str(gated["model"])
                            / str(gated["compute_type"])
                        )
                        destination.mkdir(parents=True, exist_ok=True)
                        (
                            destination / f"{clip['id']}-{gated['device']}.json"
                        ).write_text(
                            json.dumps(
                                {
                                    "commit_sha": commit_sha,
                                    "clip_id": clip["id"],
                                    "language": clip["language"],
                                    "model": gated["model"],
                                    "compute_type": gated["compute_type"],
                                    "device": gated["device"],
                                    **hypothesis,
                                },
                                indent=2,
                            )
                            + "\n",
                            encoding="utf-8",
                        )
                except (OSError, RuntimeError, TimeoutError, ValueError) as exc:
                    failure = f"clip {clip['id']} failed: {exc}"
                    break
            inference_seconds = time.perf_counter() - started
            if failure:
                payload = {
                    **base,
                    "run_id": run_id_for(
                        gated, index if measured else None, not measured
                    ),
                    "status": "FAILED",
                    "reason": failure,
                    "measured": False,
                    "repeat_index": index if measured else None,
                    "warmup": not measured,
                    "init_seconds": init_seconds,
                    "audio_seconds": audio_seconds,
                    "inference_seconds": inference_seconds,
                    "peak_rss_bytes": read_peak_rss_bytes(),
                }
            else:
                fields = measurement_fields(
                    audio_seconds, init_seconds, inference_seconds
                )
                fields["peak_rss_bytes"] = read_peak_rss_bytes()
                gpu = query_nvidia_smi()
                fields["peak_vram_bytes"] = (
                    gpu.get("memory_used_bytes") if gpu.get("available") else None
                )
                payload = {
                    **base,
                    "run_id": run_id_for(
                        gated, index if measured else None, not measured
                    ),
                    "status": "SUCCESS",
                    "reason": None,
                    "measured": measured,
                    "repeat_index": index if measured else None,
                    "warmup": not measured,
                    **fields,
                }
                if measured:
                    payload["cp1_observation"] = cp1_asr_observation(
                        audio_seconds, inference_seconds
                    )
            write_result(runs_dir, payload)
            written.append(payload)
    hardware = collect_hardware(commit_sha)
    (output_dir / "hardware.json").write_text(
        json.dumps(hardware, indent=2) + "\n",
        encoding="utf-8",
    )
    return written


def write_summary_csv(records: list[dict[str, object]], path: Path) -> None:
    fields = [
        "run_id",
        "status",
        "reason",
        "model",
        "device",
        "compute_type",
        "language",
        "measured",
        "audio_seconds",
        "init_seconds",
        "inference_seconds",
        "real_time_factor",
        "throughput",
        "peak_rss_bytes",
        "peak_vram_bytes",
        "commit_sha",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for record in records:
            writer.writerow(record)


def render_report(records: list[dict[str, object]], commit_sha: str) -> str:
    successes = [
        record
        for record in records
        if record.get("status") == "SUCCESS" and record.get("measured")
    ]
    lines = [
        "# US-105 ASR and VAD benchmark export",
        "",
        f"Benchmark commit: `{commit_sha}`",
        "",
        "Formal CP1 status: **NOT_VERIFIED**.",
        "The reference GPU has not been confirmed by the owner.",
        "The US-106 rendering CP1 result is a separate gate and is not changed here.",
        "",
    ]
    if not successes:
        lines.append(
            "Observed measurements: **PENDING**. This export has no successful measured run."
        )
        lines.append("")
        lines.append("Default ASR model: PENDING.")
        lines.append("CPU fallback model: PENDING.")
        lines.append("")
    else:
        lines.append("Observed measured runs:")
        lines.append("")
        lines.append(
            "| Model | Device | Compute | Language | Audio s | Inference s | RTF | Observed CP1 rate |"
        )
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for record in successes:
            observation = record.get("cp1_observation") or {}
            lines.append(
                "| {model} | {device} | {compute_type} | {language} | {audio_seconds} | "
                "{inference_seconds} | {real_time_factor} | {observed} |".format(
                    model=record.get("model"),
                    device=record.get("device"),
                    compute_type=record.get("compute_type"),
                    language=record.get("language"),
                    audio_seconds=record.get("audio_seconds"),
                    inference_seconds=record.get("inference_seconds"),
                    real_time_factor=record.get("real_time_factor"),
                    observed=observation.get("observed_pass"),
                )
            )
        lines.append("")
        lines.append("These observed flags are not a formal CP1 pass.")
        lines.append("Default ASR model: PENDING owner review of this export.")
        lines.append("CPU fallback model: PENDING owner review of this export.")
        lines.append("")
    problems = [record for record in records if record.get("status") != "SUCCESS"]
    lines.append(f"Non-success records: {len(problems)}.")
    return "\n".join(lines) + "\n"


def export_bundle(output_dir: Path, zip_path: Path, commit_sha: str) -> Path:
    runs_dir = output_dir / "runs"
    records: list[dict[str, object]] = []
    if runs_dir.is_dir():
        for path in sorted(runs_dir.glob("*.json")):
            records.append(json.loads(path.read_text(encoding="utf-8")))
    summary = output_dir / "summary.csv"
    write_summary_csv(records, summary)
    problems = [record for record in records if record.get("status") != "SUCCESS"]
    (output_dir / "errors.json").write_text(
        json.dumps(problems, indent=2) + "\n", encoding="utf-8"
    )
    report = render_report(records, commit_sha)
    (output_dir / "REPORT.md").write_text(report, encoding="utf-8")
    (output_dir / "commit_sha.txt").write_text(commit_sha + "\n", encoding="utf-8")
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(output_dir.rglob("*")):
            if path.is_file() and path != zip_path:
                archive.write(path, arcname=str(path.relative_to(output_dir)))
    return zip_path


def run_vad_benchmark(
    manifest_path: Path,
    dataset_root: Path,
    output_dir: Path,
    commit_sha: str,
    detect: Callable[[Path], list[dict[str, float]]] | None = None,
) -> list[dict[str, object]]:
    document = load_manifest(manifest_path)
    checked = validate_manifest(document, dataset_root, require_files=detect is None)
    if not checked["ok"]:
        raise ValueError("manifest is invalid: " + "; ".join(checked["errors"]))
    versions = _library_versions()
    vad_dir = output_dir / "vad"
    vad_dir.mkdir(parents=True, exist_ok=True)
    written: list[dict[str, object]] = []
    for clip in checked["clips"]:
        audio = dataset_root / str(clip["audio_path"])
        started = time.perf_counter()
        try:
            intervals = detect(audio) if detect is not None else detect_speech(audio)
            elapsed = time.perf_counter() - started
            (vad_dir / f"{clip['id']}.json").write_text(
                json.dumps({"clip_id": clip["id"], "intervals": intervals}, indent=2)
                + "\n",
                encoding="utf-8",
            )
            payload: dict[str, object] = {
                "run_id": f"vad-{clip['id']}",
                "commit_sha": commit_sha,
                "status": "SUCCESS",
                "reason": None,
                "model": "silero-vad",
                "device": "cpu",
                "compute_type": "default",
                "language": clip["language"],
                "measured": True,
                "repeat_index": 1,
                "warmup": False,
                "audio_seconds": clip["duration_seconds"],
                "init_seconds": None,
                "inference_seconds": elapsed,
                "real_time_factor": real_time_factor(
                    float(clip["duration_seconds"]), elapsed
                ),
                "throughput": throughput(float(clip["duration_seconds"]), elapsed),
                "peak_rss_bytes": read_peak_rss_bytes(),
                "peak_vram_bytes": None,
                "silero_vad_version": versions.get("silero_vad"),
            }
        except (ImportError, OSError, RuntimeError, ValueError) as exc:
            payload = {
                "run_id": f"vad-{clip['id']}",
                "commit_sha": commit_sha,
                "status": "FAILED",
                "reason": str(exc),
                "model": "silero-vad",
                "device": "cpu",
                "compute_type": "default",
                "language": clip["language"],
                "measured": False,
                "audio_seconds": clip["duration_seconds"],
                "silero_vad_version": versions.get("silero_vad"),
            }
        write_result(output_dir / "runs", payload)
        written.append(payload)
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the US-105 Faster-Whisper benchmark"
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--commit-sha", required=True)
    parser.add_argument("--include-cpu", action="store_true")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--clip-timeout-seconds", type=float, default=None)
    parser.add_argument("--budget-seconds", type=float, default=None)
    args = parser.parse_args(argv)
    run_benchmark(
        args.manifest,
        args.dataset_root,
        args.output,
        args.commit_sha,
        include_cpu=args.include_cpu,
        repeats=args.repeats,
        warmup=args.warmup,
        clip_timeout_seconds=args.clip_timeout_seconds,
        budget_seconds=args.budget_seconds,
    )
    run_vad_benchmark(args.manifest, args.dataset_root, args.output, args.commit_sha)
    export_bundle(args.output, args.output / "asr-benchmark.zip", args.commit_sha)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
