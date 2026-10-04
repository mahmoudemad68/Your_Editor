/**
 * SeaweedFS replaces MinIO in the active Compose stack.
 * S3ObjectStorage stays the application adapter.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("the active stack publishes only the SeaweedFS S3 gateway", () => {
  const compose = read("compose.yaml");
  const dockerfile = read("infra/seaweedfs/Dockerfile");
  assert.match(
    dockerfile,
    /chrislusf\/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d/,
  );
  assert.equal(compose.includes("infra/minio/Dockerfile"), false);
  assert.match(compose, /storage_internal:\n {4}internal: true/);
  assert.match(compose, /S3_ENDPOINT: http:\/\/seaweed-s3:8333/);
  assert.match(compose, /127\.0\.0\.1:\$\{S3_PORT/);
  assert.equal(compose.includes("minio-data:"), true);
  for (const service of ["seaweed-master:", "seaweed-volume:", "seaweed-filer:", "seaweed-s3:"]) {
    assert.equal(compose.includes(service), true, service);
  }
  const master = compose.slice(
    compose.indexOf("  seaweed-master:"),
    compose.indexOf("  seaweed-volume:"),
  );
  const volume = compose.slice(
    compose.indexOf("  seaweed-volume:"),
    compose.indexOf("  seaweed-filer:"),
  );
  const filer = compose.slice(
    compose.indexOf("  seaweed-filer:"),
    compose.indexOf("  seaweed-s3:"),
  );
  assert.equal(master.includes("ports:"), false);
  assert.equal(volume.includes("ports:"), false);
  assert.equal(filer.includes("ports:"), false);
  assert.match(read("apps/api/src/infrastructure/s3-object-storage.ts"), /IfNoneMatch: "\*"/);
  assert.match(read(".github/workflows/supply-chain.yml"), /infra\/seaweedfs\/Dockerfile/);
  assert.equal(
    read(".github/workflows/supply-chain.yml").includes("infra/minio/Dockerfile"),
    false,
  );
  assert.match(read(".github/dependabot.yml"), /\/infra\/seaweedfs/);
  assert.equal(read(".github/dependabot.yml").includes("/infra/minio"), false);
});
