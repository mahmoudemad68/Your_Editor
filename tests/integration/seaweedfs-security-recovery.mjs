/** Actual disposable 4.51 snapshot -> candidate -> snapshot rollback proof. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { startSeaweedfsStorage } from "./support/seaweedfs-storage.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const roles = ["master", "volume", "filer", "s3"];
const donor =
  "chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const storage = await startSeaweedfsStorage();
const privateDir = path.join(root, ".local", storage.project, "recovery");
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const cli = (script, args = []) =>
  execFileSync("sh", [script, ...args], {
    cwd: root,
    env: storage.env,
    stdio: "inherit",
    timeout: 600000,
  });
const candidate = storage.identity.image_id;
const s3 = new S3Client({
  endpoint: storage.endpoint,
  region: storage.region,
  credentials: storage.credentials,
  forcePathStyle: true,
});
const Bucket = `recovery-${randomUUID()}`,
  Key = "synthetic-source.bin",
  Body = Buffer.from("public synthetic storage compatibility control\n");
const snapshots = path.join(privateDir, "baseline-snapshot");
const baseRecipe = path.join(privateDir, "Baseline.Dockerfile");
const override = path.join(privateDir, "baseline.compose.json");
const baselineTag = `editagent-baseline-rehearsal:${storage.project}`;
let baselineId;
async function switchImage(baseline) {
  storage.docker(["compose", "stop", ...roles.map((r) => `seaweed-${r}`)]);
  if (baseline) storage.env.COMPOSE_FILE = `${path.join(root, "compose.yaml")}:${override}`;
  else delete storage.env.COMPOSE_FILE;
  storage.docker([
    "compose",
    "create",
    "--no-build",
    "--force-recreate",
    ...roles.map((r) => `seaweed-${r}`),
  ]);
  cli("infra/seaweedfs/apply-host-isolation.sh");
  cli("infra/seaweedfs/apply-host-isolation.sh", ["--check"]);
  const containers = roles.map((r) =>
    storage.docker(["compose", "ps", "-aq", `seaweed-${r}`]).trim(),
  );
  for (const container of containers)
    assert.equal(
      storage.docker(["inspect", "--format", "{{.Image}}", container]).trim(),
      baseline ? baselineId : candidate,
    );
  storage.docker(["start", ...containers]);
  cli("infra/seaweedfs/apply-container-firewall.sh");
  storage.docker([
    "compose",
    "up",
    "-d",
    "--no-build",
    "--wait",
    "--wait-timeout",
    "180",
    ...roles.map((r) => `seaweed-${r}`),
  ]);
}
async function stoppedSnapshot(dir, restore = false) {
  assert.match(storage.project, /^seaweed-qualification-[a-f0-9]{32}$/);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  storage.docker(["compose", "stop", ...roles.map((r) => `seaweed-${r}`)]);
  for (const role of roles.slice(0, 3)) {
    const volume = `${storage.project}_seaweed-${role}`;
    const archive = path.join(dir, `${role}.tar`);
    if (restore) {
      assert.ok((await readFile(archive)).length > 0);
      storage.docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "sh",
        "-v",
        `${volume}:/data`,
        "-v",
        `${archive}:/snapshot.tar:ro`,
        candidate,
        "-ec",
        "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar -C /data -xf /snapshot.tar",
      ]);
    } else
      storage.docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "tar",
        "-v",
        `${volume}:/data:ro`,
        "-v",
        `${dir}:/snapshot`,
        candidate,
        "-C",
        "/data",
        "-cf",
        `/snapshot/${role}.tar`,
        ".",
      ]);
  }
}
try {
  // Test-only old runtime, exact original source/donor and identical project
  // firewall wrapper. It is never offered as a qualified CI/product fallback.
  await writeFile(
    baseRecipe,
    `FROM ${donor}\nCOPY infra/seaweedfs/docker-entrypoint.sh /usr/local/bin/editagent-entrypoint.sh\nRUN chmod 755 /usr/local/bin/editagent-entrypoint.sh\nENTRYPOINT ["/usr/local/bin/editagent-entrypoint.sh"]\n`,
  );
  storage.docker(["build", "--platform", "linux/amd64", "-f", baseRecipe, "-t", baselineTag, "."]);
  baselineId = storage.docker(["image", "inspect", baselineTag, "--format", "{{.Id}}"]).trim();
  await writeFile(
    override,
    JSON.stringify({
      services: Object.fromEntries(roles.map((r) => [`seaweed-${r}`, { image: baselineTag }])),
    }),
  );
  await switchImage(true);
  await s3.send(new CreateBucketCommand({ Bucket }));
  await s3.send(new PutObjectCommand({ Bucket, Key, Body }));
  assert.deepEqual(
    Buffer.from(
      await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray(),
    ),
    Body,
  );
  await stoppedSnapshot(snapshots);
  const hashes = {};
  for (const role of roles.slice(0, 3))
    hashes[role] = sha(await readFile(path.join(snapshots, `${role}.tar`)));
  await switchImage(false);
  assert.deepEqual(
    Buffer.from(
      await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray(),
    ),
    Body,
  );
  await s3.send(
    new PutObjectCommand({
      Bucket,
      Key: "post-cutover.bin",
      Body: "not part of baseline snapshot",
    }),
  );
  // Current reviewed operator helpers: exact live image, stopped backup, hash
  // check of every archive before any destructive restore.
  const backup = path.join(privateDir, "candidate-backup");
  cli("infra/seaweedfs/backup-volumes.sh", [backup]);
  const corrupt = path.join(privateDir, "corrupt");
  await mkdir(corrupt);
  for (const name of [
    "seaweed-master.tar",
    "seaweed-volume.tar",
    "seaweed-filer.tar",
    "SHA256SUMS",
  ])
    await writeFile(path.join(corrupt, name), await readFile(path.join(backup, name)));
  await writeFile(path.join(corrupt, "seaweed-volume.tar"), "corrupted synthetic snapshot");
  let rejected = false;
  try {
    cli("infra/seaweedfs/restore-volumes.sh", [corrupt]);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
  assert.deepEqual(
    Buffer.from(
      await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray(),
    ),
    Body,
  );
  rejected = false;
  try {
    cli("infra/seaweedfs/restore-volumes.sh", [path.join(privateDir, "missing")]);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
  await s3.send(new DeleteObjectCommand({ Bucket, Key }));
  let deleted = false;
  try {
    await s3.send(new GetObjectCommand({ Bucket, Key }));
  } catch (e) {
    deleted = e.$metadata?.httpStatusCode === 404;
  }
  assert.equal(deleted, true);
  cli("infra/seaweedfs/restore-volumes.sh", [backup]);
  assert.deepEqual(
    Buffer.from(
      await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray(),
    ),
    Body,
  );
  for (const script of [
    "verify-firewall-lifecycle.sh",
    "verify-jwt-authority.sh",
    "verify-trust-boundary.sh",
  ])
    cli(`infra/seaweedfs/${script}`);
  // Rollback is a STOPPED baseline snapshot restore, not an in-place downgrade
  // after candidate writes. The post-cutover write is deliberately not retained.
  for (const role of roles.slice(0, 3))
    assert.equal(sha(await readFile(path.join(snapshots, `${role}.tar`))), hashes[role]);
  await stoppedSnapshot(snapshots, true);
  await switchImage(true);
  assert.deepEqual(
    Buffer.from(
      await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray(),
    ),
    Body,
  );
  let postCutoverMissing = false;
  try {
    await s3.send(new GetObjectCommand({ Bucket, Key: "post-cutover.bin" }));
  } catch (e) {
    postCutoverMissing = e.$metadata?.httpStatusCode === 404;
  }
  assert.equal(postCutoverMissing, true);
  await switchImage(false);
  assert.deepEqual(
    Buffer.from(
      await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray(),
    ),
    Body,
  );
  const reportDir = path.join(root, ".local/seaweedfs-recovery-public");
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, "report.json"),
    JSON.stringify(
      {
        status: "PASS",
        candidate_image: candidate,
        baseline_image: baselineId,
        baseline_snapshot_sha256: hashes,
        forward_read_write: true,
        corrupt_and_missing_rejected: true,
        authenticated_recovery: true,
        snapshot_rollback: true,
        post_cutover_writes_not_in_rollback: true,
        production_migration: "NOT_VERIFIED_NOT_AUTHORIZED",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  s3.destroy();
  delete storage.env.COMPOSE_FILE;
  await storage.close();
}
