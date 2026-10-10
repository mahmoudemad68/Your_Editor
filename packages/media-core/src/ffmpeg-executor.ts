import { spawn } from "node:child_process";
import { hasUnsafeControl, localMediaPath, validateFilterGraph } from "./ffmpeg-builder.js";

export type FfmpegFailure =
  "timeout" | "cancelled" | "output_limit" | "unavailable" | "exit" | "consumer" | "busy";
export class FfmpegError extends Error {
  constructor(
    readonly code: FfmpegFailure,
    readonly exitCode: number | null = null,
    readonly exitSignal: NodeJS.Signals | null = null,
  ) {
    super(`FFmpeg execution failed (${code}).`);
    this.name = "FfmpegError";
  }
}
export interface FfmpegProgress {
  readonly frame: number;
  readonly outTimeUs: bigint;
  readonly finished: boolean;
}
export function parseFfmpegProgress(block: string): FfmpegProgress {
  const fields = Object.fromEntries(
    block
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );
  const frame = fields["frame"] ?? "0",
    time = fields["out_time_us"] ?? "0";
  if (!/^\d{1,15}$/.test(frame) || !/^\d{1,19}$/.test(time) || BigInt(time) > 9223372036854775807n)
    throw new Error("Malformed progress.");
  return { frame: Number(frame), outTimeUs: BigInt(time), finished: fields["progress"] === "end" };
}
export interface FfmpegExecutionOptions {
  readonly executable?: string;
  readonly processGroup?: "owned" | "supervised";
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxCaptureBytes?: number;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly maxStdoutBytes?: number;
  readonly onProgress?: (progress: FfmpegProgress) => void;
  readonly onProcess?: (pid: number) => void;
  /** Infrastructure-only native US-127 broker, retaining its kernel protections. */
  readonly sandbox?: {
    readonly executable: string;
    readonly prefix: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  };
}
/** Bounded fail-fast executor. Each instance admits at most its configured process count. */
export class FfmpegExecutor {
  private active = 0;
  constructor(readonly concurrency = 1) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4)
      throw new Error("Invalid FFmpeg concurrency.");
  }
  async execute(
    args: readonly string[],
    options: FfmpegExecutionOptions,
  ): Promise<{ readonly stdout: Buffer; readonly stderr: string }> {
    if (this.active >= this.concurrency) throw new FfmpegError("busy");
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 1800000
    )
      throw new Error("Invalid FFmpeg timeout.");
    const limit = options.maxCaptureBytes ?? 1048576;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16777216)
      throw new Error("Invalid output bound.");
    const streamLimit = options.maxStdoutBytes ?? limit;
    if (!Number.isSafeInteger(streamLimit) || streamLimit < 1 || streamLimit > 2147483648)
      throw new Error("Invalid streaming bound.");
    if (args.length > 256 || args.some((arg) => typeof arg !== "string" || hasUnsafeControl(arg)))
      throw new Error("Invalid FFmpeg arguments.");
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-protocol_whitelist" && args[i + 1] !== "file")
        throw new Error("Only local input protocols are permitted.");
      if (args[i] === "-i") {
        localMediaPath(args[i + 1] ?? "");
        if (!args.includes("-protocol_whitelist"))
          throw new Error("Input protocol policy is required.");
      }
      if (args[i] === "-af" || args[i] === "-vf" || args[i] === "-filter_complex")
        validateFilterGraph(args[i + 1] ?? "");
    }
    if (args.includes("-i") && !["-", "pipe:1"].includes(args.at(-1) ?? ""))
      localMediaPath(args.at(-1) ?? "");
    if (options.signal?.aborted) throw new FfmpegError("cancelled");
    this.active++;
    try {
      return await this.run(args, options, limit, streamLimit);
    } finally {
      this.active--;
    }
  }
  private run(
    args: readonly string[],
    options: FfmpegExecutionOptions,
    limit: number,
    streamLimit: number,
  ): Promise<{ stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      const exe = options.executable ?? "ffmpeg";
      const child = spawn(
        options.sandbox?.executable ?? exe,
        options.sandbox ? [...options.sandbox.prefix, exe, "--", exe, ...args] : args,
        {
          shell: false,
          detached: process.platform !== "win32" && options.processGroup !== "supervised",
          stdio: ["ignore", "pipe", "pipe", ...(options.onProgress ? ["pipe" as const] : [])],
          env: options.sandbox?.env ?? {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            LANG: "C",
            LC_ALL: "C",
          },
        },
      );
      let failure: FfmpegFailure | undefined,
        out = 0,
        err = 0,
        progressBytes = 0,
        pending = "";
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === "win32" || options.processGroup === "supervised")
            child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") failure ??= "exit";
        }
      };
      const stop = (reason: FfmpegFailure) => {
        if (failure !== undefined) return;
        failure = reason;
        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), 150);
      };
      const abort = () =>
        stop(
          options.signal?.reason instanceof Error && options.signal.reason.name === "TimeoutError"
            ? "timeout"
            : "cancelled",
        );
      const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdout?.on("error", () => stop("exit"));
      child.stderr?.on("error", () => stop("exit"));
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.length;
        if (out > (options.onStdout ? streamLimit : limit)) {
          stop("output_limit");
          return;
        }
        if (failure !== undefined) return;
        try {
          if (options.onStdout) options.onStdout(chunk);
          else stdout.push(chunk);
        } catch {
          stop("consumer");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        err += chunk.length;
        if (err > limit) stop("output_limit");
        else stderr.push(chunk);
      });
      if (options.onProgress) {
        const stream = child.stdio[3];
        if (stream && "on" in stream)
          stream.on("data", (chunk: Buffer) => {
            progressBytes += chunk.length;
            if (progressBytes > limit) {
              stop("output_limit");
              return;
            }
            pending += chunk.toString("utf8");
            let match: RegExpExecArray | null;
            while ((match = /progress=(?:continue|end)\r?\n/.exec(pending)) !== null) {
              const end = match.index + match[0].length;
              try {
                options.onProgress?.(parseFfmpegProgress(pending.slice(0, end)));
              } catch {
                stop("consumer");
              }
              pending = pending.slice(end);
            }
          });
      }
      if (child.pid !== undefined) {
        try {
          options.onProcess?.(child.pid);
        } catch {
          stop("consumer");
        }
      }
      child.on("error", () => {
        failure ??= "unavailable";
      });
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        options.signal?.removeEventListener("abort", abort);
        // Reap descendants retaining pipes or surviving an early parent exit.
        kill("SIGKILL");
        if (failure) reject(new FfmpegError(failure));
        else if (code !== 0) reject(new FfmpegError("exit", code, exitSignal));
        else
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
      });
    });
  }
}
