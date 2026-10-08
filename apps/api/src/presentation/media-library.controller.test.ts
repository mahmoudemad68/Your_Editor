import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DerivedAsset,
  instant,
  MediaAsset,
  mediaAssetId,
  Project,
  projectId,
  userId,
} from "@editagent/domain";
import { InMemoryMediaAssetRepository } from "../application/in-memory-media-repository.js";
import { InMemoryProjectRepository } from "../application/in-memory-project-repository.js";
import { MemoryObjectStorage } from "../application/memory-object-storage.js";
import { spriteLayout } from "../application/media-library.js";
import { createApiApplication } from "../create-api-application.js";
import type { MediaLibraryResponseDto, MediaPreviewResponseDto } from "./media-library.dto.js";
import { bindActor } from "./actor.js";

const id = (n: number) => `018f6b6e-7c3a-7000-8000-${String(n).padStart(12, "0")}`;
const OWNER = userId(id(1)),
  EDITOR = userId(id(2)),
  VIEWER = userId(id(3)),
  STRANGER = userId(id(4));
const PROJECT = projectId(id(10)),
  OTHER = projectId(id(11)),
  MISSING = projectId(id(12));
const NOW = instant(100n);
function source(n: number, project = PROJECT) {
  return MediaAsset.createUploaded({
    id: mediaAssetId(id(n)),
    projectId: project,
    createdAt: NOW,
    displayFilename: `clip-${n}.mp4`,
    mimeType: "video/mp4",
    byteSize: 32,
    contentSha256: n.toString(16).padStart(64, "0"),
  });
}
function validated(asset: MediaAsset) {
  return MediaAsset.restore({
    ...asset.toSnapshot(),
    inspectionStatus: "completed",
    duration: "65000000",
    container: "MP4",
    videoCodec: "h264",
    width: 320,
    height: 180,
    displayWidth: 320,
    displayHeight: 180,
    rotation: 0,
    frameRateNumerator: "25",
    frameRateDenominator: "1",
    frameRateMode: "constant",
    streams: [
      {
        codecType: "video",
        codecName: "h264",
        width: 320,
        height: 180,
        sampleRate: null,
        channels: null,
      },
    ],
  }).recordValidation("cd".repeat(32), null, NOW);
}
function derivative(
  source: MediaAsset,
  n: number,
  variant: string,
  at: bigint,
  parameters: Record<string, unknown> = {},
  ownerProject = source.projectId,
) {
  const kind = variant === "proxy" ? "proxy" : "thumbnail";
  const signature = n.toString(16).padStart(64, "0");
  return new DerivedAsset(id(n), source.id, kind, at, at, {
    projectId: ownerProject,
    storageKey: `projects/${ownerProject}/derived/${source.id}/${kind}/${signature}/${variant === "proxy" ? "proxy.mp4" : `${variant}.jpg`}`,
    parameterSignature: signature,
    mimeType: variant === "proxy" ? "video/mp4" : "image/jpeg",
    byteSize: "100",
    sha256: "ef".repeat(32),
    metadata: { variant, parameters, internal: "/private/worker/path" },
  });
}
const layout = { tileWidth: 160, tileHeight: 90, columns: 3, rows: 2, timestampsUs: [1, 2, 3, 4] };

