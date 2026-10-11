import { request } from "node:http";
import { JobExecutionUnconfirmedError } from "@editagent/job-queue";
import type { RenderInput, RenderProgress, VerifiedAsset } from "../application/ports.js";
const socketPath = "/run/render/control.sock";
export async function executorReady(): Promise<boolean> {
  try {
    const value = await status();
    return value === "idle" || value === "busy";
  } catch {
    return false;
  }
}
async function status(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/ready", method: "GET", timeout: 250 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (v: string) => {
        text += v;
        if (text.length > 32) req.destroy();
      });
      res.once("end", () =>
        res.statusCode === 200 && (text === "idle" || text === "busy")
          ? resolve(text)
          : reject(new Error("Executor unsafe.")),
      );
    });
    req.once("timeout", () => req.destroy(new Error("Executor unavailable.")));
    req.once("error", reject);
    req.end();
  });
}
export async function remoteRender(
  token: string,
  input: RenderInput,
  timeoutMs: number,
  signal: AbortSignal,
  progress: (p: RenderProgress) => void,
  assets: readonly VerifiedAsset[] = [],
) {
  signal.throwIfAborted();
  try {
    await new Promise<void>((resolve, reject) => {
      let line = "",
        done = false,
        settled = false;
      const finish = (e?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (e) reject(e);
        else resolve();
      };
      const req = request(
        {
          socketPath,
          path: "/render",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            finish(new Error("Render executor rejected work."));
            return;
          }
          res.setEncoding("utf8");
          res.on("data", (text: string) => {
            line += text;
            if (line.length > 65536) {
              req.destroy();
              finish(new Error("Render protocol overflow."));
              return;
            }
            let end: number;
            while ((end = line.indexOf("\n")) >= 0) {
              const record = line.slice(0, end);
              line = line.slice(end + 1);
              try {
                const v = JSON.parse(record) as RenderProgress & { type: string };
                if (v.type === "progress") progress(v);
                else if (v.type === "completed") done = true;
                else if (v.type === "failed") finish(new Error("Render failed."));
                else throw new Error();
              } catch {
                req.destroy();
                finish(new Error("Invalid render response."));
              }
            }
          });
          res.once("end", () => (done ? finish() : finish(new Error("Render did not complete."))));
          res.once("error", () => finish(new Error("Render connection failed.")));
        },
      );
      const abort = () =>
        req.destroy(signal.reason instanceof Error ? signal.reason : new Error("Render aborted."));
      signal.addEventListener("abort", abort, { once: true });
      req.once("error", (e) => finish(e));
      req.end(JSON.stringify({ token, input, timeoutMs, assets }));
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
  } catch (error) {
    // Do not report Cancelled until the isolated renderer confirms its tree was reaped.
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      let idle = false;
      try {
        idle = (await status()) === "idle";
      } catch {
        /* fail closed until executor confirms reaping */
      }
      if (idle) {
        signal.throwIfAborted();
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new JobExecutionUnconfirmedError();
  }
}
