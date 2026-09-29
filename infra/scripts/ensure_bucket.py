#!/usr/bin/env python3
"""Create the development MinIO bucket if it is missing.

This is infrastructure bootstrap. It is not an application storage adapter.
"""

import datetime
import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.request


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def _signing_key(secret: str, date_stamp: str, region: str) -> bytes:
    date_key = _sign(f"AWS4{secret}".encode(), date_stamp)
    region_key = _sign(date_key, region)
    service_key = _sign(region_key, "s3")
    return _sign(service_key, "aws4_request")


def main() -> int:
    access_key = os.environ.get("MINIO_ROOT_USER", "editagent")
    secret_key = os.environ.get("MINIO_ROOT_PASSWORD", "editagent-dev-secret")
    bucket = os.environ.get("S3_BUCKET", "editagent")
    region = os.environ.get("S3_REGION", "us-east-1")
    host = os.environ.get("MINIO_HOST", "127.0.0.1")
    port = os.environ.get("MINIO_PORT", "9000")
    endpoint = f"{host}:{port}"

    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(b"").hexdigest()
    canonical_uri = f"/{bucket}"
    canonical_headers = (
        f"host:{endpoint}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = (
        f"PUT\n{canonical_uri}\n\n{canonical_headers}{signed_headers}\n{payload_hash}"
    )
    credential_scope = f"{date_stamp}/{region}/s3/aws4_request"
    request_hash = hashlib.sha256(canonical_request.encode()).hexdigest()
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{request_hash}"
    signature = hmac.new(
        _signing_key(secret_key, date_stamp, region),
        string_to_sign.encode(),
        hashlib.sha256,
    ).hexdigest()
    authorization = (
        "AWS4-HMAC-SHA256 "
        f"Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )
    request = urllib.request.Request(
        url=f"http://{endpoint}{canonical_uri}",
        data=b"",
        method="PUT",
        headers={
            "Host": endpoint,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
            "Authorization": authorization,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            print(f"created bucket {bucket} ({response.status})")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if exc.code == 409 and "BucketAlreadyOwnedByYou" in body:
            print(f"bucket {bucket} already exists")
            return 0
        print(body, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
