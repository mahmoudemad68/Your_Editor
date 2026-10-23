"""Scratch cleanup fences live owners and PID reuse without trusting payload paths."""

import json
from pathlib import Path

from editagent_ai_worker.infrastructure.analysis_workspace import (
    create_workspace,
    recover_workspaces,
)


def test_live_workspace_not_reaped_and_reused_pid_identity_is_reaped() -> None:
    directory = create_workspace()
    path = Path(directory.name)
    try:
        recover_workspaces()
        assert path.is_dir()
        owner = json.loads((path / "owner.json").read_text())
        owner["identity"] = "different-boot-or-start"
        (path / "owner.json").write_text(json.dumps(owner))
        recover_workspaces()
        assert not path.exists()
    finally:
        directory.cleanup()
