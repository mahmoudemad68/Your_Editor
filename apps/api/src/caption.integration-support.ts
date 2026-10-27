/** Synthetic MediaAnalysis data tests lifecycle authority only, never ASR accuracy. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import path from "node:path";
import type { Pool } from "pg";
import {
  DEFAULT_CAPTION_STYLE,
  type UserId,
  type ProjectId,
  type MediaAssetId,
} from "@editagent/domain";
import { parseMediaAnalysis } from "@editagent/schemas";
import { contentHash, ToolExecutor } from "@editagent/tool-sdk";
import { PostgresCaptionEdits } from "./infrastructure/postgres-caption-edits.js";
import type { TimelineEditor } from "./application/timeline-editor.js";
export async function checkCaptionLifecycle(p: {
  pool: Pool;
  url: string;
  owner: UserId;
  viewer: UserId;
  stranger: UserId;
  project: ProjectId;
  other: ProjectId;
  source: MediaAssetId;
  current: Awaited<ReturnType<TimelineEditor["read"]>>;
  base: string;
  headers: (actor?: UserId) => Promise<Record<string, string>>;
  post: (route: string, body: object, actor?: UserId) => Promise<Response>;
  newId: () => string;
}) {
  const {
      pool,
      owner,
      viewer,
      stranger,
      project,
      other,
      source,
      current,
      base,
      headers,
      post,
      newId,
    } = p,
    timeline = current.timeline.id;
  const doc = parseMediaAnalysis({
    schemaVersion: "1.0.0",
    mediaAssetId: source,
    source: { sha256: "b".repeat(64), durationUs: "2000000" },
    provenance: { producer: "caption-lifecycle-fixture", producerVersion: "1.0.0" },
    sections: {
      metadata: { status: "not_available" },
      audio: { status: "not_available" },
      scenes: { status: "not_available" },
      faces: { status: "not_available" },
      objects: { status: "not_available" },
      transcript: {
        status: "completed",
        provenance: {
          analyzer: "caption-lifecycle-fixture",
          analyzerVersion: "1.0.0",
          sourceSha256: "b".repeat(64),
          configurationSha256: "c".repeat(64),
          model: { name: "faster-whisper-small", version: "fixture-only", sha256: "d".repeat(64) },
        },
        data: {
          language: "en",
          segments: [
            {
              id: "fixture-0",
              text: "Hi مَرْحَبًا",
              startUs: "300000",
              endUs: "1200000",
              words: [
                { text: "Hi", startUs: "300000", endUs: "600000", confidence: 0.9 },
                { text: "مَرْحَبًا", startUs: "700000", endUs: "1200000" },
              ],
            },
          ],
        },
      },
    },
  });
  await pool.query(
    "INSERT INTO media_analyses(media_asset_id,project_id,source_sha256,document) VALUES($1,$2,$3,$4::jsonb)",
    [source, project, "b".repeat(64), JSON.stringify(doc)],
  );
  const route = `/${project}/timelines/${timeline}/captions`;
  const request = {
    stateSha256: current.stateSha256,
    requestId: newId(),
    assetId: source,
    sourceSha256: "b".repeat(64),
    analysisSha256: contentHash(doc),
    style: DEFAULT_CAPTION_STYLE,
  };
  assert.equal(
    (await fetch(base + route + `/sources/${source}`, { headers: await headers() })).status,
    200,
  );
  assert.equal(
    (
      await fetch(base + route, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": owner },
        body: JSON.stringify(request),
      })
    ).status,
    401,
  );
  const noCsrf = await headers();
  delete noCsrf["x-editagent-csrf"];
  assert.equal(
    (await fetch(base + route, { method: "POST", headers: noCsrf, body: JSON.stringify(request) }))
      .status,
    403,
  );
  const tiny = structuredClone(doc);
  if (tiny.sections.transcript.status !== "completed") throw new Error("Fixture must be complete.");
  tiny.sections.transcript.provenance.model = {
    name: "faster-whisper-tiny",
    version: "fixture-only",
    sha256: "e".repeat(64),
  };
  await pool.query("UPDATE media_analyses SET document=$2::jsonb WHERE media_asset_id=$1", [
    source,
    JSON.stringify(tiny),
  ]);
  try {
    assert.equal(
      (await fetch(base + route + `/sources/${source}`, { headers: await headers() })).status,
      409,
    );
  } finally {
    await pool.query("UPDATE media_analyses SET document=$2::jsonb WHERE media_asset_id=$1", [
      source,
      JSON.stringify(doc),
    ]);
  }
  assert.equal((await post(route, request, viewer)).status, 404);
  assert.equal((await post(route, request, stranger)).status, 404);
  assert.equal(
    (await post(`/${other}/timelines/${timeline}/captions`, request, stranger)).status,
    404,
  );
  for (const mutation of [
    { style: { ...DEFAULT_CAPTION_STYLE, css: "url(https://example.com)" } },
    { actorId: stranger },
    { permissions: ["project.owner"] },
  ])
    assert.equal((await post(route, { ...request, ...mutation })).status, 400);
  const bad = await post(route, { ...request, requestId: newId(), analysisSha256: "e".repeat(64) });
  assert.equal(bad.status, 409);
  const before = contentHash(
    await new PostgresCaptionEdits(pool).source(owner, project, timeline, source),
  );
  const added = await post(route, request);
  assert.equal(added.status, 201);
  const saved = (await added.json()) as typeof current;
  const caption = saved.timeline.captionsV1![0]!;
  assert.equal(caption.blocks.flatMap((b) => b.lines.flat()).length, 2);
  assert.equal(caption.blocks[0]!.lines.flat()[1]!.confidence, null);
  assert.equal((await post(route, request)).status, 201);
  assert.equal(
    (await pool.query("SELECT count(*) FROM editing_caption_commands WHERE status='committed'"))
      .rows[0].count,
    "1",
  );
  const read = await fetch(base + `/${project}/timelines/${timeline}`, {
    headers: await headers(),
  });
  assert.deepEqual(((await read.json()) as typeof current).timeline, saved.timeline);
  const history = await fetch(base + route + "/history", { headers: await headers(viewer) });
  const list = (await history.json()) as { id: string; status: string }[];
  assert.equal(list.filter((r) => r.status === "committed").length, 1);
  assert.equal(JSON.stringify(list).includes("مَرْحَبًا"), false);
  assert.equal(
    (await fetch(base + route + "/history", { headers: await headers(stranger) })).status,
    404,
  );
  const styleRequest = {
    stateSha256: saved.stateSha256,
    requestId: newId(),
    style: { ...DEFAULT_CAPTION_STYLE, highlight: "#00ff00" },
  };
  const styledResponse = await post(route + `/${caption.id}/style`, styleRequest);
  assert.equal(styledResponse.status, 201);
  const styled = (await styledResponse.json()) as typeof current;
  assert.deepEqual(styled.timeline.captionsV1![0]!.blocks, caption.blocks);
  // Real process death after durable proposal receipt, before Timeline commit.
  const crashRequest = {
    stateSha256: styled.stateSha256,
    requestId: newId(),
    operation: "update-caption-style" as const,
    input: { captionId: caption.id, style: { ...DEFAULT_CAPTION_STYLE, highlight: "#ff0000" } },
  };
  const child = fork(path.resolve(__dirname, "../../../tools/test/caption-crash-worker.cjs"), [], {
    env: { ...process.env, DATABASE_URL: p.url, CAPTION_CRASH_TEST: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const barrier = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Caption receipt barrier timed out.")),
        10000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Caption test process exited before its barrier."));
      });
      child.once("message", (m: unknown) => {
        clearTimeout(timer);
        if ((m as { phase: string }).phase === "receipt-recorded") resolve();
        else reject(new Error("Caption receipt barrier failed."));
      });
      child.once("error", reject);
    });
    child.send({ actor: owner, project, timeline, request: crashRequest });
    await barrier;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  const restarted = new PostgresCaptionEdits(pool);
  await assert.rejects(() => restarted.execute(owner, project, timeline, crashRequest));
  assert.equal(
    (await pool.query("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [timeline])).rows[0]
      .state_sha256,
    styled.stateSha256,
  );
  const pending = (
    await pool.query("SELECT id,status FROM editing_caption_commands WHERE request_id=$1", [
      crashRequest.requestId,
    ])
  ).rows[0];
  assert.equal(pending.status, "admitted");
  assert.equal(
    (await pool.query("SELECT outcome FROM tool_executions WHERE id=$1", [pending.id])).rows[0]
      .outcome,
    "succeeded",
  );
  const latest = (
    await pool.query(
      "SELECT id FROM editing_caption_commands WHERE status='committed' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0].id;
  assert.equal(
    (await post(route + `/${latest}/undo`, { stateSha256: saved.stateSha256 })).status,
    409,
  );
  const undone = await post(route + `/${latest}/undo`, { stateSha256: styled.stateSha256 });
  assert.equal(undone.status, 201);
  assert.deepEqual(((await undone.json()) as typeof current).timeline, saved.timeline);
  assert.equal(
    (await post(route + `/${latest}/undo`, { stateSha256: saved.stateSha256 })).status,
    409,
  );
  assert.equal(contentHash(await restarted.source(owner, project, timeline, source)), before);
  // Revoke AFTER the successful proposal receipt and before the durable edit.
  const original = ToolExecutor.prototype.executeWithIdentity;
  ToolExecutor.prototype.executeWithIdentity = async function (
    ...args: Parameters<ToolExecutor["executeWithIdentity"]>
  ) {
    const result = await original.apply(this, args);
    await pool.query(
      "UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [project, owner],
    );
    return result;
  };
  try {
    await assert.rejects(() =>
      restarted.execute(owner, project, timeline, {
        requestId: newId(),
        stateSha256: saved.stateSha256,
        operation: "update-caption-style",
        input: { captionId: caption.id, style: { ...DEFAULT_CAPTION_STYLE, highlight: "#ff00ff" } },
      }),
    );
  } finally {
    ToolExecutor.prototype.executeWithIdentity = original;
    await pool.query(
      "UPDATE project_memberships SET role='owner' WHERE project_id=$1 AND user_id=$2",
      [project, owner],
    );
  }
  assert.equal(
    (await pool.query("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [timeline])).rows[0]
      .state_sha256,
    saved.stateSha256,
  );
  const priorAdmission = (await pool.query("SELECT count(*) FROM editing_caption_commands")).rows[0]
    .count;
  await pool.query(
    "UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2",
    [project, owner],
  );
  try {
    assert.equal((await post(route, { ...request, requestId: newId() })).status, 404);
  } finally {
    await pool.query(
      "UPDATE project_memberships SET role='owner' WHERE project_id=$1 AND user_id=$2",
      [project, owner],
    );
  }
  assert.equal(
    (await pool.query("SELECT count(*) FROM editing_caption_commands")).rows[0].count,
    priorAdmission,
  );
}
