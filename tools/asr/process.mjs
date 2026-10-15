/** Bounded fixed worker entrypoints; timeout kills the owned group and awaits reap. */
import { setTimeout, clearTimeout } from "node:timers";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
const project = path.resolve(import.meta.dirname, "../../workers/ai-worker");
export function runWorkerPython(
  module,
  args = [],
  { input, timeoutMs = 600000, maxBytes = 16000000, env = process.env } = {},
) {
  if (!["transcribe", "score_words"].includes(module))
    throw new Error("Unsupported ASR evaluation entrypoint");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "uv",
      [
        "run",
        "--frozen",
        "--project",
        project,
        "python",
        "-m",
        "editagent_ai_worker.composition." + module,
        ...args,
      ],
      { env, detached: true, stdio: ["pipe", "pipe", "inherit"] },
    );
    let size = 0;
    const chunks = [];
    let failure;
    const stop = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") failure = new Error("ASR subprocess cleanup is unconfirmed");
        }
    };
    const timer = setTimeout(() => {
      failure = new Error("ASR evaluation deadline expired");
      stop();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        failure = new Error("ASR output bound exceeded");
        stop();
      } else chunks.push(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("ASR subprocess could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure ?? new Error("ASR subprocess failed"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
