"""Mathematical feature regression on synthetic energies, never evaluation gold."""

from decimal import Decimal, localcontext

import numpy as np
import pytest

from editagent_ai_worker.infrastructure.asr_features import (
    DeterministicFeatureExtractor,
    log_mel_energies,
)


def test_log_mel_matches_independent_high_precision_base_ten_oracle() -> None:
    # Exact float32 bit patterns cover the full positive finite exponent range,
    # including energies below the unchanged floor and both neighbors of 1.0.
    bits = np.linspace(1, 0x7F7FFFFF, 1024, dtype=np.uint32)
    values = np.concatenate((bits.view(np.float32), np.array([0, 1e-10, 1, 10], dtype=np.float32)))
    floor = np.float32(1e-10)
    with localcontext() as context:
        context.prec = 80
        expected = np.array(
            [float(Decimal.from_float(float(max(value, floor))).log10()) for value in values],
            dtype=np.float32,
        )
    actual = log_mel_energies(values)
    assert actual.dtype == np.float32
    # Actual feature values, with no tolerance, digest or timestamp rounding.
    np.testing.assert_array_equal(actual, expected, strict=True)


def test_features_do_not_call_system_dependent_log10f(monkeypatch: pytest.MonkeyPatch) -> None:
    def rejected(*args: object, **kwargs: object) -> None:
        raise AssertionError("System log10 must not participate in feature extraction")

    monkeypatch.setattr(np, "log10", rejected)
    pcm = ((np.arange(1600) % 257).astype(np.float32) - 128) / 32768
    features = DeterministicFeatureExtractor()(pcm)
    assert features.dtype == np.float32
    assert features.shape == (80, 11)
    assert np.isfinite(features).all()


def test_log_mel_floor_and_downstream_normalization_are_preserved() -> None:
    values = np.array([0, 1e-20, 1e-10, 1e-5, 1, 10, 100], dtype=np.float32)
    log = log_mel_energies(values)
    np.testing.assert_array_equal(log, np.array([-10, -10, -10, -5, 0, 1, 2], np.float32))
    normalized = (np.maximum(log, log.max() - 8.0) + 4.0) / 4.0
    np.testing.assert_array_equal(
        normalized, np.array([-0.5, -0.5, -0.5, -0.25, 1, 1.25, 1.5], np.float32)
    )
