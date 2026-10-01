import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, test } from "node:test";

/**
 * Real upload and inspection through the production API controllers.
 * The test actor is not production authentication. US-118 still has to sign the browser in.
 * FFprobe is started manually here because automatic inspection waits for US-129.
 */
const root = path.resolve(".");
const apiRequire = createRequire(path.join(root, "apps/api/package.json"));
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
webRequire(path.join(root, "apps/web/dist-test/presentation/dom-setup.js"));
const React = webRequire("react");
const { cleanup, fireEvent, render, screen } = webRequire("@testing-library/react");
const domain = apiRequire(path.join(root, "packages/domain/dist/index.js"));
const { createApiApplication } = apiRequire(
  path.join(root, "apps/api/dist/create-api-application.js"),
);
const { bindActor } = apiRequire(path.join(root, "apps/api/dist/presentation/actor.js"));
const { Pool } = apiRequire("pg");
const { applyMigrations } = apiRequire(path.join(root, "apps/api/dist/infrastructure/migrate.js"));
const { PostgresProjectRepository } = apiRequire(
  path.join(root, "apps/api/dist/infrastructure/postgres-project-repository.js"),
);
const { PostgresMediaAssetRepository } = apiRequire(
  path.join(root, "apps/api/dist/infrastructure/postgres-media-repository.js"),
);
const { S3ObjectStorage } = apiRequire(
  path.join(root, "apps/api/dist/infrastructure/s3-object-storage.js"),
);
const { NodeMediaAssetIdGenerator } = apiRequire(
  path.join(root, "apps/api/dist/infrastructure/node-media-asset-id-generator.js"),
);
const { MediaWorkspace } = webRequire(
  path.join(root, "apps/web/dist-test/presentation/media-upload.js"),
);
const { createHttpProjectApi } = webRequire(
  path.join(root, "apps/web/dist-test/infrastructure/project-api.js"),
);
const { fetchWithTestActor } = await import("./test-actor-fetch.mjs");

const DATABASE = "editagent_us124";
const OWNER = "018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f";
const PROJECT = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";

after(() => {
  cleanup();
});

test("the media page shows FFprobe details after a direct upload and a manual inspection", async () => {
  const adminUrl =
    process.env.DATABASE_URL ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5433/editagent";
  const storage = {
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9002",
    publicEndpoint:
      process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://127.0.0.1:9002",
    bucket: process.env.S3_BUCKET ?? "editagent",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "editagent",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "editagent-dev-secret",
    region: process.env.S3_REGION ?? "us-east-1",
  };
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  await admin.end();
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${DATABASE}`;
  const pool = new Pool({ connectionString: databaseUrl.toString() });
  await applyMigrations(pool);
  const projects = new PostgresProjectRepository(pool);
  const media = new PostgresMediaAssetRepository(pool);
  const objects = new S3ObjectStorage(storage);
  await objects.ensureBucket();
  await projects.save(
    domain.Project.create(
      domain.projectId(PROJECT),
      "Launch",
      domain.userId(OWNER),
      domain.instant(BigInt(Date.now())),
    ),
    null,
  );
  const app = await createApiApplication(
    {
      projects,
      media,
      objects,
      clock: { now: () => domain.instant(BigInt(Date.now())) },
      ids: { next: () => domain.projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f") },
      mediaIds: new NodeMediaAssetIdGenerator(),
      presignTtlSeconds: 900,
    },
    (use) => {
      use((request, _response, next) => {
        const header = request.headers?.["x-test-actor"];
        if (typeof header === "string") {
          bindActor(request, domain.userId(header));
        }
        next();
      });
    },
  );
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  const bytes = readFileSync(path.join(root, "packages/media-core/fixtures/media/normal.mp4"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  let signedHeaders;
  let uploadUrl = "";
  try {
    const api = createHttpProjectApi({
      baseUrl: base,
      fetchImpl: fetchWithTestActor(OWNER),
    });
    render(
      React.createElement(MediaWorkspace, {
        project: {
          id: PROJECT,
          name: "Launch",
          role: "owner",
          createdAt: "1700000000000",
          updatedAt: "1700000000000",
        },
        api,
        putObject: async (request) => {
          signedHeaders = { ...request.headers };
          uploadUrl = request.url;
          const response = await fetch(request.url, {
            method: "PUT",
            headers: request.headers,
            body: new Uint8Array(await request.body.arrayBuffer()),
          });
          request.onProgress?.(request.body.size, request.body.size);
          return { ok: response.ok, status: response.status };
        },
      }),
    );
    const file = new File([bytes], "normal.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByLabelText("Choose a video"), { target: { files: [file] } });
    await screen.findByText("pending", {}, { timeout: 20000 });
    assert.equal(signedHeaders["Content-Type"], "video/mp4");
    assert.equal(signedHeaders["If-None-Match"], "*");
    assert.equal(
      signedHeaders["x-amz-checksum-sha256"],
      Buffer.from(digest, "hex").toString("base64"),
    );
    assert.equal(signedHeaders["x-amz-checksum-sha256"].includes(digest), false);
    const preflight = await fetch(uploadUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type,x-amz-checksum-sha256,if-none-match",
      },
    });
    assert.equal(preflight.ok, true, await preflight.text());
    const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    assert.equal(allowed.includes("content-type"), true, allowed);
    assert.equal(allowed.includes("x-amz-checksum-sha256"), true, allowed);
    assert.equal(allowed.includes("if-none-match"), true, allowed);
    const objectUrl = uploadUrl.split("?")[0];
    const anonymous = await fetch(objectUrl);
    assert.equal(anonymous.ok, false);

    const stored = await pool.query(
      "SELECT id::text AS id FROM media_assets WHERE display_filename = $1",
      ["normal.mp4"],
    );
    const mediaAssetId = stored.rows[0]?.id;
    assert.equal(typeof mediaAssetId, "string");
    const inspected = await runInspect(mediaAssetId, databaseUrl.toString(), storage);
    assert.equal(inspected.status, 0, inspected.output);
    fireEvent.click(screen.getByRole("button", { name: "Refresh details" }));
    await screen.findByText("h264", {}, { timeout: 10000 });
    assert.ok(screen.getByText("MP4"));
    assert.ok(screen.getByText("aac"));
    assert.ok(screen.getAllByText("320×240").length >= 1);
    assert.ok(screen.getByText("25/1"));
    assert.ok(screen.getByText("1000000"));
    assert.ok(screen.getByText("48000"));
    assert.equal(screen.queryByText(/^0$/), null);
  } finally {
    cleanup();
    await app.close();
    await pool.end();
  }
});

function runInspect(mediaAssetId, databaseUrl, storage) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["workers/media-worker/dist/inspect.js", mediaAssetId], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0",
        S3_ENDPOINT: storage.endpoint,
        S3_PUBLIC_ENDPOINT: storage.publicEndpoint,
        S3_BUCKET: storage.bucket,
        S3_ACCESS_KEY_ID: storage.accessKeyId,
        S3_SECRET_ACCESS_KEY: storage.secretAccessKey,
        S3_REGION: storage.region,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (status) => resolve({ status, output }));
  });
}
