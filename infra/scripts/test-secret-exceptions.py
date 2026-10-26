"""Exercise the six reviewed history exceptions without storing credential literals."""

import base64
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_IGNORE_SHA256 = (
    "3eddba83701c1d63d7d7cab7b45eda5b9b8280e15a89904a269e391228265a7f"
)


def main() -> None:
    scanner = sys.argv[1] if len(sys.argv) == 2 else "gitleaks"
    version = subprocess.run(
        [scanner, "version"], check=True, capture_output=True, text=True
    )
    assert version.stdout.strip() == "8.30.1", "Unexpected scanner version"
    ignore = (ROOT / ".gitleaksignore").read_bytes()
    assert hashlib.sha256(ignore).hexdigest() == EXPECTED_IGNORE_SHA256, (
        "Exception inventory changed; requires scoped security review"
    )
    assert len(ignore.splitlines()) == 6
    with tempfile.TemporaryDirectory(prefix="editagent-exception-test-") as temp:
        directory = Path(temp)
        shutil.copyfile(ROOT / ".gitleaksignore", directory / ".gitleaksignore")

        def git(*args: str) -> None:
            subprocess.run(
                ["git", *args], cwd=directory, check=True, capture_output=True
            )

        def commit() -> None:
            git("add", ".")
            git(
                "-c",
                "user.name=Exception control",
                "-c",
                "user.email=test@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "disposable generated control",
            )

        def scan(expected_exit: int) -> list[dict]:
            report = Path(temp).parent / (directory.name + "-report.json")
            try:
                result = subprocess.run(
                    [
                        scanner,
                        "detect",
                        "--source",
                        str(directory),
                        "--redact",
                        "--config",
                        str(ROOT / ".gitleaks.toml"),
                        "--report-path",
                        str(report),
                        "--report-format",
                        "json",
                        "--exit-code",
                        "1",
                    ],
                    cwd=directory,
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
                # Do not print scanner output or matched values, even on failure.
                assert result.returncode == expected_exit, "Unexpected scan status"
                return json.loads(report.read_text())
            finally:
                report.unlink(missing_ok=True)

        git("init", "-q")
        # Independent new positive control, generated only in disposable history.
        secret = "ghp_" + "FreshExceptionControl0123456789" * 2
        control = directory / "control.txt"
        control.write_text("github_token=" + secret + "\n", encoding="utf-8")
        commit()
        first = scan(1)
        assert first and any(x["RuleID"] == "github-pat" for x in first)
        first_fingerprints = {x["Fingerprint"] for x in first}
        assert not first_fingerprints.intersection(ignore.decode().splitlines())

        # Prove the pinned scanner actually consumes exact fingerprint ignores.
        temporary_ignores = (
            ignore.decode() + "\n".join(sorted(first_fingerprints)) + "\n"
        )
        (directory / ".gitleaksignore").write_text(temporary_ignores, encoding="utf-8")
        assert scan(0) == []
        # A fingerprint for a different rule cannot hide this detection.
        wrong_rule = {
            x["Fingerprint"].replace(":" + x["RuleID"] + ":", ":unrelated-rule:")
            for x in first
        }
        (directory / ".gitleaksignore").write_text(
            ignore.decode() + "\n".join(sorted(wrong_rule)) + "\n", encoding="utf-8"
        )
        assert scan(1)
        (directory / ".gitleaksignore").write_text(temporary_ignores, encoding="utf-8")
        # Same value at another commit/line must still fail.
        control.write_text(
            "# moved\nnew_github_token=" + secret + "\n", encoding="utf-8"
        )
        commit()
        moved = scan(1)
        assert moved and all(x["Fingerprint"] not in first_fingerprints for x in moved)
        assert any(x["StartLine"] == 2 for x in moved)
        # Same value under a different path remains outside the exception.
        (directory / "other.txt").write_text(
            "github_token=" + secret + "\n", encoding="utf-8"
        )
        commit()
        assert any(x["File"] == "other.txt" for x in scan(1))

        # Fresh JWT-shaped synthetic data at the reviewed QA coordinates remains
        # detectable. Historical matched values are never read or reconstructed.
        def encoded(value: dict) -> str:
            return (
                base64.urlsafe_b64encode(json.dumps(value).encode())
                .decode()
                .rstrip("=")
            )

        token = (
            encoded({"alg": "HS256", "typ": "JWT"})
            + "."
            + encoded({"sub": "new-disposable-positive-control"})
            + "."
            + base64.urlsafe_b64encode(b"not-a-valid-signature").decode().rstrip("=")
        )
        qa = directory / "qa/pr84"
        qa.mkdir(parents=True)
        (qa / "pg84.spec.ts").write_text(
            "\n" * 184 + 'token="' + token + '"\n', encoding="utf-8"
        )
        generic = hashlib.sha256(b"disposable-generic-positive-control").hexdigest()
        (qa / "lib84.mjs").write_text(
            "\n" * 320
            + 'api_key="'
            + generic
            + '"\n'
            + "\n" * 4
            + 'api_key="'
            + generic
            + '"\n',
            encoding="utf-8",
        )
        (directory / ".gitleaksignore").write_bytes(ignore)
        commit()
        final = scan(1)
        assert any(
            x["File"] == "qa/pr84/pg84.spec.ts"
            and x["StartLine"] == 185
            and x["RuleID"] == "jwt"
            for x in final
        )
        assert any(x["File"] == "control.txt" for x in final)
        for line in (321, 326):
            assert any(
                x["File"] == "qa/pr84/lib84.mjs"
                and x["StartLine"] == line
                and x["RuleID"] == "generic-api-key"
                for x in final
            )
    print(
        "SECRET_EXCEPTION_CONTROLS PASS: exact six; fresh secret; exact-match loading; moved commit/line/path; fresh QA-coordinate JWT"
    )


if __name__ == "__main__":
    main()
