"""Fail artifact publication if retained evidence still contains credentials.

Inspect structured trace fields independently of sanitization, including decoded
bodies, nested serialized JSON and archive names. Print counts and bounded,
redacted failure-location metadata only, never matched values or raw paths.
"""

import argparse
import base64
import io
import json
import re
import zipfile
import zlib
from pathlib import Path
from urllib.parse import unquote_plus

# Independent detector: never import sanitizer classifiers or patterns.
MAX_ARCHIVE_DEPTH = 3
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_JSON_DEPTH = 32
DEFAULT_SECRETS = [
    "editagent-dev-secret",
    "editagent-dev-password",
    "local-development-jwt-secret-32chars",
]
JWT = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
ESCAPE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|\x9b[0-?]*[ -/]*[@-~]"
)
RAW_ESCAPE = re.compile(
    rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]"
)


def variants(secrets):
    from urllib.parse import quote, quote_plus

    values = set()
    for secret in secrets:
        if not isinstance(secret, str):
            raise TypeError("Audit secrets must be strings")
        if secret:
            values.update((secret, quote(secret, safe=""), quote_plus(secret, safe="")))
            for encoder in (base64.b64encode, base64.urlsafe_b64encode):
                encoded = encoder(secret.encode()).decode()
                values.update((encoded, encoded.rstrip("=")))
    return values


def normalized(value):
    # Audit stripping is separate from the sanitizer's decoder. Raw-byte
    # projection below remains a second check even when JSON parsing succeeds.
    return "".join(
        c
        for c in ESCAPE.sub("", value)
        if c in "\t\n\r" or ord(c) >= 32 and not 127 <= ord(c) <= 159
    )


KEY = re.compile(
    r"authorization|cookie|password|passwd|secret|token|credential|csrf|signature|x[-_]amz[-_]|api[-_]?key|awsaccesskeyid",
    re.IGNORECASE,
)
ASSIGNMENT = re.compile(
    r"(?i)([\"']?[\w-]*(?:password|passwd|secret|token|credential|csrf|signature|x-amz-[\w-]*|api[_-]?key|awsaccesskeyid)[\w-]*[\"']?\s*[=:]\s*)(\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s&;,<>}]+)"
)
BEARER = re.compile(r"\bBearer\s+(\S+)", re.IGNORECASE)
URI_USER = re.compile(r"[a-z][a-z0-9+.-]*://([^/@\s]+)@", re.IGNORECASE)


def location_class(name):
    # Never log arbitrary filenames: trace/member names can themselves be secrets.
    allowed = {
        "healthy",
        "negative",
        "runtime",
        "playwright",
        "resources",
        "services.log",
        "trace.zip",
    }
    # One fixed category, not a path-depth or filename-length oracle.
    return next(
        (part for part in reversed(Path(name).parts) if part in allowed), "other"
    )


def uri_diagnostic(frame, match):
    """Bounded metadata only. This observer never changes the audit verdict."""
    if frame is None:
        return {"stream": "path", "record_kind": "uri_userinfo"}
    raw = frame["raw"]
    result = {
        "location_class": location_class(frame["name"]),
        "format": "png" if raw.startswith(b"\x89PNG\r\n\x1a\n") else "other",
        "stream": frame["stream"],
        "record_kind": "uri_userinfo",
    }
    projected = frame.get("projection", "")
    value = match[0]  # In-memory only; never returned, logged or hashed separately.
    at = projected.find(value)
    if frame["stream"] != "ascii_projection" or at < 0 or projected.count(value) != 1:
        return result
    end = at + len(value)
    escapes = iter(RAW_ESCAPE.finditer(raw))
    escape = next(escapes, None)
    i = pos = 0
    first = last = None
    while i < len(raw) and pos < end:
        if escape is not None and i == escape.start():
            i = escape.end()
            escape = next(escapes, None)
            continue
        b = raw[i]
        if b in (9, 10, 13) or 32 <= b < 127:
            if pos == at:
                first = i
            if pos == end - 1:
                last = i
            pos += 1
        i += 1
    if first is None or last is None:
        return result
    result["source_contiguous"] = last - first + 1 == len(value)
    if result["format"] == "png":
        offset, chunks, valid, ended = 8, [], True, False
        for _ in range(4096):
            if offset + 12 > len(raw):
                valid = False
                break
            size = int.from_bytes(raw[offset : offset + 4], "big")
            stop = offset + 12 + size
            if stop > len(raw):
                valid = False
                break
            kind = raw[offset + 4 : offset + 8]
            valid &= zlib.crc32(
                raw[offset + 4 : stop - 4]
            ) & 0xFFFFFFFF == int.from_bytes(raw[stop - 4 : stop], "big")
            if offset + 8 <= first and last < stop - 4:
                chunks.append(
                    kind.decode("ascii")
                    if kind in (b"IDAT", b"tEXt", b"iTXt", b"zTXt")
                    else "other"
                )
            offset = stop
            if kind == b"IEND":
                ended = True
                break
        result.update(
            png_crc_valid=bool(valid and ended and offset == len(raw)),
            png_source_chunks=chunks,
        )
    return result


