/** Run existing suites against disposable real infrastructure on random ports. */
import { startIntegrationServices } from "../../tests/integration/support/containers.mjs";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { command } from "./compose-build.mjs";
import process from "node:process";
const [bin, ...args] = process.argv.slice(2);
if (!bin) throw new Error("usage: with-services.mjs <command> [arguments]");
const services = await startIntegrationServices();
try {
  const s3 = new S3Client({
    endpoint: services.minio.endpoint,
    region: services.minio.region,
    credentials: services.minio.credentials,
    forcePathStyle: true,
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: "editagent" }));
  } finally {
    s3.destroy();
  }
  await command(bin, args, {
    env: {
      ...process.env,
      DATABASE_URL: services.postgres.url,
      REDIS_URL: services.redis.url,
      S3_ENDPOINT: services.minio.endpoint,
      S3_PUBLIC_ENDPOINT: services.minio.endpoint,
      S3_BUCKET: "editagent",
      S3_ACCESS_KEY_ID: services.minio.credentials.accessKeyId,
      S3_SECRET_ACCESS_KEY: services.minio.credentials.secretAccessKey,
      S3_REGION: services.minio.region,
    },
  });
} finally {
  await services.close();
}
