"""Portable installer regression: temporary APT files only; no shell/network/root."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = (ROOT / "tools/test/ensure-ffmpeg.sh").read_text(encoding="utf-8")
INLINE = SCRIPT.split("sudo python3 - <<'PY'\n", 1)[1].split("\nPY\n", 1)[0]


def rewrite(files: dict[str, str]) -> dict[str, str]:
    with tempfile.TemporaryDirectory(prefix="apt-mirror-test-") as directory:
        root = Path(directory)
        for name, content in files.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

        def local_path(value: str) -> Path:
            if not value.startswith("/etc/apt/"):
                raise AssertionError("Installer attempted an unexpected path")
            return root / value.removeprefix("/etc/apt/")

        with patch("pathlib.Path", side_effect=local_path):
            exec(compile(INLINE, str(ROOT / "tools/test/ensure-ffmpeg.sh"), "exec"), {})
        return {
            str(p.relative_to(root)).replace("\\", "/"): p.read_text(encoding="utf-8")
            for p in root.rglob("*")
            if p.is_file()
        }


class AptRuntimeInstallTests(unittest.TestCase):
    def test_runner_mirror_list_is_rewritten_with_priorities_preserved(self) -> None:
        sources = (
            "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\n"
            "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
        )
        original = {
            "sources.list.d/ubuntu.sources": sources,
            "apt-mirrors.txt": "http://azure.archive.ubuntu.com/ubuntu\tpriority:1\nhttp://archive.ubuntu.com/ubuntu\tpriority:2\n",
        }
        result = rewrite(original)
        self.assertEqual(result["sources.list.d/ubuntu.sources"], sources)
        self.assertEqual(
            result["apt-mirrors.txt"],
            "https://archive.ubuntu.com/ubuntu\tpriority:1\nhttps://archive.ubuntu.com/ubuntu\tpriority:2\n",
        )

    def test_security_mirror_and_deb822_signature_policy_are_preserved(self) -> None:
        source = (
            "Types: deb\nURIs: http://security.ubuntu.com/ubuntu\n"
            "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
        )
        result = rewrite(
            {
                "sources.list.d/security.sources": source,
                "apt-mirrors-security.txt": "http://security.ubuntu.com/ubuntu\tpriority:1\n",
            }
        )
        self.assertEqual(
            result["sources.list.d/security.sources"], source.replace("http://", "https://")
        )
        self.assertEqual(
            result["apt-mirrors-security.txt"], "https://security.ubuntu.com/ubuntu\tpriority:1\n"
        )

    def test_legacy_sources_and_unrelated_repositories_keep_their_policy(self) -> None:
        third_party = "deb http://packages.example.invalid/ubuntu stable main\n"
        result = rewrite(
            {
                "sources.list": "deb http://azure.archive.ubuntu.com/ubuntu noble main\n",
                "sources.list.d/third-party.list": third_party,
                "unrelated.txt": "http://azure.archive.ubuntu.com/ubuntu\n",
            }
        )
        self.assertEqual(
            result["sources.list"], "deb https://archive.ubuntu.com/ubuntu noble main\n"
        )
        self.assertEqual(result["sources.list.d/third-party.list"], third_party)
        self.assertEqual(result["unrelated.txt"], "http://azure.archive.ubuntu.com/ubuntu\n")

    def test_missing_sources_are_not_created_and_rewriting_is_idempotent(self) -> None:
        self.assertEqual(rewrite({}), {})
        once = rewrite({"apt-mirrors.txt": "http://azure.archive.ubuntu.com/ubuntu\tpriority:1\n"})
        self.assertEqual(rewrite(once), once)


if __name__ == "__main__":
    unittest.main()
