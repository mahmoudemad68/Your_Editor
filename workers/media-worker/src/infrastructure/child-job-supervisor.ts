/**
 * Forks one child per reservation and does not resolve until that child has exited.
 * Cooperative abort is requested first. A child that ignores it is killed and reaped.
 */

import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
const REAP_MS = 1_000;

type ChildResult = { type: "completed" } | { type: "failed"; name: string; message: string };

export class ChildProcessJobSupervisor implements JobSupervisor {
  async run(envelope: JobEnvelope, handler: IsolatedHandler, signal: AbortSignal): Promise<void> {
    const child = fork(path.join(__dirname, "job-child.js"), [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
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
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const requestStop = () => {
      const reason = signal.reason instanceof Error ? signal.reason.message : "cancelled";
      if (child.connected) {
        child.send({ type: "abort", reason });
      }
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, GRACE_MS);
    };
    if (signal.aborted) {
      requestStop();
    } else {
      signal.addEventListener("abort", requestStop, { once: true });
    }
    const winner = await Promise.race([
      once(child, "message").then(() => "message" as const),
      exited.then(() => "exit" as const),
    ]);
    if (winner === "message" && killTimer) {
      clearTimeout(killTimer);
    }
    await reap(child, exited);
    if (killTimer) {
      clearTimeout(killTimer);
    }
    child.removeAllListeners();

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

async function reap(
  child: ChildProcess,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const first = await Promise.race([
    exited.then(() => "exited" as const),
    delay(REAP_MS).then(() => "stuck" as const),
  ]);
  if (first === "exited") {
    return;
  }
  child.kill("SIGKILL");
  const second = await Promise.race([
    exited.then(() => "exited" as const),
    delay(REAP_MS).then(() => "stuck" as const),
  ]);
  if (second === "stuck") {
    throw new JobExecutionUnconfirmedError();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
