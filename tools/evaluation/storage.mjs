import {
  S3Client,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createReadStream, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";
import { loadDataset, validateDataset, repositoryRoot } from "./validate.mjs";

export function storageConfig(env, bucket) {
  for (const key of [
    "EVALUATION_S3_ENDPOINT",
    "EVALUATION_S3_BUCKET",
    "EVALUATION_S3_ACCESS_KEY_ID",
    "EVALUATION_S3_SECRET_ACCESS_KEY",
  ])
    if (!env[key]) throw new Error(`Missing ${key}`);
  if (env.EVALUATION_S3_BUCKET !== bucket)
    throw new Error("Configured bucket differs from manifest");
  const endpoint = new URL(env.EVALUATION_S3_ENDPOINT);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      ))
  )
    throw new Error("Endpoint must use HTTPS (HTTP permitted only on local loopback)");
  return {
    endpoint: endpoint.toString(),
    region: env.EVALUATION_S3_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.EVALUATION_S3_ACCESS_KEY_ID,
      secretAccessKey: env.EVALUATION_S3_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
}
export async function hashStream(body) {
  const hash = createHash("sha256");
  let size = 0n;
  for await (const chunk of body) {
    hash.update(chunk);
    size += BigInt(chunk.length);
  }
  return { sha256: hash.digest("hex"), sizeBytes: String(size) };
}
function verifyIdentity(actual, expected) {
  if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes)
    throw new Error(`Content differs for ${expected.id}`);
}
export async function verifyRemote(client, bucket, item) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.objectKey }));
  verifyIdentity(await hashStream(response.Body), item);
  if (!response.VersionId || response.VersionId === "null")
    throw new Error(`Object is not versioned: ${item.id}`);
  return response.VersionId;
}
export async function syncItem(client, bucket, item, path) {
  verifyIdentity(await hashStream(createReadStream(path)), item);
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: item.objectKey }));
    await verifyRemote(client, bucket, item);
    return "REUSED";
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
  }
  // Content-addressed names and conditional writes prevent accidental replacement.
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: item.objectKey,
      Body: createReadStream(path),
      ContentLength: statSync(path).size,
      ContentType:
        item.extension === "json"
          ? "application/json"
          : item.extension === "mp4"
            ? "video/mp4"
            : item.extension === "webm"
              ? "video/webm"
              : "video/ogg",
      IfNoneMatch: "*",
      Metadata: { sha256: item.sha256, dataset: item.datasetVersion || "source" },
    }),
  );
  await verifyRemote(client, bucket, item);
  return "UPLOADED";
}
export async function runStorage(command, { root, dryRun = false, env = process.env } = {}) {
  const { manifest, registry, documents } = loadDataset();
  const report = validateDataset(manifest, registry, documents);
  if (!report.DATASET_STRUCTURALLY_VALID) throw new Error(report.errors.join("; "));
  const config = storageConfig(env, manifest.storage.bucket);
  const items = manifest.sources.flatMap((source) => [source, ...source.referenceArtifacts]);
  if (command !== "sync" && command !== "deep") throw new Error("Expected sync or deep");
  if (command === "sync" && !root) throw new Error("sync requires --root media-directory");
  const files = items.map((item) => ({
    item,
    path: item.metadataPath
      ? resolve(repositoryRoot, item.metadataPath)
      : resolve(root || ".", `${item.id}.${item.extension}`),
  }));
  if (dryRun) {
    for (const { item, path } of files) {
      if (command === "sync") verifyIdentity(await hashStream(createReadStream(path)), item);
      console.log(`${command.toUpperCase()} ${item.id} ${item.objectKey}`);
    }
    return { inspected: items.length, uploaded: 0, reused: 0 };
  }
  const client = new S3Client(config);
  try {
    const versioning = await client.send(
      new GetBucketVersioningCommand({ Bucket: manifest.storage.bucket }),
    );
    if (versioning.Status !== "Enabled")
      throw new Error(
        "Bucket versioning must be Enabled; tool never enables or creates buckets implicitly",
      );
    const result = { inspected: 0, uploaded: 0, reused: 0 };
    for (const { item, path } of files) {
      const action =
        command === "deep"
          ? (await verifyRemote(client, manifest.storage.bucket, item), "VERIFIED")
          : await syncItem(client, manifest.storage.bucket, item, path);
      result.inspected++;
      if (action === "UPLOADED") result.uploaded++;
      if (action === "REUSED") result.reused++;
      console.log(`${action} ${item.id}`);
    }
    return result;
  } finally {
    client.destroy();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      command = args.shift();
    const index = args.indexOf("--root");
    const allowed = args.filter((_, i) => i !== index && i !== index + 1);
    if (
      index < 0
        ? args.some((a) => a !== "--dry-run")
        : !args[index + 1] || allowed.some((a) => a !== "--dry-run")
    )
      throw new Error("Usage: storage.mjs sync --root DIR [--dry-run] | deep [--dry-run]");
    console.log(
      JSON.stringify(
        await runStorage(command, {
          root: index >= 0 ? args[index + 1] : undefined,
          dryRun: args.includes("--dry-run"),
        }),
      ),
    );
  } catch (error) {
    // SDK errors may carry request headers/URLs. Emit only a safe fixed error or local validation error.
    console.error(
      error.$metadata
        ? `Storage request failed (${error.$metadata.httpStatusCode || "unknown"})`
        : error.message,
    );
    process.exitCode = 1;
  }
}
