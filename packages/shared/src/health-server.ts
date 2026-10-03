import { createServer, type Server } from "node:http";

/** Workers listen here inside their own container. The API and web use their public ports. */
export const WORKER_HEALTH_PORT = 3200;

export function startHealthServer(port: number): Server {
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0];
    if (request.method === "GET" && path === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && path === "/ready") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "not-found" }));
  });
  server.listen(port, "0.0.0.0");
  return server;
}
