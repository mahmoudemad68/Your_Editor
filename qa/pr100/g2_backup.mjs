/**
 * Stopped backup, delete, and restore against the live SeaweedFS gateway.
 * Uses the AWS SDK rather than a hand-signed curl DELETE.
 */
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "apps/api/package.json"));
const { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } =
  require("@aws-sdk/client-s3");

const results = process.argv[2];
const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const bucket = process.env.S3_BUCKET ?? "editagent";
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "editagent";
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "editagent-dev-secret";
const client = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

const emitted = new Set();
function emit(id, status, required, detail) {
  if (emitted.has(id)) return;
  emitted.add(id);
  appendFileSync(results, JSON.stringify({ id, gate: "G2", status, required, detail }) + "\n");
  console.log(`${status} ${id}: ${detail}`);
}

function run(script, directory) {
  return spawnSync("sh", [path.join(root, "infra/seaweedfs", script), directory], {
    cwd: root,
    encoding: "utf8",
    timeout: 180000,
  });
}

const key = `projects/qa-backup/${randomBytes(8).toString("hex")}.bin`;
const body = Buffer.from(`qa-backup-${randomBytes(16).toString("hex")}`);
const digest = createHash("sha256").update(body).digest("hex");

try {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 409) throw error;
  }
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/octet-stream",
    }),
  );
  const backup = await mkdtemp(path.join(tmpdir(), "qa-seaweed-backup-"));
  const copied = run("backup-volumes.sh", backup);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  let absent = false;
  let absentStatus = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      absentStatus = 200;
    } catch (error) {
      absentStatus = error?.$metadata?.httpStatusCode ?? 0;
      absent = absentStatus === 404;
      if (absent) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const restored = run("restore-volumes.sh", backup);
  let restoredBytes = Buffer.alloc(0);
  let getStatus = 0;
  try {
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    getStatus = got.$metadata.httpStatusCode ?? 0;
    restoredBytes = Buffer.from(await got.Body.transformToByteArray());
  } catch (error) {
    getStatus = error?.$metadata?.httpStatusCode ?? 0;
  }
  const actual = createHash("sha256").update(restoredBytes).digest("hex");
  const anonymous = await fetch(`${endpoint.replace(/\/$/, "")}/${bucket}/${key}`);
  const ok =
    copied.status === 0 &&
    absent &&
    restored.status === 0 &&
    getStatus === 200 &&
    actual === digest &&
    anonymous.status === 403;
  emit(
    "g2.backup_restore",
    ok ? "PASS" : "FAIL",
    true,
    `backup=${copied.status} absent=${absentStatus} restore=${restored.status} get=${getStatus} sha256=${actual} expected=${digest} anonymous=${anonymous.status}`,
  );
  const corrupt = path.join(backup, "corrupt");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(corrupt);
  for (const name of ["seaweed-master.tar", "seaweed-volume.tar", "seaweed-filer.tar"]) {
    writeFileSync(path.join(corrupt, name), "not-a-tar");
  }
  const bad = run("restore-volumes.sh", corrupt);
  emit("g2.corrupt_backup_control", bad.status === 0 ? "FAIL" : "PASS", true, `corrupt restore exit=${bad.status}`);
  const missing = run("restore-volumes.sh", path.join(backup, "missing-backup"));
  emit(
    "g2.missing_backup_control",
    missing.status === 0 ? "FAIL" : "PASS",
    true,
    `missing restore exit=${missing.status}`,
  );
  await rm(backup, { recursive: true, force: true });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  emit("g2.backup_restore", "ERROR", true, detail);
  emit("g2.corrupt_backup_control", "ERROR", true, detail);
  emit("g2.missing_backup_control", "ERROR", true, detail);
  process.exitCode = 1;
}
