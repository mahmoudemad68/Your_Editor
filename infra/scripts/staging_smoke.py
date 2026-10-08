"""Bounded readiness and exact-image verification; never print container env/logs."""

import argparse
import json
import subprocess
import time
from pathlib import Path

from release_manifest import load_release

SERVICE_IMAGES = {
    s: s
    for s in (
        "api",
        "web",
        "media-worker",
        "render-worker",
        "agent-worker",
        "ai-worker",
        "postgres",
        "redis",
    )
}
SERVICE_IMAGES.update(
    {
        s: "seaweedfs"
        for s in ("seaweed-master", "seaweed-volume", "seaweed-filer", "seaweed-s3")
    }
)


def command(args):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=15
    ).stdout


def check_once(release, services=None):
    wanted = services or list(SERVICE_IMAGES)
    records = {r["service"]: r for r in release["images"]} if release else {}
    for service in wanted:
        if service not in SERVICE_IMAGES:
            raise ValueError("Unknown smoke service")
        ids = command(["docker", "compose", "ps", "-aq", service]).split()
        if len(ids) != 1:
            raise ValueError(f"Missing or duplicate container: {service}")
        state = json.loads(command(["docker", "inspect", ids[0]]))[0]
        if (
            not state["State"].get("Running")
            or state["State"].get("Health", {}).get("Status") != "healthy"
        ):
            raise ValueError(f"Service is not healthy: {service}")
        if release:
            record = records[SERVICE_IMAGES[service]]
            if (
                state["Config"]["Image"] != record["image"] + "@" + record["digest"]
                or state["Image"] != record["scannedImageId"]
            ):
                raise ValueError(f"Wrong immutable image: {service}")
            if (
                state["Config"]
                .get("Labels", {})
                .get("org.opencontainers.image.revision")
                != release["gitSha"]
            ):
                raise ValueError(f"Wrong revision: {service}")
        if service in (
            "api",
            "web",
            "media-worker",
            "render-worker",
            "agent-worker",
            "ai-worker",
        ):
            port = 3001 if service == "api" else 3000 if service == "web" else 3200
            for endpoint in ("health", "ready"):
                url = f"http://127.0.0.1:{port}/{endpoint}"
                if service == "ai-worker":
                    probe = [
                        "/app/.venv/bin/python",
                        "-c",
                        f"import urllib.request; urllib.request.urlopen('{url}',timeout=3).close()",
                    ]
                else:
                    probe = [
                        "node",
                        "-e",
                        f"fetch('{url}',{{signal:AbortSignal.timeout(3000)}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
                    ]
                command(["docker", "compose", "exec", "-T", service, *probe])


def smoke(release, timeout=60, services=None):
    deadline = time.monotonic() + timeout
    while True:
        try:
            check_once(release, services)
            print("STAGING_SMOKE PASS")
            return
        except (ValueError, subprocess.SubprocessError) as exc:
            if time.monotonic() >= deadline:
                # No command output, request headers, container env or exception
                # bodies: diagnostics expose only service/state classifications.
                raise ValueError(
                    "Staging smoke failed: unavailable, unhealthy or mismatched image"
                ) from exc
            time.sleep(min(1, max(0, deadline - time.monotonic())))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--manifest", type=Path)
    group.add_argument(
        "--local-test",
        action="store_true",
        help="Disposable test stack only; no deployment identity claim",
    )
    parser.add_argument(
        "--services", help="Subset allowed only for disposable local test stacks"
    )
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()
    if args.services and not args.local_test:
        parser.error("Production smoke must check every service")
    smoke(
        load_release(args.manifest) if args.manifest else None,
        args.timeout,
        args.services.split(",") if args.services else None,
    )
