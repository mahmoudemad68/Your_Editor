/**
 * The staging object ingress accepts a signed upload and refuses MinIO
 * STS and admin paths. An unpublished MinIO port remains reachable on the
 * Docker bridge from this host.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function apiNode(source) {
  const file = path.join(
    root,
    "apps/api",
    `.ingress-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`,
  );
  writeFileSync(file, source);
  try {
    const result = spawnSync("node", [file], {
      cwd: path.join(root, "apps/api"),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  } finally {
    unlinkSync(file);
  }
}

test("signed uploads use the ingress and admin paths do not", async () => {
  const suffix = mkdtempSync(path.join(tmpdir(), "ingress-")).split("/").pop();
  const minio = `editagent-minio-${suffix}`;
  const ingress = `editagent-ingress-${suffix}`;
  const ingressImage = `editagent-object-ingress:${suffix}`;
  try {
    docker(["build", "-t", ingressImage, "-f", "infra/object-ingress/Dockerfile", "."], {
      cwd: root,
    });
    docker([
      "run",
      "-d",
      "--name",
      minio,
      "-e",
      "MINIO_ROOT_USER=editagent",
      "-e",
      "MINIO_ROOT_PASSWORD=editagent-dev-secret",
      "editagent-minio:remediated",
    ]);
    const minioAddress = docker([
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      minio,
    ]);
    let live = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`http://${minioAddress}:9000/minio/health/live`).catch(
        () => null,
      );
      live = response?.status ?? 0;
      if (live === 200) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(live, 200);
    docker([
      "run",
      "-d",
      "--name",
      ingress,
      "-e",
      `MINIO_UPSTREAM=http://${minioAddress}:9000`,
      "-p",
      "127.0.0.1::8080",
      ingressImage,
    ]);
    const port = docker([
      "inspect",
      "-f",
      '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}',
      ingress,
    ]);
    const publicEndpoint = `http://127.0.0.1:${port}`;
    apiNode(`
      import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
      const client = new S3Client({
        region: "us-east-1",
        endpoint: "http://${minioAddress}:9000",
        forcePathStyle: true,
        credentials: { accessKeyId: "editagent", secretAccessKey: "editagent-dev-secret" },
      });
      await client.send(new CreateBucketCommand({ Bucket: "editagent" }));
    `);
    const signed = apiNode(`
      import { createHash } from "node:crypto";
      import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
      import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
      const body = Buffer.from("editagent-ingress");
      const checksum = createHash("sha256").update(body).digest("base64");
      const client = new S3Client({
        region: "us-east-1",
        endpoint: "${publicEndpoint}",
        forcePathStyle: true,
        credentials: { accessKeyId: "editagent", secretAccessKey: "editagent-dev-secret" },
      });
      const url = await getSignedUrl(client, new PutObjectCommand({
        Bucket: "editagent",
        Key: "ingress.txt",
        ContentType: "text/plain",
        ChecksumSHA256: checksum,
      }), { expiresIn: 60, signableHeaders: new Set(["content-type"]), unhoistableHeaders: new Set(["x-amz-checksum-sha256"]) });
      process.stdout.write(url + "\\n" + checksum);
    `);
    const [url, checksum] = signed.split("\n");
    assert.equal(url.startsWith(`${publicEndpoint}/`), true);
    const uploaded = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "text/plain", "x-amz-checksum-sha256": checksum },
      body: Buffer.from("editagent-ingress"),
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    assert.equal(
      (await fetch(`${publicEndpoint}/?Action=AssumeRoleWithLDAPIdentity`, { method: "POST" }))
        .status,
      403,
    );
    assert.equal((await fetch(`${publicEndpoint}/minio/admin/v3/info`)).status, 403);
    assert.equal((await fetch(`${publicEndpoint}/health`)).status, 200);
  } finally {
    spawnSync("docker", ["rm", "-f", minio, ingress]);
  }
});
