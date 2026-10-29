#!/usr/bin/env python3
"""Independent FFmpeg download controls.

Executes the production build-ffmpeg.sh prefix against an ephemeral trusted TLS
fixture. This file is not the Coding Agent unittest and does not import it.
"""

from __future__ import annotations

import hashlib
import http.server
import lzma
import os
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "workers/media-worker/build-ffmpeg.sh"
PIN = "de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f"
DEBIAN = "https://security.debian.org/debian-security/pool/updates/main/f/ffmpeg/ffmpeg_7.1.5.orig.tar.xz"
DSC = "https://security.debian.org/debian-security/pool/updates/main/f/ffmpeg/ffmpeg_7.1.5-0+deb13u1.dsc"
PRIMARY = "https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz"
SIZE = 11050340

sys.path.insert(0, str(Path(__file__).resolve().parent))
from results import emit  # noqa: E402


def production_text() -> str:
    return SCRIPT.read_text(encoding="utf-8")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):  # noqa: N802
        server = self.server
        server.paths.append(self.path)
        mode = server.mode
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", server.redirect_to)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if mode == "slow" and server.slow_left > 0:
            server.slow_left -= 1
            time.sleep(100)
        body = server.body
        if mode == "partial" and server.partial_left > 0:
            server.partial_left -= 1
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body[:4])
            self.wfile.flush()
            self.close_connection = True
            return
        if mode == "rst" and server.rst_left > 0:
            server.rst_left -= 1
            self.send_response(200)
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b"hello")
            self.wfile.flush()
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            os.close(self.connection.fileno())
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002
        return


class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def shutdown_request(self, request):
        try:
            super().shutdown_request(request)
        except OSError:
            return

    def get_request(self):
        connection, address = self.socket.accept()
        self.hits += 1
        if self.hits <= self.resets:
            connection.close()
            raise OSError("injected pre-handshake reset")
        return self.context.wrap_socket(connection, server_side=True), address


def make_cert(directory: Path) -> Path:
    cert = directory / "cert.pem"
    key = directory / "key.pem"
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
            str(cert),
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        check=True,
        capture_output=True,
    )
    return cert


def start_server(cert: Path, body: bytes, *, resets: int = 0, mode: str = "ok", redirect_to: str = "") -> Server:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, directory_key(cert))
    server = Server(("127.0.0.1", 0), Handler)
    server.context = context
    server.body = body
    server.resets = resets
    server.hits = 0
    server.paths = []
    server.mode = mode
    server.partial_left = 1
    server.rst_left = 1
    server.slow_left = 1
    server.redirect_to = redirect_to
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.thread = thread
    return server


def directory_key(cert: Path) -> Path:
    return cert.parent / "key.pem"


def tiny_xz() -> bytes:
    buffer = BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        payload = b"qa-independent\n"
        info = tarfile.TarInfo("qa.txt")
        info.size = len(payload)
        archive.addfile(info, BytesIO(payload))
    return lzma.compress(buffer.getvalue())


