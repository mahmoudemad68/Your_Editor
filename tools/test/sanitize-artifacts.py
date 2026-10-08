"""Sanitize exported logs and Playwright traces before artifact publication.

Known secret encodings are generated once. ZIP recursion is limited to three
archive levels and a shared 64 MiB expanded-byte budget; unsafe archives fail
closed so the workflow cannot upload partially sanitized evidence.
"""

from __future__ import annotations

import argparse
import base64
import copy
import io
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import parse_qsl, quote, quote_plus, urlencode, urlsplit, urlunsplit

REDACTED = "[REDACTED]"
SENSITIVE = re.compile(
    r"authorization|cookie|password|passwd|secret|token|credential|csrf|signature|"
    r"x[-_]amz[-_]|api[-_]?key|awsaccesskeyid|postdata|requestbody",
    re.IGNORECASE,
)
JWT = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
BEARER = re.compile(r"\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
URI = re.compile(r"[a-z][a-z0-9+.-]*://[^\s\"'<>\\]+", re.IGNORECASE)
ASSIGNMENT = re.compile(
    r"(?i)(?<![\w-])([\"']?[\w-]{0,64}(?:authorization|cookie|password|passwd|secret|"
    r"token|credential|csrf|signature|x[-_]amz[-_][\w-]*|api[-_]?key|awsaccesskeyid)"
    r"[\w-]{0,64}[\"']?\s*\+?[=:]\s*)(\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s&;,<>}]+)",
)
DEFAULT_SECRETS = [
    "editagent-dev-secret",
    "editagent-dev-password",
    "local-development-jwt-secret-32chars",
]
MAX_ARCHIVE_DEPTH = 3
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_JSON_DEPTH = 32
TEXT_SUFFIXES = {
    ".log",
    ".txt",
    ".json",
    ".jsonl",
    ".network",
    ".trace",
    ".html",
    ".xml",
    ".csv",
    ".md",
    ".js",
    ".css",
    ".svg",
    ".yaml",
    ".yml",
    ".map",
}
BINARY_SUFFIXES = {
    ".bin",
    ".ico",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".mp4",
    ".webm",
    ".pdf",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
}
ANSI = re.compile(
    r"(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]"
)
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def terminal_text(value: str) -> str:
    return CONTROL.sub("", ANSI.sub("", value)).replace("\r", "\n")


def archive_intent(source: bytes, name: str = "") -> bool:
    return (
        Path(name).suffix.lower() == ".zip"
        or source.startswith(b"PK")
        or zipfile.is_zipfile(io.BytesIO(source))
    )


def binary_signature(source: bytes) -> bool:
    return (
        source.startswith(
            (
                b"\x89PNG\r\n\x1a\n",
                b"\xff\xd8\xff",
                b"\x00\x00\x01\x00",
                b"GIF87a",
                b"GIF89a",
                b"%PDF-",
                b"wOFF",
                b"wOF2",
                b"OTTO",
                b"\x00\x01\x00\x00",
            )
        )
        or source[:4] == b"RIFF"
        and source[8:12] == b"WEBP"
        or source[4:8] == b"ftyp"
    )


def decode_text(source: bytes, name: str = "") -> str | None:
    # Content signatures outweigh misleading extensions. Unknown opaque formats
    # fail closed; only recognized binary evidence is retained unchanged.
    if binary_signature(source):
        return None
    if source.startswith((b"\xff\xfe", b"\xfe\xff")):
        return source.decode("utf-16", errors="replace")
    suffix = Path(name).suffix.lower()
    if suffix in TEXT_SUFFIXES:
        return source.decode("utf-8-sig", errors="replace")
    if suffix in BINARY_SUFFIXES:
        return None
    try:
        decoded = source.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("Artifact format cannot be safely classified") from exc
    if "\x00" in decoded:
        raise ValueError("Unknown artifact contains opaque binary data")
    return decoded


def secret_variants(secrets: list[str]) -> list[str]:
    variants = set()
    for secret in secrets:
        if not isinstance(secret, str):
            raise TypeError("Artifact secrets must be strings")
        if secret:
            variants.update(
                (secret, quote(secret, safe=""), quote_plus(secret, safe=""))
            )
            for encode in (base64.b64encode, base64.urlsafe_b64encode):
                encoded = encode(secret.encode()).decode()
                variants.update((encoded, encoded.rstrip("=")))
    return sorted(variants, key=lambda value: (-len(value), value))


def text(value: str, secrets: list[str]) -> str:
    value = terminal_text(value)
    for secret in secrets:
        value = value.replace(secret, REDACTED)
    value = JWT.sub(REDACTED, value)
    value = BEARER.sub("Bearer " + REDACTED, value)

    def uri(match: re.Match) -> str:
        try:
            parts = urlsplit(match[0])
            authority = parts.netloc
            if "@" in authority:
                authority = REDACTED + "@" + authority.rsplit("@", 1)[1]
            # Retain safe host/path and parameter names; credentials/fragments
            # have no diagnostic value. Treat unknown fragment syntax as opaque.
            query = urlencode(
                [
                    (
                        k,
                        REDACTED
                        if SENSITIVE.search(terminal_text(k))
                        else text(v, secrets),
                    )
                    for k, v in parse_qsl(parts.query, keep_blank_values=True)
                ]
            )
            return urlunsplit((parts.scheme, authority, parts.path, query, ""))
        except ValueError:
            return REDACTED

    value = URI.sub(uri, value)
    # Quoted markers have an explicit end even beside minified JS expressions.
    # Consume the whole assignment token; never retain a secret marker suffix.
    return ASSIGNMENT.sub(lambda m: m[1] + json.dumps(REDACTED), value)


def clean(value: object, secrets: list[str], depth: int = 0) -> object:
    if depth > MAX_JSON_DEPTH:
        raise ValueError("Artifact JSON nesting exceeds safe limit")
    if isinstance(value, dict):
        for key_field in ("name", "key"):
            if isinstance(value.get(key_field), str) and SENSITIVE.search(
                value[key_field]
            ):
                value = {
                    **value,
                    **{field: REDACTED for field in ("value", "val") if field in value},
                }
        if value.get("type") == "password":
            value = {**value, "value": REDACTED, "__playwright_value_": REDACTED}
        if isinstance(value.get("body"), str):
            try:
                raw = base64.b64decode(value["body"], validate=True)
            except ValueError:
                pass
            else:
                # Recognized binary stays intact; textual encodings/controls
                # take the same safe path as files. Unknown bodies fail closed.
                value = {
                    **value,
                    "body": base64.b64encode(data(raw, secrets, depth + 1)).decode(),
                }
        filled = value.get("method") == "fill" or "fill" in str(
            value.get("apiName", "")
        )
        return {
            k: (
                REDACTED
                if SENSITIVE.search(terminal_text(k))
                else {**v, "value": REDACTED}
                if filled and k == "params" and isinstance(v, dict)
                else clean(v, secrets, depth + 1)
            )
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [clean(v, secrets, depth + 1) for v in value]
    if isinstance(value, str):
        try:
            embedded = json.loads(value)
        except ValueError:
            return text(value, secrets)
        if isinstance(embedded, (dict, list, str)) and embedded != value:
            return json.dumps(clean(embedded, secrets, depth + 1), ensure_ascii=False)
        return text(value, secrets)
    return value


def data(source: bytes, secrets: list[str], depth: int = 0, name: str = "") -> bytes:
    decoded = decode_text(source, name)
    if decoded is None:
        return source
    decoded = terminal_text(decoded)
    try:
        parsed = json.loads(decoded)
    except ValueError:
        pass
    else:
        return (
            json.dumps(clean(parsed, secrets, depth), ensure_ascii=False) + "\n"
        ).encode()
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
                text(line[:offset], secrets)
                + json.dumps(clean(parsed, secrets, depth))
                + "\n"
            )
    return "".join(lines).encode()


def archive(
    source: bytes, secrets: list[str], budget: list[int], depth: int = 1
) -> bytes:
    if depth > MAX_ARCHIVE_DEPTH:
        raise ValueError("Artifact ZIP nesting exceeds safe limit")
    output = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(source)) as old,
        zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as new,
    ):
        used = set()
        for entry in old.infolist():
            budget[0] -= entry.file_size
            if budget[0] < 0:
                raise ValueError("Artifact ZIP expanded bytes exceed safe limit")
            raw = old.read(entry)
            name = text(entry.filename, secrets)
            candidate, suffix = name, 1
            while candidate in used:
                candidate = f"{name}.redacted-{suffix}"
                suffix += 1
            used.add(candidate)
            info = copy.copy(entry)
            info.filename = candidate
            sanitized = (
                archive(raw, secrets, budget, depth + 1)
                if archive_intent(raw, entry.filename)
                else data(raw, secrets, name=entry.filename)
            )
            new.writestr(info, sanitized)
    return output.getvalue()


def sanitize(directory: Path, secret_file: Path | None = None) -> dict:
    secrets = secret_variants(
        DEFAULT_SECRETS
        + (
            json.loads(secret_file.read_text())
            if secret_file and secret_file.exists()
            else []
        )
    )
    budget = [MAX_EXPANDED_BYTES]
    stats = {"servicesLogFilesFound": 0, "servicesLogFilesSanitized": 0}
    for file in directory.rglob("*"):
        if not file.is_file():
            continue
        source = file.read_bytes()
        if file.name == "services.log":
            stats["servicesLogFilesFound"] += 1
        result = (
            archive(source, secrets, budget)
            if archive_intent(source, str(file))
            else data(source, secrets, name=str(file))
        )
        file.write_bytes(result)
        if file.name == "services.log":
            if decode_text(source, str(file)) is None:
                raise ValueError("services.log must be safely inspectable text")
            stats["servicesLogFilesSanitized"] += 1
    return stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("--secret-file", type=Path)
    args = parser.parse_args()
    print(
        "ARTIFACT_SANITIZATION", json.dumps(sanitize(args.directory, args.secret_file))
    )