test("US-125 authenticated media list, persisted states/order and preview IDOR", async () => {
  const projects = new InMemoryProjectRepository(),
    media = new InMemoryMediaAssetRepository();
  const project = Project.create(PROJECT, "Library", OWNER, NOW)
    .grantMembership(OWNER, EDITOR, "editor", NOW)
    .grantMembership(OWNER, VIEWER, "viewer", NOW);
  await projects.save(project, null);
  await projects.save(Project.create(OTHER, "Other", STRANGER, NOW), null);
  const emptyProject = projectId(id(13));
  await projects.save(Project.create(emptyProject, "Empty", OWNER, NOW), null);
  const pending = source(20),
    rejected = source(21).recordValidation("cd".repeat(32), "invalid_signature", NOW),
    ready = validated(source(22)),
    awaitingDerive = validated(source(23)),
    failed = source(24).recordInspectionFailure("timeout", NOW),
    other = validated(source(25, OTHER));
  for (const asset of [failed, ready, rejected, pending, other, awaitingDerive])
    await media.save(asset);
  const rows = [
    derivative(ready, 100, "proxy", 101n),
    derivative(ready, 101, "proxy", 102n),
    derivative(ready, 102, "proxy", 102n),
    derivative(ready, 103, "poster", 102n),
    derivative(ready, 104, "sprite", 101n, layout),
    derivative(ready, 105, "sprite", 102n, { ...layout, timestampsUs: [] }),
    derivative(other, 106, "proxy", 103n),
    derivative(ready, 108, "proxy", 999n, {}, OTHER),
  ];
  let reads = 0;
  const signed: { key: string; ttl: number }[] = [];
  const objects = new MemoryObjectStorage();
  objects.presignGet = async (key: string, ttl?: number) => {
    signed.push({ key, ttl: ttl ?? 0 });
    return { url: `https://private.test/${key}?signature=temporary` };
  };
  const app = await createApiApplication(
    {
      projects,
      media,
      derivedAssets: {
        async listByMediaAsset() {
          reads++;
          return rows;
        },
      },
      objects,
      clock: { now: () => NOW },
      ids: { next: () => PROJECT },
      mediaIds: { next: () => pending.id },
      presignTtlSeconds: 900,
    },
    (use) =>
      use((request, _response, next) => {
        const actor = (request as { headers: Record<string, string> }).headers["x-test-actor"];
        if (actor) bindActor(request, userId(actor));
        next();
      }),
  );
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  const list = `/projects/${PROJECT}/media`,
    preview = `${list}/${ready.id}/preview`;
  const get = (route: string, actor?: string) =>
    fetch(base + route, actor ? { headers: { "x-test-actor": actor } } : {});
  try {
    for (const route of [list, preview]) {
      assert.equal((await get(route)).status, 401);
      assert.equal((await get(route, STRANGER)).status, 404);
      assert.equal((await fetch(base + route, { headers: { "x-user-id": OWNER } })).status, 401);
    }
    assert.equal(reads, 0);
    assert.equal(signed.length, 0);
    assert.deepEqual(await (await get(`/projects/${emptyProject}/media`, OWNER)).json(), {
      media: [],
    });
    for (const actor of [OWNER, EDITOR, VIEWER]) {
      const response = await get(list, actor);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const body = (await response.json()) as MediaLibraryResponseDto;
      assert.deepEqual(
        body.media.map((a: { id: string }) => a.id),
        [pending.id, rejected.id, ready.id, awaitingDerive.id, failed.id],
      );
      assert.equal(body.media[0]!.inspectionStatus, "pending");
      assert.equal(body.media[1]!.validationStatus, "rejected");
      assert.equal(body.media[1]!.rejectionMessage, "The file is not recognized media.");
      assert.deepEqual(body.media[1]!.previews, { proxy: false, poster: false, sprite: false });
      assert.deepEqual(body.media[2]!.previews, { proxy: true, poster: true, sprite: true });
      assert.deepEqual(body.media[3]!.previews, { proxy: false, poster: false, sprite: false });
      assert.equal(body.media[4]!.inspectionError, "timeout");
      assert.doesNotMatch(
        JSON.stringify(body),
        /storageKey|storage_key|\/private|X-Amz|parameters|payload/,
      );
      const issued = await get(preview, actor);
      assert.equal(issued.status, 200);
      assert.equal(issued.headers.get("cache-control"), "private, no-store");
      const contract = (await issued.json()) as MediaPreviewResponseDto;
      assert.equal(contract.expiresInSeconds, 900);
      assert.deepEqual(contract.sprite.layout, { ...layout, timestampsUs: ["1", "2", "3", "4"] });
      assert.ok(contract.proxy.url!.includes(rows[2]!.artifact!.storageKey));
      assert.ok(contract.sprite.url!.includes(rows[4]!.artifact!.storageKey));
      assert.doesNotMatch(
        JSON.stringify(contract),
        /storageKey|parameterSignature|sha256|internal|\/private\//,
      );
    }
    const persisted = await (await get(list, OWNER)).json();
    assert.deepEqual(await (await get(list, OWNER)).json(), persisted, "reload snapshot stable");
    const beforeRead = reads,
      beforeSign = signed.length;
    for (const route of [
      `${list}/${other.id}/preview`,
      `/projects/${OTHER}/media/${ready.id}/preview`,
      `/projects/${MISSING}/media`,
      `/projects/${MISSING}/media/${ready.id}/preview`,
    ])
      assert.equal((await get(route, OWNER)).status, 404);
    assert.equal(reads, beforeRead);
    assert.equal(signed.length, beforeSign);
    const rejectedContract = (await (
      await get(`${list}/${rejected.id}/preview`, OWNER)
    ).json()) as MediaPreviewResponseDto;
    assert.equal(rejectedContract.proxy.available, false);
    assert.equal(signed.length, beforeSign);
    assert.ok(signed.every((a) => a.ttl === 900 && a.key.includes("/derived/")));
    const current = await projects.findById(PROJECT);
    await projects.save(current!.project.deleteProject(OWNER, instant(101n)), current!.revision);
    assert.equal((await get(list, OWNER)).status, 404);
    assert.equal((await get(preview, OWNER)).status, 404);
  } finally {
    await app.close();
  }
});

test("sprite contract validates geometry, sample bounds, safe integer timestamps and single sample", () => {
  assert.deepEqual(
    spriteLayout({ ...layout, columns: 1, rows: 1, timestampsUs: [5] }, 10n)?.timestampsUs,
    ["5"],
  );
  for (const change of [
    { tileWidth: 0 },
    { columns: 6 },
    { rows: 1 },
    { timestampsUs: [1, 1] },
    { timestampsUs: [-1] },
    { timestampsUs: [Number.MAX_SAFE_INTEGER + 1] },
    { timestampsUs: [65_000_000] },
    { timestampsUs: [] },
  ])
    assert.equal(spriteLayout({ ...layout, ...change }, 65_000_000n), null);
});
