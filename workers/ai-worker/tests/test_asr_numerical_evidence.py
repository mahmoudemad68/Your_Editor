"""Actual synthetic arithmetic evidence; no model inference or speech gold."""

import importlib.util
import json
from pathlib import Path

import pytest


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
        "cpu",
        "packages",
        "ctranslate2ExtensionSha256",
        "vadGraphSha256",
        "numpyKernels",
        "synthetic",
    }
    assert len(json.dumps(first)) < 2000


def test_cpu_taxonomy_excludes_unbounded_and_private_cpuinfo_fields() -> None:
    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location(
        "asr_cpu_qualification", root / "tools/asr/qualification.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sample = (
        "processor : 0\nvendor_id : GenuineIntel\ncpu family : 6\nmodel : 85\n"
        "stepping : 7\nmodel name : private-sentinel\nserial : private-sentinel\n"
    )
    expected = {"vendor": "GenuineIntel", "family": 6, "model": 85, "stepping": 7, "uniform": True}
    assert module.cpu_dispatch_evidence(sample) == expected
    assert module.cpu_dispatch_evidence(sample + "\n" + sample.replace("0", "1")) == expected
    assert module.cpu_dispatch_evidence(sample.replace("GenuineIntel", "private-sentinel")) == {
        **expected,
        "vendor": "other",
    }
    assert (
        module.cpu_dispatch_evidence(sample + "\n" + sample.replace("85", "86"))["uniform"] is False
    )


@pytest.mark.parametrize("value", ["-1", "4096", "not-a-number"])
def test_cpu_taxonomy_rejects_unverifiable_numeric_values(value: str) -> None:
    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location(
        "asr_invalid_cpu_qualification", root / "tools/asr/qualification.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with pytest.raises(ValueError):
        module.cpu_dispatch_evidence(
            "processor : 0\nvendor_id : GenuineIntel\ncpu family : 6\n"
            f"model : {value}\nstepping : 7"
        )
