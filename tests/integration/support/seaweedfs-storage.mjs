/** Disposable production Compose storage; never substitutes MinIO or fixture APIs. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
export async function startSeaweedfsStorage() {
  if (!process.env.SEAWEED_QUALIFIED_RECEIPT)
    throw new Error("Candidate SeaweedFS requires admitted immutable evidence");
  const receipt = JSON.parse(await readFile(process.env.SEAWEED_QUALIFIED_RECEIPT, "utf8"));
  const project = `seaweed-qualification-${randomUUID().replaceAll("-", "")}`;
  const secretDir = path.join(root, ".local", project);
  await mkdir(secretDir, { mode: 0o700 });
  const credentials = { accessKeyId: `test-${randomUUID()}`, secretAccessKey: randomUUID() };
  const env = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    SEAWEED_SECRET_DIR: secretDir,
    S3_ACCESS_KEY_ID: credentials.accessKeyId,
    S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    S3_PORT: "9000",
  };
  const docker = (args) =>
    execFileSync("docker", args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 2097152,
    });
  for (const role of ["master", "volume", "filer", "s3"]) {
    let exists = false;
    try {
      docker(["inspect", `editagent-seaweed-${role}`]);
      exists = true;
    } catch {
      /* absent on clean runner */
    }
    if (exists) throw new Error("Refusing to replace an existing storage container");
  }
  const close = async () => {
    if (!/^seaweed-qualification-[a-f0-9]{32}$/.test(project))
      throw new Error("Unsafe fixture project");
    docker(["compose", "down", "-v", "--remove-orphans"]);
  };
  try {
    execFileSync("sh", ["infra/seaweedfs/start-storage.sh", "--from-boot"], {
      cwd: root,
      env,
      stdio: "inherit",
      timeout: 600000,
    });
    const gateway = docker(["compose", "ps", "-q", "seaweed-s3"]).trim();
    if (!/^[a-f0-9]{64}$/.test(gateway)) throw new Error("Gateway identity missing");
    for (const role of ["master", "volume", "filer", "s3"]) {
      const container = docker(["compose", "ps", "-q", `seaweed-${role}`]).trim();
      if (docker(["inspect", "--format", "{{.Image}}", container]).trim() !== receipt.image_id)
        throw new Error("Storage role image differs from admitted candidate");
    }
    return {
      backend: "seaweedfs",
      endpoint: "http://127.0.0.1:9000",
      internalEndpoint: "http://editagent-seaweed-s3:8333",
      // The existing readiness helper reconnects alias minio. That is only a
      // legacy network alias; the endpoint and evidence explicitly say SeaweedFS.
      networkAlias: "minio",
      credentials,
      region: "us-east-1",
      env,
      docker,
      project,
      container: {
        getId: () => docker(["compose", "ps", "-q", "seaweed-s3"]).trim(),
        getHost: () => "127.0.0.1",
        getMappedPort: () => 9000,
      },
      identity: {
        backend: "seaweedfs",
        image_id: receipt.image_id,
        elf_sha256: receipt.elf_sha256,
        producer_run: receipt.producer_run,
        producer_attempt: receipt.producer_attempt,
        artifact_id: receipt.artifact_id,
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
