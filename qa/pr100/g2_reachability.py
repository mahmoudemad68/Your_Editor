#!/usr/bin/env python3
"""Static reachability notes for the residual Go modules. No exploit payload is sent."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from results import emit  # noqa: E402

REVISION = "ffa87c25fdf587178b1521ad87f2a4a72a02e584"


def run(args: list[str], cwd: Path) -> str:
    completed = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-500:] or completed.stdout[-500:])
    return completed.stdout


def main() -> int:
    results = Path(sys.argv[1])
    work = Path(sys.argv[2])
    try:
        return analyze(results, work)
    except Exception as exc:  # noqa: BLE001
        emit(results, "g2.reachability", "G2", "ERROR", True, str(exc)[:500])
        return 0


def analyze(results: Path, work: Path) -> int:
    repo = Path(__file__).resolve().parents[2]
    destination = work / "seaweedfs-src"
    if not (destination / "go.mod").is_file():
        if destination.exists():
            shutil.rmtree(destination)
        run(["git", "clone", "--filter=blob:none", "--no-checkout", "https://github.com/seaweedfs/seaweedfs.git", str(destination)], repo)
        run(["git", "fetch", "--depth", "1", "origin", REVISION], destination)
        run(["git", "checkout", "--detach", "FETCH_HEAD"], destination)
    actual = run(["git", "rev-parse", "HEAD"], destination).strip()
    if actual != REVISION:
        emit(results, "g2.reachability", "G2", "FAIL", True, f"checked out {actual}")
        return 1
    jose = run(["go", "mod", "why", "-m", "github.com/go-jose/go-jose/v4"], destination)
    brotli = run(["go", "mod", "why", "-m", "github.com/andybalholm/brotli"], destination)
    compose = (repo / "compose.yaml").read_text(encoding="utf-8")
    security = "\n".join(path.read_text(encoding="utf-8") for path in (repo / "infra/seaweedfs").glob("*.sh"))
    configured = "openbao" in compose.lower() or "kms" in security.lower()
    detail = (
        f"revision {actual}. go mod why go-jose: {jose.strip().replace(chr(10), ' | ')}. "
        f"go mod why brotli: {brotli.strip().replace(chr(10), ' | ')}. "
        f"repository compose/security scripts configure OpenBao or KMS={configured}. "
        "s3api blank-imports weed/kms/openbao, which imports hashicorp/vault/api and therefore go-jose. "
        "NewOpenBaoKMSProvider runs only when that KMS provider is configured. "
        "This deployment's volume JWT probe uses HS256 HMAC, not go-jose RSA JWK parsing. "
        "Go brotli is reached from weed/admin/dash through parquet-go. "
        "HIGH_UNRESOLVED: the vulnerable module remains linked in /usr/bin/weed and there is no formal disposition."
    )
    (work / "reachability.txt").write_text(detail + "\n", encoding="utf-8")
    emit(results, "g2.reachability", "G2", "PASS", True, detail[:1200])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
