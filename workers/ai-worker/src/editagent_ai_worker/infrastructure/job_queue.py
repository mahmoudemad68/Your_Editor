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
from jsonschema import ValidationError

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
        job_id = str(job.id)
        renew_task = asyncio.create_task(self._renew(job_id, token))
        try:
            try:
                envelope = _envelope(job.data, int(getattr(job, "attemptsStarted", 0) or 0))
            except (ValidationError, QueueProtocolError):
                await self._settle_invalid(job, token, job_id)
                return {"result": "failed", "jobId": job_id, "status": "Failed"}
            if await self._lost(renew_task):
                return {"result": "lock-lost", "jobId": job_id}
            phase = await asyncio.to_thread(self._history.read_status, job_id)
            if phase in {"Completed", "Cancelled", "Failed"}:
                await self._ack_terminal(job, token, job_id, phase)
                return {"result": phase.lower(), "jobId": job_id, "status": phase}
            started, _attempt_number = await asyncio.to_thread(
                self._history.begin, job_id, envelope
            )
            if await self._lost(renew_task):
                return {"result": "lock-lost", "jobId": job_id}
            if started == "exhausted":
                if await self._owns(job_id, token):
                    await job.moveToFailed(UnrecoverableError("worker failed"), token, False)
                return {"result": "failed", "jobId": job_id, "status": "Failed"}
            return await self._run_guarded(job, token, job_id, envelope, renew_task)
        finally:
            if not renew_task.done():
                renew_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await renew_task
            _retrieve(renew_task)
            await self._stop_processes()

    async def _run_guarded(
        self,
        job: Any,
        token: str,
        job_id: str,
        envelope: dict[str, Any],
        renew_task: asyncio.Task[None],
    ) -> dict[str, Any]:
        execute_task = asyncio.create_task(self._execute(envelope))
        guard_task = asyncio.create_task(self._guard(job_id, int(envelope["timeoutMs"])))
        try:
            await asyncio.wait(
                {execute_task, renew_task, guard_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if await self._lost(renew_task):
                await self._halt(execute_task, guard_task)
                return {"result": "lock-lost", "jobId": job_id}
            if not execute_task.done():
                reason = guard_task.exception() if guard_task.done() else None
                await self._halt(execute_task, guard_task)
                if not await self._owns(job_id, token):
                    return {"result": "lock-lost", "jobId": job_id}
                if isinstance(reason, _CancelRequested):
                    await asyncio.to_thread(self._history.cancel, job_id)
                    await job.moveToCompleted("cancelled", token, False)
                    return {"result": "cancelled", "jobId": job_id, "status": "Cancelled"}
                attempt = int(envelope["attempt"])
                max_attempts = int(envelope["maxAttempts"])
                if attempt < max_attempts:
                    await asyncio.to_thread(self._history.retry, job_id, "timed out")
                    await job.moveToFailed(RuntimeError("timed out"), token, False)
                    return {"result": "retrying", "jobId": job_id, "status": "Retrying"}
                await asyncio.to_thread(self._history.fail, job_id, "timed out", envelope)
                await job.moveToFailed(UnrecoverableError("timed out"), token, False)
                return {"result": "failed", "jobId": job_id, "status": "Failed"}
            guard_task.cancel()
            outcome = execute_task.result()
            if not await self._owns(job_id, token):
                return {"result": "lock-lost", "jobId": job_id}
            if outcome == "complete":
                await asyncio.to_thread(self._history.complete, job_id)
                await job.moveToCompleted("completed", token, False)
                return {"result": "completed", "jobId": job_id, "status": "Completed"}
            if outcome[0] == "retry":
                await asyncio.to_thread(self._history.retry, job_id, outcome[1])
                await job.moveToFailed(RuntimeError(outcome[1]), token, False)
                return {"result": "retrying", "jobId": job_id, "status": "Retrying"}
            await asyncio.to_thread(self._history.fail, job_id, outcome[1], envelope)
            await job.moveToFailed(UnrecoverableError(outcome[1]), token, False)
            return {"result": "failed", "jobId": job_id, "status": "Failed"}
        finally:
            await self._halt(execute_task, guard_task)

    async def _guard(self, job_id: str, timeout_ms: int) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + (timeout_ms / 1000)
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise _TimedOut()
            await asyncio.sleep(min(0.05, remaining))
            if await self._cancel_requested(job_id):
                raise _CancelRequested()

    async def _cancel_requested(self, job_id: str) -> bool:
        raw = await self._worker.client.get(f"editagent:job-cancel:{job_id}")
        return bool(raw == "1")

    async def _owns(self, job_id: str, token: str) -> bool:
        try:
            extended = await self._worker.backend.extendLock(job_id, token, self._lock_ms)
        except Exception:
            return False
        return int(extended) == 1

    async def _lost(self, renew_task: asyncio.Task[None]) -> bool:
        if not _task_failed(renew_task):
            return False
        _retrieve(renew_task)
        return True

    async def _halt(self, *tasks: asyncio.Task[Any]) -> None:
        for task in tasks:
            if not task.done():
                task.cancel()
        await self._stop_processes()
        for task in tasks:
            if not task.done():
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            _retrieve(task)

    async def _ack_terminal(self, job: Any, token: str, job_id: str, phase: str) -> None:
        if not await self._owns(job_id, token):
            return
        if phase == "Failed":
            await job.moveToFailed(UnrecoverableError("already failed"), token, False)
            return
        await job.moveToCompleted(phase.lower(), token, False)

    async def _settle_invalid(self, job: Any, token: str, job_id: str) -> None:
        reason = "Job envelope does not match the shared JSON Schema."
        await asyncio.to_thread(
            self._history.fail,
            job_id,
            reason,
            {"schemaVersion": 1, "jobId": job_id, "invalid": True},
        )
        await job.moveToFailed(UnrecoverableError(reason), token, False)

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


class _CancelRequested(Exception):
    """The shared cancel key was set while this worker owned the job."""


class _TimedOut(Exception):
    """The envelope timeout elapsed before the handler finished."""


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
