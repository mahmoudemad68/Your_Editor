"""End-to-end sanitizer fixtures exercise the publication entry point."""

import base64
import hashlib
import importlib.util
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote, quote_plus

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "sanitizer", ROOT / "tools/test/sanitize-artifacts.py"
)
san = importlib.util.module_from_spec(spec)
spec.loader.exec_module(san)
audit_spec = importlib.util.spec_from_file_location(
    "artifact_audit", ROOT / "tools/test/audit-artifacts.py"
)
artifact_audit = importlib.util.module_from_spec(audit_spec)
audit_spec.loader.exec_module(artifact_audit)


class SanitizerRegression(unittest.TestCase):
    @staticmethod
    def png(comment):
        def chunk(kind, value):
            return (
                struct.pack(">I", len(value))
                + kind
                + value
                + struct.pack(">I", zlib.crc32(kind + value) & 0xFFFFFFFF)
            )

        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"tEXt", b"Comment\0note " + comment)
            + chunk(b"IDAT", zlib.compress(b"\0\0\0\0"))
            + chunk(b"IEND", b"")
        )

    def test_uri_diagnostics_never_disclose_values_or_arbitrary_paths(self):
        folder = self.artifacts / "DIAG_PRIVATE_PATH"
        folder.mkdir()
        path = folder / "fixture.png"
        raw = self.png(b"postgres://DIAG_USER:DIAG_PASSWORD@invalid.example/")
        path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "credential audit failed") as caught:
            artifact_audit.audit(self.artifacts, self.secret_file)
        message = str(caught.exception)
        for value in (
            "DIAG_USER",
            "DIAG_PASSWORD",
            "invalid.example",
            "DIAG_PRIVATE_PATH",
            str(self.root),
        ):
            self.assertNotIn(value, message)
        report = json.loads(message.split(": ", 1)[1])
        diag = report["first_uri_diagnostic"]
        self.assertEqual(
            set(diag),
            {
                "location_class",
                "format",
                "stream",
                "record_kind",
                "source_contiguous",
                "png_crc_valid",
                "png_source_chunks",
            },
        )
        self.assertEqual(diag["location_class"], "other")
        self.assertEqual(diag["format"], "png")
        self.assertTrue(diag["source_contiguous"])
        self.assertTrue(diag["png_crc_valid"])
        self.assertEqual(diag["png_source_chunks"], ["tEXt"])
        self.assertLess(len(json.dumps(diag)), 1500)

    def report(self):
        with self.assertRaisesRegex(ValueError, "credential audit failed") as caught:
            artifact_audit.audit(self.artifacts, self.secret_file)
        return json.loads(str(caught.exception).split(": ", 1)[1])

    def test_weak_credentials_have_no_digest_length_offset_or_filename_oracle(self):
        # A dictionary guess must not be checkable using public metadata.
        for shape in ("line", "json", "png", "zip", "nested_zip"):
            diagnostics = []
            for password in ("a", "password", "x" * 32, "letmein", "123456"):
                uri = f"postgres://user:{password}@example.invalid/db"
                raw = (uri + "\n").encode()
                if shape == "json":
                    raw = json.dumps({"url": uri}).encode()
                elif shape == "png":
                    raw = self.png(raw)
                elif shape in ("zip", "nested_zip"):
                    inner = io.BytesIO()
                    with zipfile.ZipFile(inner, "w") as z:
                        z.writestr(f"PRIVATE_{password}/payload.log", raw)
                    raw = inner.getvalue()
                    if shape == "nested_zip":
                        outer = io.BytesIO()
                        with zipfile.ZipFile(outer, "w") as z:
                            z.writestr("inner.zip", raw)
                        raw = outer.getvalue()
                path = self.artifacts / (
                    "fixture.zip" if "zip" in shape else "fixture.bin"
                )
                path.write_bytes(raw)
                diag = self.report()["first_uri_diagnostic"]
                encoded = json.dumps(diag)
                self.assertNotIn(hashlib.sha256(raw).hexdigest(), encoded)
                self.assertNotIn(hashlib.sha256(uri.encode()).hexdigest(), encoded)
                self.assertNotIn("PRIVATE_", encoded)
                self.assertFalse(
                    set(diag)
                    & {
                        "file_sha256",
                        "bytes",
                        "raw_start",
                        "raw_end_exclusive",
                        "normalized_record_offset",
                        "entry",
                        "suffix",
                        "value_sha256",
                    }
                )
                diagnostics.append(diag)
                path.unlink()
            self.assertTrue(all(d == diagnostics[0] for d in diagnostics), shape)

    def test_diagnostic_faults_preserve_original_counts_without_exception_text(self):
        (self.artifacts / "fixture.log").write_text(
            "postgres://PRIVATE_USER:PRIVATE_PASS@host/db"
        )
        baseline = self.report()
        baseline.pop("first_uri_diagnostic")
        for error in (ValueError, RuntimeError, KeyError, MemoryError, TypeError):
            with (
                self.subTest(error=error.__name__),
                patch.object(
                    artifact_audit,
                    "uri_diagnostic",
                    side_effect=error("PRIVATE_EXCEPTION"),
                ),
            ):
                report = self.report()
                self.assertEqual(
                    report.pop("first_uri_diagnostic"),
                    {"status": "DIAGNOSTIC_UNAVAILABLE"},
                )
                self.assertEqual(report, baseline)
                self.assertGreater(report["db_credentials"], 0)
                self.assertNotIn("PRIVATE", json.dumps(report))

    def test_observer_mutations_cannot_publish_arbitrary_metadata_or_suppress_counts(
        self,
    ):
        (self.artifacts / "fixture.log").write_text("postgres://user:password@host/db")
        base = {"stream": "ascii_projection", "record_kind": "uri_userinfo"}
        mutations = [
            None,
            {},
            [],
            {**base, "suffix": ".PRIVATE_PASSWORD"},
            {**base, "value_sha256": hashlib.sha256(b"password").hexdigest()},
            {**base, "png_source_chunks": ["PASS"]},
            {**base, "png_source_chunks": ["tEXt"] * 9},
            {**base, "location_class": "PRIVATE_PATH"},
            {**base, "source_contiguous": 8},
            {**base, "format": object()},
            {**base, "bytes": 42},
        ]
        expected = self.report()
        expected.pop("first_uri_diagnostic")
        for mutation in mutations:
            with (
                self.subTest(mutation_type=type(mutation).__name__),
                patch.object(artifact_audit, "uri_diagnostic", return_value=mutation),
            ):
                report = self.report()
                self.assertEqual(
                    report.pop("first_uri_diagnostic"),
                    {"status": "DIAGNOSTIC_UNAVAILABLE"},
                )
                self.assertEqual(report, expected)

    def test_untrusted_png_chunk_names_and_suffixes_are_never_public(self):
        raw = self.png(b"postgres://user:password@host/db")
        raw = raw.replace(
            b"tEXt", b"PASS"
        )  # Deliberately invalid CRC remains a boolean.
        (self.artifacts / "PRIVATE_PATH.PRIVATE_SUFFIX").write_bytes(raw)
        report = self.report()
        diag = report["first_uri_diagnostic"]
        self.assertEqual(diag["png_source_chunks"], ["other"])
        self.assertFalse(diag["png_crc_valid"])
        self.assertNotIn("PRIVATE", json.dumps(diag))
        self.assertNotIn("PASS", json.dumps(diag))

    def test_projection_diagnostic_observes_but_cannot_change_rejection(self):
        raw = self.png(b"h\xfftt\xffps\xff://DIAG_USER@invalid.example/")
        (self.artifacts / "fixture.png").write_bytes(raw)
        san.sanitize(self.artifacts, self.secret_file)
        with self.assertRaisesRegex(ValueError, "credential audit failed") as caught:
            artifact_audit.audit(self.artifacts, self.secret_file)
        report = json.loads(str(caught.exception).split(": ", 1)[1])
        diag = report["first_uri_diagnostic"]
        self.assertEqual(report["db_credentials"], 1)
        self.assertEqual(diag["stream"], "ascii_projection")
        self.assertFalse(diag["source_contiguous"])
        self.assertTrue(diag["png_crc_valid"])
        self.assertEqual(diag["png_source_chunks"], ["tEXt"])
        self.assertNotIn("DIAG_USER", str(caught.exception))

    def test_nested_diagnostic_keeps_archive_names_and_credentials_private(self):
        raw = "postgres://DIAG_USER:DIAG_PASSWORD@invalid.example/".encode("utf-16")
        with zipfile.ZipFile(self.artifacts / "trace.zip", "w") as archive:
            archive.writestr("DIAG_PRIVATE_PATH/payload.network", raw)
        with self.assertRaisesRegex(ValueError, "credential audit failed") as caught:
            artifact_audit.audit(self.artifacts, self.secret_file)
        message = str(caught.exception)
        self.assertNotIn("DIAG_USER", message)
        self.assertNotIn("DIAG_PASSWORD", message)
        self.assertNotIn("DIAG_PRIVATE_PATH", message)
        self.assertGreater(json.loads(message.split(": ", 1)[1])["db_credentials"], 0)
        self.sanitize()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        self.known = "fixture P@ss+/word?=&"
        self.secret_file = self.root / "secrets.json"
        self.secret_file.write_text(
            json.dumps([self.known, "entry-secret-A", "entry-secret-B"])
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_opaque_bearer_trace_values_and_marker_suffixes_are_fully_redacted(self):
        # Trace source/resources can contain template syntax and opaque values,
        # not only base64url-shaped tokens. The independent audit must keep
        # rejecting them; redaction must consume the complete value instead.
        source = (
            'const a="Bearer ${OPAQUE_AUTH}"; '
            'const b="Bearer ".concat(auth); '
            'const c="Bearer %OPAQUE_AUTH%"; '
            'const d="Bearer [REDACTED]OPAQUE_SUFFIX"; '
            "status=503; stage=uploading"
        )
        path = self.artifacts / "browser-resource.js"
        path.write_text(source)
        with zipfile.ZipFile(self.artifacts / "trace.zip", "w") as archive:
            archive.writestr("resources/browser.js", source)
        with self.assertRaisesRegex(ValueError, "credential audit failed"):
            artifact_audit.audit(self.artifacts, self.secret_file)
        self.sanitize()
        result = path.read_text()
        self.assertNotIn("OPAQUE_AUTH", result)
        self.assertNotIn("OPAQUE_SUFFIX", result)
        self.assertIn("status=503", result)
        self.assertIn("stage=uploading", result)
        self.sanitize()
        self.assertEqual(path.read_text(), result)

    def sanitize(self):
        san.sanitize(self.artifacts, self.secret_file)
        self.assertEqual(
            artifact_audit.audit(self.artifacts, self.secret_file)["secret"], 0
        )

    def test_minified_trace_assets_redact_complete_assignment_boundaries(self):
        # Real browser trace resources include source bundles. Adjacent quoted
        # expressions and += must not leave material attached to the marker.
        source = (
            'cannotHaveUsernamePasswordPort:function(){return "file"===this.scheme},'
            'credentials="same-origin",'
            'withCredentials:"omit"===o.credentials,'
            'document.cookie="editagent_csrf="+value;'
            'password+=STATIC_PASSWORD;token="STATIC_TOKEN";'
            '"password"===type&&"textarea"===tag;'
            '"credentialless":case"default":case"defer":break;'
            '"use-credentials"===mode?"":void 0;status=503;stage=uploading'
        )
        path = self.artifacts / "resource.js"
        path.write_text(source)
        with zipfile.ZipFile(self.artifacts / "trace.zip", "w") as archive:
            archive.writestr("resources/browser.js", source)
        with self.assertRaisesRegex(ValueError, "credential audit failed"):
            artifact_audit.audit(self.artifacts, self.secret_file)
        self.sanitize()
        result = path.read_text()
        self.assertNotIn("STATIC_PASSWORD", result)
        self.assertNotIn("STATIC_TOKEN", result)
        self.assertIn("status=503", result)
        self.assertIn("stage=uploading", result)
        once = path.read_bytes()
        self.sanitize()
        self.assertEqual(path.read_bytes(), once)
        with zipfile.ZipFile(self.artifacts / "trace.zip") as archive:
            self.assertIsNone(archive.testzip())
            self.assertNotIn(b"STATIC_PASSWORD", archive.read("resources/browser.js"))

    def test_structured_presigned_and_name_value_pairs(self):
        keys = [
            "X-Amz-Signature",
            "x-amz-credential",
            "X-Amz-Security-Token",
            "X-Amz-Date",
            "X-Amz-Algorithm",
            "X-Amz-Expires",
            "Signature",
            "AWSAccessKeyId",
            "authorization",
            "cookie",
            "set-cookie",
            "password",
            "passwd",
            "secret",
            "token",
            "access_token",
            "refresh_token",
            "csrf",
            "credential",
            "api_key",
            "apikey",
        ]
        path = self.artifacts / "trace.network"
        path.write_text(
            json.dumps(
                {
                    "request": {
                        "queryString": [
                            {"name": key, "value": "REAL_SECRET_VALUE", "status": 200}
                            for key in keys
                        ]
                    },
                    "status": 503,
                    "jobStatus": "Queued",
                    "path": "/projects/media",
                }
            )
        )
        with self.assertRaisesRegex(ValueError, "credential audit failed"):
            artifact_audit.audit(self.artifacts, self.secret_file)
        self.sanitize()
        result = json.loads(path.read_text())
        pairs = result["request"]["queryString"]
        self.assertEqual([p["name"] for p in pairs], keys)
        self.assertTrue(all(p["value"] == "[REDACTED]" for p in pairs))
        self.assertNotIn("REAL_SECRET_VALUE", path.read_text())
        self.assertEqual(result["status"], 503)
        self.assertEqual(result["jobStatus"], "Queued")
        self.assertEqual(result["path"], "/projects/media")

    def test_text_uri_fragment_encoded_and_nested_json(self):
        uri_schemes = [
            "postgresql",
            "postgres",
            "redis",
            "rediss",
            "mysql",
            "mongodb",
            "mongodb+srv",
            "s3",
            "http",
            "https",
        ]
        variants = [
            self.known,
            quote(self.known, safe=""),
            quote_plus(self.known, safe=""),
            base64.b64encode(self.known.encode()).decode(),
            base64.urlsafe_b64encode(self.known.encode()).decode().rstrip("="),
        ]
        body = base64.b64encode(
            b"password=FORM_PASSWORD&token=FORM_TOKEN&stage=uploading"
        ).decode()
        path = self.artifacts / "trace.json"
        path.write_text(
            json.dumps(
                {
                    "unexpected": "bEaReR OPAQUE_BEARER_TOKEN",
                    "message": "stage=uploading password=TEXT_PASSWORD; token: TEXT_TOKEN status=503",
                    "uris": [
                        f"{scheme}://dbuser:DB_PASSWORD@host/db?mode=read#token=FRAGMENT_TOKEN"
                        for scheme in uri_schemes
                    ],
                    "presigned": "https://storage.test/object?ok=1&X-Amz-Signature=URL_SIGNATURE&X-Amz-Credential=URL_CREDENTIAL#access_token=FRAGMENT_TOKEN",
                    "variants": variants,
                    "payload": {"body": body},
                    "nested": json.dumps(
                        {
                            "inner": json.dumps(
                                {
                                    "queryString": [
                                        {
                                            "name": "X-Amz-Signature",
                                            "value": "NESTED_SIGNATURE",
                                        }
                                    ],
                                    "status": "Queued",
                                }
                            )
                        }
                    ),
                }
            )
        )
        raw = self.artifacts / "service.log"
        raw.write_text(
            "worker stage=probing password: 'TEXT_PASSWORD' token=TEXT_TOKEN&signature=RAW_SIGNATURE; status=503\n"
        )
        self.sanitize()
        result = json.loads(path.read_text())
        combined = path.read_text() + raw.read_text()
        for secret in variants + [
            "OPAQUE_BEARER_TOKEN",
            "TEXT_PASSWORD",
            "TEXT_TOKEN",
            "DB_PASSWORD",
            "dbuser:",
            "FRAGMENT_TOKEN",
            "URL_SIGNATURE",
            "URL_CREDENTIAL",
            "NESTED_SIGNATURE",
            "RAW_SIGNATURE",
        ]:
            self.assertNotIn(secret, combined)
        decoded = base64.b64decode(result["payload"]["body"]).decode()
        self.assertNotIn("FORM_PASSWORD", decoded)
        self.assertNotIn("FORM_TOKEN", decoded)
        self.assertIn("stage=uploading", decoded)
        self.assertIn("Bearer [REDACTED]", result["unexpected"])
        self.assertIn("status=503", combined)
        nested = json.loads(json.loads(result["nested"])["inner"])
        self.assertEqual(nested["queryString"][0]["value"], "[REDACTED]")
        self.assertEqual(nested["status"], "Queued")
        self.assertTrue(all("host/db" in u for u in result["uris"]))

    def test_zip_nested_names_collisions_and_binary_preservation(self):
        # Valid 1x1 PNG and a UTF-8-decodable binary blob (NUL is not text).
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII="
        )
        blob = b"\x00\x01\x02binary-evidence\x00"
        self.artifacts.joinpath("image.png").write_bytes(png)
        self.artifacts.joinpath("blob.bin").write_bytes(blob)
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, "w") as z:
            z.writestr(
                "nested/trace.json",
                json.dumps(
                    {
                        "queryString": [
                            {"name": "X-Amz-Signature", "value": "ZIP_SIGNATURE"}
                        ]
                    }
                ),
            )
            z.writestr("nested/service.log", "stage=staging token=ZIP_TOKEN status=503")
        archive = self.artifacts / "trace.zip"
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("inner.zip", inner.getvalue())
            z.writestr("dir/request-entry-secret-A.txt", "Bearer ZIP_BEARER")
            z.writestr("dir/request-entry-secret-B.txt", "password=ZIP_PASSWORD")
            z.writestr("screenshots/image.png", png)
            z.writestr("data/blob.bin", blob)
        self.sanitize()
        self.assertEqual(self.artifacts.joinpath("image.png").read_bytes(), png)
        self.assertEqual(self.artifacts.joinpath("blob.bin").read_bytes(), blob)
        with zipfile.ZipFile(archive) as z:
            self.assertIsNone(z.testzip())
            self.assertEqual(len(set(z.namelist())), len(z.namelist()))
            self.assertIn("dir/request-[REDACTED].txt", z.namelist())
            self.assertIn("dir/request-[REDACTED].txt.redacted-1", z.namelist())
            self.assertEqual(z.read("screenshots/image.png"), png)
            self.assertEqual(z.read("data/blob.bin"), blob)
            for name in z.namelist():
                self.assertNotIn("entry-secret", name)
                if name.endswith((".txt", ".redacted-1")):
                    self.assertNotIn(b"ZIP_BEARER", z.read(name))
                    self.assertNotIn(b"ZIP_PASSWORD", z.read(name))
            with zipfile.ZipFile(io.BytesIO(z.read("inner.zip"))) as nested:
                self.assertIsNone(nested.testzip())
                self.assertNotIn(b"ZIP_SIGNATURE", nested.read("nested/trace.json"))
                self.assertNotIn(b"ZIP_TOKEN", nested.read("nested/service.log"))
                self.assertIn(b"status=503", nested.read("nested/service.log"))

    def test_unsafe_archive_fails_closed(self):
        raw = b"token=DEPTH_SECRET"
        for _ in range(4):
            out = io.BytesIO()
            with zipfile.ZipFile(out, "w") as z:
                z.writestr("inner.zip", raw)
            raw = out.getvalue()
        archive = self.artifacts / "deep.zip"
        archive.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "nesting"):
            self.sanitize()
        with self.assertRaisesRegex(ValueError, "nesting"):
            artifact_audit.audit(self.artifacts, self.secret_file)
        self.assertEqual(archive.read_bytes(), raw)
        archive.unlink()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("large.txt", "x" * (san.MAX_EXPANDED_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "expanded bytes"):
            self.sanitize()
        with self.assertRaisesRegex(ValueError, "expanded-byte"):
            artifact_audit.audit(self.artifacts, self.secret_file)

    def test_ansi_controls_and_independent_audit_canary(self):
        path = self.artifacts / "services.log"
        source = (
            "\x1b[2Kapi | \x1b[31mpassword=ANSI_PASSWORD\x1b[0m status=500 "
            "token=ANSI_TOKEN X-Amz-Signature=ANSI_SIGNATURE "
            "Bearer ANSI_BEARER editagent-dev-password\n"
            "\x1b]0;terminal title\x07worker | pass\bword=CONTROL_PASSWORD\x00 stage=probing\tstatus=503\r\n"
        )
        path.write_text(source)
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools/test/audit-artifacts.py"),
                str(self.artifacts),
            ],
            capture_output=True,
            check=False,
            timeout=10,
        )
        self.assertEqual(result.returncode, 1)
        print("AUDIT_WITHOUT_SANITIZER_EXIT_CODE", result.returncode)
        stats = san.sanitize(self.artifacts, self.secret_file)
        self.assertEqual(stats["servicesLogFilesFound"], 1)
        self.assertEqual(stats["servicesLogFilesSanitized"], 1)
        report = artifact_audit.audit(self.artifacts, self.secret_file)
        self.assertEqual(report["secret"], 0)
        self.assertEqual(report["servicesLogFilesAudited"], 1)
        value = path.read_text()
        for canary in (
            "ANSI_PASSWORD",
            "ANSI_TOKEN",
            "ANSI_SIGNATURE",
            "ANSI_BEARER",
            "editagent-dev-password",
            "CONTROL_PASSWORD",
            "\x1b",
            "\x00",
            "\b",
        ):
            self.assertNotIn(canary, value)
        self.assertIn("api |", value)
        self.assertIn("stage=probing", value)
        self.assertIn("status=500", value)
        self.assertIn("status=503", value)

    def test_text_encodings_never_bypass(self):
        cases = {
            "malformed.log": b"\xffapi | password=ENCODING_PASSWORD token=ENCODING_TOKEN status=500\xfe",
            "le.txt": ("api | password=ENCODING_PASSWORD status=500").encode("utf-16"),
            "be.log": b"\xfe\xff"
            + ("api | X-Amz-Signature=ENCODING_SIGNATURE status=500").encode(
                "utf-16-be"
            ),
        }
        for name, raw in cases.items():
            path = self.artifacts / name
            path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "credential audit failed"):
            artifact_audit.audit(self.artifacts, self.secret_file)
        self.sanitize()
        for name in cases:
            value = (self.artifacts / name).read_text(encoding="utf-8")
            self.assertNotIn("ENCODING_PASSWORD", value)
            self.assertNotIn("ENCODING_TOKEN", value)
            self.assertNotIn("ENCODING_SIGNATURE", value)
            self.assertIn("status=500", value)
        self.assertIn("\ufffd", (self.artifacts / "malformed.log").read_text())

    def test_alternate_pairs_and_quoted_plaintext_assignments(self):
        pairs = [
            {"key": "X-Amz-Signature", "val": "PAIR_SIGNATURE"},
            {"key": "password", "value": "PAIR_PASSWORD"},
            {"name": "token", "val": "PAIR_TOKEN"},
        ]
        path = self.artifacts / "pairs.json"
        path.write_text(json.dumps({"pairs": pairs, "status": 503}))
        log = self.artifacts / "quoted.log"
        log.write_text(
            'api | "password" : "QUOTED_PASSWORD" status=500\n'
            "worker | 'token' = 'QUOTED_TOKEN' stage=staging\n"
            'storage | "X-Amz-Signature":"QUOTED_SIGNATURE" status=403\n'
        )
        with self.assertRaisesRegex(ValueError, "credential audit failed"):
            artifact_audit.audit(self.artifacts, self.secret_file)
        self.sanitize()
        result = json.loads(path.read_text())
        self.assertEqual(result["pairs"][0]["val"], "[REDACTED]")
        self.assertEqual(result["pairs"][1]["value"], "[REDACTED]")
        self.assertEqual(result["pairs"][2]["val"], "[REDACTED]")
        self.assertEqual(result["status"], 503)
        for canary in ("QUOTED_PASSWORD", "QUOTED_TOKEN", "QUOTED_SIGNATURE"):
            self.assertNotIn(canary, log.read_text())
        self.assertIn("stage=staging", log.read_text())

    def test_malformed_archives_fail_closed_in_both_paths(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
            z.writestr("services.log", "CRC_PAYLOAD password=ARCHIVE_PASSWORD")
        valid = out.getvalue()
        crc_bad = bytearray(valid)
        crc_bad[valid.index(b"CRC_PAYLOAD")] ^= 1
        nested = io.BytesIO()
        with zipfile.ZipFile(nested, "w") as z:
            z.writestr("inner.zip", b"PK\x03\x04truncated")
        cases = [
            ("broken.zip", valid[:-22]),
            ("prefix.bin", b"PK\x03"),
            ("not-a-zip.zip", b"opaque bytes"),
            ("crc.zip", bytes(crc_bad)),
            ("nested.zip", nested.getvalue()),
        ]
        for name, raw in cases:
            with self.subTest(name=name):
                path = self.artifacts / name
                path.write_bytes(raw)
                for action in (san.sanitize, artifact_audit.audit):
                    with self.assertRaises(
                        (ValueError, zipfile.BadZipFile, RuntimeError)
                    ):
                        action(self.artifacts, self.secret_file)
                self.assertEqual(path.read_bytes(), raw)
                path.unlink()

    def test_binary_known_secret_is_detected_without_lossy_sanitization(self):
        path = self.artifacts / "blob.bin"
        raw = b"\x00\x01" + self.known.encode() + b"\x00\xff"
        path.write_bytes(raw)
        san.sanitize(self.artifacts, self.secret_file)
        self.assertEqual(path.read_bytes(), raw)
        with self.assertRaisesRegex(ValueError, "credential audit failed"):
            artifact_audit.audit(self.artifacts, self.secret_file)

    def test_redaction_markers_remain_stable_and_audit_rejects_suffix_secrets(self):
        path = self.artifacts / "services.log"
        path.write_text(
            "api | password=MARKER_PASSWORD token=MARKER_TOKEN status=500\n"
        )
        self.sanitize()
        first = path.read_bytes()
        self.sanitize()
        self.sanitize()
        self.assertEqual(path.read_bytes(), first)
        path.write_text("api | token=[REDACTED]SUFFIX_SECRET status=500")
        with self.assertRaisesRegex(ValueError, "credential audit failed"):
            artifact_audit.audit(self.artifacts, self.secret_file)

    def test_unknown_opaque_format_fails_publication(self):
        (self.artifacts / "unknown-resource").write_bytes(b"\xff\x00\x01opaque")
        with self.assertRaisesRegex(ValueError, "safely classified"):
            san.sanitize(self.artifacts, self.secret_file)

    @staticmethod
    def unsafe_zip_cases():
        name = "PRIVATE_USER:PRIVATE_PASSWORD@PRIVATE_HOST/entry.network"
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as archive:
            archive.writestr(name, b"PRIVATE_PAYLOAD")
        valid = out.getvalue()
        crc = bytearray(valid)
        crc[valid.index(b"PRIVATE_PAYLOAD")] ^= 1
        encrypted = bytearray(valid)
        encrypted[6] |= 1
        central = valid.index(b"PK\x01\x02")
        encrypted[central + 8] |= 1
        mismatch = bytearray(valid)
        mismatch[valid.index(name.encode())] ^= 1
        unsupported = bytearray(valid)
        unsupported[8:10] = (99).to_bytes(2, "little")
        unsupported[central + 10 : central + 12] = (99).to_bytes(2, "little")
        nested = io.BytesIO()
        with zipfile.ZipFile(nested, "w") as archive:
            archive.writestr("inner.zip", bytes(crc))
        return {
            "crc": (bytes(crc), "ARTIFACT_ARCHIVE_INVALID"),
            "encrypted": (bytes(encrypted), "ARTIFACT_ARCHIVE_ENCRYPTED"),
            "mismatch": (bytes(mismatch), "ARTIFACT_ARCHIVE_INVALID"),
            "unsupported": (bytes(unsupported), "ARTIFACT_ARCHIVE_INVALID"),
            "truncated": (valid[:-22], "ARTIFACT_ARCHIVE_INVALID"),
            "nested": (nested.getvalue(), "ARTIFACT_ARCHIVE_INVALID"),
            "not_zip": (b"PRIVATE_PASSWORD not a zip", "ARTIFACT_ARCHIVE_INVALID"),
        }

    def assert_private_failure(self, result, category):
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, (category + os.linesep).encode())
        for canary in (
            "PRIVATE_USER",
            "PRIVATE_PASSWORD",
            "PRIVATE_HOST",
            "PRIVATE_PAYLOAD",
            "PRIVATE_PATH",
        ):
            for encoded in (
                canary.encode(),
                canary.encode().hex().encode(),
                base64.b64encode(canary.encode()),
                quote(canary, safe="").encode(),
            ):
                self.assertNotIn(encoded, result.stdout + result.stderr)
        self.assertNotIn(b"Traceback", result.stderr)

    def private_cli(self, script, *extra, node=False):
        args = [
            sys.executable,
            str(ROOT / "tools/test" / script),
            str(self.artifacts),
            *extra,
        ]
        if node:
            executable = shutil.which("node")
            self.assertIsNotNone(
                executable, "Node is required for the actual inherit-stdio wrapper"
            )
            args = [
                executable,
                "-e",
                "const r=require('node:child_process').spawnSync(process.argv[1],process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1)",
                *args,
            ]
        return subprocess.run(args, capture_output=True, check=False, timeout=15)

    def test_real_cli_zip_errors_are_fixed_and_never_disclose_member_credentials(self):
        for name, (raw, category) in self.unsafe_zip_cases().items():
            for script in ("audit-artifacts.py", "sanitize-artifacts.py"):
                with self.subTest(case=name, script=script):
                    path = self.artifacts / "PRIVATE_PATH.zip"
                    path.write_bytes(raw)
                    self.assert_private_failure(self.private_cli(script), category)
                    self.assertEqual(path.read_bytes(), raw)
                    path.unlink()

    def test_node_inherit_stdio_does_not_reintroduce_archive_exception_leaks(self):
        for name, (raw, category) in self.unsafe_zip_cases().items():
            for script in ("audit-artifacts.py", "sanitize-artifacts.py"):
                with self.subTest(case=name, script=script):
                    path = self.artifacts / "PRIVATE_PATH.zip"
                    path.write_bytes(raw)
                    self.assert_private_failure(
                        self.private_cli(script, node=True), category
                    )
                    path.unlink()

    def test_real_filesystem_errors_do_not_disclose_secret_file_paths(self):
        # Reading a directory as a secret file fails on both Windows and Linux.
        private = self.root / "PRIVATE_PATH_PRIVATE_PASSWORD"
        private.mkdir()
        for script in ("audit-artifacts.py", "sanitize-artifacts.py"):
            for node in (False, True):
                with self.subTest(script=script, node=node):
                    self.assert_private_failure(
                        self.private_cli(
                            script, "--secret-file", str(private), node=node
                        ),
                        "ARTIFACT_IO_FAILED",
                    )

    def test_library_io_exceptions_are_safe_even_when_the_original_message_is_malicious(
        self,
    ):
        path = self.artifacts / "PRIVATE_PATH.log"
        path.write_text("clean")
        for action in (san.sanitize, artifact_audit.audit):
            for error in (PermissionError, OSError, FileNotFoundError):
                with (
                    self.subTest(action=action.__name__, error=error.__name__),
                    patch.object(
                        Path,
                        "read_bytes",
                        side_effect=error("PRIVATE_PASSWORD PRIVATE_PATH"),
                    ),
                ):
                    with self.assertRaisesRegex(
                        ValueError, "^ARTIFACT_IO_FAILED$"
                    ) as caught:
                        action(self.artifacts)
                    self.assertTrue(caught.exception.__suppress_context__)

    def test_cli_argument_errors_do_not_echo_private_arguments(self):
        for script in ("audit-artifacts.py", "sanitize-artifacts.py"):
            self.assert_private_failure(
                self.private_cli(script, "--PRIVATE_PASSWORD"),
                "ARTIFACT_ARGUMENT_INVALID",
            )

    def test_real_cli_success_and_credential_rejection_still_use_original_counts(self):
        for script in ("audit-artifacts.py", "sanitize-artifacts.py"):
            result = self.private_cli(script)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stderr, b"")
        (self.artifacts / "services.log").write_text(
            "postgres://PRIVATE_USER:PRIVATE_PASSWORD@PRIVATE_HOST/db"
        )
        expected = self.report()
        result = self.private_cli("audit-artifacts.py")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(json.loads(result.stderr.decode().split(": ", 1)[1]), expected)
        self.assertNotIn(b"PRIVATE", result.stderr)

    def test_6079_reference_decisions_and_counters_are_unchanged(self):
        corpus_spec = importlib.util.spec_from_file_location(
            "audit_decision_corpus",
            Path(__file__).with_name("audit-decision-corpus.py"),
        )
        corpus = importlib.util.module_from_spec(corpus_spec)
        corpus_spec.loader.exec_module(corpus)
        count, totals, digest = corpus.decisions(artifact_audit)
        # Captured from b9484e0922daa7860f30bb3bd088f3cfbc46ca89,
        # auditor SHA-256 88060ade27ef276b7523a5f844d8b64087d6b9408fda6c8c7dab6e4b23cfa2b2.
        # Hashes here cover synthetic decision/counter records, never private
        # evidence, credentials or the public diagnostic payload.
        self.assertEqual(count, 6079)
        self.assertEqual(totals, {"accept": 530, "reject": 4038, "closed": 1511})
        self.assertEqual(
            digest, "7c44aaffff2a15016b22b27ceeb25da5472d39c10ab8ce6eb1cc3eb783c5eff8"
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
