"""Fault paths use the production handler/consumer and real owned scratch cleanup."""

import asyncio
import tempfile
from pathlib import Path
from typing import Any, NoReturn

import pytest

from editagent_ai_worker.infrastructure import job_queue


@pytest.mark.parametrize("attempt,expected", [(1, "retry"), (2, "permanent")])
def test_failed_spawn_cleans_workspace_and_sanitizes_outcome(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, attempt: int, expected: str
) -> None:
    monkeypatch.setattr(
        job_queue, "create_workspace", lambda: tempfile.TemporaryDirectory(dir=tmp_path)
    )

    async def reject_spawn(*_args: Any, **_kwargs: Any) -> NoReturn:
        raise OSError("sensitive internal adapter details")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", reject_spawn)
    consumer = object.__new__(job_queue.BullMqConsumer)
    consumer._handler = job_queue.run_analysis_handler
    consumer._processes = []
    outcome = asyncio.run(
        consumer._execute(
            {
                "jobType": "analysis.transcript.v1",
                "attempt": attempt,
                "maxAttempts": 2,
            }
        )
    )
    assert outcome == (expected, "Analysis resources are unavailable")
    assert list(tmp_path.iterdir()) == []
    assert consumer._processes == []


def test_cancelled_spawn_cleans_workspace_and_preserves_cancellation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(
        job_queue, "create_workspace", lambda: tempfile.TemporaryDirectory(dir=tmp_path)
    )

    async def cancelled_spawn(*_args: Any, **_kwargs: Any) -> NoReturn:
        raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "create_subprocess_exec", cancelled_spawn)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(job_queue.run_analysis_handler({"jobType": "analysis.transcript.v1"}, []))
    assert list(tmp_path.iterdir()) == []


def test_cancellation_during_real_child_creation_reaps_owned_process(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import contextlib
    import os
    import signal
    import sys

    monkeypatch.setattr(
        job_queue, "create_workspace", lambda: tempfile.TemporaryDirectory(dir=tmp_path)
    )
    original = asyncio.create_subprocess_exec

    async def scenario() -> None:
        created = asyncio.Event()
        release = asyncio.Event()
        children: list[asyncio.subprocess.Process] = []

        async def paused_creation(*_args: Any, **_kwargs: Any) -> asyncio.subprocess.Process:
            child = await original(
                sys.executable, "-c", "import time; time.sleep(60)", start_new_session=True
            )
            children.append(child)
            created.set()
            await release.wait()
            return child

        monkeypatch.setattr(asyncio, "create_subprocess_exec", paused_creation)
        request = asyncio.create_task(
            job_queue.run_analysis_handler({"jobType": "analysis.transcript.v1"}, [])
        )
        try:
            await asyncio.wait_for(created.wait(), timeout=5)
            request.cancel()
            await asyncio.sleep(0)  # cancellation delivery barrier, no timing delay
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert children[0].returncode is not None, "Cancelled creation leaked its real child"
            assert list(tmp_path.iterdir()) == []
        finally:
            release.set()
            if not request.done():
                request.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await request
            for child in children:
                if child.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(child.pid, signal.SIGKILL)
                    await child.wait()

    asyncio.run(scenario())
