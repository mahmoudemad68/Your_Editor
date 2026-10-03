import { createServer, type Server } from "node:http";

/** Workers listen here inside their own container. The API and web use their public ports. */
export const WORKER_HEALTH_PORT = 3200;

export interface HealthServerOptions {
  /** When omitted, /ready reports not-ready. /health stays a liveness check. */
  readonly ready?: () => boolean | Promise<boolean>;
}

export function startHealthServer(port: number, options: HealthServerOptions = {}): Server {
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0];
    if (request.method === "GET" && path === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && path === "/ready") {
      void Promise.resolve(options.ready ? options.ready() : false)
        .then((ready) => {
          writeJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not-ready" });
        })
        .catch(() => {
          writeJson(response, 503, { status: "not-ready" });
        });
      return;
    }
    writeJson(response, 404, { status: "not-found" });
  });
  server.listen(port, "0.0.0.0");
  return server;
}

function writeJson(
  response: {
    writeHead(status: number, headers: Record<string, string>): void;
    end(body: string): void;
  },
  status: number,
  body: { status: string },
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
