"""Fail artifact publication if retained evidence still contains credentials.

Inspect structured trace fields independently of sanitization, including decoded
bodies, nested serialized JSON and archive names. Print counts only, never values.
"""

import argparse
import base64
import importlib.util
import io
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import unquote_plus

spec = importlib.util.spec_from_file_location(
    "sanitize_artifacts", Path(__file__).with_name("sanitize-artifacts.py")
)
san = importlib.util.module_from_spec(spec)
spec.loader.exec_module(san)
KEY = re.compile(
    r"authorization|cookie|password|passwd|secret|token|credential|csrf|signature|x[-_]amz[-_]|api[-_]?key|awsaccesskeyid",
    re.IGNORECASE,
)
ASSIGNMENT = re.compile(
    r"(?i)([\w-]*(?:password|passwd|secret|token|credential|csrf|signature|x-amz-[\w-]*|api[_-]?key|awsaccesskeyid)[\w-]*\s*[=:]\s*)([^\s&;,\"'<>}]+)"
)
BEARER = re.compile(r"\bBearer\s+(\S+)", re.IGNORECASE)
URI_USER = re.compile(r"[a-z][a-z0-9+.-]*://([^/@\s]+)@", re.IGNORECASE)


def audit(directory: Path, secret_file: Path | None = None) -> dict:
    known = san.secret_variants(
        san.DEFAULT_SECRETS
        + (
            json.loads(secret_file.read_text())
            if secret_file and secret_file.exists()
            else []
        )
    )
    counts = {
        key: 0
        for key in (
            "secret",
            "x_amz_signature",
            "bearer",
            "password",
            "token",
            "db_credentials",
        )
    }
    entries = 0
    budget = [san.MAX_EXPANDED_BYTES]

    def safe(value):
        return value is None or value == "" or value == "[REDACTED]"

    def finding(key):
        counts["secret"] += 1
        if "signature" in key.lower():
            counts["x_amz_signature"] += 1
        elif "password" in key.lower() or "passwd" in key.lower():
            counts["password"] += 1
        elif "token" in key.lower() or "cookie" in key.lower() or "csrf" in key.lower():
            counts["token"] += 1

    def text(value):
        decoded = unquote_plus(value)
        if any(secret in value or secret in decoded for secret in known):
            finding("known")
        if san.JWT.search(value):
            finding("token")
        for match in BEARER.finditer(value):
            if not safe(match[1].strip("\"'.,}")):
                counts["bearer"] += 1
                finding("token")
        for match in URI_USER.finditer(value):
            if not safe(unquote_plus(match[1])):
                counts["db_credentials"] += 1
                finding("userinfo")
        for match in ASSIGNMENT.finditer(decoded):
            if not safe(
                match[2].rstrip("]")
                if not match[2].startswith("[REDACTED]")
                else "[REDACTED]"
            ):
                finding(match[1])

    def structured(value, depth=0):
        if depth > san.MAX_JSON_DEPTH:
            raise ValueError("Artifact audit nesting exceeds safe limit")
        if isinstance(value, dict):
            if (
                isinstance(value.get("name"), str)
                and KEY.search(value["name"])
                and "value" in value
                and not safe(value["value"])
            ):
                finding(value["name"])
            for key, child in value.items():
                if KEY.search(key) and not safe(child):
                    finding(key)
                elif key == "body" and isinstance(child, str):
                    try:
                        raw = base64.b64decode(child, validate=True)
                    except ValueError:
                        pass
                    else:
                        content(raw, depth=depth + 1)
                else:
                    structured(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                structured(child, depth + 1)
        elif isinstance(value, str):
            try:
                embedded = json.loads(value)
            except ValueError:
                text(value)
            else:
                if isinstance(embedded, (dict, list, str)) and embedded != value:
                    structured(embedded, depth + 1)
                else:
                    text(value)

    def content(raw, archive_depth=0, depth=0):
        nonlocal entries
        entries += 1
        if zipfile.is_zipfile(io.BytesIO(raw)):
            if archive_depth >= san.MAX_ARCHIVE_DEPTH:
                raise ValueError("Artifact audit archive nesting exceeds safe limit")
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                for entry in z.infolist():
                    budget[0] -= entry.file_size
                    if budget[0] < 0:
                        raise ValueError("Artifact audit expanded-byte budget exceeded")
                    text(entry.filename)
                    content(z.read(entry), archive_depth + 1, depth)
            return
        try:
            decoded = raw.decode("utf-8")
        except UnicodeDecodeError:
            return
        if not san.is_text(decoded):
            return
        try:
            parsed = json.loads(decoded)
        except ValueError:
            for line in decoded.splitlines():
                offset = line.find("{")
                try:
                    parsed = json.loads(line[offset:]) if offset >= 0 else None
                except ValueError:
                    parsed = None
                if parsed is None:
                    text(line)
                else:
                    text(line[:offset])
                    structured(parsed, depth)
        else:
            structured(parsed, depth)

    for file in directory.rglob("*"):
        if file.is_file():
            text(str(file.relative_to(directory)))
            content(file.read_bytes())
    result = {"entriesAudited": entries, **counts}
    if counts["secret"]:
        raise ValueError("Artifact credential audit failed: " + json.dumps(result))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--secret-file", type=Path)
    args = parser.parse_args()
    print(
        "ACTUAL_ARTIFACT_SECRET_AUDIT",
        json.dumps(audit(args.directory, args.secret_file)),
    )
