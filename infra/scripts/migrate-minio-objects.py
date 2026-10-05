#!/usr/bin/env python3
"""Copy objects from one S3 endpoint to another.

The copy keeps the key, content type, and body bytes. It does not delete the
source bucket, the source objects, or any Docker volume. Historical MinIO
volumes stay where they are.
"""

import datetime
import hashlib
import hmac
import http.client
import os
import sys
import xml.etree.ElementTree as xml
from urllib.parse import quote


def sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def signing_key(secret: str, date_stamp: str, region: str) -> bytes:
    return sign(
        sign(sign(sign(f"AWS4{secret}".encode(), date_stamp), region), "s3"),
        "aws4_request",
    )


def request(
    host: str,
    port: int,
    method: str,
    path: str,
    access_key: str,
    secret_key: str,
    region: str,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
    query: str = "",
) -> tuple[int, dict[str, str], bytes]:
    extra = {name.lower(): value for name, value in (headers or {}).items()}
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    endpoint = f"{host}:{port}"
    signed = {
        "host": endpoint,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        **extra,
    }
    canonical_headers = "".join(f"{name}:{signed[name]}\n" for name in sorted(signed))
    signed_headers = ";".join(sorted(signed))
    canonical_query = (
        "&".join(sorted(part for part in query.split("&") if part)) if query else ""
    )
    canonical = f"{method}\n{path}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    scope = f"{date_stamp}/{region}/s3/aws4_request"
    string_to_sign = (
        "AWS4-HMAC-SHA256\n"
        + amz_date
        + "\n"
        + scope
        + "\n"
        + hashlib.sha256(canonical.encode()).hexdigest()
    )
    signature = hmac.new(
        signing_key(secret_key, date_stamp, region),
        string_to_sign.encode(),
        hashlib.sha256,
    ).hexdigest()
    connection = http.client.HTTPConnection(host, port, timeout=30)
    target = path if not canonical_query else f"{path}?{canonical_query}"
    connection.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
    for name, value in signed.items():
        connection.putheader(name, value)
    connection.putheader(
        "Authorization",
        "AWS4-HMAC-SHA256 "
        f"Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
    )
    connection.putheader("Content-Length", str(len(body)))
    connection.endheaders(body)
    response = connection.getresponse()
    payload = response.read()
    result_headers = {name.lower(): value for name, value in response.getheaders()}
    status = response.status
    connection.close()
    return status, result_headers, payload


def list_keys(
    host: str, port: int, bucket: str, access_key: str, secret_key: str, region: str
) -> list[str]:
    keys: list[str] = []
    token = ""
    while True:
        query = "list-type=2"
        if token:
            query += "&continuation-token=" + quote(token, safe="")
        status, _headers, body = request(
            host,
            port,
            "GET",
            f"/{bucket}",
            access_key,
            secret_key,
            region,
            query=query,
        )
        if status != 200:
            raise SystemExit(f"list failed: {status} {body[:300]!r}")
        root = xml.fromstring(body)
        namespace = ""
        if root.tag.startswith("{"):
            namespace = root.tag.split("}", 1)[0] + "}"
        keys.extend(item.text or "" for item in root.findall(f".//{namespace}Key"))
        truncated = root.findtext(f"{namespace}IsTruncated")
        if truncated != "true":
            return keys
        token = root.findtext(f"{namespace}NextContinuationToken") or ""


def split_endpoint(value: str) -> tuple[str, int]:
    bare = value.removeprefix("http://").removeprefix("https://").rstrip("/")
    host, _, port = bare.partition(":")
    return host, int(port or "80")


def main() -> int:
    if any(
        argument in {"--delete-source", "--delete-volumes", "-v"}
        for argument in sys.argv[1:]
    ):
        print("migration does not delete source objects or volumes", file=sys.stderr)
        return 2
    source_host, source_port = split_endpoint(os.environ["SOURCE_S3_ENDPOINT"])
    dest_host, dest_port = split_endpoint(os.environ["DEST_S3_ENDPOINT"])
    bucket = os.environ.get("S3_BUCKET", "editagent")
    region = os.environ.get("S3_REGION", "us-east-1")
    source_key = os.environ["SOURCE_ACCESS_KEY_ID"]
    source_secret = os.environ["SOURCE_SECRET_ACCESS_KEY"]
    dest_key = os.environ["DEST_ACCESS_KEY_ID"]
    dest_secret = os.environ["DEST_SECRET_ACCESS_KEY"]
    status, _headers, body = request(
        dest_host, dest_port, "PUT", f"/{bucket}", dest_key, dest_secret, region
    )
    if status not in {200, 204, 409}:
        print(body.decode("utf-8", "replace"), file=sys.stderr)
        return 1
    keys = list_keys(
        source_host, source_port, bucket, source_key, source_secret, region
    )
    for key in keys:
        encoded = quote(key, safe="/")
        get_status, get_headers, payload = request(
            source_host,
            source_port,
            "GET",
            f"/{bucket}/{encoded}",
            source_key,
            source_secret,
            region,
        )
        if get_status != 200:
            print(f"get {key} failed: {get_status}", file=sys.stderr)
            return 1
        content_type = get_headers.get("content-type", "application/octet-stream")
        put_status, _put_headers, put_body = request(
            dest_host,
            dest_port,
            "PUT",
            f"/{bucket}/{encoded}",
            dest_key,
            dest_secret,
            region,
            payload,
            {"content-type": content_type},
        )
        if put_status not in {200, 204}:
            print(f"put {key} failed: {put_status} {put_body[:200]!r}", file=sys.stderr)
            return 1
        copied = request(
            dest_host,
            dest_port,
            "GET",
            f"/{bucket}/{encoded}",
            dest_key,
            dest_secret,
            region,
        )
        if (
            copied[0] != 200
            or hashlib.sha256(copied[2]).digest() != hashlib.sha256(payload).digest()
        ):
            print(f"checksum mismatch for {key}", file=sys.stderr)
            return 1
        if (
            copied[1].get("content-type", "").split(";")[0]
            != content_type.split(";")[0]
        ):
            print(f"content type mismatch for {key}", file=sys.stderr)
            return 1
    print(f"copied {len(keys)} objects into {bucket}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
