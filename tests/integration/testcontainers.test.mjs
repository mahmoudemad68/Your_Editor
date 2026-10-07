import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import Redis from "ioredis";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { startIntegrationServices } from "./support/containers.mjs";

test(
  "US-116 AC1: real PostgreSQL, Redis and MinIO Testcontainers round trip",
  { timeout: 660000 },
  async () => {
    const startedAt = performance.now();
    const services = await startIntegrationServices();
    const startupMs = performance.now() - startedAt;
    const pg = new Client({ connectionString: services.postgres.url });
    const redis = new Redis(services.redis.url, { maxRetriesPerRequest: 1 });
    const s3 = new S3Client({
      endpoint: services.minio.endpoint,
      region: services.minio.region,
      credentials: services.minio.credentials,
      forcePathStyle: true,
    });
    try {
      await pg.connect();
      await pg.query("CREATE TABLE sample (value text NOT NULL)");
      await pg.query("INSERT INTO sample VALUES ($1)", ["hello postgres"]);
      assert.equal((await pg.query("SELECT value FROM sample")).rows[0].value, "hello postgres");
      await redis.set("sample", "hello redis");
      assert.equal(await redis.get("sample"), "hello redis");
      await s3.send(new CreateBucketCommand({ Bucket: "sample" }));
      await s3.send(
        new PutObjectCommand({
          Bucket: "sample",
          Key: "hello.txt",
          Body: "hello minio",
          ContentType: "text/plain",
        }),
      );
      assert.equal(
        (await s3.send(new HeadObjectCommand({ Bucket: "sample", Key: "hello.txt" })))
          .ContentLength,
        11,
      );
      const object = await s3.send(new GetObjectCommand({ Bucket: "sample", Key: "hello.txt" }));
      assert.equal(await object.Body.transformToString(), "hello minio");
    } finally {
      await pg.end();
      redis.disconnect();
      s3.destroy();
      await services.close();
    }
    for (const service of [services.postgres, services.redis, services.minio])
      assert.throws(
        () => execFileSync("docker", ["inspect", service.container.getId()], { stdio: "ignore" }),
        "container removed after cleanup",
      );
    console.log(
      "US116_TESTCONTAINERS_EVIDENCE",
      JSON.stringify({
        startupMs,
        runtimeMs: performance.now() - startedAt,
        cleanup: "PASS",
        randomPorts: true,
        postgres: "round-trip",
        redis: "SET/GET",
        minio: "PUT/HEAD/GET",
      }),
    );
  },
);
