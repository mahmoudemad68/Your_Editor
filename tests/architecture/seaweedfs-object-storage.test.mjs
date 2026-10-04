/**
 * SeaweedFS replaces MinIO in the active Compose stack.
 * S3ObjectStorage stays the application adapter.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("the active stack publishes only the SeaweedFS S3 gateway", () => {
  const compose = read("compose.yaml");
  const dockerfile = read("infra/seaweedfs/Dockerfile");
  assert.match(
    dockerfile,
    /chrislusf\/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d/,
  );
  assert.equal(compose.includes("infra/minio/Dockerfile"), false);
  assert.match(compose, /storage_internal:\n {4}internal: true/);
  assert.match(compose, /S3_ENDPOINT: http:\/\/seaweed-s3:8333/);
  assert.match(compose, /127\.0\.0\.1:\$\{S3_PORT/);
  assert.equal(compose.includes("minio-data:"), true);
  for (const service of ["seaweed-master:", "seaweed-volume:", "seaweed-filer:", "seaweed-s3:"]) {
    assert.equal(compose.includes(service), true, service);
  }
  const master = compose.slice(
    compose.indexOf("  seaweed-master:"),
    compose.indexOf("  seaweed-volume:"),
  );
  const volume = compose.slice(
    compose.indexOf("  seaweed-volume:"),
    compose.indexOf("  seaweed-filer:"),
  );
  const filer = compose.slice(
    compose.indexOf("  seaweed-filer:"),
    compose.indexOf("  seaweed-s3:"),
  );
  assert.equal(master.includes("ports:"), false);
  assert.equal(volume.includes("ports:"), false);
  assert.equal(filer.includes("ports:"), false);
  assert.match(read("apps/api/src/infrastructure/s3-object-storage.ts"), /IfNoneMatch: "\*"/);
  assert.match(read(".github/workflows/supply-chain.yml"), /infra\/seaweedfs\/Dockerfile/);
  assert.equal(
    read(".github/workflows/supply-chain.yml").includes("infra/minio/Dockerfile"),
    false,
  );
  assert.match(read(".github/dependabot.yml"), /\/infra\/seaweedfs/);
  assert.equal(read(".github/dependabot.yml").includes("/infra/minio"), false);
});

test("the S3 contract runs after the workspace install", () => {
  const workflow = read(".github/workflows/ci.yml");
  const pnpmSetup = workflow.indexOf("name: Install pnpm");
  const nodeSetup = workflow.indexOf("name: Setup Node.js");
  const install = workflow.indexOf("pnpm install --frozen-lockfile");
  const contract = workflow.indexOf("node tests/architecture/seaweedfs-s3-contract.mjs");
  const start = workflow.indexOf("name: Start SeaweedFS");
  assert.equal(pnpmSetup > 0 && nodeSetup > pnpmSetup, true);
  assert.equal(install > nodeSetup, true);
  assert.equal(contract > install, true);
  const startup = workflow.slice(start, pnpmSetup);
  assert.match(startup, /curl -fsS http:\/\/127\.0\.0\.1:9000\/status/);
  assert.match(startup, /ensure_bucket\.py/);
  assert.match(startup, /start-storage\.sh/);
  assert.match(startup, /verify-trust-boundary\.sh/);
  assert.equal(startup.includes("seaweedfs-s3-contract.mjs"), false);
  assert.match(
    read("tests/architecture/seaweedfs-s3-contract.mjs"),
    /If-None-Match duplicate returned 412/,
  );
  assert.match(
    read("tests/architecture/seaweedfs-s3-contract.mjs"),
    /anonymous GET returned the private object/,
  );
});

test("object migration refuses to delete historical volumes", () => {
  const script = read("infra/scripts/migrate-minio-objects.py");
  const backup = read("infra/seaweedfs/backup-volumes.sh");
  const restore = read("infra/seaweedfs/restore-volumes.sh");
  assert.equal(script.includes("volume rm"), false);
  assert.equal(script.includes("compose down"), false);
  assert.match(script, /does not delete source objects or volumes/);
  assert.equal(backup.includes("minio-data"), false);
  assert.equal(restore.includes("volume rm"), false);
  const rejected = spawnSync(
    "python3",
    [path.join(root, "infra/scripts/migrate-minio-objects.py"), "--delete-volumes"],
    { encoding: "utf8" },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /does not delete/);
});

test("storage components keep fixed addresses and reject anonymous master HTTP", () => {
  const compose = read("compose.yaml");
  const network = read("infra/seaweedfs/storage-network.env");
  const secrets = read("infra/seaweedfs/prepare-secrets.sh");
  const isolation = read("infra/seaweedfs/apply-host-isolation.sh");
  const verify = read("infra/seaweedfs/verify-trust-boundary.sh");
  assert.match(compose, /-disableHttp/);
  assert.match(compose, /https:\/\/127\.0\.0\.1:9333\/healthz/);
  assert.equal(compose.includes("/dir/status"), false);
  assert.match(network, /SEAWEED_SUBNET=172\.30\.210\.0\/24/);
  assert.match(network, /SEAWEED_MASTER_IP=172\.30\.210\.10/);
  assert.match(network, /SEAWEED_VOLUME_IP=172\.30\.210\.11/);
  assert.match(network, /SEAWEED_FILER_IP=172\.30\.210\.12/);
  assert.match(network, /SEAWEED_S3_IP=172\.30\.210\.13/);
  for (const ip of ["172.30.210.10", "172.30.210.11", "172.30.210.12", "172.30.210.13"]) {
    assert.equal(compose.includes(ip), true, ip);
  }
  assert.match(
    compose,
    /-whiteList=172\.30\.210\.10,172\.30\.210\.11,172\.30\.210\.12,172\.30\.210\.13/,
  );
  assert.match(secrets, /\[https\.master\]/);
  assert.match(secrets, /\[grpc\.client\]/);
  assert.match(secrets, /allowed_commonNames = "editagent-volume,editagent-filer,editagent-s3"/);
  assert.match(secrets, /allowed_commonNames = "editagent-master,editagent-filer"/);
  assert.equal(secrets.includes('allowed_commonNames = "editagent-seaweed"'), false);
  assert.match(isolation, /DOCKER-USER/);
  assert.match(isolation, /ExecStartPost/);
  assert.match(isolation, /-j DROP/);
  assert.match(isolation, /ESTABLISHED,RELATED/);
  assert.match(isolation, /still allows the whole subnet/);
  const master = compose.slice(
    compose.indexOf("  seaweed-master:"),
    compose.indexOf("  seaweed-volume:"),
  );
  assert.match(master, /restart: "no"/);
  assert.match(master, /disable_ipv6/);
  assert.match(master, /master\.crt/);
  assert.equal(master.includes("seaweed.crt"), false);
  assert.match(verify, /dir\/assign/);
  assert.match(verify, /vol_status/);
  assert.match(verify, /DiskStatuses/);
  assert.match(verify, /master issued a write token/);
  assert.equal(verify.includes("console.log"), false);
  const starter = read("infra/seaweedfs/start-storage.sh");
  assert.equal(
    starter.indexOf("apply-host-isolation.sh") < starter.indexOf("docker compose up"),
    true,
  );
  assert.match(starter, /REBOOT_PERSISTENCE=open/);
  assert.match(read("Makefile"), /start-storage\.sh/);
});
