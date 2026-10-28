/** Real PostgreSQL caption authority, migration 0024, and SIGKILL windows. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { check, results, writeReport } from "./report.mjs";

const app = process.env.QA_APP_ROOT;
const require = createRequire(path.join(app, "apps/api/package.json"));
const { Pool } = require("pg");
const domain = require("@editagent/domain");
const { contentHash } = require("@editagent/tool-sdk");
const { parseMediaAnalysis } = require("@editagent/schemas");
const { applyMigrations } = require(path.join(app, "apps/api/dist/infrastructure/migrate.js"));
const { createApiApplication } = require(path.join(app, "apps/api/dist/create-api-application.js"));
const { TimelineEditor } = require(path.join(app, "apps/api/dist/application/timeline-editor.js"));
const { TimelineCaptions } = require(
  path.join(app, "apps/api/dist/application/timeline-captions.js"),
);
const { PostgresCaptionEdits } = require(
  path.join(app, "apps/api/dist/infrastructure/postgres-caption-edits.js"),
);
const { TimelineExports } = require(
  path.join(app, "apps/api/dist/application/timeline-exports.js"),
);
const { GetMediaDetails } = require(path.join(app, "apps/api/dist/application/media-details.js"));
const { MemoryObjectStorage } = require(
  path.join(app, "apps/api/dist/application/memory-object-storage.js"),
);
const { PostgresProjectRepository } = require(
  path.join(app, "apps/api/dist/infrastructure/postgres-project-repository.js"),
);
const { PostgresMediaAssetRepository } = require(
  path.join(app, "apps/api/dist/infrastructure/postgres-media-repository.js"),
);
const { PostgresTimelineStore } = require(
  path.join(app, "apps/api/dist/infrastructure/postgres-timeline-store.js"),
);
const { PostgresTimelineRenders } = require(
  path.join(app, "apps/api/dist/infrastructure/postgres-timeline-renders.js"),
);
const { timelineProposals } = require(
  path.join(app, "apps/api/dist/infrastructure/timeline-proposals.js"),
);
const { JwtSessionTokens } = require(
  path.join(app, "apps/api/dist/infrastructure/jwt-session-tokens.js"),
);
const { NodeProjectIdGenerator } = require(
  path.join(app, "apps/api/dist/infrastructure/node-project-id-generator.js"),
);
const { NodeMediaAssetIdGenerator } = require(
  path.join(app, "apps/api/dist/infrastructure/node-media-asset-id-generator.js"),
);
const { authenticateRequest } = require(
  path.join(app, "apps/api/dist/presentation/authenticate-request.js"),
);
const { requireCookieCsrf } = require(path.join(app, "apps/api/dist/presentation/csrf.js"));
const { BullMqJobQueue } = require("@editagent/job-queue");
const { PostgresJobRepository } = require("@editagent/job-queue");
const rows = results();
const adminUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
const newId = () => domain.createUuidV7(Date.now(), randomBytes(10));
const dbName = `qa93_${process.pid}`;
const migrationName = `qa93m_${process.pid}`;

function databaseUrl(name) {
  const url = new URL(adminUrl);
  url.pathname = "/" + name;
  return url.href;
}
async function createDatabase(name) {
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
}
async function dropDatabase(name) {
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

await check(
  rows,
  "G2-MIGRATION-UP",
  "Migration 0024 applies once on a populated pre-0024 database and preserves the old project",
  async () => {
    await createDatabase(migrationName);
    const pool = new Pool({ connectionString: databaseUrl(migrationName) });
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      const directory = path.join(app, "apps/api/migrations");
      const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
      const prior = files.filter((name) => name < "0024_timed_caption_commands.sql");
      await pool.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const file of prior) {
        await pool.query(await readFile(path.join(directory, file), "utf8"));
        await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      }
      const project = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
      await pool.query(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES ($1, 'historical', 10, 10)",
        [project],
      );
      const applied = await applyMigrations(pool, directory);
      const again = await applyMigrations(pool, directory);
      const kept = await pool.query("SELECT name FROM projects WHERE id=$1", [project]);
      const table = await pool.query(
        "SELECT to_regclass('public.editing_caption_commands') AS name",
      );
      const down = files.filter((name) => name.includes("down"));
      const ok =
        applied.length === 1 &&
        applied[0] === "0024_timed_caption_commands.sql" &&
        again.length === 0 &&
        kept.rows[0].name === "historical" &&
        table.rows[0].name === "editing_caption_commands" &&
        down.length === 0;
      rows.push({
        id: "G2-MIGRATION-DOWN",
        title: "No product down migration is shipped for 0024",
        status: "OBSERVED",
        expected: "forward-only migrator",
        actual: { downFiles: down },
        exclusion:
          "The product migrator only applies upward SQL and release docs state schema rollback is not automated. An invented DROP was not executed. Up, repeat, and old-row preservation are the checked controls.",
        ms: 0,
      });
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "0024 once, old project kept",
        actual: { applied, again, kept: kept.rows[0]?.name, table: table.rows[0]?.name },
      };
    } finally {
      await pool.end();
      await dropDatabase(migrationName);
    }
  },
);

const pool = new Pool({ connectionString: databaseUrl(dbName) });
let appServer;
let queue;
try {
  await createDatabase(dbName);
  await applyMigrations(pool);
  await pool.query("CREATE TABLE qa_pause (id int PRIMARY KEY, mode text NOT NULL)");
  await pool.query("INSERT INTO qa_pause VALUES (1, 'off')");
  await pool.query(`CREATE OR REPLACE FUNCTION qa_pause_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE m text; i int;
    BEGIN
      SELECT mode INTO m FROM qa_pause WHERE id=1;
      IF m = 'wait' THEN
        FOR i IN 1..100 LOOP
          SELECT mode INTO m FROM qa_pause WHERE id=1;
          EXIT WHEN m <> 'wait';
          PERFORM pg_sleep(0.1);
        END LOOP;
      END IF;
      RETURN NEW;
    END $$`);
  await pool.query(
    "CREATE TRIGGER qa_pause_tool BEFORE INSERT ON tool_executions FOR EACH ROW EXECUTE FUNCTION qa_pause_fn()",
  );
  const now = () => domain.instant(BigInt(Date.now()));
  const projects = new PostgresProjectRepository(pool);
  const media = new PostgresMediaAssetRepository(pool);
  const store = new PostgresTimelineStore(pool);
  queue = new BullMqJobQueue(redisUrl);
  const jobs = new PostgresJobRepository(pool);
  const owner = domain.userId(newId());
  const editor = domain.userId(newId());
  const viewer = domain.userId(newId());
  const stranger = domain.userId(newId());
  const project = domain.projectId(newId());
  const other = domain.projectId(newId());
  const source = domain.mediaAssetId(newId());
  const editorService = new TimelineEditor(
    projects,
    new GetMediaDetails(projects, media),
    store,
    { propose: (...args) => timelineProposals(pool, store).propose(...args) },
    { now },
    newId,
  );
  const renders = new PostgresTimelineRenders(
    pool,
    {
      jobs,
      queue,
      now,
      newAttemptId: newId,
      supervisor: {
        async run() {
          throw new Error("no renderer");
        },
      },
    },
    "a".repeat(64),
  );
  const tokens = new JwtSessionTokens(randomBytes(32).toString("hex"));
  const objects = new MemoryObjectStorage();
  appServer = await createApiApplication(
    {
      editor: editorService,
      timelineCaptions: new TimelineCaptions(new PostgresCaptionEdits(pool)),
      timelineExports: new TimelineExports(projects, editorService, renders, objects, (key) =>
        objects.presignGet(key),
      ),
      projects,
      media,
      objects,
      clock: { now },
      ids: new NodeProjectIdGenerator(),
      mediaIds: new NodeMediaAssetIdGenerator(),
      presignTtlSeconds: 60,
    },
    (use) => {
      use(authenticateRequest(tokens, now));
      const csrf = requireCookieCsrf();
      use((req, res, next) => csrf(req, res, next));
    },
  );
  for (const actor of [owner, editor, viewer, stranger])
    await pool.query(
      "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$qa93-fixture',1,1)",
      [actor, `${actor}@example.test`],
    );
  for (const id of [project, other])
    await pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'qa',1,1)", [
      id,
    ]);
  for (const [actor, role] of [
    [owner, "owner"],
    [editor, "editor"],
    [viewer, "viewer"],
  ])
    await pool.query(
      "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,$3,1)",
      [project, actor, role],
    );
  await pool.query(
    "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'owner',1)",
    [other, stranger],
  );
  const uploaded = domain.MediaAsset.createUploaded({
    id: source,
    projectId: project,
    createdAt: now(),
    displayFilename: "fixture.mp4",
    mimeType: "video/mp4",
    byteSize: 100,
    contentSha256: "b".repeat(64),
  });
  await media.save(uploaded);
  await media.saveInspection(
    uploaded.recordInspection(
      {
        container: "mp4",
        videoCodec: "h264",
        audioCodec: null,
        width: 640,
        height: 360,
        displayWidth: 640,
        displayHeight: 360,
        rotation: 0,
        frameRate: domain.frameRate(25n, 1n),
        frameRateMode: "constant",
        duration: 2_000_000n,
        colorSpace: null,
        audioChannels: null,
        sampleRate: null,
        streams: [
          {
            codecType: "video",
            codecName: "h264",
            width: 640,
            height: 360,
            sampleRate: null,
            channels: null,
          },
        ],
      },
      now(),
    ),
    0n,
  );
  await pool.query(
    "UPDATE media_assets SET validation_status='validated',validation_policy_signature=$2,validation_source_sha256=content_sha256,validation_checked_at=updated_at WHERE id=$1",
    [source, "c".repeat(64)],
  );
  const wordA = "Alpha";
  const wordB = "Beta";
  const document = parseMediaAnalysis({
    schemaVersion: "1.0.0",
    mediaAssetId: source,
    source: { sha256: "b".repeat(64), durationUs: "2000000" },
    provenance: { producer: "qa93", producerVersion: "1.0.0" },
    sections: {
      metadata: { status: "not_available" },
      audio: { status: "not_available" },
      scenes: { status: "not_available" },
      faces: { status: "not_available" },
      objects: { status: "not_available" },
      transcript: {
        status: "completed",
        provenance: {
          analyzer: "qa93",
          analyzerVersion: "1.0.0",
          sourceSha256: "b".repeat(64),
          configurationSha256: "c".repeat(64),
          model: { name: "faster-whisper-small", version: "qa", sha256: "d".repeat(64) },
        },
        data: {
          language: "en",
          segments: [
            {
              id: "s0",
              text: `${wordA} ${wordB}`,
              startUs: "300000",
              endUs: "1200000",
              words: [
                { text: wordA, startUs: "300000", endUs: "600000", confidence: 0.4 },
                { text: wordB, startUs: "700000", endUs: "1200000" },
              ],
            },
          ],
        },
      },
    },
  });
  await pool.query(
    "INSERT INTO media_analyses(media_asset_id,project_id,source_sha256,document) VALUES($1,$2,$3,$4::jsonb)",
    [source, project, "b".repeat(64), JSON.stringify(document)],
  );
  await appServer.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${appServer.getHttpServer().address().port}/projects`;
  const headers = async (actor = owner, csrf = true) => {
    const cookie = `editagent_access=${(await tokens.issueAccess(actor, now())).token}; editagent_csrf=qa93-csrf`;
    return {
      "content-type": "application/json",
      cookie,
      ...(csrf ? { "x-editagent-csrf": "qa93-csrf" } : {}),
    };
  };
  const post = (route, body, extra = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: extra.headers ?? undefined,
      body: JSON.stringify(body),
    }).then(async (response) => ({
      status: response.status,
      body: await response.json().catch(() => null),
    }));
  const created = await fetch(base + `/${project}/timelines`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({ mediaAssetId: source }),
  });
  const initial = await created.json();
  const timeline = initial.timeline.id;
  const route = `/${project}/timelines/${timeline}/captions`;
  const style = domain.DEFAULT_CAPTION_STYLE;
  const request = {
    stateSha256: initial.stateSha256,
    requestId: newId(),
    assetId: source,
    sourceSha256: "b".repeat(64),
    analysisSha256: contentHash(document),
    style,
  };
  const directAdd = (stateSha256, requestId) => ({
    stateSha256,
    requestId,
    operation: "add-caption",
    input: {
      assetId: source,
      sourceSha256: "b".repeat(64),
      analysisSha256: contentHash(document),
      style,
    },
  });
  function runChild(requestBody) {
    const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "kill-child.mjs");
    return spawn(
      process.execPath,
      [
        childPath,
        JSON.stringify({
          databaseUrl: databaseUrl(dbName),
          actor: owner,
          project,
          timeline,
          request: requestBody,
        }),
      ],
      {
        env: { ...process.env, QA_APP_ROOT: app },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }
  async function waitFor(predicate, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }
  async function toolCount() {
    const result = await pool.query("SELECT count(*) FROM tool_executions");
    return Number(result.rows[0].count);
  }
  function watch(child) {
    let output = "";
    const take = (chunk) => {
      output = (output + chunk.toString()).slice(-500);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    return () => output;
  }
  async function held(child, requestId, baseline) {
    const admitted = await pool.query(
      "SELECT status FROM editing_caption_commands WHERE request_id=$1",
      [requestId],
    );
    return (
      admitted.rows[0]?.status === "admitted" &&
      child.exitCode === null &&
      !child.killed &&
      (await toolCount()) === baseline
    );
  }

  await check(
    rows,
    "G2-REVOKE-WINDOW",
    "Membership revoked while the tool admission is paused does not commit",
    async () => {
      const current = await store.load(project, timeline);
      const before = current.stateSha256;
      const body = directAdd(before, newId());
      await pool.query("UPDATE qa_pause SET mode='wait'");
      const baseline = await toolCount();
      const child = runChild(body);
      const output = watch(child);
      const seen = await waitFor(() => held(child, body.requestId, baseline), 8000);
      await new Promise((resolve) => setTimeout(resolve, seen ? 400 : 0));
      const paused = seen && (await held(child, body.requestId, baseline));
      if (!paused) {
        child.kill("SIGKILL");
        await pool.query("UPDATE qa_pause SET mode='off'");
        return {
          status: "NOT_VERIFIED",
          expected: "paused admission",
          actual: { paused, output: output() },
        };
      }
      await pool.query(
        "UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2",
        [project, owner],
      );
      await pool.query("UPDATE qa_pause SET mode='off'");
      const exit = await new Promise((resolve) => child.once("exit", resolve));
      const status = (
        await pool.query("SELECT status FROM editing_caption_commands WHERE request_id=$1", [
          body.requestId,
        ])
      ).rows[0]?.status;
      const after = (await store.load(project, timeline)).stateSha256;
      await pool.query(
        "UPDATE project_memberships SET role='owner' WHERE project_id=$1 AND user_id=$2",
        [project, owner],
      );
      const ok = status === "admitted" && after === before;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "admitted but not committed",
        actual: { exit, status, unchanged: after === before },
      };
    },
  );

  await check(
    rows,
    "G2-SIGKILL-BEFORE-COMMIT",
    "SIGKILL during the paused pre-commit tool insert leaves one admitted receipt and no timeline effect",
    async () => {
      const current = await store.load(project, timeline);
      const before = current.stateSha256;
      const body = directAdd(before, newId());
      await pool.query("UPDATE qa_pause SET mode='wait'");
      const baseline = await toolCount();
      const child = runChild(body);
      const output = watch(child);
      const seen = await waitFor(() => held(child, body.requestId, baseline), 8000);
      await new Promise((resolve) => setTimeout(resolve, seen ? 400 : 0));
      const paused = seen && (await held(child, body.requestId, baseline));
      if (!paused) {
        child.kill("SIGKILL");
        await pool.query("UPDATE qa_pause SET mode='off'");
        return {
          status: "NOT_VERIFIED",
          expected: "kill inside the open tool insert",
          actual: { paused, output: output() },
        };
      }
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      await pool.query("UPDATE qa_pause SET mode='off'");
      const status = (
        await pool.query("SELECT status FROM editing_caption_commands WHERE request_id=$1", [
          body.requestId,
        ])
      ).rows[0]?.status;
      const after = (await store.load(project, timeline)).stateSha256;
      const retry = runChild(body);
      const retryExit = await new Promise((resolve) => retry.once("exit", resolve));
      const count = Number(
        (
          await pool.query("SELECT count(*) FROM editing_caption_commands WHERE request_id=$1", [
            body.requestId,
          ])
        ).rows[0].count,
      );
      const finalHash = (await store.load(project, timeline)).stateSha256;
      const ok =
        child.signalCode === "SIGKILL" &&
        status === "admitted" &&
        after === before &&
        retryExit !== 0 &&
        count === 1 &&
        finalHash === before;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "killed before commit, retry does not apply",
        actual: {
          signal: child.signalCode,
          status,
          retryExit,
          count,
          unchanged: finalHash === before,
        },
      };
    },
  );

  await check(
    rows,
    "G2-HTTP-DENY",
    "Unauthenticated, CSRF-less, viewer, and outsider caption writes are rejected without a receipt",
    async () => {
      const before = Number(
        (await pool.query("SELECT count(*) FROM editing_caption_commands")).rows[0].count,
      );
      const noAuth = await post(route, request, {
        headers: { "content-type": "application/json" },
      });
      const noCsrf = await fetch(base + route, {
        method: "POST",
        headers: await headers(owner, false),
        body: JSON.stringify(request),
      });
      const viewerResponse = await fetch(base + route, {
        method: "POST",
        headers: await headers(viewer),
        body: JSON.stringify(request),
      });
      const strangerResponse = await fetch(base + `/${other}/timelines/${timeline}/captions`, {
        method: "POST",
        headers: await headers(stranger),
        body: JSON.stringify(request),
      });
      const after = Number(
        (await pool.query("SELECT count(*) FROM editing_caption_commands")).rows[0].count,
      );
      const ok =
        created.status === 201 &&
        noAuth.status === 401 &&
        noCsrf.status === 403 &&
        viewerResponse.status === 404 &&
        strangerResponse.status === 404 &&
        before === after;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "401/403/404 and zero receipts",
        actual: {
          created: created.status,
          noAuth: noAuth.status,
          noCsrf: noCsrf.status,
          viewer: viewerResponse.status,
          stranger: strangerResponse.status,
          receipts: after - before,
        },
      };
    },
  );

  await check(
    rows,
    "G2-MALICIOUS-HTTP",
    "Style injection, overlong JSON, and a foreign asset are rejected",
    async () => {
      const badStyle = await fetch(base + route, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({
          ...request,
          requestId: newId(),
          style: { ...style, color: "javascript:alert(1)" },
        }),
      });
      const foreign = await fetch(base + route, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({
          ...request,
          requestId: newId(),
          assetId: domain.mediaAssetId(newId()),
        }),
      });
      const huge = await fetch(base + route, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ ...request, sourceSha256: "z".repeat(80) }),
      });
      const ok = badStyle.status === 400 && foreign.status === 409 && huge.status === 400;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "400 or 409",
        actual: { badStyle: badStyle.status, foreign: foreign.status, huge: huge.status },
      };
    },
  );

  let saved;
  await check(
    rows,
    "G2-COMMIT-RELOAD",
    "One committed command survives a new API process, style keeps words, and undo restores the prior hash",
    async () => {
      const response = await fetch(base + route, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(request),
      });
      saved = await response.json();
      const words = saved.timeline.captionsV1[0].blocks.flatMap((block) => block.lines.flat());
      const wordHash = contentHash(
        words.map((item) => [item.text, item.startUs, item.endUs, item.confidence]),
      );
      const sourceHash = contentHash(
        document.sections.transcript.data.segments
          .flatMap((segment) => segment.words)
          .map((item) => [item.text, item.startUs, item.endUs, item.confidence ?? null]),
      );
      const styled = await fetch(base + route + `/${saved.timeline.captionsV1[0].id}/style`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({
          stateSha256: saved.stateSha256,
          requestId: newId(),
          style: { ...style, highlight: "#00ffff" },
        }),
      });
      const afterStyle = await styled.json();
      const styledWords = contentHash(
        afterStyle.timeline.captionsV1[0].blocks
          .flatMap((block) => block.lines.flat())
          .map((item) => [item.text, item.startUs, item.endUs, item.confidence]),
      );
      const styleCommand = (
        await pool.query(
          "SELECT id FROM editing_caption_commands WHERE operation='update-caption-style' AND status='committed' ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0].id;
      const undone = await fetch(base + route + `/${styleCommand}/undo`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ stateSha256: afterStyle.stateSha256 }),
      });
      const afterUndo = await undone.json();
      await appServer.close();
      appServer = await createApiApplication(
        {
          editor: editorService,
          timelineCaptions: new TimelineCaptions(new PostgresCaptionEdits(pool)),
          timelineExports: new TimelineExports(projects, editorService, renders, objects, (key) =>
            objects.presignGet(key),
          ),
          projects,
          media,
          objects,
          clock: { now },
          ids: new NodeProjectIdGenerator(),
          mediaIds: new NodeMediaAssetIdGenerator(),
          presignTtlSeconds: 60,
        },
        (use) => {
          use(authenticateRequest(tokens, now));
          const csrf = requireCookieCsrf();
          use((req, res, next) => csrf(req, res, next));
        },
      );
      await appServer.listen(0, "127.0.0.1");
      const reloadedBase = `http://127.0.0.1:${appServer.getHttpServer().address().port}/projects`;
      const reloaded = await (
        await fetch(reloadedBase + `/${project}/timelines/${timeline}`, {
          headers: await headers(),
        })
      ).json();
      const history = await (
        await fetch(reloadedBase + route + "/history", { headers: await headers() })
      ).json();
      const historyText = JSON.stringify(history);
      const leaked = historyText.includes(wordA) || historyText.includes(wordB);
      const ok =
        response.status === 201 &&
        styled.status === 201 &&
        wordHash === sourceHash &&
        styledWords === wordHash &&
        afterStyle.timeline.captionsV1[0].style.highlight === "#00ffff" &&
        undone.status === 201 &&
        afterUndo.stateSha256 !== afterStyle.stateSha256 &&
        reloaded.stateSha256 === afterUndo.stateSha256 &&
        !leaked;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "commit, reload, style, undo, no history text",
        actual: {
          add: response.status,
          style: styled.status,
          undo: undone.status,
          wordHashMatch: wordHash === sourceHash,
          leaked,
          historyKeys: Array.isArray(history) ? Object.keys(history[0] ?? {}) : typeof history,
        },
      };
    },
  );

  await check(
    rows,
    "G2-DUPLICATE-CAS",
    "Replaying a committed request does not add a command and a stale hash conflicts",
    async () => {
      const port = appServer.getHttpServer().address().port;
      const endpoint = `http://127.0.0.1:${port}/projects${route}`;
      const before = Number(
        (
          await pool.query(
            "SELECT count(*) FROM editing_caption_commands WHERE request_id=$1 AND status='committed'",
            [request.requestId],
          )
        ).rows[0].count,
      );
      const replay = await fetch(endpoint, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(request),
      });
      const stale = await fetch(endpoint, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ ...request, requestId: newId(), stateSha256: "a".repeat(64) }),
      });
      const after = Number(
        (
          await pool.query(
            "SELECT count(*) FROM editing_caption_commands WHERE request_id=$1 AND status='committed'",
            [request.requestId],
          )
        ).rows[0].count,
      );
      const ok = replay.status === 201 && stale.status === 409 && before === 1 && after === 1;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "replay keeps one command; stale hash is 409",
        actual: { replay: replay.status, stale: stale.status, before, after },
      };
    },
  );

  await check(
    rows,
    "G2-SIGKILL-AFTER-COMMIT",
    "The committed receipt survives SIGKILL of a connected client and a new database session",
    async () => {
      const before = await pool.query(
        "SELECT status,result_sha256 FROM editing_caption_commands WHERE request_id=$1",
        [request.requestId],
      );
      const sleeper = spawn(
        process.execPath,
        [
          "-e",
          "const {createRequire}=require('module'); const req=createRequire(process.env.API_PKG); const {Pool}=req('pg'); const pool=new Pool({connectionString:process.env.QA_DB}); pool.query('SELECT pg_sleep(30)').catch(()=>{})",
        ],
        {
          env: {
            ...process.env,
            API_PKG: path.join(app, "apps/api/package.json"),
            QA_DB: databaseUrl(dbName),
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      sleeper.kill("SIGKILL");
      await new Promise((resolve) => sleeper.once("exit", resolve));
      const fresh = new Pool({ connectionString: databaseUrl(dbName) });
      try {
        const after = await fresh.query(
          "SELECT status,result_sha256 FROM editing_caption_commands WHERE request_id=$1",
          [request.requestId],
        );
        const ok =
          sleeper.signalCode === "SIGKILL" &&
          before.rows[0]?.status === "committed" &&
          after.rows[0]?.status === "committed" &&
          after.rows[0].result_sha256 === before.rows[0].result_sha256;
        return {
          status: ok ? "PASS" : "FAIL",
          expected: "committed row unchanged after SIGKILL",
          actual: { signal: sleeper.signalCode, status: after.rows[0]?.status },
        };
      } finally {
        await fresh.end();
      }
    },
  );

  await check(
    rows,
    "G2-F2-CAS",
    "Same-hash trims commit once and conflict; a stale replay stays 409; an unexpected database fault stays 500; a cancelled write does not stick",
    async () => {
      const read = async () => {
        const response = await fetch(base + `/${project}/timelines/${timeline}`, {
          headers: await headers(),
        });
        return { status: response.status, body: await response.json() };
      };
      const counts = async () => {
        const result = await pool.query(
          "SELECT outcome, coalesce(code,'') AS code, count(*)::int AS n FROM tool_executions GROUP BY 1,2",
        );
        return Object.fromEntries(result.rows.map((row) => [`${row.outcome}:${row.code}`, row.n]));
      };
      const auth = await headers();
      const view = await read();
      const clip = view.body.timeline.tracks[0].clips[0];
      const ends = ["700000", "1400000"];
      const beforeAudit = await counts();
      const raced = await Promise.all(
        ends.map((endUs) =>
          post(
            `/${project}/timelines/${timeline}/trim`,
            {
              stateSha256: view.body.stateSha256,
              clipId: clip.id,
              startUs: "0",
              endUs,
            },
            { headers: auth },
          ),
        ),
      );
      const after = await read();
      const persistedEnd = String(
        BigInt(after.body.timeline.tracks[0].clips[0].timelineStartUs) +
          BigInt(after.body.timeline.tracks[0].clips[0].outPoint) -
          BigInt(after.body.timeline.tracks[0].clips[0].inPoint),
      );
      const afterAudit = await counts();
      const sum = (audit, prefix) =>
        Object.entries(audit)
          .filter(([key]) => key.startsWith(prefix))
          .reduce((total, [, count]) => total + count, 0);
      const replayAudit = await counts();
      const replay = await post(
        `/${project}/timelines/${timeline}/trim`,
        {
          stateSha256: view.body.stateSha256,
          clipId: clip.id,
          startUs: "0",
          endUs: ends[0],
        },
        { headers: await headers() },
      );
      const replayed = await read();
      const replayAuditAfter = await counts();
      const freshEnd = "500000";
      const mixed = await Promise.all([
        post(
          `/${project}/timelines/${timeline}/trim`,
          {
            stateSha256: after.body.stateSha256,
            clipId: clip.id,
            startUs: "0",
            endUs: freshEnd,
          },
          { headers: await headers() },
        ),
        post(
          `/${project}/timelines/${timeline}/trim`,
          {
            stateSha256: view.body.stateSha256,
            clipId: clip.id,
            startUs: "0",
            endUs: freshEnd,
          },
          { headers: await headers() },
        ),
      ]);
      const mixedView = await read();
      const mixedEnd = String(
        BigInt(mixedView.body.timeline.tracks[0].clips[0].outPoint) -
          BigInt(mixedView.body.timeline.tracks[0].clips[0].inPoint),
      );
      const fault = { status: 0, leak: true };
      const hashBeforeFault = mixedView.body.stateSha256;
      await pool.query("ALTER TABLE editing_timelines RENAME COLUMN snapshot TO snapshot_qa93");
      try {
        const broken = await post(
          `/${project}/timelines/${timeline}/trim`,
          {
            stateSha256: hashBeforeFault,
            clipId: clip.id,
            startUs: "0",
            endUs: "400000",
          },
          { headers: await headers() },
        );
        fault.status = broken.status;
        const encoded = JSON.stringify(broken.body ?? {});
        fault.leak = /snapshot|column|qa93/.test(encoded);
      } finally {
        await pool.query("ALTER TABLE editing_timelines RENAME COLUMN snapshot_qa93 TO snapshot");
      }
      const afterFault = await read();
      const holder = await pool.connect();
      const cancellation = { status: 0 };
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM editing_timelines WHERE id=$1 FOR UPDATE", [timeline]);
        const pending = post(
          `/${project}/timelines/${timeline}/trim`,
          {
            stateSha256: afterFault.body.stateSha256,
            clipId: clip.id,
            startUs: "0",
            endUs: "300000",
          },
          { headers: await headers() },
        );
        const deadline = Date.now() + 4000;
        let pid = null;
        while (Date.now() < deadline && pid === null) {
          const waiting = await pool.query(
            "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
          );
          pid = waiting.rows[0]?.pid ?? null;
          if (pid === null) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (pid !== null) await pool.query("SELECT pg_cancel_backend($1)", [pid]);
        cancellation.status = await Promise.race([
          pending.then((result) => result.status),
          new Promise((resolve) => setTimeout(() => resolve(0), 8000)),
        ]);
        await holder.query("ROLLBACK");
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
      const afterCancel = await read();
      const statuses = raced.map((item) => item.status).sort((a, b) => a - b);
      const raceOk =
        statuses[0] === 201 &&
        statuses[1] === 409 &&
        ends.includes(persistedEnd) &&
        after.body.stateSha256 !== view.body.stateSha256 &&
        sum(afterAudit, "succeeded:") - sum(beforeAudit, "succeeded:") === 1 &&
        sum(afterAudit, "failed:") - sum(beforeAudit, "failed:") <= 1;
      const replayOk =
        replay.status === 409 &&
        replayed.body.stateSha256 === after.body.stateSha256 &&
        JSON.stringify(replayAudit) === JSON.stringify(replayAuditAfter);
      const mixedOk =
        mixed.map((item) => item.status)[0] === 201 &&
        mixed.map((item) => item.status)[1] === 409 &&
        mixedEnd === freshEnd;
      const faultOk =
        fault.status === 500 && !fault.leak && afterFault.body.stateSha256 === hashBeforeFault;
      const cancelOk =
        afterCancel.body.stateSha256 === afterFault.body.stateSha256 && cancellation.status >= 400;
      const ok = raceOk && replayOk && mixedOk && faultOk && cancelOk;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "201+409 once, stale 409, unexpected fault 500, cancelled write absent",
        actual: {
          statuses,
          persistedEnd,
          replay: replay.status,
          mixed: mixed.map((item) => item.status),
          mixedEnd,
          internalStatus: fault.status,
          internalLeak: fault.leak,
          cancelStatus: cancellation.status,
          hashStableAfterCancel: afterCancel.body.stateSha256 === afterFault.body.stateSha256,
        },
      };
    },
  );
} catch (error) {
  rows.push({
    id: "G2-SETUP",
    title: "PostgreSQL caption harness reached the probes",
    status: "ERROR",
    expected: "setup completes",
    actual: String(error?.stack ?? error).slice(0, 900),
    ms: 0,
  });
} finally {
  if (appServer) await appServer.close().catch(() => undefined);
  if (queue) await queue.close(true).catch(() => undefined);
  await pool.end().catch(() => undefined);
  await dropDatabase(dbName).catch(() => undefined);
}

writeReport(process.argv[2] ?? "/tmp/qa93-persist.json", rows, {
  suite: "persist",
  productSha: process.env.QA_APP_SHA,
});
if (rows.some((row) => !["PASS", "OBSERVED"].includes(row.status))) process.exit(1);
