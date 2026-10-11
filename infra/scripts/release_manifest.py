"""Immutable release records: bind scanned images, published digests and SBOMs."""

import argparse
import hashlib
import json
import re
from pathlib import Path

SERVICES = (
    "api",
    "web",
    "media-worker",
    "render-worker",
    "render-executor",
    "agent-worker",
    "ai-worker",
    "seaweedfs",
    "postgres",
    "redis",
)
LEGACY_SERVICES = tuple(s for s in SERVICES if s != "render-executor")
SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
IMAGE = re.compile(r"ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_record(record, sha, directory):
    require(SHA.fullmatch(sha), "Invalid release SHA")
    service = record.get("service")
    require(service in SERVICES, "Unexpected release service")
    require(record.get("gitSha") == sha, "Mixed release commits")
    require(IMAGE.fullmatch(record.get("image", "")), "Invalid GHCR image")
    require(record.get("tag") == f"sha-{sha}", "Mutable or mismatched release tag")
    require(DIGEST.fullmatch(record.get("digest", "")), "Invalid published digest")
    require(
        DIGEST.fullmatch(record.get("scannedImageId", "")),
        "Missing scanned image identity",
    )
    sbom = record.get("sbom")
    require(sbom == f"sbom-{service}.spdx.json", "Invalid SBOM path")
    content = (directory / sbom).read_bytes()
    require(
        hashlib.sha256(content).hexdigest() == record.get("sbomSha256"),
        "SBOM hash mismatch",
    )
    parsed = json.loads(content)
    require(str(parsed.get("spdxVersion", "")).startswith("SPDX-"), "Invalid SPDX SBOM")
    return record


def load_release(path):
    release = json.loads(path.read_text())
    version = release.get("schemaVersion")
    require(type(version) is int and version in (1, 2), "Unknown release schema")
    services = LEGACY_SERVICES if version == 1 else SERVICES
    sha = release.get("gitSha", "")
    require(SHA.fullmatch(sha), "Invalid release SHA")
    records = release.get("images", [])
    require(len(records) == len(services), "Incomplete release")
    require(
        {r.get("service") for r in records} == set(services),
        "Missing or duplicate services",
    )
    for record in records:
        validate_record(record, sha, path.parent)
    return release


def image_environment(release):
    return {
        r["service"].upper().replace("-", "_") + "_IMAGE": r["image"]
        + "@"
        + r["digest"]
        for r in release["images"]
    }


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="command", required=True)
    record = sub.add_parser("record")
    for arg in ("service", "sha", "image", "digest", "image-id", "directory"):
        record.add_argument("--" + arg, required=True)
    assemble = sub.add_parser("assemble")
    assemble.add_argument("--sha", required=True)
    assemble.add_argument("--directory", type=Path, required=True)
    args = p.parse_args()
    directory = Path(args.directory)
    if args.command == "record":
        sbom = f"sbom-{args.service}.spdx.json"
        data = {
            "service": args.service,
            "gitSha": args.sha,
            "image": args.image,
            "tag": f"sha-{args.sha}",
            "digest": args.digest,
            "scannedImageId": args.image_id,
            "sbom": sbom,
            "sbomSha256": hashlib.sha256((directory / sbom).read_bytes()).hexdigest(),
        }
        validate_record(data, args.sha, directory)
        (directory / f"image-{args.service}.json").write_text(
            json.dumps(data, indent=2) + "\n"
        )
    else:
        records = [
            json.loads((directory / f"image-{s}.json").read_text()) for s in SERVICES
        ]
        data = {"schemaVersion": 2, "gitSha": args.sha, "images": records}
        path = directory / "release.json"
        path.write_text(json.dumps(data, indent=2) + "\n")
        load_release(path)
    print("release record validated")


if __name__ == "__main__":
    main()
