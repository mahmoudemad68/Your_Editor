/**
 * Independent S3 checks against the running SeaweedFS gateway.
 * Does not import the product contract runner.
 */
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "apps/api/package.json"));
const {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const results = process.argv[2];
const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const bucket = process.env.S3_BUCKET ?? "editagent";
const otherBucket = "qa-cross-bucket";
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "editagent";
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "editagent-dev-secret";
const region = process.env.S3_REGION ?? "us-east-1";

const emitted = new Set();
function emit(id, status, detail) {
  if (emitted.has(id)) return;
  emitted.add(id);
  appendFileSync(
    results,
    JSON.stringify({ id, gate: "G2", status, required: true, detail }) + "\n",
  );
  console.log(`${status} ${id}: ${detail}`);
}

const client = new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

const key = `projects/qa-independent/${randomBytes(8).toString("hex")}.bin`;
const body = Buffer.from(`qa-seaweed-${randomBytes(16).toString("hex")}`);
const checksum = createHash("sha256").update(body).digest("base64");
const checksumHex = createHash("sha256").update(body).digest("hex");

try {
  for (const name of [bucket, otherBucket]) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: name }));
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 409) throw error;
    }
  }
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/octet-stream",
      ChecksumSHA256: checksum,
    }),
  );
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }));
  const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = Buffer.from(await got.Body.transformToByteArray());
  const match = bytes.equals(body) && head.ChecksumSHA256 === checksum;
  emit(
    "g2.s3_checksum",
    match ? "PASS" : "FAIL",
    `bytes=${bytes.length} sha256=${checksumHex} headChecksumMatch=${head.ChecksumSHA256 === checksum}`,
  );

  const signed = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 2 });
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const expired = await fetch(signed);
  emit(
    "g2.presign_expiry",
    expired.status === 403 ? "PASS" : "FAIL",
    `expired presigned GET status=${expired.status}`,
  );

  const anonymous = await fetch(`${endpoint.replace(/\/$/, "")}/${bucket}/${key}`);
  const anonymousBody = Buffer.from(await anonymous.arrayBuffer());
  emit(
    "g2.anonymous_deny",
    anonymous.status === 403 && !anonymousBody.equals(body) ? "PASS" : "FAIL",
    `anonymous status=${anonymous.status}`,
  );

  const wrong = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "qa-wrong", secretAccessKey: "qa-wrong-secret" },
  });
  let wrongStatus = 0;
  try {
    await wrong.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    wrongStatus = 200;
  } catch (error) {
    wrongStatus = error?.$metadata?.httpStatusCode ?? 0;
  }
  emit(
    "g2.wrong_credentials",
    wrongStatus === 403 ? "PASS" : "FAIL",
    `wrong credentials status=${wrongStatus}`,
  );

  const cross = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 60 });
  const rewritten = cross.replace(`/${bucket}/`, `/${otherBucket}/`);
  const crossResponse = await fetch(rewritten);
  const crossBody = Buffer.from(await crossResponse.arrayBuffer());
  emit(
    "g2.cross_bucket",
    crossResponse.status !== 200 && !crossBody.equals(body) ? "PASS" : "FAIL",
    `signature rewritten to ${otherBucket} status=${crossResponse.status}`,
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  for (const id of ["g2.s3_checksum", "g2.presign_expiry", "g2.anonymous_deny", "g2.wrong_credentials", "g2.cross_bucket"]) {
    emit(id, "ERROR", detail);
  }
  process.exitCode = 1;
}
