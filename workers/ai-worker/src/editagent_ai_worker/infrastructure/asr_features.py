"""Fixed-order log-Mel projection, independent of a process's BLAS worker pool.

Uses Faster-Whisper's STFT/filter definitions; the reduction order is explicit
instead of depending on the installed BLAS and its dynamic thread scheduling.
No model, media samples, probabilities or transcript values are rounded here.
"""

from typing import Any

import numpy as np
from faster_whisper.feature_extractor import FeatureExtractor  # type: ignore[import-untyped]

from editagent_ai_worker.infrastructure.config import ConfigurationError

NUMPY_CPU_PROFILE = "numpy-avx2-log-v2"


def numpy_cpu_kernels() -> dict[str, str]:
    """Attest the actual selected kernels, not just their environment declaration.

    NumPy's baseline float32 log10 delegates to system libm, which differs
    across supported Linux distributions. Use its pinned AVX2 float64 natural
    log and the change-of-base identity instead. A missing or different
    binding cannot describe the same numerical feature profile.
    """
    try:
        if np.__version__ != "2.4.6":
            raise ValueError("Unsupported NumPy runtime")
        selected = np.lib.introspect.opt_func_info(
            func_name="^(cos|absolute|log)$", signature="float32|float64|complex64"
        )
        kernels = {
            "cos_float64": selected["cos"]["dd"]["current"],
            "absolute_complex64": selected["absolute"]["Ff"]["current"],
            "log_float64": selected["log"]["dd"]["current"],
        }
        if kernels != {
            "cos_float64": "X86_V3",
            "absolute_complex64": "X86_V3",
            "log_float64": "X86_V3",
        }:
            raise ValueError("Different selected feature kernels")
        return kernels
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        raise ConfigurationError("ASR NumPy feature profile is invalid.") from exc


def log_mel_energies(mel: Any) -> Any:
    """Whisper's clipped base-ten logarithm with no system-libm float32 call.

    Keep intermediate precision through log(x) * log10(e), then convert once
    to the model's float32 features. This preserves the existing logarithm,
    floor and downstream normalization; no media or inference output is rounded.
    """
    positive = np.clip(mel, a_min=1e-10, a_max=None).astype(np.float64)
    return (np.log(positive) * np.float64("0.434294481903251827651128918916605082")).astype(
        np.float32
    )


class DeterministicFeatureExtractor(FeatureExtractor):  # type: ignore[misc]
    def __call__(self, waveform: Any, padding: int = 160, chunk_length: int | None = None) -> Any:
        if chunk_length is not None:
            self.n_samples = chunk_length * self.sampling_rate
            self.nb_max_frames = self.n_samples // self.hop_length
        waveform = np.asarray(waveform, dtype=np.float32)
        if padding:
            waveform = np.pad(waveform, (0, padding))
        window = np.hanning(self.n_fft + 1)[:-1].astype(np.float32)
        spectrum = self.stft(
            waveform, self.n_fft, self.hop_length, window=window, return_complex=True
        ).astype(np.complex64)
        magnitudes = np.abs(spectrum[..., :-1]) ** 2
        # Accumulate each Mel band in ascending frequency-bin order. Separate
        # float32 multiply/add ufuncs prevent a BLAS/einsum implementation from
        # selecting a different reduction tree or fused accumulation. Filters
        # are nonnegative and sparse, so omitting their exact-zero terms is
        # mathematically exact and keeps the work bounded and inexpensive.
        mel = np.empty((len(self.mel_filters), magnitudes.shape[-1]), dtype=np.float32)
        scratch = np.empty(magnitudes.shape[-1], dtype=np.float32)
        for index, weights in enumerate(self.mel_filters):
            accumulator = np.zeros(magnitudes.shape[-1], dtype=np.float32)
            for frequency in np.flatnonzero(weights):
                np.multiply(magnitudes[frequency], weights[frequency], out=scratch)
                np.add(accumulator, scratch, out=accumulator)
            mel[index] = accumulator
        log = log_mel_energies(mel)
        return (np.maximum(log, log.max() - 8.0) + 4.0) / 4.0
