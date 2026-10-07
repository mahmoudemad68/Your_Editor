import { GenericContainer, Wait } from "testcontainers";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildProductImages } from "../../../tools/test/compose-build.mjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { lookup } from "node:dns/promises";

const root = path.resolve(import.meta.dirname, "../../..");
function imageTag(service, files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(path.join(root, file)));
  return `editagent-test-${service}:${hash.digest("hex").slice(0, 24)}`;
}
export const TEST_IMAGES = Object.freeze({
  // Reuse the accepted pinned builds: upstream gosu/OpenSSL are vulnerable.
  postgres: imageTag("postgres", ["infra/postgres/Dockerfile"]),
  redis: imageTag("redis", ["infra/redis/Dockerfile", "infra/redis/require-openssl.sh"]),
  minio: imageTag("minio", [
    "tests/integration/support/Minio.Dockerfile",
    "tests/integration/support/minio.go.mod",
    "tests/integration/support/minio.go.sum",
  ]),
});
async function buildInfrastructureImage(service) {
  try {
    execFileSync("docker", ["image", "inspect", TEST_IMAGES[service]], { stdio: "ignore" });
  } catch {
    await buildProductImages(root, [service], TEST_IMAGES);
  }
}
export async function buildMinioImage() {
  try {
    execFileSync("docker", ["image", "inspect", TEST_IMAGES.minio], { stdio: "ignore" });
  } catch {
    const args = [
      "build",
      "-f",
      "tests/integration/support/Minio.Dockerfile",
      "-t",
      TEST_IMAGES.minio,
    ];
    if (process.env.CODEX_PROXY_CERT) {
      args.push("--secret", "id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt");
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"])
        if (process.env[name]) args.push("--build-arg", name);
      const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      if (proxy) {
        const host = new URL(proxy).hostname;
        const { address } = await lookup(host, { family: 4 });
        args.push("--add-host", `${host}:${address}`);
      }
    }
    execFileSync("docker", [...args, "."], {
      cwd: root,
      stdio: "inherit",
      timeout: 600000,
    });
  }
}
export async function startPostgres() {
  await buildInfrastructureImage("postgres");
  const user = "test_user",
    password = randomUUID(),
    database = "test_db";
  const container = await new GenericContainer(TEST_IMAGES.postgres)
    .withEnvironment({ POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  return {
    container,
    url: `postgresql://${user}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/${database}`,
    close: () => container.stop(),
  };
}
export async function startRedis() {
  await buildInfrastructureImage("redis");
  const container = await new GenericContainer(TEST_IMAGES.redis)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  return {
    container,
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    close: () => container.stop(),
  };
}
export async function startMinio() {
  await buildMinioImage();
  const credentials = { accessKeyId: "test-" + randomUUID(), secretAccessKey: randomUUID() };
  const container = await new GenericContainer(TEST_IMAGES.minio)
    .withEnvironment({
      MINIO_ROOT_USER: credentials.accessKeyId,
      MINIO_ROOT_PASSWORD: credentials.secretAccessKey,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000).forStatusCode(200))
    .start();
  return {
    container,
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    credentials,
    region: "us-east-1",
    close: () => container.stop(),
  };
}
/** Concurrent startup and cleanup of partial failures, with no implicit Docker skip. */
export async function startIntegrationServices() {
  await Promise.all([
    buildInfrastructureImage("postgres"),
    buildInfrastructureImage("redis"),
    buildMinioImage(),
  ]);
  const result = await Promise.allSettled([startPostgres(), startRedis(), startMinio()]);
  const started = result.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (result.some((r) => r.status === "rejected")) {
    await Promise.allSettled(started.map((service) => service.close()));
    throw new AggregateError(
      result.filter((r) => r.status === "rejected").map((r) => r.reason),
      "Testcontainers startup failed",
    );
  }
  return {
    postgres: result[0].value,
    redis: result[1].value,
    minio: result[2].value,
    close: async () => {
      const stopped = await Promise.allSettled(started.map((service) => service.close()));
      const failures = stopped.filter((r) => r.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          "Testcontainers cleanup failed",
        );
    },
  };
}
