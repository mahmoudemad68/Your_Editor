#!/usr/bin/env python3
"""Create the configured S3 bucket if it is missing.

Staging talks to SeaweedFS with S3_ACCESS_KEY_ID. Development seed still
accepts the MinIO variable names. This is infrastructure bootstrap, not the
application storage adapter.
"""

import datetime
import hashlib
import hmac
import http.client
import os
import sys


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def _signing_key(secret: str, date_stamp: str, region: str) -> bytes:
    date_key = _sign(f"AWS4{secret}".encode(), date_stamp)
    region_key = _sign(date_key, region)
    service_key = _sign(region_key, "s3")
    return _sign(service_key, "aws4_request")


def main() -> int:
    access_key = os.environ.get("S3_ACCESS_KEY_ID") or os.environ.get(
        "MINIO_ROOT_USER", "editagent"
    )
    secret_key = os.environ.get("S3_SECRET_ACCESS_KEY") or os.environ.get(
        "MINIO_ROOT_PASSWORD", "editagent-dev-secret"
    )
    bucket = os.environ.get("S3_BUCKET", "editagent")
    region = os.environ.get("S3_REGION", "us-east-1")
    host = os.environ.get("S3_HOST") or os.environ.get("MINIO_HOST", "127.0.0.1")
    port = os.environ.get("S3_PORT") or os.environ.get("MINIO_PORT", "9000")
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
        f"PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
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
    connection = http.client.HTTPConnection(host, int(port), timeout=10)
    connection.putrequest(
        "PUT", canonical_uri, skip_host=True, skip_accept_encoding=True
    )
    connection.putheader("Host", endpoint)
    connection.putheader("x-amz-content-sha256", payload_hash)
    connection.putheader("x-amz-date", amz_date)
    connection.putheader("Authorization", authorization)
    connection.putheader("Content-Length", "0")
    connection.endheaders()
    response = connection.getresponse()
    body = response.read().decode("utf-8", errors="replace")
    connection.close()
    if response.status in {200, 204}:
        print(f"created bucket {bucket} ({response.status})")
        return 0
    if response.status == 409 and (
        "BucketAlreadyOwnedByYou" in body or "BucketAlreadyExists" in body
    ):
        print(f"bucket {bucket} already exists")
        return 0
    print(body, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
