import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readdir, stat, realpath } from "node:fs/promises";
import path from "node:path";
/** Loopback-only immutable bundle. No proxy, redirects, remote URLs or filesystem fallback. */
export async function startBundleServer(
  bundle: string,
  work: string,
  assets: readonly { name: string }[] = [],
) {
  const routes = new Map<string, string>();
  async function scan(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile() && !entry.name.endsWith(".map"))
        routes.set("/" + path.relative(bundle, file).split(path.sep).join("/"), file);
    }
  }
  await scan(bundle);
  routes.set("/", path.join(bundle, "index.html"));
  for (const { name } of assets)
    if (/^[a-f0-9]{64}\.(mp4|wav|png|jpg)$/.test(name)) {
      const file = path.join(work, name);
      if ((await realpath(file)) !== file) throw new Error("Unsafe staged asset.");
      routes.set(`/public/${name}`, file);
    }
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      const requested = req.url?.split("?")[0] ?? "/";
      const file = routes.get(requested);
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      const s = await stat(file);
      let start = 0,
        end = s.size - 1,
        status = 200;
      if (req.headers.range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!m) {
          res.writeHead(416).end();
          return;
        }
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : end;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          end >= s.size
        ) {
          res.writeHead(416).end();
          return;
        }
        status = 206;
      }
      const ext = path.extname(file);
      const mime =
        ext === ".html"
          ? "text/html"
          : ext === ".js"
            ? "text/javascript"
            : ext === ".css"
              ? "text/css"
              : ext === ".mp4"
                ? "video/mp4"
                : ext === ".wav"
                  ? "audio/wav"
                  : ext === ".png"
                    ? "image/png"
                    : ext === ".jpg"
                      ? "image/jpeg"
                      : "application/octet-stream";
      res.writeHead(status, {
        "Content-Type": mime,
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${s.size}` } : {}),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = createReadStream(file, { start, end });
      res.once("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    })().catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bundle listener unavailable.");
  return {
    serveUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
