/**
 * S3 contract against the running SeaweedFS gateway.
 * Uses the same presign headers as S3ObjectStorage.
 */
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Recovery is destructive beyond this test's random key. Admit only the local,
// independently inspected disposable Walking stack, before constructing an S3
// client or touching storage. Environment strings alone are never admission.
const recoveryMode = process.argv.includes("--verify-backup");
function inspectDisposableRecovery() {
  const reject = () => {
    throw new Error("RECOVERY_REQUIRES_DISPOSABLE_WALKING_STACK");
  };
  const project = "walking-skeleton",
    socket = "unix:///var/run/docker.sock";
  const port = process.env.S3_PORT ?? "9000";
  if (
    process.env.COMPOSE_PROJECT_NAME !== project ||
    process.env.EDITAGENT_RUNTIME !== "development" ||
    !/^[1-9][0-9]{0,4}$/.test(port) ||
    Number(port) > 65535 ||
    process.env.S3_ENDPOINT !== `http://127.0.0.1:${port}` ||
    process.platform !== "linux" ||
    (process.env.DOCKER_HOST !== undefined && process.env.DOCKER_HOST !== socket) ||
    (process.env.DOCKER_CONTEXT !== undefined && process.env.DOCKER_CONTEXT !== "default") ||
    process.env.COMPOSE_FILE !== undefined ||
    process.env.COMPOSE_ENV_FILES !== undefined ||
    process.env.DOCKER_TLS_VERIFY !== undefined ||
    process.env.DOCKER_CERT_PATH !== undefined
  )
    reject();
  const env = {
    ...process.env,
    DOCKER_HOST: socket,
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: path.join(root, "compose.yaml"),
    COMPOSE_DISABLE_ENV_FILE: "1",
    COMPOSE_PATH_SEPARATOR: ":",
    COMPOSE_PROFILES: "",
    S3_PORT: port,
  };
  delete env.DOCKER_CONTEXT;
  delete env.COMPOSE_ENV_FILES;
  const docker = (args) => {
    const r = spawnSync("docker", ["--host", socket, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1048576,
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") reject();
    return r.stdout;
  };
  const one = (args) => {
    let value;
    try {
      value = JSON.parse(docker(args));
    } catch {
      reject();
    }
    if (
      !Array.isArray(value) ||
      value.length !== 1 ||
      value[0] === null ||
      typeof value[0] !== "object" ||
      Array.isArray(value[0])
    )
      reject();
    return value[0];
  };
  const identities = [],
    ids = new Set();
  let image;
  for (const role of ["seaweed-master", "seaweed-volume", "seaweed-filer", "seaweed-s3"]) {
    const id = docker([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      `label=com.docker.compose.service=${role}`,
    ]).trim();
    if (!/^[a-f0-9]{64}$/.test(id) || ids.has(id)) reject();
    ids.add(id);
    const c = one(["container", "inspect", id]),
      labels = c.Config?.Labels;
    if (
      c.Id !== id ||
      c.State?.Running !== true ||
      c.HostConfig?.Privileged !== false ||
      labels?.["com.docker.compose.project"] !== project ||
      labels?.["com.docker.compose.service"] !== role ||
      labels?.["com.docker.compose.project.working_dir"] !== root ||
      labels?.["com.docker.compose.project.config_files"] !== path.join(root, "compose.yaml") ||
      !/^sha256:[a-f0-9]{64}$/.test(c.Image) ||
      (image !== undefined && image !== c.Image)
    )
      reject();
    image = c.Image;
    let volume = null,
      dataSource = null;
    if (role === "seaweed-s3") {
      const bindings = c.NetworkSettings?.Ports?.["8333/tcp"];
      if (
        typeof c.HostConfig?.NetworkMode !== "string" ||
        !c.HostConfig.NetworkMode ||
        c.HostConfig.NetworkMode === "host" ||
        !Array.isArray(bindings) ||
        bindings.length !== 1 ||
        bindings[0].HostIp !== "127.0.0.1" ||
        bindings[0].HostPort !== port
      )
        reject();
    } else {
      if (!Array.isArray(c.Mounts) || c.Mounts.some((m) => !m || typeof m.Destination !== "string"))
        reject();
      const mounts = c.Mounts.filter(
        (m) => m.Destination === "/data" || m.Destination?.startsWith("/data/"),
      );
      volume = `${project}_${role}`;
      if (
        mounts.length !== 1 ||
        mounts[0].Type !== "volume" ||
        mounts[0].RW !== true ||
        mounts[0].Name !== volume
      )
        reject();
      const v = one(["volume", "inspect", volume]);
      if (
        v.Name !== volume ||
        v.Driver !== "local" ||
        v.Scope !== "local" ||
        !(
          v.Options === null ||
          (v.Options &&
            typeof v.Options === "object" &&
            !Array.isArray(v.Options) &&
            Object.keys(v.Options).length === 0)
        ) ||
        typeof v.Mountpoint !== "string" ||
        !v.Mountpoint.startsWith("/") ||
        mounts[0].Source !== v.Mountpoint ||
        v.Labels?.["com.docker.compose.project"] !== project ||
        v.Labels?.["com.docker.compose.volume"] !== role
      )
        reject();
      dataSource = v.Mountpoint;
    }
    identities.push({ role, id, image: c.Image, volume, dataSource });
  }
  return { env, identities };
}
const recoveryAdmission = recoveryMode ? inspectDisposableRecovery() : null;

const require = createRequire(path.join(root, "apps/api/package.json"));
const {
  CreateBucketCommand,
  DeleteObjectCommand,
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

// Exercise the existing stopped-copy recovery procedure on disposable CI data.
// Never pass production volumes or private evidence to this contract runner.
if (recoveryMode) {
  const parent = path.join(root, ".local/seaweedfs-recovery");
  mkdirSync(parent, { recursive: true });
  const backup = mkdtempSync(path.join(parent, "contract-"));
  function recovery(script) {
    const current = inspectDisposableRecovery();
    if (JSON.stringify(current.identities) !== JSON.stringify(recoveryAdmission.identities)) {
      throw new Error("RECOVERY_DISPOSABLE_STACK_CHANGED");
    }
    const result = spawnSync("sh", [path.join(root, "infra/seaweedfs", script), backup], {
      cwd: root,
      env: recoveryAdmission.env,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.status !== 0) fail(`SeaweedFS ${script} failed; inspect service readiness`);
  }
  try {
    recovery("backup-volumes.sh");
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    let deleted = false;
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 404) throw error;
      deleted = true;
    }
    if (!deleted) fail("backup recovery control object was not deleted");
    recovery("restore-volumes.sh");
    const restored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!Buffer.from(await restored.Body.transformToByteArray()).equals(body)) {
      fail("restored object bytes do not match the pre-backup source");
    }
    const denied = await fetch(`${endpoint.replace(/\/$/, "")}/${bucket}/${key}`);
    if (denied.status !== 403) fail("restored private object did not reject anonymous access");
    console.log("SeaweedFS stopped backup/delete/restore: bytes and private access PASS");
  } finally {
    rmSync(backup, { recursive: true, force: true });
  }
}
console.log(`SEAWEED_OBJECT_KEY=${key}`);
