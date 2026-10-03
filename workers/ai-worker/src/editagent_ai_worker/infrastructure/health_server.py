"""HTTP /health and /ready for the AI worker process."""

from __future__ import annotations

import json
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

WORKER_HEALTH_PORT = 3200


def health_response() -> tuple[int, dict[str, str]]:
    return 200, {"status": "ok"}


def ready_response(ready: bool) -> tuple[int, dict[str, str]]:
    if ready:
        return 200, {"status": "ready"}
    return 503, {"status": "not-ready"}


class _Handler(BaseHTTPRequestHandler):
    ready_check: Callable[[], bool] = staticmethod(lambda: False)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/health":
            status, body = health_response()
            self._json(status, body)
            return
        if path == "/ready":
            try:
                ready = bool(self.ready_check())
            except Exception:
                ready = False
            status, body = ready_response(ready)
            self._json(status, body)
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


def start_health_server(
    port: int = WORKER_HEALTH_PORT,
    ready: Callable[[], bool] | None = None,
) -> ThreadingHTTPServer:
    class Handler(_Handler):
        ready_check = staticmethod(ready if ready is not None else (lambda: False))

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    thread = Thread(target=server.serve_forever, name="ai-worker-health", daemon=True)
    thread.start()
    return server
