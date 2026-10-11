import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import path from "node:path";
import { JobExecutionUnconfirmedError } from "@editagent/job-queue";
import type { RenderInput, RenderProgress, VerifiedAsset } from "../application/ports.js";
interface ProcessIdentity {
  pid: number;
  ppid: number;
  start: string;
  state: string;
}
function table(): Map<number, ProcessIdentity> {
  const out = new Map<number, ProcessIdentity>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = readFileSync(`/proc/${entry}/stat`, "utf8");
      const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      out.set(Number(entry), {
        pid: Number(entry),
        ppid: Number(f[1]),
        start: f[19]!,
        state: f[0]!,
      });
    } catch {
      /* exited */
    }
  }
  return out;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function runRenderChild(
  input: RenderInput,
  work: string,
  temp: string,
  signal: AbortSignal,
  onProgress: (p: RenderProgress) => void,
  assets: readonly VerifiedAsset[] = [],
): Promise<{ processes: ProcessIdentity[]; pid: number }> {
  signal.throwIfAborted();
  const child = fork(path.join(__dirname, "render-child.js"), [], {
    detached: true,
    execArgv: ["--max-old-space-size=512"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: "production",
      TMPDIR: temp,
      EDITAGENT_RENDER_JOB_TOKEN: path.basename(work),
      REMOTION_CONCURRENCY: process.env.REMOTION_CONCURRENCY ?? "2",
      REMOTION_BROWSER: "/opt/chromium/chrome-headless-shell-linux64/chrome-headless-shell",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  if (!child.pid) throw new JobExecutionUnconfirmedError();
  const pid = child.pid,
    known = new Map<number, ProcessIdentity>();
  const collect = () => {
    const current = table();
    // A detached descendant can be reparented before the first ancestry scan.
    // Only processes carrying this unpredictable, internally supplied job marker belong here.
    for (const p of current.values()) {
      if (p.pid === process.pid || known.has(p.pid)) continue;
      try {
        if (
          readFileSync(`/proc/${p.pid}/environ`, "utf8")
            .split("\0")
            .includes(`EDITAGENT_RENDER_JOB_TOKEN=${path.basename(work)}`)
        )
          known.set(p.pid, p);
      } catch {
        /* inaccessible or exited */
      }
    }
    const root = current.get(pid);
    if (root && !known.has(pid)) known.set(pid, root);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of current.values())
        if (
          !known.has(p.pid) &&
          known.has(p.ppid) &&
          current.get(p.ppid)?.start === known.get(p.ppid)?.start
        ) {
          known.set(p.pid, p);
          changed = true;
        }
    }
  };
  const kill = (name: NodeJS.Signals) => {
    collect();
    const current = table();
    for (const p of [...known.values()].reverse()) {
      if (p.pid === process.pid || current.get(p.pid)?.start !== p.start) continue;
      try {
        process.kill(p.pid, name);
      } catch {
        /* exited */
      }
    }
  };
  const scan = setInterval(collect, 10);
  collect();
  let exited = false,
    settled = false,
    complete = false;
  let resolveResult: () => void = () => undefined,
    rejectResult: (e: Error) => void = () => undefined;
  const result = new Promise<void>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const finish = (e?: Error) => {
    if (settled) return;
    settled = true;
    if (e) rejectResult(e);
    else resolveResult();
  };
  child.once("error", () => finish(new Error("Renderer process failed.")));
  child.once("exit", () => {
    exited = true;
    if (!settled) finish(new Error("Renderer exited without a result."));
  });
  child.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object" || !("type" in raw)) return;
    const m = raw as { type: string; progress?: RenderProgress; detail?: string };
    if (m.type === "progress" && m.progress) {
      collect();
      try {
        writeFileSync(
          path.join(work, "processes.json"),
          JSON.stringify(
            [...known.values()].map((p) => ({
              ...p,
              uid: (() => {
                try {
                  return /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${p.pid}/status`, "utf8"))?.[1];
                } catch {
                  return undefined;
                }
              })(),
              rssBytes: (() => {
                try {
                  return (
                    Number(
                      /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${p.pid}/status`, "utf8"))?.[1] ??
                        0,
                    ) * 1024
                  );
                } catch {
                  return 0;
                }
              })(),
              expatLibrary: (() => {
                try {
                  return readFileSync(`/proc/${p.pid}/maps`, "utf8")
                    .split("\n")
                    .map((line) => line.split(/\s+/).at(-1))
                    .find((file) => file?.includes("libexpat.so.1"));
                } catch {
                  return undefined;
                }
              })(),
              argv: (() => {
                try {
                  return readFileSync(`/proc/${p.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
                } catch {
                  return [];
                }
              })(),
            })),
          ),
        );
        onProgress(m.progress);
      } catch {
        finish(new Error("Invalid render progress."));
        kill("SIGTERM");
      }
    } else if (m.type === "completed") {
      complete = true;
      finish();
    } else if (m.type === "failed") {
      console.error(JSON.stringify({ errorCode: "render_execution_failed", detail: m.detail }));
      finish(new Error("Render execution failed."));
    }
  });
  let term: ReturnType<typeof setTimeout> | undefined,
    hard: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    if (child.connected) {
      try {
        child.send({ type: "abort" });
      } catch {
        kill("SIGTERM");
      }
    }
    term = setTimeout(() => kill("SIGTERM"), 400);
    hard = setTimeout(() => kill("SIGKILL"), 600);
  };
  signal.addEventListener("abort", abort, { once: true });
  child.send({ type: "start", input, work, assets });
  if (signal.aborted) abort();
  let outcome: unknown;
  let unconfirmed = false;
  try {
    await result;
  } catch (error) {
    outcome = error;
  } finally {
    signal.removeEventListener("abort", abort);
    if (term) clearTimeout(term);
    if (hard) clearTimeout(hard);
    if (signal.aborted || !complete) kill("SIGTERM");
    const grace = Date.now() + 400;
    while (!exited && Date.now() < grace) await delay(10);
    // BrowserRunner uses a detached group. A child process group alone cannot reap it.
    kill("SIGKILL");
    const deadline = Date.now() + 2000;
    const live = () => {
      const current = table();
      return [...known.values()].filter(
        (p) => current.get(p.pid)?.start === p.start && current.get(p.pid)?.state !== "Z",
      );
    };
    while (live().length && Date.now() < deadline) {
      kill("SIGKILL");
      await delay(20);
    }
    clearInterval(scan);
    child.removeAllListeners();
    if (live().length) unconfirmed = true;
  }
  if (unconfirmed) throw new JobExecutionUnconfirmedError();
  if (outcome !== undefined) throw outcome;
  signal.throwIfAborted();
  return { pid, processes: [...known.values()] };
}
