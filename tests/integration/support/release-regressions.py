"""Release/CD proofs operate only in temporary stores and fake command targets."""

import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra/scripts"))
import release_manifest as manifest
import staging_release as deploy
import staging_smoke as smoke


class ReleaseRegression(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "shared").mkdir()
        (self.root / "shared/runtime.env").write_text(
            "\n".join(
                [
                    "POSTGRES_PASSWORD=isolated-test-only",
                    "S3_ACCESS_KEY_ID=test-only",
                    "S3_SECRET_ACCESS_KEY=isolated-test-only",
                    "AUTH_JWT_SECRET=" + "t" * 40,
                    "AUTH_TRUSTED_ORIGINS=https://app.example.test",
                    "S3_PUBLIC_ENDPOINT=https://objects.example.test",
                    "SEAWEED_SECRET_DIR=/tmp/test-only-storage",
                ]
            )
        )
        self.directory = self.release("a" * 40)

    def tearDown(self):
        self.temporary.cleanup()

    def release(self, sha):
        directory = self.root / "releases" / sha
        directory.mkdir(parents=True)
        records = []
        for service in manifest.SERVICES:
            sbom = f"sbom-{service}.spdx.json"
            content = json.dumps({"spdxVersion": "SPDX-2.3", "name": service}).encode()
            (directory / sbom).write_bytes(content)
            records.append(
                {
                    "service": service,
                    "gitSha": sha,
                    "image": f"ghcr.io/example/editor-{service}",
                    "tag": f"sha-{sha}",
                    "digest": "sha256:" + "b" * 64,
                    "scannedImageId": "sha256:" + "c" * 64,
                    "sbom": sbom,
                    "sbomSha256": hashlib.sha256(content).hexdigest(),
                }
            )
        (directory / "release.json").write_text(
            json.dumps({"schemaVersion": 1, "gitSha": sha, "images": records})
        )
        return directory

    def test_manifest_complete_immutable_sbom_binding_and_failures(self):
        data = manifest.load_release(self.directory / "release.json")
        self.assertEqual(len(manifest.image_environment(data)), 9)
        self.assertTrue(
            all("@sha256:" in v for v in manifest.image_environment(data).values())
        )
        for field, bad in [
            ("tag", "main"),
            ("digest", "latest"),
            ("gitSha", "d" * 40),
            ("service", "test-minio"),
            ("sbom", "../private.json"),
        ]:
            with self.subTest(field=field):
                record = {**data["images"][0], field: bad}
                with self.assertRaises(ValueError):
                    manifest.validate_record(record, data["gitSha"], self.directory)
        (self.directory / data["images"][0]["sbom"]).write_text("{}")
        with self.assertRaisesRegex(ValueError, "SBOM hash"):
            manifest.load_release(self.directory / "release.json")

    def test_deploy_and_rollback_dry_run_never_execute_commands_or_change_current(self):
        prior = self.release("d" * 40)
        (self.root / "current").symlink_to(prior)
        (self.root / "previous").symlink_to(prior)
        output = io.StringIO()
        with (
            patch.object(
                deploy.subprocess,
                "run",
                side_effect=AssertionError("Dry run executed a command"),
            ),
            contextlib.redirect_stdout(output),
        ):
            deploy.deploy(self.root, self.directory, dry=True)
            deploy.deploy(self.root, (self.root / "previous").resolve(), dry=True)
        self.assertEqual((self.root / "current").resolve(), prior)
        self.assertNotIn(" build ", output.getvalue())
        self.assertIn("apply-host-isolation.sh --check", output.getvalue())
        self.assertIn("apply-container-firewall.sh", output.getvalue())
        self.assertIn("STAGING_PIPELINE_DRY_RUN PASS", output.getvalue())
        self.assertNotIn("isolated-test-only", output.getvalue())
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "infra/scripts/staging_release.py"),
                "rollback",
                "--root",
                str(self.root),
                "--dry-run",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("STAGING_PIPELINE_DRY_RUN PASS", result.stdout)

    def test_success_records_prior_identity_failure_cannot_activate(self):
        prior = self.release("d" * 40)
        (self.root / "current").symlink_to(prior)
        deploy.activate(self.root, self.directory)
        self.assertEqual((self.root / "previous").resolve(), prior)
        self.assertEqual((self.root / "current").resolve(), self.directory)
        deploy.activate(self.root, self.directory)
        self.assertEqual((self.root / "previous").resolve(), prior)
        with (
            patch.object(deploy, "run"),
            patch.object(deploy.subprocess, "check_output", return_value="a b c d"),
            patch.object(deploy, "smoke", side_effect=ValueError("not ready")),
            patch.object(deploy.subprocess, "run") as command,
        ):
            command.return_value.stdout = "[]"
            with self.assertRaises(ValueError):
                deploy.deploy(self.root, prior)
        self.assertEqual((self.root / "current").resolve(), self.directory)

    def test_smoke_rejects_missing_unhealthy_wrong_digest_wrong_sha_and_503(self):
        release = manifest.load_release(self.directory / "release.json")
        record = release["images"][0]
        good = {
            "State": {"Running": True, "Health": {"Status": "healthy"}},
            "Image": record["scannedImageId"],
            "Config": {
                "Image": record["image"] + "@" + record["digest"],
                "Labels": {"org.opencontainers.image.revision": release["gitSha"]},
            },
        }

        def commands(args):
            if args[1] == "inspect":
                return json.dumps([good])
            return "container" if "ps" in args else ""

        with patch.object(smoke, "command", side_effect=commands):
            smoke.check_once(release, ["api"])
            for mutation in ("unhealthy", "digest", "revision"):
                broken = json.loads(json.dumps(good))
                if mutation == "unhealthy":
                    broken["State"]["Health"]["Status"] = "unhealthy"
                if mutation == "digest":
                    broken["Config"]["Image"] = "mutable:main"
                if mutation == "revision":
                    broken["Config"]["Labels"]["org.opencontainers.image.revision"] = (
                        "wrong"
                    )
                with (
                    patch.object(
                        smoke,
                        "command",
                        side_effect=lambda args, broken=broken: (
                            json.dumps([broken])
                            if args[1] == "inspect"
                            else "container"
                        ),
                    ),
                    self.assertRaises(ValueError),
                ):
                    smoke.check_once(release, ["api"])
        with (
            patch.object(smoke, "command", return_value=""),
            self.assertRaisesRegex(ValueError, "Missing"),
        ):
            smoke.check_once(release, ["api"])
        with (
            patch.object(
                smoke, "command", side_effect=subprocess.CalledProcessError(1, "503")
            ),
            self.assertRaisesRegex(ValueError, "Staging smoke failed"),
        ):
            smoke.smoke(release, timeout=0)

    def test_runtime_credentials_required_and_not_evaluated(self):
        p = self.root / "shared/runtime.env"
        p.write_text("POSTGRES_PASSWORD=editagent-dev-password\n")
        with self.assertRaises(ValueError):
            deploy.runtime_environment(p)
        p.write_text("INVALID KEY=$(touch /tmp/not-executed)")
        with self.assertRaises(ValueError):
            deploy.runtime_environment(p)

    def test_publish_tag_digest_and_changed_sha_tag_guard(self):
        fake = self.root / "bin"
        fake.mkdir()
        docker = fake / "docker"
        docker.write_text("""#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
a=sys.argv[1:]
with open(os.environ['CALL_LOG'],'a') as f:f.write(json.dumps(a)+'\\n')
if a[:2]==['image','inspect']:
 if '.Id' in a[3]:print('sha256:'+'c'*64)
 elif 'revision' in a[3]:print(os.environ['GITHUB_SHA'])
 elif 'RepoDigests' in a[3]:print(json.dumps(['ghcr.io/example/editor-api@sha256:'+'b'*64]))
elif a[:2]==['manifest','inspect']:
 if os.environ.get('REMOTE_CHANGED'):print(json.dumps({'config':{'digest':'sha256:'+'d'*64}}))
 else:sys.stderr.write('no such manifest');sys.exit(1)
""")
        docker.chmod(0o755)
        work = self.root / "publish"
        work.mkdir()
        (work / "infra/scripts").mkdir(parents=True)
        (work / "infra/scripts/release_manifest.py").write_bytes(
            (ROOT / "infra/scripts/release_manifest.py").read_bytes()
        )
        (work / "sbom-api.spdx.json").write_bytes(
            (self.directory / "sbom-api.spdx.json").read_bytes()
        )
        env = {
            **os.environ,
            "PATH": str(fake) + ":" + os.environ["PATH"],
            "GITHUB_SHA": "a" * 40,
            "GITHUB_REPOSITORY": "Example/Editor",
            "CALL_LOG": str(self.root / "calls"),
        }
        result = subprocess.run(
            [str(ROOT / "infra/scripts/publish-release-image.sh"), "api"],
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads((work / "release/image-api.json").read_text())
        self.assertEqual(record["tag"], "sha-" + "a" * 40)
        self.assertEqual(record["digest"], "sha256:" + "b" * 64)
        calls = (self.root / "calls").read_text()
        self.assertNotIn("build", calls)
        self.assertEqual(sum('"push"' in line for line in calls.splitlines()), 2)
        env["REMOTE_CHANGED"] = "1"
        (self.root / "calls").write_text("")
        result = subprocess.run(
            [str(ROOT / "infra/scripts/publish-release-image.sh"), "api"],
            cwd=work,
            env=env,
            capture_output=True,
            timeout=15,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('"push"', (self.root / "calls").read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
