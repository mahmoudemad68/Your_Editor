/** Explicit disposable MinIO regression fixture; never SeaweedFS admission. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { withoutQualificationCredentials } from "./pc100-candidate-policy.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const marker = "io.editagent.pc100.minio-regression";
export function walkingStorageBackend(name, event = {}) {
  if (name === "pull_request" && event.pull_request?.number === 100) return "seaweedfs-qualified";
  if (["pull_request", "workflow_dispatch", "push"].includes(name)) return "minio-regression";
  return "seaweedfs-qualified";
}
export function minioRegressionPlan(role, network) {
  if (!["repository", "walking"].includes(role)) throw Error("MINIO_REGRESSION_ROLE_REJECTED");
  if (role === "walking" && network !== "walking-skeleton_render_control")
    throw Error("MINIO_REGRESSION_NETWORK_REJECTED");
  const port = role === "walking" ? 8333 : 9000;
  return {
    name: `pc100-${role}-minio-regression`,
    role,
    port,
    network: role === "walking" ? network : null,
    networks: role === "walking" ? [network, "walking-skeleton_default"] : [],
  };
}
export function walkingApplicationStart(backend, services) {
  if (
    !["minio-regression", "seaweedfs-qualified"].includes(backend) ||
    !Array.isArray(services) ||
    !services.length ||
    services.some((s) => !["api", "web", "media-worker"].includes(s))
  )
    throw Error("REGRESSION_APPLICATION_ROLE_REJECTED");
  return [
    "up",
    "-d",
    "--no-build",
    ...(backend === "minio-regression" ? ["--no-deps"] : []),
    "--wait",
    "--wait-timeout",
    "120",
    ...services,
  ];
}
function docker(args) {
  return execFileSync("docker", args, {
    cwd: root,
    env: withoutQualificationCredentials(process.env),
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1048576,
  }).trim();
}
export async function startMinioRegression(role, network) {
  const plan = minioRegressionPlan(role, network);
  const { buildMinioImage, TEST_IMAGES } =
    await import("../../tests/integration/support/containers.mjs");
  await buildMinioImage();
  const image = docker(["image", "inspect", TEST_IMAGES.minio, "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw Error("MINIO_REGRESSION_IMAGE_REJECTED");
  for (const network of plan.networks) {
    const n = JSON.parse(docker(["network", "inspect", network]));
    if (n.length !== 1 || n[0].Labels?.["com.docker.compose.project"] !== "walking-skeleton")
      throw Error("MINIO_REGRESSION_NETWORK_REJECTED");
  }
  const args = [
    "run",
    "--detach",
    "--name",
    plan.name,
    "--label",
    `${marker}=${role}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--cpus",
    "1",
    "--memory",
    "1g",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/data:rw,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=268435456",
    "--publish",
    `127.0.0.1:9000:${plan.port}`,
    "--env",
    "HOME=/data",
    "--env",
    "MINIO_ROOT_USER=editagent",
    "--env",
    "MINIO_ROOT_PASSWORD=editagent-dev-secret",
    "--env",
    "MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3000",
  ];
  if (plan.network) args.push("--network", plan.network, "--network-alias", "seaweed-s3");
  args.push(image, "--certs-dir", "/data/certs", "server", "/data", "--address", `:${plan.port}`);
  const id = docker(args);
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("MINIO_REGRESSION_CONTAINER_REJECTED");
  const stop = () => {
    const row = JSON.parse(docker(["inspect", id]))[0];
    if (row.Id !== id || row.Image !== image || row.Config.Labels?.[marker] !== role)
      throw Error("MINIO_REGRESSION_CLEANUP_REJECTED");
    docker(["rm", "--force", id]);
  };
  try {
    for (const network of plan.networks.slice(1))
      docker(["network", "connect", "--alias", "seaweed-s3", network, id]);
    let healthy = false;
    for (let n = 0; n < 60; n++) {
      try {
        const r = await globalThis.fetch("http://127.0.0.1:9000/minio/health/live", {
          signal: globalThis.AbortSignal.timeout(2000),
        });
        await r.body?.cancel();
        if (r.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        // Connection refusal is expected during bounded server startup.
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1000));
    }
    if (!healthy) throw Error("MINIO_REGRESSION_NOT_READY");
    const evidence = {
      schema: "pc100-explicit-minio-regression-v1",
      backend: "MINIO_TEST_ONLY",
      seaweedfs_qualification: false,
      role,
      image_id: image,
      container_id: id,
    };
    console.log(JSON.stringify(evidence));
    return { evidence, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const dir = path.join(root, ".local/pc100-minio-regression");
  if (mode === "repository") {
    const fixture = await startMinioRegression("repository");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, "repository.json"), JSON.stringify(fixture.evidence) + "\n", {
      mode: 0o600,
    });
  } else if (mode === "stop-repository") {
    const e = JSON.parse(await readFile(path.join(dir, "repository.json"), "utf8"));
    if (
      e.role !== "repository" ||
      !/^sha256:[a-f0-9]{64}$/.test(e.image_id) ||
      !/^[a-f0-9]{64}$/.test(e.container_id)
    )
      throw Error("MINIO_REGRESSION_CLEANUP_REJECTED");
    const row = JSON.parse(docker(["inspect", e.container_id]))[0];
    if (row.Image !== e.image_id || row.Config.Labels?.[marker] !== "repository")
      throw Error("MINIO_REGRESSION_CLEANUP_REJECTED");
    docker(["rm", "--force", e.container_id]);
  } else throw Error("MINIO_REGRESSION_MODE_REJECTED");
}