def safe_uri_diagnostic(frame, match):
    """Closed public vocabulary; observer faults cannot mask audit findings.

    Do not pass arbitrary observer dictionaries through to JSON, even if future
    observer changes accidentally add a hash, filename, length or exception.
    """
    enums = {
        "stream": {"path", "raw", "ascii_projection", "decoded_text"},
        "record_kind": {"uri_userinfo"},
        "format": {"png", "other"},
        "location_class": {
            "healthy",
            "negative",
            "runtime",
            "playwright",
            "resources",
            "services.log",
            "trace.zip",
            "other",
        },
    }
    flags = {"source_contiguous", "png_crc_valid"}
    try:
        value = uri_diagnostic(frame, match)
        if type(value) is not dict or not {"stream", "record_kind"} <= value.keys():
            raise ValueError
        if value.keys() - (enums.keys() | flags | {"png_source_chunks"}):
            raise ValueError
        result = {}
        for key, choices in enums.items():
            if key in value:
                if type(value[key]) is not str or value[key] not in choices:
                    raise ValueError
                result[key] = value[key]
        for key in flags:
            if key in value:
                if type(value[key]) is not bool:
                    raise ValueError
                result[key] = value[key]
        if "png_source_chunks" in value:
            chunks = value["png_source_chunks"]
            if (
                type(chunks) is not list
                or len(chunks) > 8
                or any(
                    type(kind) is not str
                    or kind not in {"IDAT", "tEXt", "iTXt", "zTXt", "other"}
                    for kind in chunks
                )
            ):
                raise ValueError
            result["png_source_chunks"] = list(chunks)
        return result
    except Exception:  # noqa: BLE001 -- public diagnostics must contain every observer fault
        # Never stringify the exception: even its message/path can be a secret.
        return {"status": "DIAGNOSTIC_UNAVAILABLE"}


def audit(directory: Path, secret_file: Path | None = None) -> dict:
    known = variants(
        DEFAULT_SECRETS
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
    service_logs_found = 0
    service_logs_audited = 0
    raw_known = {
        secret.encode(encoding)
        for secret in known
        for encoding in ("utf-8", "utf-16-le", "utf-16-be")
    }
    budget = [MAX_EXPANDED_BYTES]
    frame = None
    first_uri = None

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
        nonlocal first_uri
        value = normalized(value)
        decoded = unquote_plus(value)
        if any(secret in value or secret in decoded for secret in known):
            finding("known")
        if JWT.search(value):
            finding("token")
        for match in BEARER.finditer(value):
            if not safe(match[1].strip("\"'.,}")):
                counts["bearer"] += 1
                finding("token")
        for match in URI_USER.finditer(value):
            if not safe(unquote_plus(match[1])):
                counts["db_credentials"] += 1
                finding("userinfo")
                if first_uri is None:
                    first_uri = safe_uri_diagnostic(frame, match)
        for match in ASSIGNMENT.finditer(decoded):
            candidate = match[2].strip("\"'")
            # Closing JSON/array/escaped-quote punctuation is not credential
            # material. Never accept arbitrary text after the redaction marker.
            if not safe(candidate) and not re.fullmatch(
                r"\[REDACTED\][\]\)}\\]*", candidate
            ):
                finding(match[1])

    def structured(value, depth=0):
        if depth > MAX_JSON_DEPTH:
            raise ValueError("Artifact audit nesting exceeds safe limit")
        if isinstance(value, dict):
            for key_field in ("name", "key"):
                if isinstance(value.get(key_field), str) and KEY.search(
                    normalized(value[key_field])
                ):
                    for value_field in ("value", "val"):
                        if value_field in value and not safe(value[value_field]):
                            finding(value[key_field])
            for key, child in value.items():
                if KEY.search(normalized(key)) and not safe(child):
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

    def content(raw, archive_depth=0, depth=0, name=""):
        nonlocal entries, frame
        entries += 1
        previous = frame
        frame = {"entry": entries, "name": name, "raw": raw, "stream": "raw"}
        try:
            scan_content(raw, archive_depth, depth, name)
        finally:
            frame = previous

    def scan_content(raw, archive_depth, depth, name):
        # No binary/text classifier may suppress a raw known-secret check.
        if any(secret in raw for secret in raw_known):
            finding("known_raw")
        archive_claim = Path(name).suffix.lower() == ".zip" or raw.startswith(b"PK")
        if archive_claim or zipfile.is_zipfile(io.BytesIO(raw)):
            if archive_depth >= MAX_ARCHIVE_DEPTH:
                raise ValueError("Artifact audit archive nesting exceeds safe limit")
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                for entry in z.infolist():
                    budget[0] -= entry.file_size
                    if budget[0] < 0:
                        raise ValueError("Artifact audit expanded-byte budget exceeded")
                    text(entry.filename)
                    content(z.read(entry), archive_depth + 1, depth, entry.filename)
            return
        # Scan a control-free ASCII projection regardless of encoding, magic,
        # extension or successful decoding. This catches skipped canary logs and
        # known credentials embedded in otherwise opaque binary evidence.
        projected = RAW_ESCAPE.sub(b"", raw)
        projected_text = bytes(
            b for b in projected if b in (9, 10, 13) or 32 <= b < 127
        ).decode("ascii")
        frame.update(stream="ascii_projection", projection=projected_text)
        inspect_text(projected_text, depth)
        decoded = normalized(
            raw.decode(
                "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig",
                errors="replace",
            )
        )
        frame["stream"] = "decoded_text"
        inspect_text(decoded, depth)

    def inspect_text(decoded, depth):
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
            if file.name == "services.log":
                service_logs_found += 1
            content(file.read_bytes(), name=str(file))
            if file.name == "services.log":
                service_logs_audited += 1
    result = {
        "entriesAudited": entries,
        "servicesLogFilesFound": service_logs_found,
        "servicesLogFilesAudited": service_logs_audited,
        **counts,
    }
    if counts["secret"]:
        if first_uri is not None:
            result["first_uri_diagnostic"] = first_uri
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
