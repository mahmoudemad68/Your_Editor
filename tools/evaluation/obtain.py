"""Download pinned licensed source representations; no media decoder network access."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def check_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "upload.wikimedia.org"
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Source URL must be unsigned HTTPS on upload.wikimedia.org")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[2]
    subprocess.run(
        ["node", str(repository / "tools/evaluation/validate.mjs")],
        check=True,
        cwd=repository,
        shell=False,
    )
    manifest = json.loads((repository / "docs/evaluation/manifest.json").read_text())
    args.root.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(SafeRedirect())
    for source in manifest["sources"]:
        # IDs/extensions are checked independently before any path is constructed.
        if not re.fullmatch(r"[a-z][a-z0-9-]{2,79}", source["id"]) or source[
            "extension"
        ] not in ("webm", "ogv", "mp4"):
            raise ValueError("Unsafe source identity")
        url = source["source"]["downloadUrl"]
        check_url(url)
        path = args.root / (source["id"] + "." + source["extension"])
        if path.is_symlink():
            raise ValueError("Source files must not be symlinks")
        if path.exists():
            if digest(path) != source["sha256"] or path.stat().st_size != int(
                source["sizeBytes"]
            ):
                raise ValueError("Existing source differs: " + source["id"])
            print("REUSED", source["id"])
            continue
        temporary = path.with_suffix(path.suffix + ".partial")
        request = urllib.request.Request(
            url, headers={"User-Agent": "YourEditorEvaluation/1.0"}
        )
        try:
            with (
                opener.open(request, timeout=120) as response,
                temporary.open("xb") as output,
            ):
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > int(source["sizeBytes"]) or size > 512 * 1024 * 1024:
                        raise ValueError("Source exceeds pinned download size")
                    output.write(chunk)
            if digest(temporary) != source["sha256"] or size != int(
                source["sizeBytes"]
            ):
                raise ValueError("Downloaded identity differs: " + source["id"])
            os.replace(temporary, path)
            print("OBTAINED", source["id"])
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
