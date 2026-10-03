/**
 * Isolated SeaweedFS proof. The S3 adapter is the production class, unchanged.
 * This does not replace MinIO or accept an ADR change.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(root, "apps/api/package.json"));
const { S3ObjectStorage } = require(
  path.join(root, "apps/api/dist/infrastructure/s3-object-storage.js"),
);

const endpoint = "http://127.0.0.1:18333";
const ingressPort = 18081;

function compose(args) {
  return spawnSync("docker", ["compose", "-f", "compose.seaweedfs-spike.yaml", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function docker(args) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("SeaweedFS satisfies the current S3 upload guarantees", async () => {
  const minioVolumesBefore = docker(["volume", "ls", "--format", "{{.Name}}"])
    .split("\n")
    .filter((name) => name.includes("minio"));
  const up = compose(["up", "-d", "--wait", "--wait-timeout", "60"]);
  assert.equal(up.status, 0, up.stderr);
  const ingress = "editagent-seaweedfs-spike-ingress";
  try {
    const storage = new S3ObjectStorage({
      endpoint,
      publicEndpoint: endpoint,
      bucket: "editagent-spike",
      accessKeyId: "seaweed-spike-access",
      secretAccessKey: "seaweed-spike-secret",
      region: "us-east-1",
    });
    const body = Buffer.from("editagent-seaweed-feasibility");
    const hash = createHash("sha256").update(body).digest("hex");
    const key = `projects/spike/media/sha256/${hash}`;
    await storage.ensureBucket();
    await storage.put(key, body, "video/mp4", hash);
    assert.deepEqual(Buffer.from(await storage.get(key)), body);
    const direct = await storage.stat(key);
    assert.equal(direct?.byteSize, BigInt(body.length));
    assert.equal(direct?.contentType, "video/mp4");
    assert.equal(direct?.checksumSha256Hex, hash);
    await storage.delete(key);
    assert.equal(await storage.stat(key), null);

    const presigned = await storage.presignPut({
      key,
      contentType: "video/mp4",
      checksumSha256Hex: hash,
      expiresInSeconds: 60,
      onlyIfAbsent: true,
    });
    const signedUrl = new URL(presigned.url);
    assert.equal(signedUrl.host, "127.0.0.1:18333");
    assert.equal(signedUrl.pathname.startsWith("/editagent-spike/"), true);
    assert.equal(presigned.requiredHeaders["Content-Type"], "video/mp4");
    assert.equal(presigned.requiredHeaders["If-None-Match"], "*");
    assert.equal(typeof presigned.requiredHeaders["x-amz-checksum-sha256"], "string");
    const uploaded = await fetch(presigned.url, {
      method: "PUT",
      headers: presigned.requiredHeaders,
      body,
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    const wrongType = await fetch(presigned.url, {
      method: "PUT",
      headers: { ...presigned.requiredHeaders, "Content-Type": "text/plain" },
      body,
    });
    assert.equal(wrongType.status, 403);
    const missingMatch = { ...presigned.requiredHeaders };
    delete missingMatch["If-None-Match"];
    assert.equal(
      (
        await fetch(presigned.url, {
          method: "PUT",
          headers: missingMatch,
          body,
        })
      ).status,
      403,
    );
    const missingChecksum = { ...presigned.requiredHeaders };
    delete missingChecksum["x-amz-checksum-sha256"];
    assert.equal(
      (
        await fetch(presigned.url, {
          method: "PUT",
          headers: missingChecksum,
          body,
        })
      ).status,
      403,
    );
    const duplicate = await fetch(presigned.url, {
      method: "PUT",
      headers: presigned.requiredHeaders,
      body,
    });
    assert.equal(duplicate.status, 412);
    const completed = await storage.stat(key);
    assert.equal(completed?.byteSize, BigInt(body.length));
    assert.equal(completed?.contentType, "video/mp4");
    assert.equal(completed?.checksumSha256Hex, hash);

    docker([
      "build",
      "-t",
      "editagent-object-ingress:debug",
      "-f",
      "infra/object-ingress/Dockerfile",
      ".",
    ]);
    spawnSync("docker", ["rm", "-f", ingress]);
    docker([
      "run",
      "-d",
      "--name",
      ingress,
      "--network",
      "host",
      "-e",
      "MINIO_UPSTREAM=http://127.0.0.1:18333",
      "-e",
      `PORT=${ingressPort}`,
      "editagent-object-ingress:debug",
    ]);
    let ingressReady = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const health = await fetch(`http://127.0.0.1:${ingressPort}/health`).catch(() => null);
      if (health?.ok) {
        ingressReady = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ingressReady, true);
    const publicStorage = new S3ObjectStorage({
      endpoint,
      publicEndpoint: `http://127.0.0.1:${ingressPort}`,
      bucket: "editagent-spike",
      accessKeyId: "seaweed-spike-access",
      secretAccessKey: "seaweed-spike-secret",
      region: "us-east-1",
    });
    const ingressBody = Buffer.from("editagent-seaweed-ingress");
    const ingressHash = createHash("sha256").update(ingressBody).digest("hex");
    const ingressPresigned = await publicStorage.presignPut({
      key: `ingress/${ingressHash}`,
      contentType: "text/plain",
      checksumSha256Hex: ingressHash,
      expiresInSeconds: 60,
      onlyIfAbsent: true,
    });
    assert.equal(new URL(ingressPresigned.url).host, `127.0.0.1:${ingressPort}`);
    const ingressPut = await fetch(ingressPresigned.url, {
      method: "PUT",
      headers: ingressPresigned.requiredHeaders,
      body: ingressBody,
    });
    assert.equal(ingressPut.status, 200, await ingressPut.text());
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${ingressPort}/?Action=AssumeRoleWithLDAPIdentity`, {
          method: "POST",
        })
      ).status,
      403,
    );
    assert.equal((await fetch(`http://127.0.0.1:${ingressPort}/minio/admin/v3/info`)).status, 403);
  } finally {
    spawnSync("docker", ["rm", "-f", ingress]);
    compose(["down", "-v"]);
    const minioVolumesAfter = docker(["volume", "ls", "--format", "{{.Name}}"])
      .split("\n")
      .filter((name) => name.includes("minio"));
    assert.deepEqual(minioVolumesAfter, minioVolumesBefore);
  }
});
