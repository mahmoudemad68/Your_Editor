import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.join(process.env.QA_APP_ROOT, "apps/api/package.json"));
const { S3Client, CreateBucketCommand, PutBucketCorsCommand } = require("@aws-sdk/client-s3");
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "editagent", secretAccessKey: "editagent-dev-secret" },
});
try {
  await s3.send(new CreateBucketCommand({ Bucket: "editagent" }));
} catch (error) {
  const name = String(error?.name ?? "");
  if (!name.includes("BucketAlready") && !name.includes("BucketAlreadyOwnedByYou")) throw error;
}
await s3.send(
  new PutBucketCorsCommand({
    Bucket: "editagent",
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: ["http://127.0.0.1:3000", "http://localhost:3000"],
          AllowedMethods: ["PUT", "GET", "HEAD"],
          AllowedHeaders: ["*"],
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 60,
        },
      ],
    },
  }),
);
s3.destroy();
