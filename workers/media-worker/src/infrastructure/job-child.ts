/**
 * Supervised job process. The parent reaps this process on cancel and timeout.
 * Handlers are loaded from a module path so they do not run in the coordinator.
 */

import { createRequire } from "node:module";
import { type JobEnvelope } from "@editagent/domain";

import { JobCancelledError, JobTimeoutError, LockLostError } from "../application/job-errors.js";

const loadHandler = createRequire(__filename);
const controller = new AbortController();

type StartMessage = {
  type: "start";
  envelope: JobEnvelope;
  modulePath: string;
  exportName: string;
};

type AbortMessage = {
  type: "abort";
  reason: string;
};

type Handler = (envelope: JobEnvelope, signal: AbortSignal) => Promise<void>;

function send(
  message: { type: "completed" } | { type: "failed"; name: string; message: string },
): void {
  if (!process.send) {
    return;
  }
  process.send(message, () => {
    process.exit(0);
  });
}

function abortFrom(reason: string): void {
  if (reason === "timed out") {
    controller.abort(new JobTimeoutError());
    return;
  }
  if (reason === "lock lost") {
    controller.abort(new LockLostError());
    return;
  }
  controller.abort(new JobCancelledError());
}

async function execute(message: StartMessage): Promise<void> {
  try {
    const imported = loadHandler(message.modulePath) as Record<string, Handler>;
    const handler = imported[message.exportName];
    if (typeof handler !== "function") {
      throw new Error(`Handler ${message.exportName} is missing.`);
    }
    await handler(message.envelope, controller.signal);
    send({ type: "completed" });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const text = error instanceof Error ? error.message : "job failed";
    send({ type: "failed", name, message: text });
  }
}

process.on("message", (raw: unknown) => {
  if (raw == null || typeof raw !== "object" || !("type" in raw)) {
    return;
  }
  const message = raw as StartMessage | AbortMessage;
  if (message.type === "abort") {
    abortFrom(message.reason);
    return;
  }
  if (message.type === "start") {
    void execute(message);
  }
});
