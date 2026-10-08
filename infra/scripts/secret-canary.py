"""Prove the actual configured Gitleaks Git-history gate rejects a fake secret."""

import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    # Generated only in an isolated temporary Git history; no real credential.
    canary = "ghp_" + "SyntheticCanary0123456789" * 2
    (directory / "canary.txt").write_text("github_token=" + canary + "\n")
    for args in (
        ["init", "-q"],
        ["add", "."],
        [
            "-c",
            "user.name=Secret gate test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-qm",
            "synthetic canary",
        ],
    ):
        subprocess.run(["git", *args], cwd=directory, check=True, capture_output=True)
    result = subprocess.run(
        [
            "gitleaks",
            "detect",
            "--source",
            str(directory),
            "--config",
            str(ROOT / ".gitleaks.toml"),
            "--redact",
            "--exit-code",
            "1",
        ],
        capture_output=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 1 or b"leaks found" not in result.stderr.lower():
        raise SystemExit("Synthetic secret gate was not proven")
    print("SECRET_CANARY_DETECTED YES")
    print("SECRET_CANARY_GATE_EXIT_CODE", result.returncode)
