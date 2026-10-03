"""HTTP /health and /ready for the AI worker process."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

WORKER_HEALTH_PORT = 3200


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._json(200, {"status": "ok"})
            return
        if path == "/ready":
            self._json(200, {"status": "ready"})
            return
        self._json(404, {"status": "not-found"})

    def log_message(self, format: str, *args: object) -> None:
        del format, args

    def _json(self, status: int, body: dict[str, str]) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def start_health_server(port: int = WORKER_HEALTH_PORT) -> None:
    server = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    thread = Thread(target=server.serve_forever, name="ai-worker-health", daemon=True)
    thread.start()
