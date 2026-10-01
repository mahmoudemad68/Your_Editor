import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const root = path.resolve(".");
const require = createRequire(path.join(root, "apps/api/package.json"));
const domain = require(path.join(root, "packages/domain/dist/index.js"));
const { applyMigrations } = require(path.join(root, "apps/api/dist/infrastructure/migrate.js"));
const { PostgresMediaAssetRepository } = require(
  path.join(root, "apps/api/dist/infrastructure/postgres-media-repository.js"),
);
const { PostgresProjectRepository } = require(
  path.join(root, "apps/api/dist/infrastructure/postgres-project-repository.js"),
);
const { PostgresMediaInspectionRepository } = require(
  path.join(
    root,
    "workers/media-worker/dist/infrastructure/postgres-media-inspection-repository.js",
  ),
);
const { Pool } = require("pg");

const TEST_DATABASE = "editagent_us126_cas";
const T = 1_700_000_000_000n;
const OWNER = domain.userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const PROJECT = domain.projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");

function adminUrl() {
  return (
    process.env.DATABASE_URL ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
}

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function probe(codec, duration = 1_000_000n) {
  return {
    container: "MP4",
    videoCodec: codec,
    audioCodec: null,
    width: 320,
    height: 240,
    displayWidth: 320,
    displayHeight: 240,
    rotation: null,
    frameRate: { numerator: 25n, denominator: 1n },
    frameRateMode: "constant",
    duration,
    colorSpace: null,
    audioChannels: null,
    sampleRate: null,
    streams: [
      {
        codecType: "video",
        codecName: codec,
        width: 320,
        height: 240,
        sampleRate: null,
        channels: null,
      },
    ],
  };
}

describe("inspection revision compare-and-swap", { concurrency: 1 }, () => {
  let pool;
  let projects;
  let media;
  const databaseUrl = withDatabase(adminUrl(), TEST_DATABASE);

  before(async () => {
    const admin = new Pool({ connectionString: adminUrl() });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl });
    await applyMigrations(pool);
    projects = new PostgresProjectRepository(pool);
    media = new PostgresMediaAssetRepository(pool);
    await projects.save(domain.Project.create(PROJECT, "Launch", OWNER, domain.instant(T)), null);
  });

  after(async () => {
    await pool.end();
  });

  test("two same-millisecond successes keep only the first writer", async () => {
    await race(
      PostgresMediaAssetRepository,
      "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e41",
      async (left, right) => {
        const winner = left.asset.recordInspection(probe("h264"), domain.instant(T));
        const loser = right.asset.recordInspection(probe("hevc", 2_000_000n), domain.instant(T));
        assert.equal(winner.updatedAt, loser.updatedAt);
        assert.equal(winner.updatedAt, T);
        await left.repo.saveInspection(winner, left.revision);
        await assert.rejects(
          () => right.repo.saveInspection(loser, right.revision),
          domain.MediaInspectionConflict,
        );
        const stored = await reload(left.asset.id);
        assert.equal(stored.revision, 1n);
        assert.equal(stored.asset.videoCodec, "h264");
        assert.equal(stored.asset.duration, 1_000_000n);
        assert.equal(stored.asset.inspectionStatus, "completed");
        assert.equal(stored.asset.inspectionError, null);
      },
    );
  });

  test("a same-millisecond failure cannot replace completed metadata", async () => {
    await race(
      PostgresMediaInspectionRepository,
      "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e42",
      async (left, right) => {
        const winner = left.asset.recordInspection(probe("h264"), domain.instant(T));
        const failure = right.asset.recordInspectionFailure("timeout", domain.instant(T));
        assert.equal(winner.updatedAt, failure.updatedAt);
        await left.repo.saveInspection(winner, left.revision);
        await assert.rejects(
          () => right.repo.saveInspection(failure, right.revision),
          domain.MediaInspectionConflict,
        );
        const stored = await reload(left.asset.id);
        assert.equal(stored.revision, 1n);
        assert.equal(stored.asset.inspectionStatus, "completed");
        assert.equal(stored.asset.videoCodec, "h264");
        assert.equal(stored.asset.duration, 1_000_000n);
        assert.equal(stored.asset.inspectionError, null);
      },
    );
  });

  test("the same later timestamp still allows only one writer", async () => {
    const later = domain.instant(T + 1n);
    await race(
      PostgresMediaAssetRepository,
      "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e43",
      async (left, right) => {
        const winner = left.asset.recordInspection(probe("h264"), later);
        const loser = right.asset.recordInspection(probe("hevc"), later);
        assert.equal(winner.updatedAt, later);
        assert.equal(loser.updatedAt, later);
        await left.repo.saveInspection(winner, left.revision);
        await assert.rejects(
          () => right.repo.saveInspection(loser, right.revision),
          domain.MediaInspectionConflict,
        );
        const stored = await reload(left.asset.id);
        assert.equal(stored.revision, 1n);
        assert.equal(stored.asset.videoCodec, "h264");
      },
    );
  });

  test("a newer timestamp with a stale revision is rejected", async () => {
    await race(
      PostgresMediaInspectionRepository,
      "018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e44",
      async (left, right) => {
        const winner = left.asset.recordInspection(probe("h264"), domain.instant(T));
        const newer = right.asset.recordInspection(probe("hevc"), domain.instant(T + 50n));
        assert.ok(newer.updatedAt > winner.updatedAt);
        await left.repo.saveInspection(winner, left.revision);
        await assert.rejects(
          () => right.repo.saveInspection(newer, right.revision),
          domain.MediaInspectionConflict,
        );
        const stored = await reload(left.asset.id);
        assert.equal(stored.revision, 1n);
        assert.equal(stored.asset.videoCodec, "h264");
        assert.equal(stored.asset.duration, 1_000_000n);
      },
    );
  });

  test("a fresh reader can advance revision 1 to revision 2", async () => {
    const id = await insertAsset("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e45");
    const first = await media.loadForInspection(id);
    await media.saveInspection(
      first.asset.recordInspection(probe("h264"), domain.instant(T)),
      first.revision,
    );
    const secondPool = new Pool({ connectionString: databaseUrl });
    try {
      const second = new PostgresMediaAssetRepository(secondPool);
      const loaded = await second.loadForInspection(id);
      assert.equal(loaded.revision, 1n);
      await second.saveInspection(
        loaded.asset.recordInspection(probe("hevc", 2_000_000n), domain.instant(T + 10n)),
        loaded.revision,
      );
      const stored = await media.loadForInspection(id);
      assert.equal(stored.revision, 2n);
      assert.equal(stored.asset.videoCodec, "hevc");
      assert.equal(stored.asset.duration, 2_000_000n);
      const before = stored.revision;
      assert.equal((await media.findById(id)).videoCodec, "hevc");
      assert.equal((await media.loadForInspection(id)).revision, before);
    } finally {
      await secondPool.end();
    }
  });

  test("a saved failure increments the revision and a fresh retry can complete", async () => {
    const id = await insertAsset("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e46");
    const loaded = await media.loadForInspection(id);
    await media.saveInspection(
      loaded.asset.recordInspectionFailure("invalid_json", domain.instant(T)),
      loaded.revision,
    );
    const failed = await media.loadForInspection(id);
    assert.equal(failed.revision, 1n);
    assert.equal(failed.asset.inspectionStatus, "failed");
    assert.equal(failed.asset.inspectionError, "invalid_json");
    assert.equal(failed.asset.videoCodec, null);
    const other = new Pool({ connectionString: databaseUrl });
    try {
      const retry = new PostgresMediaInspectionRepository(other);
      const again = await retry.loadForInspection(id);
      assert.equal(again.revision, 1n);
      await retry.saveInspection(
        again.asset.recordInspection(probe("h264"), domain.instant(T + 5n)),
        again.revision,
      );
    } finally {
      await other.end();
    }
    const stored = await media.loadForInspection(id);
    assert.equal(stored.revision, 2n);
    assert.equal(stored.asset.inspectionStatus, "completed");
    assert.equal(stored.asset.videoCodec, "h264");
    assert.equal(stored.asset.inspectionError, null);
    assert.equal(stored.asset.duration, 1_000_000n);
  });

  async function race(Repository, rawId, run) {
    const id = await insertAsset(rawId);
    const leftPool = new Pool({ connectionString: databaseUrl });
    const rightPool = new Pool({ connectionString: databaseUrl });
    try {
      const leftRepo = new Repository(leftPool);
      const rightRepo = new Repository(rightPool);
      const left = await leftRepo.loadForInspection(id);
      const right = await rightRepo.loadForInspection(id);
      assert.equal(left.revision, 0n);
      assert.equal(right.revision, 0n);
      assert.equal(left.asset.updatedAt, T);
      await run(
        { repo: leftRepo, asset: left.asset, revision: left.revision },
        { repo: rightRepo, asset: right.asset, revision: right.revision },
      );
    } finally {
      await leftPool.end();
      await rightPool.end();
    }
  }

  async function insertAsset(rawId) {
    const id = domain.mediaAssetId(rawId);
    await media.save(
      domain.MediaAsset.createUploaded({
        id,
        projectId: PROJECT,
        createdAt: domain.instant(T),
        displayFilename: "clip.mp4",
        mimeType: "video/mp4",
        byteSize: 32,
        contentSha256: rawId.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
      }),
    );
    const loaded = await media.loadForInspection(id);
    assert.equal(loaded.revision, 0n);
    assert.equal(loaded.asset.inspectionStatus, "pending");
    assert.equal(loaded.asset.updatedAt, T);
    return id;
  }

  async function reload(id) {
    const fresh = new Pool({ connectionString: databaseUrl });
    try {
      return await new PostgresMediaAssetRepository(fresh).loadForInspection(id);
    } finally {
      await fresh.end();
    }
  }
});
