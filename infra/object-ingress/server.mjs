/**
 * External object ingress for staging.
 * Browser signed PUT and GET requests are forwarded to MinIO with the
 * original Host header, which SigV4 includes in the signature.
 * STS, the admin API, and the MinIO console prefix are refused here.
 * This process does not remove vulnerabilities from the MinIO binary.
 * Containers that share the Docker network can still reach MinIO directly.
 */
import dns from "node:dns";
import http from "node:http";

dns.setDefaultResultOrder("ipv4first");

const upstream = new URL(process.env.MINIO_UPSTREAM ?? "http://minio:9000");
const port = Number(process.env.PORT ?? "8080");

function forbidden(url) {
  const path = url.pathname;
  if (path === "/" || path === "") {
    return true;
  }
  if (path === "/minio" || path.startsWith("/minio/")) {
    return true;
  }
  return /(?:^|&)Action=/i.test(url.search.slice(1));
}

function deny(response) {
  response.writeHead(403, { "content-type": "text/plain" });
  response.end("forbidden");
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  const url = new URL(request.url ?? "/", "http://ingress.local");
  if (forbidden(url)) {
    deny(response);
    return;
  }
  const headers = { ...request.headers };
  dns.lookup(upstream.hostname, { family: 4 }, (lookupError, address) => {
    if (lookupError) {
      denyUnavailable(response);
      return;
    }
    const proxied = http.request(
      {
        host: address,
        port: upstream.port || 80,
        method: request.method,
        path: request.url,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    proxied.setTimeout(5000, () => proxied.destroy());
    proxied.on("error", () => denyUnavailable(response));
    request.pipe(proxied);
  });
});

function denyUnavailable(response) {
  if (!response.headersSent) {
    response.writeHead(502, { "content-type": "text/plain" });
  }
  response.end("upstream unavailable");
}

server.listen(port, "0.0.0.0");
