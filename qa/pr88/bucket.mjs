// QA bootstrap: same bucket + browser CORS the repository's Compose proof configures.
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const app = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(path.join(app, "package.json"));
const { S3Client, CreateBucketCommand, PutBucketCorsCommand } = require("@aws-sdk/client-s3");
const s3 = new S3Client({
  endpoint: `http://localhost:${process.env.S3_PORT ?? 9000}`,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "editagent", secretAccessKey: "editagent-dev-secret" },
});
await s3.send(new CreateBucketCommand({ Bucket: "editagent" }));
await s3.send(
  new PutBucketCorsCommand({
    Bucket: "editagent",
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: ["http://localhost:3000"],
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
console.log("bucket ready");
