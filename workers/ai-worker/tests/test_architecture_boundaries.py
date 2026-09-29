import os
import subprocess
from pathlib import Path

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "tests"
    / "architecture"
    / "fixtures"
    / "python-domain-imports-infrastructure"
)


def test_invalid_domain_import_is_rejected() -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(FIXTURE / "src")
    result = subprocess.run(
        ["lint-imports", "--config", str(FIXTURE / ".importlinter")],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    combined = f"{result.stdout}\n{result.stderr}"
    assert result.returncode != 0, combined
    assert "Domain does not import infrastructure" in combined
