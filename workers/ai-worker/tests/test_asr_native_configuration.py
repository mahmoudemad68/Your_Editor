"""The native profile is established before import, never inferred from a CPU vendor."""

import json
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest

from editagent_ai_worker.infrastructure.config import (
    ASR_NATIVE_ENVIRONMENT,
    ASR_NATIVE_RESERVED_ENVIRONMENT,
    ConfigurationError,
    analysis_child_environment,
    configure_asr_native_environment,
    require_asr_native_environment,
)


def test_native_profile_bootstraps_a_fresh_process_before_native_import() -> None:
    program = """
import json,os,sys
from editagent_ai_worker.infrastructure.config import (
    ASR_NATIVE_ENVIRONMENT, ASR_NATIVE_RESERVED_ENVIRONMENT, configure_asr_native_environment
)
configure_asr_native_environment()
assert 'ctranslate2' not in sys.modules and 'faster_whisper' not in sys.modules
assert all(key not in os.environ for key in ASR_NATIVE_RESERVED_ENVIRONMENT)
print(json.dumps({key: os.environ[key] for key in ASR_NATIVE_ENVIRONMENT}))
"""
    result = subprocess.run(
        [sys.executable, "-c", program],
        env={
            **os.environ,
            **{key: "incorrect" for key in ASR_NATIVE_ENVIRONMENT},
            **{key: "untrusted" for key in ASR_NATIVE_RESERVED_ENVIRONMENT},
        },
        capture_output=True,
        text=True,
        check=True,
        timeout=20,
    )
    assert json.loads(result.stdout) == dict(ASR_NATIVE_ENVIRONMENT)


def test_child_profile_overrides_inherited_backend_without_mutating_parent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CT2_USE_MKL", "1")
    monkeypatch.setenv("CT2_FORCE_CPU_ISA", "AVX512")
    result = analysis_child_environment("/tmp/trusted-analysis-workspace")
    assert all(result[key] == value for key, value in ASR_NATIVE_ENVIRONMENT.items())
    assert all(key not in result for key in ASR_NATIVE_RESERVED_ENVIRONMENT)
    assert os.environ["CT2_USE_MKL"] == "1"
    assert os.environ["CT2_FORCE_CPU_ISA"] == "AVX512"


def test_late_conflicting_native_initialization_fails_without_changing_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace())
    monkeypatch.setenv("CT2_USE_MKL", "1")
    before = {key: os.environ.get(key) for key in ASR_NATIVE_ENVIRONMENT}
    with pytest.raises(ConfigurationError, match="not configured"):
        configure_asr_native_environment()
    assert {key: os.environ.get(key) for key in ASR_NATIVE_ENVIRONMENT} == before


def test_matching_environment_alone_cannot_attest_an_already_imported_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name, value in ASR_NATIVE_ENVIRONMENT.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace())
    with pytest.raises(ConfigurationError, match="already imported"):
        configure_asr_native_environment()


@pytest.mark.parametrize("key", list(ASR_NATIVE_ENVIRONMENT))
def test_each_native_profile_constraint_is_required(
    monkeypatch: pytest.MonkeyPatch, key: str
) -> None:
    for name, value in ASR_NATIVE_ENVIRONMENT.items():
        monkeypatch.setenv(name, value)
    require_asr_native_environment()
    monkeypatch.setenv(key, "incorrect")
    with pytest.raises(ConfigurationError, match="not configured"):
        require_asr_native_environment()


@pytest.mark.parametrize("key", ASR_NATIVE_RESERVED_ENVIRONMENT)
def test_dispatch_override_cannot_be_reported_as_the_admitted_profile(
    monkeypatch: pytest.MonkeyPatch, key: str
) -> None:
    for name, value in ASR_NATIVE_ENVIRONMENT.items():
        monkeypatch.setenv(name, value)
    for name in ASR_NATIVE_RESERVED_ENVIRONMENT:
        monkeypatch.delenv(name, raising=False)
    require_asr_native_environment()
    monkeypatch.setenv(key, "unsupported")
    with pytest.raises(ConfigurationError, match="unsupported dispatch"):
        require_asr_native_environment()


def test_unsupported_architecture_fails_before_native_initialization() -> None:
    program = """
import sys
from unittest.mock import patch
from editagent_ai_worker.infrastructure.config import (
    ConfigurationError, configure_asr_native_environment
)
try:
    with patch('platform.machine', return_value='aarch64'):
        configure_asr_native_environment()
except ConfigurationError:
    assert 'ctranslate2' not in sys.modules and 'faster_whisper' not in sys.modules
    sys.exit(0)
sys.exit(1)
"""
    result = subprocess.run(
        [sys.executable, "-c", program],
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("flags", ["", "flags : sse4_1", "flags : avx2", "flags : fma"])
def test_unverified_instruction_support_fails_before_native_import(flags: str) -> None:
    program = """
import io,sys
from pathlib import Path
from unittest.mock import patch
from editagent_ai_worker.infrastructure.config import (
    ConfigurationError, configure_asr_native_environment
)
with patch.object(Path,'open',return_value=io.StringIO(sys.stdin.read())):
    try:
        configure_asr_native_environment()
    except ConfigurationError:
        assert 'ctranslate2' not in sys.modules and 'faster_whisper' not in sys.modules
        sys.exit(0)
sys.exit(1)
"""
    result = subprocess.run(
        [sys.executable, "-c", program], input=flags, text=True, capture_output=True, timeout=20
    )
    assert result.returncode == 0, result.stderr


def test_unreadable_cpu_metadata_is_a_safe_startup_failure() -> None:
    program = """
import sys
from pathlib import Path
from unittest.mock import patch
from editagent_ai_worker.infrastructure.config import (
    ConfigurationError, configure_asr_native_environment
)
with patch.object(Path,'open',side_effect=OSError('private-host-detail')):
    try:
        configure_asr_native_environment()
    except ConfigurationError as error:
        assert str(error)=='ASR CPU instruction support cannot be verified.'
        assert 'ctranslate2' not in sys.modules and 'faster_whisper' not in sys.modules
        sys.exit(0)
sys.exit(1)
"""
    result = subprocess.run([sys.executable, "-c", program], capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr
