/**
 * Forks one child per reservation in its own Linux process group.
 * Cooperative abort is requested first. SIGTERM and SIGKILL then go to that
 * group, so a descendant cannot outlive the child and write after Cancelled.
 */

import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type JobEnvelope } from "@editagent/domain";

import {
  JobCancelledError,
  JobExecutionUnconfirmedError,
  JobTimeoutError,
  LockLostError,
  PermanentJobError,
} from "../application/job-errors.js";
import { type IsolatedHandler, type JobSupervisor } from "../application/job-supervisor.js";

const GRACE_MS = 400;
const TERM_MS = 200;
const REAP_MS = 1_000;

type ChildResult = { type: "completed" } | { type: "failed"; name: string; message: string };

export class ChildProcessJobSupervisor implements JobSupervisor {
  async run(envelope: JobEnvelope, handler: IsolatedHandler, signal: AbortSignal): Promise<void> {
    const child = fork(path.join(__dirname, "job-child.js"), [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      detached: true,
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    const pgid = await dedicatedGroup(child);
    if (pgid == null) {
      child.kill("SIGKILL");
      throw new JobExecutionUnconfirmedError();
    }
    const exited = once(child, "exit").then(([code, signalName]) => ({
      code: code as number | null,
      signal: signalName as NodeJS.Signals | null,
    }));
    let message: ChildResult | undefined;
    child.on("message", (value: unknown) => {
      message = value as ChildResult;
    });
    child.send({
      type: "start",
      envelope,
      modulePath: handler.modulePath,
      exportName: handler.exportName,
    });
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const requestStop = () => {
      const reason = signal.reason instanceof Error ? signal.reason.message : "cancelled";
      if (child.connected) {
        child.send({ type: "abort", reason });
      }
      termTimer = setTimeout(() => {
        signalGroup(pgid, "SIGTERM");
        killTimer = setTimeout(() => {
          signalGroup(pgid, "SIGKILL");
        }, TERM_MS);
      }, GRACE_MS);
    };
    if (signal.aborted) {
      requestStop();
    } else {
      signal.addEventListener("abort", requestStop, { once: true });
    }
    try {
      await Promise.race([once(child, "message"), exited]);
      if (termTimer) {
        clearTimeout(termTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (signal.aborted) {
        signalGroup(pgid, "SIGKILL");
      }
      await ensureGroupGone(pgid, exited);
    } finally {
      if (termTimer) {
        clearTimeout(termTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      child.removeAllListeners();
    }

    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new JobCancelledError();
    }
    if (message?.type === "completed") {
      return;
    }
    if (message?.type === "failed") {
      if (message.name === "PermanentJobError") {
        throw new PermanentJobError(message.message);
      }
      if (message.name === "JobCancelledError") {
        throw new JobCancelledError();
      }
      if (message.name === "LockLostError") {
        throw new LockLostError();
      }
      if (message.name === "JobTimeoutError") {
        throw new JobTimeoutError();
      }
      throw new Error(message.message);
    }
    const detail = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(detail.length > 0 ? detail : "job process exited before reporting a result");
  }
}

async function dedicatedGroup(child: ChildProcess): Promise<number | null> {
  const pid = child.pid;
  if (pid == null || pid <= 1) {
    return null;
  }
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    const group = processGroupId(pid);
    const own = processGroupId(process.pid);
    if (group === pid && group !== own && group > 1) {
      return group;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return null;
    }
    await delay(10);
  }
  return null;
}

async function ensureGroupGone(
  pgid: number,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  await Promise.race([exited.then(() => undefined), delay(REAP_MS)]);
  if (!(await groupGone(pgid))) {
    signalGroup(pgid, "SIGKILL");
  }
  if (!(await groupGone(pgid))) {
    throw new JobExecutionUnconfirmedError();
  }
}

async function groupGone(pgid: number): Promise<boolean> {
  const deadline = Date.now() + REAP_MS;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) {
      return true;
    }
    await delay(20);
  }
  return !groupAlive(pgid);
}

function processGroupId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) {
      return null;
    }
    const fields = stat.slice(end + 2).split(" ");
    const group = Number(fields[2]);
    return Number.isInteger(group) ? group : null;
  } catch {
    return null;
  }
}

function groupAlive(pgid: number): boolean {
  if (pgid <= 1) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  const own = processGroupId(process.pid);
  if (pgid <= 1 || pgid === own || pgid === process.pid) {
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
