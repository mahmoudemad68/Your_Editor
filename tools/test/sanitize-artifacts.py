"""Sanitize exported service logs, result JSON and Playwright ZIP resources."""

from __future__ import annotations

import argparse
import base64
import json
import re
import zipfile
from pathlib import Path

SENSITIVE = re.compile(
    r"authorization|cookie|password|secret|token|credential|csrf|postdata|requestbody",
    re.IGNORECASE,
)
JWT = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
URL = re.compile(r"https?://[^\s\"'<>\\]+")
DEFAULT_SECRETS = [
    "editagent-dev-secret",
    "editagent-dev-password",
    "local-development-jwt-secret-32chars",
]


def text(value: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            value = value.replace(secret, "[REDACTED]")
    value = JWT.sub("[REDACTED]", value)
    value = URL.sub(
        lambda m: re.sub(r"//[^/@]+:[^/@]+@", "//[REDACTED]@", m[0].split("?", 1)[0]),
        value,
    )
    return re.sub(
        r"(?im)((?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+",
        r"\1[REDACTED]",
        value,
    )


def clean(value: object, secrets: list[str]) -> object:
    if isinstance(value, dict):
        if isinstance(value.get("name"), str) and SENSITIVE.search(value["name"]):
            return {**value, "value": "[REDACTED]"}
        if isinstance(value.get("body"), str):
            try:
                raw = base64.b64decode(value["body"], validate=True)
                decoded = raw.decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                pass
            else:
                if decoded.startswith(("{", "[")):
                    value = {
                        **value,
                        "body": base64.b64encode(data(raw, secrets)).decode(),
                    }
        filled = value.get("method") == "fill" or "fill" in str(
            value.get("apiName", "")
        )
        return {
            k: (
                "[REDACTED]"
                if SENSITIVE.search(k)
                else (
                    {**v, "value": "[REDACTED]"}
                    if filled and k == "params" and isinstance(v, dict)
                    else clean(v, secrets)
                )
            )
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [clean(v, secrets) for v in value]
    if isinstance(value, str):
        try:
            embedded = json.loads(value)
        except (ValueError, TypeError):
            return text(value, secrets)
        if isinstance(embedded, (dict, list)):
            return json.dumps(clean(embedded, secrets), ensure_ascii=False)
        return text(value, secrets)
    return value


def data(source: bytes, secrets: list[str]) -> bytes:
    try:
        decoded = source.decode("utf-8")
    except UnicodeDecodeError:
        return source  # PNG/media; browser masks password inputs.
    try:
        return (
            json.dumps(clean(json.loads(decoded), secrets), ensure_ascii=False) + "\n"
        ).encode()
    except ValueError:
        pass
    lines = []
    for line in decoded.splitlines(keepends=True):
        offset = line.find("{")
        try:
            parsed = json.loads(line[offset:]) if offset >= 0 else None
        except ValueError:
            parsed = None
        if parsed is None:
            lines.append(text(line, secrets))
        else:
            lines.append(
                text(line[:offset], secrets) + json.dumps(clean(parsed, secrets)) + "\n"
            )
    return "".join(lines).encode()


def sanitize(directory: Path, secret_file: Path | None = None) -> None:
    secrets = DEFAULT_SECRETS + (
        json.loads(secret_file.read_text())
        if secret_file and secret_file.exists()
        else []
    )
    for file in directory.rglob("*"):
        if not file.is_file():
            continue
        if file.suffix == ".zip":
            temp = file.with_suffix(".sanitized.zip")
            with (
                zipfile.ZipFile(file) as old,
                zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED) as new,
            ):
                for entry in old.infolist():
                    new.writestr(entry, data(old.read(entry.filename), secrets))
            temp.replace(file)
        else:
            file.write_bytes(data(file.read_bytes(), secrets))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--secret-file", type=Path)
    args = parser.parse_args()
    sanitize(args.directory, args.secret_file)
