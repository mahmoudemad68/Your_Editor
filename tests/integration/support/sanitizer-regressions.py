"""End-to-end sanitizer fixtures exercise the publication entry point."""

import base64
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
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

    def sanitize(self):
        san.sanitize(self.artifacts, self.secret_file)
        self.assertEqual(
            artifact_audit.audit(self.artifacts, self.secret_file)["secret"], 0
        )

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
                "python3",
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

    def test_unknown_opaque_format_fails_publication(self):
        (self.artifacts / "unknown-resource").write_bytes(b"\xff\x00\x01opaque")
        with self.assertRaisesRegex(ValueError, "safely classified"):
            san.sanitize(self.artifacts, self.secret_file)


if __name__ == "__main__":
    unittest.main(verbosity=2)
