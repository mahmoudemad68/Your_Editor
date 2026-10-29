"""Exercise the production download/checksum prefix with real curl and trusted TLS.

Only the destination directory, URL and expected fixture hash are substituted.
No source archive, compilation, private fixture or external network is needed.
"""

import hashlib
import http.server
import os
import ssl
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "workers/media-worker/build-ffmpeg.sh").read_text()
PIN = "de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f"
BODY = b"bounded download regression fixture\n"


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        partial = self.server.partial and self.server.connections == 1
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY[:5] if partial else BODY)
        self.wfile.flush()
        self.close_connection = True

    def log_message(self, *_):
        pass


class Server(http.server.HTTPServer):
    def get_request(self):
        connection, address = self.socket.accept()
        self.connections += 1
        if self.connections <= self.resets:
            # Close before TLS handshake: curl must report error 35, as in CI.
            connection.close()
            raise OSError("injected pre-handshake reset")
        return self.context.wrap_socket(connection, server_side=True), address


class DownloadControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix="ffmpeg-tls-controls-")
        cls.directory = Path(cls.workspace.name)
        cls.cert = cls.directory / "cert.pem"
        key = cls.directory / "key.pem"
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                str(key),
                "-out",
                str(cls.cert),
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost",
            ],
            check=True,
            capture_output=True,
        )
        cls.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.context.load_cert_chain(cls.cert, key)

    @classmethod
    def tearDownClass(cls):
        cls.workspace.cleanup()

    def execute(self, *, resets=0, partial=False, corrupt=False, default_retry=False):
        with Server(("127.0.0.1", 0), Handler) as server:
            server.context = self.context
            server.connections = 0
            server.resets = resets
            server.partial = partial
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with tempfile.TemporaryDirectory(dir=self.directory) as directory:
                    prefix = SOURCE.split('tar -xJf "$archive"', 1)[0]
                    prefix = prefix.replace("cd /src", "cd " + directory)
                    prefix = prefix.replace(
                        "https://ffmpeg.org/releases/${archive}",
                        f"https://localhost:{server.server_port}/fixture",
                    )
                    expected = hashlib.sha256(b"wrong" if corrupt else BODY).hexdigest()
                    prefix = prefix.replace(PIN, expected)
                    if default_retry:
                        prefix = prefix.replace("--retry-all-errors", "")
                    env = {
                        key: value
                        for key, value in os.environ.items()
                        if "proxy" not in key.lower()
                    }
                    env["CURL_CA_BUNDLE"] = str(self.cert)
                    result = subprocess.run(
                        ["sh", "-c", prefix],
                        check=False,
                        env=env,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    archive = Path(directory) / "ffmpeg-7.1.5.tar.xz"
                    content = archive.read_bytes() if archive.exists() else None
                    self.assertFalse(Path(str(archive) + ".part").exists())
                    return result, server.connections, content
            finally:
                server.shutdown()
                thread.join(timeout=5)

    def test_original_default_retry_reproduces_tls_failure(self):
        result, attempts, content = self.execute(resets=1, default_retry=True)
        self.assertEqual(result.returncode, 35, result.stderr)
        self.assertEqual(attempts, 1)
        self.assertIsNone(content)

    def test_tls_reset_recovers_and_verifies_complete_bytes(self):
        result, attempts, content = self.execute(resets=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(attempts, 2)
        self.assertEqual(content, BODY)

    def test_partial_transfer_restarts_without_appending_bytes(self):
        result, attempts, content = self.execute(partial=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(attempts, 2)
        self.assertEqual(content, BODY)

    def test_persistent_tls_failure_stops_at_four_attempts(self):
        result, attempts, content = self.execute(resets=100)
        self.assertEqual(result.returncode, 35, result.stderr)
        self.assertEqual(attempts, 4)
        self.assertIsNone(content)

    def test_checksum_mismatch_is_not_retried_or_promoted(self):
        result, attempts, content = self.execute(corrupt=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAILED", result.stdout)
        self.assertEqual(attempts, 1)
        self.assertIsNone(content)

    def test_production_identity_and_transfer_bounds(self):
        self.assertIn("version=7.1.5", SOURCE)
        self.assertIn("expected=" + PIN, SOURCE)
        self.assertIn('url="https://ffmpeg.org/releases/${archive}"', SOURCE)
        for option in [
            "--retry 3",
            "--retry-max-time 300",
            "--connect-timeout 15",
            "--max-time 120",
            "--proto '=https'",
            "--proto-redir '=https'",
        ]:
            self.assertIn(option, SOURCE)
        self.assertNotIn("--insecure", SOURCE)
        self.assertLess(
            SOURCE.index("sha256sum -c -"), SOURCE.index('tar -xJf "$archive"')
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
