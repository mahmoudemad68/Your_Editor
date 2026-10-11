"""Owner-approved immutable Compose deployment/rollback on a dedicated host.

Dry run validates the same manifest/config and emits command names without
connecting to a host, logging in, pulling images or starting containers.
"""

import argparse
import fcntl
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

from release_manifest import image_environment, load_release, require
from staging_smoke import smoke

STORAGE = ["seaweed-master", "seaweed-volume", "seaweed-filer", "seaweed-s3"]
APPS = ["api", "web", "media-worker", "render-worker", "agent-worker", "ai-worker"]


def runtime_environment(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition("=")
        require(
            separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key),
            "Invalid runtime environment syntax",
        )
        if value.startswith('"'):
            value = json.loads(value)
        require(
            isinstance(value, str)
            and not any(c in value for c in ("\n", "\r", "\x00")),
            "Invalid runtime environment value",
        )
        values[key] = value
    for key in (
        "POSTGRES_PASSWORD",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "AUTH_JWT_SECRET",
        "AUTH_TRUSTED_ORIGINS",
        "S3_PUBLIC_ENDPOINT",
        "SEAWEED_SECRET_DIR",
    ):
        require(values.get(key), f"Missing staging configuration: {key}")
    require(
        values["POSTGRES_PASSWORD"] != "editagent-dev-password"
        and values["S3_SECRET_ACCESS_KEY"] != "editagent-dev-secret",
        "Development secrets are forbidden in staging",
    )
    require(
        len(values["AUTH_JWT_SECRET"]) >= 32
        and values["AUTH_JWT_SECRET"] != "local-development-jwt-secret-32chars",
        "Staging JWT key must be provisioned",
    )
    require(
        all(
            v.startswith("https://") for v in values["AUTH_TRUSTED_ORIGINS"].split(",")
        ),
        "Staging requires HTTPS origins",
    )
    require(
        values["S3_PUBLIC_ENDPOINT"].startswith("https://"),
        "Staging requires HTTPS S3 ingress",
    )
    require(
        Path(values["SEAWEED_SECRET_DIR"]).is_absolute(),
        "Storage credentials must use a persistent absolute directory",
    )
    return values


def run(args, dry):
    if dry:
        print("DRY_RUN " + " ".join(args))
        return
    subprocess.run(
        args,
        check=True,
        timeout=300,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def activate(root, directory):
    target = root / "current"
    if target.is_symlink() and target.resolve() != directory:
        previous = root / "previous.next"
        previous.unlink(missing_ok=True)
        previous.symlink_to(target.resolve())
        previous.replace(root / "previous")
    pending = root / "current.next"
    pending.unlink(missing_ok=True)
    pending.symlink_to(directory)
    pending.replace(target)


def deploy(root, directory, dry=False, registry_user=None, pull=True):
    root, directory = root.resolve(), directory.resolve()
    require(
        directory.parent == root / "releases",
        "Release must be inside the release store",
    )
    release = load_release(directory / "release.json")
    apps = [*APPS, "render-executor"] if release["schemaVersion"] == 2 else APPS
    require(directory.name == release["gitSha"], "Release directory/SHA mismatch")
    values = runtime_environment(root / "shared/runtime.env")
    environment = {
        **os.environ,
        **values,
        **image_environment(release),
        "COMPOSE_FILE": f"{directory}/compose.yaml:{directory}/compose.staging.yaml",
        "COMPOSE_PROJECT_NAME": "editagent",
        "SEAWEED_REQUIRE_S3_ENV": "1",
    }
    old = os.environ.copy()
    original_cwd = Path.cwd()
    with tempfile.TemporaryDirectory() as docker_config:
        if registry_user and not dry:
            token = os.sys.stdin.read().strip()
            require(token, "Registry pull credential missing")
            environment["DOCKER_CONFIG"] = docker_config
            subprocess.run(
                [
                    "docker",
                    "--config",
                    docker_config,
                    "login",
                    "ghcr.io",
                    "--username",
                    registry_user,
                    "--password-stdin",
                ],
                input=token,
                text=True,
                check=True,
                timeout=30,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        os.environ.clear()
        os.environ.update(environment)
        try:
            os.chdir(directory)
            run(["docker", "compose", "config", "--quiet"], dry)
            if pull:
                run(["docker", "compose", "pull"], dry)
            run(["infra/seaweedfs/prepare-secrets.sh"], dry)
            run(["infra/seaweedfs/ensure-storage-network.sh"], dry)
            run(["docker", "compose", "stop", *apps, *STORAGE], dry)
            run(
                [
                    "docker",
                    "compose",
                    "create",
                    "--no-build",
                    "--force-recreate",
                    *STORAGE,
                ],
                dry,
            )
            run(["infra/seaweedfs/apply-host-isolation.sh"], dry)
            run(["infra/seaweedfs/apply-host-isolation.sh", "--check"], dry)
            if dry:
                print("DRY_RUN docker start <all four storage container IDs>")
            else:
                ids = subprocess.check_output(
                    ["docker", "compose", "ps", "-aq", *STORAGE], text=True, timeout=15
                ).split()
                require(len(ids) == 4, "Missing storage containers")
                run(["docker", "start", *ids], False)
            run(["infra/seaweedfs/apply-container-firewall.sh"], dry)
            run(
                [
                    "docker",
                    "compose",
                    "up",
                    "-d",
                    "--no-build",
                    "--wait",
                    "--wait-timeout",
                    "180",
                    *STORAGE,
                    "postgres",
                    "redis",
                ],
                dry,
            )
            run(["python3", "infra/scripts/ensure_bucket.py"], dry)
            run(
                [
                    "docker",
                    "compose",
                    "up",
                    "-d",
                    "--no-build",
                    "--wait",
                    "--wait-timeout",
                    "180",
                    *apps,
                ],
                dry,
            )
            if dry:
                print(
                    "DRY_RUN smoke all services and immutable digests; activate only after PASS"
                )
            else:
                smoke(release)
                activate(root, directory)
                (root / "deployed.json").write_text(
                    json.dumps(release, indent=2) + "\n"
                )
            print("STAGING_PIPELINE_DRY_RUN PASS" if dry else "STAGING_RELEASE PASS")
        except Exception:
            # Keep useful classifications without leaking inspect Config.Env/logs.
            if not dry:
                result = subprocess.run(
                    ["docker", "compose", "ps", "--all", "--format", "json"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
                (directory / "failed-compose-status.json").write_text(result.stdout)
            raise
        finally:
            os.chdir(original_cwd)
            os.environ.clear()
            os.environ.update(old)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=("deploy", "rollback", "resume"))
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--release-dir", type=Path)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--registry-user")
    args = p.parse_args()
    directory = (
        args.release_dir
        or (
            args.root / ("current" if args.action == "resume" else "previous")
        ).resolve()
    )
    require(directory.exists(), "Requested immutable release does not exist")
    args.root.mkdir(parents=True, exist_ok=True)
    with (args.root / "deployment.lock").open("a") as lock:
        deadline = time.monotonic() + 180
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline, "Deployment lock timed out")
                time.sleep(1)
        deploy(
            args.root,
            directory,
            args.dry_run,
            args.registry_user,
            pull=args.action != "resume",
        )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit(
            "Staging release failed; inspect safe Compose status and prior immutable release record"
        ) from None
