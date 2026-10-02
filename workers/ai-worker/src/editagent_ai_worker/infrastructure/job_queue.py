"""Python BullMQ consumer.

This is the official BullMQ Python client, which speaks the same Redis
scripts as the Node adapter. It stays in infrastructure. Domain code does
not import it. The shared JSON Schema is still packages/schemas.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import sys
from typing import Any
from uuid import uuid4

import jsonschema
from bullmq import Worker  # type: ignore[import-untyped]
from bullmq.custom_errors import UnrecoverableError  # type: ignore[import-untyped]

from editagent_ai_worker.infrastructure.job_envelope import load_job_envelope_schema
from editagent_ai_worker.infrastructure.job_history import JobHistory


class QueueProtocolError(RuntimeError):
    """BullMQ rejected a reserve, acknowledgement, or lock renewal."""


async def _noop(_job: Any, _token: str) -> None:
    return None


class BullMqConsumer:
    def __init__(self, redis_url: str, database_url: str, queue_name: str, lock_ms: int) -> None:
        self._history = JobHistory(database_url)
        self._lock_ms = lock_ms
        self._processes: list[asyncio.subprocess.Process] = []
        self._worker = Worker(
            queue_name,
            _noop,
            {
                "connection": redis_url,
                "prefix": "bull",
                "autorun": False,
                "lockDuration": lock_ms,
                "lockRenewTime": max(50, lock_ms // 2),
                "stalledInterval": 200,
                "maxStalledCount": 5,
            },
        )

    async def close(self) -> None:
        await self._worker.close()

    async def probe(self) -> str | None:
        await self._sweep()
        token = uuid4().hex
        job = await self._worker.getNextJob(token)
        if job is None:
            return None
        await job.moveToFailed(UnrecoverableError("probe reserved a job"), token, False)
        raise QueueProtocolError(f"probe reserved {job.id}")

    async def consume_one(self) -> dict[str, Any]:
        await self._sweep()
        token = uuid4().hex
        job = await self._worker.getNextJob(token)
        if job is None:
            return {"result": "idle"}
        envelope = _envelope(job.data, int(getattr(job, "attemptsStarted", 0) or 0))
        started, _attempt_number = self._history.begin(str(job.id))
        if started == "exhausted":
            await job.moveToFailed(UnrecoverableError("worker failed"), token, False)
            return {"result": "failed", "jobId": str(job.id), "status": "Failed"}
        execute_task = asyncio.create_task(self._execute(envelope))
        renew_task = asyncio.create_task(self._renew(str(job.id), token))
        try:
            await asyncio.wait(
                {execute_task, renew_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            lock_lost = _task_failed(renew_task)
            if lock_lost or not execute_task.done():
                execute_task.cancel()
                await self._stop_processes()
                with contextlib.suppress(asyncio.CancelledError):
                    await execute_task
            if lock_lost:
                _retrieve(renew_task)
                return {"result": "lock-lost", "jobId": str(job.id)}
            outcome = execute_task.result()
            if not renew_task.done():
                renew_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await renew_task
            if _task_failed(renew_task):
                _retrieve(renew_task)
                return {"result": "lock-lost", "jobId": str(job.id)}
            owned = await self._worker.backend.extendLock(str(job.id), token, self._lock_ms)
            if int(owned) != 1:
                return {"result": "lock-lost", "jobId": str(job.id)}
            if outcome == "complete":
                await job.moveToCompleted("completed", token, False)
                self._history.complete(str(job.id))
                return {"result": "completed", "jobId": str(job.id), "status": "Completed"}
            if outcome[0] == "retry":
                await job.moveToFailed(RuntimeError(outcome[1]), token, False)
                self._history.retry(str(job.id), outcome[1])
                return {"result": "retrying", "jobId": str(job.id), "status": "Retrying"}
            await job.moveToFailed(UnrecoverableError(outcome[1]), token, False)
            self._history.fail(str(job.id), outcome[1], envelope)
            return {"result": "failed", "jobId": str(job.id), "status": "Failed"}
        finally:
            if not execute_task.done():
                execute_task.cancel()
            await self._stop_processes()
            if not execute_task.done():
                with contextlib.suppress(asyncio.CancelledError):
                    await execute_task
            if not renew_task.done():
                renew_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await renew_task
            _retrieve(renew_task)

    async def _sweep(self) -> None:
        await self._worker.backend.moveStalledJobsToWait(
            self._worker.opts.get("maxStalledCount"),
            self._worker.opts.get("stalledInterval"),
        )

    async def _renew(self, job_id: str, token: str) -> None:
        while True:
            await asyncio.sleep(max(0.05, self._lock_ms / 2000))
            extended = await self._worker.backend.extendLock(job_id, token, self._lock_ms)
            if int(extended) != 1:
                raise QueueProtocolError(f"lost lock for {job_id}")

    async def _execute(self, envelope: dict[str, Any]) -> str | tuple[str, str]:
        payload = envelope.get("payload")
        if not isinstance(payload, dict):
            return ("permanent", "job payload must be an object")
        mode = payload.get("mode", "ok")
        attempt = int(envelope.get("attempt", 1))
        max_attempts = int(envelope.get("maxAttempts", 1))
        if mode == "hold":
            await self._hold(payload)
            return "complete"
        if mode == "transient" and attempt < max_attempts:
            return ("retry", "blip")
        if mode == "transient":
            return "complete"
        if mode == "permanent":
            return ("permanent", "disk corrupt")
        if mode == "ok":
            return "complete"
        return ("permanent", f"unknown payload mode {mode}")

    async def _hold(self, payload: dict[str, Any]) -> None:
        delay_ms = int(payload.get("delayMs", 1000))
        marker = payload.get("markerPath")
        marker_path = marker if isinstance(marker, str) else ""
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            _HOLD_SCRIPT,
            str(delay_ms),
            marker_path,
            start_new_session=True,
        )
        self._processes.append(process)
        try:
            code = await process.wait()
        finally:
            if process in self._processes:
                self._processes.remove(process)
        if code != 0:
            raise asyncio.CancelledError

    async def _stop_processes(self) -> None:
        processes = list(self._processes)
        for process in processes:
            _kill_process_group(process.pid)
        for process in processes:
            with contextlib.suppress(ProcessLookupError):
                await process.wait()


def _envelope(data: Any, attempts_started: int) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise QueueProtocolError("BullMQ job data must be a JSON object")
    document = dict(data)
    stored_attempt = int(document.get("attempt", 1))
    document["attempt"] = attempts_started if attempts_started > 0 else stored_attempt
    jsonschema.validate(document, load_job_envelope_schema())
    return document


def _task_failed(task: asyncio.Task[Any]) -> bool:
    return task.done() and not task.cancelled() and task.exception() is not None


def _retrieve(task: asyncio.Task[Any]) -> None:
    if task.done() and not task.cancelled():
        task.exception()


def _kill_process_group(pid: int | None) -> None:
    if pid is None or pid <= 1:
        return
    try:
        group = os.getpgid(pid)
    except ProcessLookupError:
        return
    if group != pid or group <= 1 or group == os.getpgrp():
        return
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        return


_HOLD_SCRIPT = """
import ctypes
import signal
import sys
import time

try:
    ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL)
except Exception:
    pass
delay_ms = int(sys.argv[1])
marker = sys.argv[2]
time.sleep(delay_ms / 1000)
if marker:
    with open(marker, "a", encoding="utf-8") as handle:
        handle.write(f"done {delay_ms}\\n")
"""
