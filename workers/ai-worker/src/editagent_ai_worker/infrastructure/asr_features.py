"""Fixed-order log-Mel projection, independent of a process's BLAS worker pool.

Uses Faster-Whisper's STFT/filter definitions; the reduction order is explicit
instead of depending on the installed BLAS and its dynamic thread scheduling.
No model, media samples, probabilities or transcript values are rounded here.
"""

from typing import Any

import numpy as np
from faster_whisper.feature_extractor import FeatureExtractor  # type: ignore[import-untyped]


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
        log = np.log10(np.clip(mel, a_min=1e-10, a_max=None))
        return (np.maximum(log, log.max() - 8.0) + 4.0) / 4.0
