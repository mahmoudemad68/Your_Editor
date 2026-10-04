/**
 * S3 contract against the running SeaweedFS gateway.
 * Uses the same presign headers as S3ObjectStorage.
 */
import { createRequire } from "node:module";
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

const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const bucket = process.env.S3_BUCKET ?? "editagent";
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "editagent";
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "editagent-dev-secret";
const region = process.env.S3_REGION ?? "us-east-1";
const key = `projects/seaweed-regression/${randomBytes(8).toString("hex")}.bin`;
const body = Buffer.from(`seaweed-private-${randomBytes(16).toString("hex")}`);
const checksum = createHash("sha256").update(body).digest("base64");

const client = new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
} catch (error) {
  const status = error?.$metadata?.httpStatusCode;
  if (status !== 409) {
    fail(`create bucket failed: ${error}`);
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
const head = await client.send(
  new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: "ENABLED" }),
);
if (head.ContentType?.split(";")[0] !== "application/octet-stream") {
  fail(`content type ${head.ContentType}`);
}
if (head.ChecksumSHA256 !== checksum) {
  fail(`checksum ${head.ChecksumSHA256} != ${checksum}`);
}
const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
const bytes = Buffer.from(await got.Body.transformToByteArray());
if (!bytes.equals(body)) {
  fail("downloaded body does not match");
}

const anonymous = await fetch(`${endpoint.replace(/\/$/, "")}/${bucket}/${key}`);
if (anonymous.status === 200) {
  const leaked = Buffer.from(await anonymous.arrayBuffer());
  if (leaked.equals(body)) {
    fail("anonymous GET returned the private object");
  }
}
console.log(`anonymous status ${anonymous.status}`);

const command = new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  ContentType: "application/octet-stream",
  ChecksumSHA256: checksum,
  IfNoneMatch: "*",
});
const url = await getSignedUrl(client, command, {
  expiresIn: 900,
  signableHeaders: new Set(["content-type", "if-none-match"]),
  unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
});
const headers = {
  "Content-Type": "application/octet-stream",
  "x-amz-checksum-sha256": checksum,
  "If-None-Match": "*",
};
const duplicate = await fetch(url, { method: "PUT", headers, body });
if (duplicate.status !== 412) {
  fail(`If-None-Match duplicate returned ${duplicate.status} ${await duplicate.text()}`);
}
console.log("If-None-Match duplicate returned 412");

const freshKey = `${key}.fresh`;
const freshUrl = await getSignedUrl(
  client,
  new PutObjectCommand({
    Bucket: bucket,
    Key: freshKey,
    ContentType: "video/mp4",
    ChecksumSHA256: checksum,
    IfNoneMatch: "*",
  }),
  {
    expiresIn: 900,
    signableHeaders: new Set(["content-type", "if-none-match"]),
    unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
  },
);
const created = await fetch(freshUrl, {
  method: "PUT",
  headers: { ...headers, "Content-Type": "video/mp4" },
  body,
});
if (created.status !== 200 && created.status !== 204) {
  fail(`presigned create returned ${created.status} ${await created.text()}`);
}
console.log(`presigned create returned ${created.status}`);
console.log(`SEAWEED_OBJECT_KEY=${key}`);
