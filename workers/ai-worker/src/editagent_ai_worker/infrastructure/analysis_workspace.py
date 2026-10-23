"""Owned crash-recoverable scratch space; PID reuse cannot authorize deletion."""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
from pathlib import Path

PREFIX = "editagent-analysis-owned-"


def process_identity(pid: int) -> str | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip() + ":" + fields[19]
    except (OSError, ValueError, IndexError):
        return None


def recover_workspaces() -> None:
    root = Path(tempfile.gettempdir())
    for directory in root.glob(PREFIX + "*"):
        try:
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
                continue
            marker = directory / "owner.json"
            if marker.is_symlink() or marker.stat().st_size > 512:
                continue
            owner = json.loads(marker.read_text())
            if set(owner) != {"pid", "identity"} or type(owner["pid"]) is not int:
                continue
            if (
                owner["identity"] is not None
                and process_identity(owner["pid"]) != owner["identity"]
            ):
                shutil.rmtree(directory)
        except (OSError, ValueError, TypeError):
            continue


def create_workspace() -> tempfile.TemporaryDirectory[str]:
    recover_workspaces()
    directory = tempfile.TemporaryDirectory(prefix=PREFIX)
    marker = Path(directory.name) / "owner.json"
    marker.write_text(json.dumps({"pid": os.getpid(), "identity": process_identity(os.getpid())}))
    marker.chmod(0o600)
    return directory
