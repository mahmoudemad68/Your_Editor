import { createServer } from "node:http";
import { mkdtemp, realpath, rm, readFile, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { JobExecutionUnconfirmedError } from "@editagent/job-queue";
import { assertRenderIsolation } from "./security.js";
import { parseRenderInput } from "./contract.js";
import { runRenderChild } from "./process-tree.js";
import { verifyStagedAssets } from "./verified-assets.js";
const ROOT = "/render-work",
  SOCKET = "/run/render/control.sock";
export async function startExecutor() {
  assertRenderIsolation();
  await readFile(path.join(__dirname, "../bundle/catalog.json"));
  await lstat("/opt/chromium/chrome-headless-shell-linux64/chrome-headless-shell");
  for (const token of await readdir(ROOT)) {
    if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("Unexpected render workspace entry.");
    await rm(path.join(ROOT, token), { recursive: true, force: true });
  }
  let active: AbortController | null = null;
  let unsafe = false;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/ready") {
        res.writeHead(unsafe ? 503 : 200).end(active ? "busy" : "idle");
        return;
      }
      if (req.method !== "POST" || req.url !== "/render" || active || unsafe) {
        res.writeHead(503).end();
        return;
      }
      const abort = new AbortController();
      active = abort;
      const disconnected = () => {
        if (!res.writableEnded) abort.abort(new Error("Render controller disconnected."));
      };
      res.once("close", disconnected);
      req.once("aborted", disconnected);
      const bodyWatchdog = setTimeout(() => {
        abort.abort();
        req.destroy();
      }, 5000);
      let temp: string | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const raw of req) {
          const chunk = raw as Buffer;
          bytes += chunk.length;
          if (bytes > 8388608) throw new Error("Render request too large.");
          chunks.push(chunk);
        }
        clearTimeout(bodyWatchdog);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          token: string;
          input: unknown;
          timeoutMs: number;
          assets: unknown;
        };
        if (
          !body ||
          Object.keys(body).sort().join(",") !== "assets,input,timeoutMs,token" ||
          !/^[a-f0-9]{32}$/.test(body.token) ||
          !Number.isSafeInteger(body.timeoutMs) ||
          body.timeoutMs < 1 ||
          body.timeoutMs > 600000
        )
          throw new Error("Invalid executor request.");
        const input = parseRenderInput(body.input);
        timeout = setTimeout(
          () => abort.abort(new Error("Render deadline exceeded.")),
          body.timeoutMs,
        );
        const work = path.join(ROOT, body.token);
        if ((await realpath(work)) !== work || (await lstat(work)).isSymbolicLink())
          throw new Error("Unsafe render workspace.");
        const assets = await verifyStagedAssets(input, body.assets, work, abort.signal);
        temp = await mkdtemp("/tmp/render-");
        if (res.destroyed || req.aborted) abort.abort();
        abort.signal.throwIfAborted();
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        try {
          const proof = await runRenderChild(
            input,
            work,
            temp,
            abort.signal,
            (p) => {
              if (!res.destroyed && !res.write(JSON.stringify({ type: "progress", ...p }) + "\n"))
                abort.abort(new Error("Render progress consumer stalled."));
            },
            assets,
          );
          abort.signal.throwIfAborted();
          res.end(JSON.stringify({ type: "completed", proof }) + "\n");
        } catch (e) {
          if (e instanceof JobExecutionUnconfirmedError) unsafe = true;
          if (!res.destroyed) res.end(JSON.stringify({ type: "failed" }) + "\n");
          await rm(work, { recursive: true, force: true });
        }
      } finally {
        clearTimeout(bodyWatchdog);
        if (timeout) clearTimeout(timeout);
        res.removeListener("close", disconnected);
        req.removeListener("aborted", disconnected);
        if (temp) await rm(temp, { recursive: true, force: true });
        active = null;
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  // Stale sockets are removed only at the fixed dedicated endpoint, never a caller path.
  await rm(SOCKET, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET, resolve);
  });
  const reap = setInterval(() => {
    if (active) return;
    void (async () => {
      for (const token of await readdir(ROOT)) {
        if (!/^[a-f0-9]{32}$/.test(token)) continue;
        const work = path.join(ROOT, token);
        if (Date.now() - (await lstat(work)).mtimeMs > 660000)
          await rm(work, { recursive: true, force: true });
      }
    })().catch(() => {
      unsafe = true;
    });
  }, 60000);
  reap.unref();
  const stop = () => {
    clearInterval(reap);
    active?.abort(new Error("Executor shutdown."));
    server.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}
if (require.main === module)
  void startExecutor().catch(() => {
    console.error("Render executor startup failed.");
    process.exitCode = 1;
  });