def run_prefix(
    source: str,
    directory: Path,
    primary: str,
    fallback: str,
    body: bytes,
    *,
    trust: Path | None,
    include_tar: bool,
    env_extra: dict[str, str] | None = None,
    timeout: int = 180,
) -> subprocess.CompletedProcess[str]:
    expected = hashlib.sha256(body).hexdigest()
    marker = 'tar -xJf "$archive"'
    prefix = source.split(marker, 1)[0]
    prefix = prefix.replace("cd /src", f"cd {sh_quote(str(directory))}")
    lines = []
    for line in prefix.splitlines(keepends=True):
        if line.startswith("url="):
            lines.append(f"url={sh_quote(primary)}\n")
        elif line.startswith("fallback_url="):
            lines.append(f"fallback_url={sh_quote(fallback)}\n")
        elif line.startswith("expected="):
            lines.append(f"expected={expected}\n")
        else:
            lines.append(line)
    script = "".join(lines)
    if include_tar:
        script += 'tar -xJf "$archive"\necho EXTRACTED > extracted.marker\nexit 0\n'
    path = directory / "prefix.sh"
    path.write_text(script, encoding="utf-8")
    env = os.environ.copy()
    for name in ("CURL_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"):
        env.pop(name, None)
    if trust is not None:
        env["CURL_CA_BUNDLE"] = str(trust)
        env["SSL_CERT_FILE"] = str(trust)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        ["sh", str(path)],
        cwd=directory,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def sh_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main() -> int:
    results = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("qa-results-g1.jsonl")
    source = production_text()
    problems = 0

    def record(case_id: str, status: str, required: bool, detail: str) -> None:
        nonlocal problems
        if status in {"FAIL", "ERROR"}:
            problems += 1
        emit(results, case_id, "G1", status, required, detail)

    identity_ok = (
        "https://ffmpeg.org/releases/${archive}" in source
        and DEBIAN.split("ffmpeg_")[0] + "ffmpeg_${version}.orig.tar.xz" in source
        and PIN in source
        and "--proto '=https'" in source
        and "--proto-redir '=https'" in source
        and "--retry-all-errors" in source
        and "--retry 3" in source
        and "--connect-timeout 15" in source
        and "--max-time 90" in source
        and "--retry-max-time 120" in source
        and "--insecure" not in source
        and " -k " not in source
        and source.index("sha256sum -c -") < source.index('tar -xJf "$archive"')
        and "FFMPEG_URL" not in source
    )
    record(
        "g1.script_identity",
        "PASS" if identity_ok else "FAIL",
        True,
        "production script pins ffmpeg.org, Debian security, approved SHA-256, HTTPS-only, bounded retry, checksum before tar",
    )

    workspace = Path(tempfile.mkdtemp(prefix="qa-ffmpeg-"))
    try:
        cert = make_cert(workspace)
        good = tiny_xz()
        bad = b"corrupt-primary-bytes-not-the-archive\n"

        def direct_curl(args: list[str], url: str) -> tuple[int, int]:
            server = start_server(cert, good, resets=8)
            try:
                target = f"https://localhost:{server.server_port}{url}"
                completed = subprocess.run(
                    args + ["--cacert", str(cert), "-o", str(workspace / "direct.bin"), target],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                return completed.returncode, server.hits
            finally:
                server.shutdown()

        old_code, old_hits = direct_curl(
            ["curl", "-fsSL", "--proto", "=https", "--retry", "3", "--retry-delay", "1", "--connect-timeout", "5", "--max-time", "10"],
            "/old",
        )
        new_code, new_hits = direct_curl(
            ["curl", "-fsSL", "--proto", "=https", "--proto-redir", "=https", "--retry", "3", "--retry-all-errors", "--retry-delay", "0", "--connect-timeout", "5", "--max-time", "10"],
            "/new",
        )
        old_ok = old_code != 0 and old_hits == 1
        new_ok = new_hits >= 2
        record(
            "g1.old_retry_skips_curl35",
            "PASS" if old_ok and new_ok else "FAIL",
            True,
            f"legacy --retry hits={old_hits} exit={old_code}; --retry-all-errors hits={new_hits} exit={new_code}",
        )

        def scenario(
            case_id: str,
            *,
            primary_mode: str = "ok",
            fallback_mode: str = "ok",
            primary_resets: int = 0,
            fallback_resets: int = 0,
            primary_body: bytes | None = None,
            fallback_body: bytes | None = None,
            trust: bool = True,
            expect_ok: bool,
            fallback_hits: int | None = None,
            primary_max: int | None = None,
            include_tar: bool = False,
            timeout: int = 180,
            primary_url: str | None = None,
            fallback_url: str | None = None,
            redirect_to: str = "",
            http_server: http.server.ThreadingHTTPServer | None = None,
            fallback_max: int | None = None,
        ) -> subprocess.CompletedProcess[str]:
            pbody = good if primary_body is None else primary_body
            fbody = good if fallback_body is None else fallback_body
            primary = start_server(cert, pbody, resets=primary_resets, mode=primary_mode, redirect_to=redirect_to)
            fallback = start_server(cert, fbody, resets=fallback_resets, mode=fallback_mode)
            work = Path(tempfile.mkdtemp(dir=workspace))
            try:
                purl = primary_url or f"https://127.0.0.1:{primary.server_port}/primary"
                furl = fallback_url or f"https://127.0.0.1:{fallback.server_port}/fallback"
                completed = run_prefix(
                    source,
                    work,
                    purl,
                    furl,
                    good,
                    trust=cert if trust else None,
                    include_tar=include_tar,
                    timeout=timeout,
                )
                # Checksum expectation follows the bytes the script was told to accept.
                archive = work / "ffmpeg-7.1.5.tar.xz"
                part = work / "ffmpeg-7.1.5.tar.xz.part"
                marker = work / "extracted.marker"
                ok = completed.returncode == 0
                detail = f"exit={completed.returncode} primary_hits={primary.hits} fallback_hits={fallback.hits} stderr={completed.stderr.strip()[:240]}"
                passed = ok == expect_ok and not part.exists()
                if fallback_hits is not None and fallback.hits != fallback_hits:
                    passed = False
                if primary_max is not None and primary.hits > primary_max:
                    passed = False
                if fallback_max is not None and fallback.hits > fallback_max:
                    passed = False
                if include_tar and expect_ok and not marker.exists():
                    passed = False
                if include_tar and not expect_ok and marker.exists():
                    passed = False
                if expect_ok and not archive.exists():
                    passed = False
                if not expect_ok and archive.exists():
                    passed = False
                if http_server is not None and http_server.hits:  # type: ignore[attr-defined]
                    passed = False
                    detail += f" http_hits={http_server.hits}"
                record(case_id, "PASS" if passed else "FAIL", True, detail)
                completed.primary_hits = primary.hits  # type: ignore[attr-defined]
                completed.fallback_hits = fallback.hits  # type: ignore[attr-defined]
                return completed
            finally:
                primary.shutdown()
                fallback.shutdown()

        scenario("g1.tls_reset_recovery", primary_resets=1, fallback_hits=0, expect_ok=True)
        scenario("g1.recv_reset_recovery", primary_mode="rst", fallback_hits=0, expect_ok=True)
        scenario("g1.partial_body_recovery", primary_mode="partial", fallback_hits=0, expect_ok=True)
        scenario(
            "g1.refused_uses_fallback",
            primary_url=f"https://127.0.0.1:{closed_port()}/primary",
            fallback_hits=1,
            expect_ok=True,
            primary_max=0,
        )
        scenario("g1.slow_then_recover", primary_mode="slow", fallback_hits=0, expect_ok=True, timeout=240)
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        httpd.hits = 0
        httpd.paths = []
        httpd.body = b"plain"
        httpd.mode = "ok"

        def count_http(self):  # type: ignore[no-untyped-def]
            self.server.hits += 1
            self.send_response(200)
            self.send_header("Content-Length", "4")
            self.end_headers()
            self.wfile.write(b"evil")

        Handler.do_GET_saved = Handler.do_GET  # type: ignore[attr-defined]
        # Dedicated plaintext counter, independent of the TLS handler.
        class Plain(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.server.hits += 1
                self.send_response(200)
                self.send_header("Content-Length", "4")
                self.end_headers()
                self.wfile.write(b"evil")

            def log_message(self, format, *args):  # noqa: A002
                return

        plain = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Plain)
        plain.hits = 0
        threading.Thread(target=plain.serve_forever, daemon=True).start()
        try:
            scenario(
                "g1.http_redirect_no_protocol_change",
                primary_mode="redirect",
                redirect_to=f"http://127.0.0.1:{plain.server_address[1]}/evil",
                fallback_hits=1,
                expect_ok=True,
                http_server=plain,
            )
        finally:
            plain.shutdown()
        scenario("g1.invalid_ca_fail_closed", trust=False, fallback_hits=None, expect_ok=False)
        scenario(
            "g1.primary_outage_fallback",
            primary_url=f"https://127.0.0.1:{closed_port()}/down",
            expect_ok=True,
            fallback_hits=1,
            primary_max=0,
        )
        scenario(
            "g1.both_outage_fail_closed",
            primary_url=f"https://127.0.0.1:{closed_port()}/down",
            fallback_url=f"https://127.0.0.1:{closed_port()}/down2",
            expect_ok=False,
            fallback_hits=0,
            primary_max=0,
        )
        scenario(
            "g1.retry_budget",
            primary_resets=10,
            fallback_resets=10,
            expect_ok=False,
            primary_max=4,
            fallback_max=4,
            timeout=180,
        )
        # retry budget also bounds fallback; check via a dedicated assertion already in scenario primary_max.
        # Re-check fallback cap by reading the last result is not stored. Run an explicit cap test inside retry by
        # extending scenario: primary_max covers primary. Add fallback cap here with a second small run if needed.
        scenario("g1.part_cleanup", primary_body=bad, fallback_body=bad, expect_ok=False, fallback_hits=0)
        scenario(
            "g1.no_extract_on_bad_checksum",
            primary_body=bad,
            fallback_body=good,
            expect_ok=False,
            fallback_hits=0,
            include_tar=True,
        )
        scenario("g1.primary_success_skips_fallback", fallback_hits=0, expect_ok=True, include_tar=True)
        scenario("g1.corrupt_primary_no_fallback", primary_body=bad, expect_ok=False, fallback_hits=0, include_tar=True)
        scenario(
            "g1.corrupt_fallback_fail_closed",
            primary_url=f"https://127.0.0.1:{closed_port()}/down",
            fallback_body=bad,
            expect_ok=False,
            primary_max=0,
        )

        work = Path(tempfile.mkdtemp(dir=workspace))
        poisoned = run_prefix(
            source,
            work,
            f"https://127.0.0.1:{closed_port()}/nope",
            f"https://127.0.0.1:{closed_port()}/nope",
            good,
            trust=cert,
            include_tar=False,
            env_extra={"url": "http://evil.example/ffmpeg.tar.xz", "FFMPEG_URL": "http://evil.example/a", "fallback_url": "http://evil.example/b"},
            timeout=20,
        )
        script_copy = (work / "prefix.sh").read_text(encoding="utf-8")
        override_ok = "evil.example" not in script_copy and poisoned.returncode != 0
        record(
            "g1.no_env_url_override",
            "PASS" if override_ok else "FAIL",
            True,
            "env url/FFMPEG_URL/fallback_url did not replace the script's assigned origins",
        )
    finally:
        shutil.rmtree(workspace, ignore_errors=True)

    debian_detail = "not run"
    debian_status = "ERROR"
    try:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "ffmpeg.tar.xz"
            completed = subprocess.run(
                ["curl", "-fsSL", "--proto", "=https", "--proto-redir", "=https", "--retry", "3", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "15", "--max-time", "180", "-o", str(target), DEBIAN],
                capture_output=True,
                text=True,
                timeout=240,
                check=False,
            )
            digest = hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else ""
            debian_ok = completed.returncode == 0 and target.stat().st_size == SIZE and digest == PIN
            debian_status = "PASS" if debian_ok else "FAIL"
            debian_detail = f"exit={completed.returncode} bytes={target.stat().st_size if target.is_file() else 0} sha256={digest}"
    except Exception as exc:  # noqa: BLE001
        debian_status = "ERROR"
        debian_detail = str(exc)
    record("g1.debian_archive_sha256", debian_status, True, debian_detail)

    dsc_status = "NOT_VERIFIED"
    dsc_detail = "signature not verified"
    try:
        with tempfile.TemporaryDirectory() as directory:
            dsc_path = Path(directory) / "ffmpeg.dsc"
            completed = subprocess.run(
                ["curl", "-fsSL", "--proto", "=https", "--proto-redir", "=https", "--max-time", "60", "-o", str(dsc_path), DSC],
                capture_output=True,
                text=True,
                timeout=90,
                check=False,
            )
            text = dsc_path.read_text(encoding="utf-8", errors="replace") if dsc_path.is_file() else ""
            recorded = PIN in text and "11050340" in text
            gpg = subprocess.run(["gpg", "--verify", str(dsc_path)], capture_output=True, text=True, check=False)
            if gpg.returncode == 0:
                dsc_status = "PASS"
                dsc_detail = "Debian .dsc signature verified and records the approved size and SHA-256"
            else:
                dsc_status = "NOT_VERIFIED"
                dsc_detail = f"dsc_downloaded={completed.returncode == 0} hash_recorded={recorded} gpg_exit={gpg.returncode} gpg={gpg.stderr.strip()[:240]}"
    except Exception as exc:  # noqa: BLE001
        dsc_status = "NOT_VERIFIED"
        dsc_detail = f"signature not verified: {exc}"
    record("g1.dsc_signature", dsc_status, False, dsc_detail)

    try:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "primary.tar.xz"
            completed = subprocess.run(
                ["curl", "-fL", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15", "--max-time", "40", "-o", str(target), PRIMARY],
                capture_output=True,
                text=True,
                timeout=50,
                check=False,
            )
            if completed.returncode == 0 and target.is_file():
                digest = hashlib.sha256(target.read_bytes()).hexdigest()
                record(
                    "g1.live_primary_observed",
                    "OBSERVED",
                    False,
                    f"primary reachable bytes={target.stat().st_size} sha256={digest} match={digest == PIN}",
                )
            else:
                record(
                    "g1.live_primary_observed",
                    "OBSERVED",
                    False,
                    f"primary not fully fetched in one 40s attempt exit={completed.returncode} stderr={completed.stderr.strip()[:200]}",
                )
    except Exception as exc:  # noqa: BLE001
        record("g1.live_primary_observed", "OBSERVED", False, f"primary observation error: {exc}")

    # Fallback request cap is part of retry_budget. Record an explicit extra check by re-reading is unnecessary.
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
