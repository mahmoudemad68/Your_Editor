"""CPU ONNX Silero adapter. One bounded window in memory; state is per detection."""

from __future__ import annotations

import hashlib
import importlib.metadata
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

import numpy as np
import onnxruntime as ort  # type: ignore[import-untyped]

from editagent_ai_worker.domain.analysis.segmentation import WindowProbability, speech_regions
from editagent_ai_worker.domain.analysis.voice_activity import (
    WINDOW_SAMPLES,
    AudioIdentity,
    Cancellation,
    InferenceProvenance,
    InvalidAudio,
    SpeechAnalysis,
    VadCancelled,
    VadConfiguration,
    VadModelError,
    VadTimeout,
    integer,
)
from editagent_ai_worker.infrastructure.vad_model import (
    MODEL_NAME,
    MODEL_SHA256,
    MODEL_VERSION,
    verify_model,
)

ADAPTER_VERSION = "silero-onnx-stream-v1"


class SileroVadAdapter:
    def __init__(self, model_path: Path, timeout_ms: int) -> None:
        integer(timeout_ms, 1, 600_000)
        verify_model(model_path)
        self._timeout_ms = timeout_ms
        self._lock = threading.Lock()  # At most one model invocation per adapter at a time.
        options = ort.SessionOptions()
        options.inter_op_num_threads = options.intra_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_cpu_mem_arena = False
        options.log_severity_level = 4
        try:
            self._session = ort.InferenceSession(
                str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
            )
            if [i.name for i in self._session.get_inputs()] != ["input", "h", "c"]:
                raise VadModelError("Unsupported Silero model interface")
        except Exception as exc:
            raise VadModelError("Silero model could not be initialized") from exc

    def detect(
        self,
        pcm: BinaryIO,
        source: AudioIdentity,
        configuration: VadConfiguration,
        cancellation: Cancellation | None = None,
    ) -> SpeechAnalysis:
        deadline = time.monotonic() + self._timeout_ms / 1000

        def check() -> None:
            if cancellation is not None and cancellation.is_set():
                raise VadCancelled("Voice-activity detection cancelled")
            if time.monotonic() >= deadline:
                raise VadTimeout("Voice-activity detection timed out")

        while not self._lock.acquire(timeout=min(0.05, self._timeout_ms / 1000)):
            check()
        try:
            check()
            return self._detect(pcm, source, configuration, check)
        finally:
            self._lock.release()

    def _detect(
        self,
        pcm: BinaryIO,
        source: AudioIdentity,
        configuration: VadConfiguration,
        check: Callable[[], None],
    ) -> SpeechAnalysis:
        h = np.zeros((1, 1, 128), dtype=np.float32)
        c = np.zeros((1, 1, 128), dtype=np.float32)
        context = np.zeros((1, 64), dtype=np.float32)
        digest = hashlib.sha256()
        frames: list[WindowProbability] = []
        total = source.sample_count
        for start in range(0, total, WINDOW_SAMPLES):
            check()
            samples = min(WINDOW_SAMPLES, total - start)
            raw = pcm.read(samples * 2)
            if len(raw) != samples * 2:
                raise InvalidAudio("Normalized PCM duration differs from declared scope")
            digest.update(raw)
            audio = np.zeros((1, WINDOW_SAMPLES), dtype=np.float32)
            audio[0, :samples] = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
            batch = np.concatenate((context, audio), axis=1)
            try:
                result, h, c = self._session.run(None, {"input": batch, "h": h, "c": c})
                value = float(result[0])
                frame = WindowProbability(start, start + samples, value)
            except Exception as exc:
                raise VadModelError("Silero inference returned an invalid result") from exc
            frames.append(frame)
            context = audio[:, -64:].copy()
        if pcm.read(1):
            raise InvalidAudio("Normalized PCM exceeds declared scope")
        check()
        regions = speech_regions(frames, source, configuration)
        check()
        provenance = InferenceProvenance(
            ADAPTER_VERSION,
            MODEL_NAME,
            MODEL_VERSION,
            MODEL_SHA256,
            "onnxruntime",
            importlib.metadata.version("onnxruntime"),
            importlib.metadata.version("numpy"),
            digest.hexdigest(),
            configuration,
        )
        return SpeechAnalysis(source, regions, provenance)
