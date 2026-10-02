/**
 * Handlers executed inside the supervised child process.
 * They cannot close over the parent test. Side effects go through payload paths.
 */

import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { type JobEnvelope } from "@editagent/domain";

import { PermanentJobError } from "../application/job-errors.js";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function markerPath(envelope: JobEnvelope): string {
  const value = envelope.payload.markerPath;
  return typeof value === "string" ? value : "";
}

function delayMs(envelope: JobEnvelope, fallback: number): number {
  const value = envelope.payload.delayMs;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function succeed(): Promise<void> {
  return undefined;
}

export async function failTransient(envelope: JobEnvelope): Promise<void> {
  if (envelope.attempt < 2) {
    throw new Error("blip");
  }
}

export async function failPermanent(): Promise<void> {
  throw new PermanentJobError("disk corrupt");
}

export async function failAlways(envelope: JobEnvelope): Promise<void> {
  const reason = envelope.payload.reason;
  throw new Error(typeof reason === "string" ? reason : "still broken");
}

export async function sleepBriefly(envelope: JobEnvelope, signal: AbortSignal): Promise<void> {
  await delay(delayMs(envelope, 300), signal);
}

/** Stops when the parent asks. Writes the marker only after the abort is observed. */
export async function cooperativeCancel(envelope: JobEnvelope, signal: AbortSignal): Promise<void> {
  const marker = markerPath(envelope);
  await new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("cooperative handler was not aborted"));
    }, 10_000);
    const onAbort = () => {
      clearTimeout(timer);
      const write = marker.length > 0 ? writeFile(marker, "stopped") : Promise.resolve();
      void write.then(
        () => reject(signal.reason),
        (error: unknown) => reject(error),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Ignores cancellation. The marker is written only if this process is still
 * alive when the delay ends.
 */
export async function nonCooperativeSideEffect(
  envelope: JobEnvelope,
  _signal: AbortSignal,
): Promise<void> {
  const marker = markerPath(envelope);
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs(envelope, 2_500));
  });
  if (marker.length > 0) {
    await writeFile(marker, `${Date.now()}\n`);
  }
}

/** Writes as soon as the handler starts. A cancel check that fails must not reach this. */
export async function touchMarker(envelope: JobEnvelope): Promise<void> {
  const marker = markerPath(envelope);
  if (marker.length > 0) {
    await writeFile(marker, "ran\n");
  }
}

/**
 * Spawns a non-detached descendant that writes the marker later.
 * The descendant stays in this process group so the supervisor can reap it.
 */
export async function spawnDescendant(envelope: JobEnvelope, _signal: AbortSignal): Promise<void> {
  const marker = markerPath(envelope);
  const pidPath = typeof envelope.payload.pidPath === "string" ? envelope.payload.pidPath : "";
  const wait = delayMs(envelope, 2_500);
  const child = spawn(
    process.execPath,
    [
      "-e",
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late\\n'), Number(process.argv[2]))",
      marker,
      String(wait),
    ],
    { stdio: "ignore" },
  );
  if (pidPath.length > 0 && child.pid != null) {
    await writeFile(pidPath, String(child.pid));
  }
  await new Promise(() => undefined);
}

/** Records one execution span. A second worker appending start before end means overlap. */
export async function recordSpan(envelope: JobEnvelope, signal: AbortSignal): Promise<void> {
  const marker = markerPath(envelope);
  await appendFile(marker, `start ${process.pid} ${Date.now()}\n`);
  await delay(delayMs(envelope, 1_500), signal);
  await appendFile(marker, `end ${process.pid} ${Date.now()}\n`);
}
