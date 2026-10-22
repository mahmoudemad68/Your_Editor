"""Actual synthetic arithmetic evidence; no model inference or speech gold."""

import importlib.util
import json
from pathlib import Path


def test_synthetic_numerical_evidence_has_repeatable_bounded_stage_hashes() -> None:
    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location(
        "asr_qualification", root / "tools/asr/qualification.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    first = module.numerical_runtime_evidence()
    assert first == module.numerical_runtime_evidence()
    assert first["probe"] == "integer-ramp-pcm16-16000-v1"
    assert set(first["synthetic"]) == {
        "pcmFloat32Sha256",
        "melFiltersFloat32Sha256",
        "hannFloat32Sha256",
        "stftComplex64Sha256",
        "logMelFloat32Sha256",
    }
    assert len(set(first["synthetic"].values())) == 5
    assert all(len(value) == 64 for value in first["synthetic"].values())
    # The payload is intentionally incapable of carrying words, source media,
    # environment values or filesystem operands into a public report.
    assert set(first) == {
        "schemaVersion",
        "probe",
        "python",
        "libc",
        "machine",
        "packages",
        "ctranslate2ExtensionSha256",
        "vadGraphSha256",
        "numpyKernels",
        "synthetic",
    }
    assert len(json.dumps(first)) < 2000
