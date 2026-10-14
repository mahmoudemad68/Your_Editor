import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DerivedAsset, createUuidV7, type DerivedAssetSnapshot } from "@editagent/domain";
import {
  ToolError,
  contentHash,
  editingToolManifests,
  validateEditingParameters,
  type EditingToolName,
  type ToolContext,
  type ITool,
  type ToolResult,
  type ToolAuthority,
  ToolRegistry,
} from "@editagent/tool-sdk";
import type { MediaEditInput, FixtureInput } from "../application/ports.js";
import { PostgresRenderAssetResolver } from "./asset-resolver.js";
import { RenderObjects, workspace, fileSha } from "./storage.js";
import { remoteEdit } from "./remote-render.js";
import { validateOutput } from "./probe-output.js";
import { JobExecutionUnconfirmedError } from "@editagent/job-queue";

interface Output {
  schemaVersion: 1;
  kind: "derived-media";
  asset: DerivedAssetSnapshot & { artifact: NonNullable<DerivedAssetSnapshot["artifact"]> };
}
/** Coordinator owns authorization/storage. Decoding and transformations remain in the networkless executor. */
export class MediaEditingTool implements ITool {
  constructor(
    private readonly operation: Exclude<EditingToolName, "trim_video" | "split_video">,
    private readonly pool: Pool,
    private readonly authority: ToolAuthority,
    private readonly objects: RenderObjects,
    private readonly costMicros = 1000,
  ) {}
  start(raw: unknown, context: ToolContext) {
    const cleanup = { confirmed: true };
    const abort = new AbortController(),
      relay = () => abort.abort(context.signal.reason);
    context.signal.addEventListener("abort", relay, { once: true });
    if (context.signal.aborted) relay();
    const result = this.execute(raw, { ...context, signal: abort.signal }, cleanup)
      .catch((error: unknown) => {
        if (error instanceof JobExecutionUnconfirmedError) cleanup.confirmed = false;
        throw error;
      })
      .finally(() => context.signal.removeEventListener("abort", relay));
    // Rejection is the execution result. Cancellation still waits for owned process-tree cleanup.
    const stop = async () => {
      abort.abort();
      await result.catch(() => undefined);
      if (!cleanup.confirmed) throw new JobExecutionUnconfirmedError();
    };
    return { result, cancel: stop, forceStop: stop };
  }
  private async execute(
    raw: unknown,
    context: ToolContext,
    cleanup: { confirmed: boolean },
  ): Promise<ToolResult> {
    const parameters = validateEditingParameters(this.operation, raw),
      ids = [
        ...new Set(
          this.operation === "concat_clips"
            ? (parameters.clips as { assetId: string }[]).map((c) => c.assetId)
            : [parameters.assetId as string],
        ),
      ];
    const manifest = editingToolManifests(this.costMicros).find(
      (m) => m.name === `editing.${this.operation.replaceAll("_", "-")}`,
    )!;
    const registry = new ToolRegistry();
    registry.register(manifest, { mode: "remote", target: "render" });
    const definition = registry.lookup(manifest.name, manifest.version);
    if (
      this.operation === "concat_clips"
        ? context.resource.kind !== "project" || context.resource.id !== context.projectId
        : context.resource.kind !== "asset" || context.resource.id !== ids[0]
    )
      throw new ToolError("invalid_subject");
    for (const id of ids)
      await this.authority.authorize(
        { ...context, resource: { kind: "asset", id } },
        manifest.permissions,
      );
    const resolver = new PostgresRenderAssetResolver(this.pool),
      refs = await resolver.sourceReferences(context.projectId, ids, context.signal);
    const sources = refs.map(({ rootMediaId: _root, ...s }) => s),
      resolved = await resolver.resolve(context.projectId, sources, context.signal);
    const catalog = JSON.parse(
      await readFile(path.join(__dirname, "../bundle/catalog.json"), "utf8"),
    ) as { renderVersion: string };
    const input: MediaEditInput = {
      schemaVersion: 1,
      kind: "media-edit-v1",
      renderVersion: catalog.renderVersion,
      operation: this.operation,
      parameters,
      sources,
    };
    const signature = contentHash({ executionId: context.executionId, input, assets: resolved });
    const connection = await this.pool.connect(),
      stage = await workspace().catch((error: unknown) => {
        connection.release();
        throw error;
      });
    cleanup.confirmed = false;
    let locked = false,
      published = false,
      ownedKey: string | undefined;
    try {
      const lock = await connection.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [context.executionId],
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) throw new Error("Editing execution busy.");
      await this.active(connection, context);
      const prior = await connection.query<{
        descriptor: Output;
        descriptor_sha256: string;
        published: boolean;
      }>(
        "SELECT descriptor,descriptor_sha256,published FROM editing_output_intents WHERE execution_id=$1",
        [context.executionId],
      );
      let output: Output | undefined = prior.rows[0]?.descriptor;
      if (output) {
        registry.validate(definition, "output", output);
        if (
          contentHash(output) !== prior.rows[0]!.descriptor_sha256 ||
          output.asset.artifact.parameterSignature !== signature ||
          output.asset.mediaAssetId !== refs[0]!.rootMediaId ||
          output.asset.artifact.projectId !== context.projectId
        )
          throw new ToolError("invalid_output");
        DerivedAsset.restore(output.asset);
        published = prior.rows[0]!.published;
      }
      const file = path.join(stage.work, "output.mp4");
      let stored = output
        ? await this.objects.find(output.asset.artifact.storageKey, signature, context.signal)
        : null;
      if (stored && output) {
        if (!published) ownedKey = output.asset.artifact.storageKey;
        if (
          stored.sha256 !== output.asset.artifact.sha256 ||
          String(stored.byteSize) !== output.asset.artifact.byteSize
        )
          throw new ToolError("invalid_output");
        await this.objects.stage(output.asset.artifact.storageKey, file, stored, context.signal);
        await this.validate(file, output, context.signal);
      } else {
        const names = new Set<string>();
        for (const asset of resolved) {
          if (!names.has(asset.name))
            await this.objects.stage(
              asset.objectKey,
              path.join(stage.work, asset.name),
              asset,
              context.signal,
            );
          names.add(asset.name);
        }
        let last = 0,
          progress = Promise.resolve(),
          progressFailed = false;
        await remoteEdit(
          stage.token,
          input,
          manifest.timeoutMs,
          context.signal,
          (p) => {
            const percent = Math.max(
              last,
              Math.min(95, Math.floor((p.encodedFrames * 95) / p.totalFrames)),
            );
            if (percent <= last) return;
            last = percent;
            progress = progress
              .then(() => context.progress(percent))
              .catch(() => {
                progressFailed = true;
              });
          },
          resolved.map(({ objectKey: _key, audioPresent: _audio, ...a }) => a),
        );
        await progress;
        if (progressFailed) throw new Error("Editing progress unavailable.");
        const meta = JSON.parse(await readFile(path.join(stage.work, "output.json"), "utf8")) as {
          durationUs: string;
          videoDurationUs: string;
          decodedFrames: number;
          audioSamples: string;
          sourceVideoFrames?: number;
          spatialFrameCountBasis?: "decoded_cfr_v1";
          width: number;
          height: number;
          frameRate: { numerator: string; denominator: string };
          audioPresent: boolean;
          byteSize: number;
        };
        const sha = await fileSha(file, context.signal),
          key = `projects/${context.projectId}/derived/${refs[0]!.rootMediaId}/edited-video/${signature}/${sha}.mp4`;
        const stamp = Number(BigInt("0x" + context.executionId.replaceAll("-", "").slice(0, 12)));
        const asset = new DerivedAsset(
          createUuidV7(
            stamp,
            createHash("sha256")
              .update(context.executionId + ":edited-video")
              .digest()
              .subarray(0, 10),
          ),
          refs[0]!.rootMediaId,
          "edited-video",
          String(stamp),
          String(stamp),
          {
            projectId: context.projectId,
            storageKey: key,
            parameterSignature: signature,
            mimeType: "video/mp4",
            byteSize: String(meta.byteSize),
            sha256: sha,
            metadata: {
              variant: "edit",
              parameters: {
                operation: this.operation,
                toolVersion: "1.0.0",
                inputSha256: contentHash(parameters),
                sourceIds: ids,
                sourceHashes: resolved.map((a) => a.sha256),
                renderVersion: catalog.renderVersion,
              },
              durationUs: meta.durationUs,
              videoDurationUs: meta.videoDurationUs,
              videoFrames: meta.decodedFrames,
              audioSamples: meta.audioSamples,
              ...(meta.sourceVideoFrames !== undefined
                ? {
                    sourceVideoFrames: meta.sourceVideoFrames,
                    spatialFrameCountBasis: meta.spatialFrameCountBasis,
                  }
                : {}),
              width: meta.width,
              height: meta.height,
              frameRate: {
                numerator: Number(meta.frameRate.numerator),
                denominator: Number(meta.frameRate.denominator),
              },
              audioPresent: meta.audioPresent,
              producer: "ffmpeg-edit-v1",
            },
          },
        ).toSnapshot();
        const candidate: Output = {
          schemaVersion: 1,
          kind: "derived-media",
          asset: {
            ...asset,
            createdAt: String(asset.createdAt),
            updatedAt: String(asset.updatedAt),
            artifact: asset.artifact!,
          },
        };
        registry.validate(definition, "output", candidate);
        await this.validate(file, candidate, context.signal);
        if (output && contentHash(output) !== contentHash(candidate))
          throw new ToolError("invalid_output");
        output = candidate;
        await connection.query(
          "INSERT INTO editing_output_intents(execution_id,descriptor,descriptor_sha256) VALUES($1,$2::jsonb,$3) ON CONFLICT DO NOTHING",
          [context.executionId, JSON.stringify(output), contentHash(output)],
        );
        await this.active(connection, context);
        ownedKey = key;
        stored = await this.objects.put(key, signature, file, context.signal);
      }
      context.signal.throwIfAborted();
      await this.authority.authorize(context, manifest.permissions);
      for (const id of ids)
        await this.authority.authorize(
          { ...context, resource: { kind: "asset", id } },
          manifest.permissions,
        );
      await connection.query("BEGIN");
      try {
        await this.active(connection, context, true);
        const a = output!.asset,
          artifact = a.artifact;
        await connection.query(
          `INSERT INTO derived_assets(id,media_asset_id,kind,created_at,updated_at,project_id,storage_key,parameter_signature,mime_type,byte_size,content_sha256,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT(id) DO NOTHING`,
          [
            a.id,
            a.mediaAssetId,
            a.kind,
            a.createdAt,
            a.updatedAt,
            artifact.projectId,
            artifact.storageKey,
            artifact.parameterSignature,
            artifact.mimeType,
            artifact.byteSize,
            artifact.sha256,
            JSON.stringify(artifact.metadata),
          ],
        );
        const existing = await connection.query<{ storage_key: string; content_sha256: string }>(
          "SELECT storage_key,content_sha256 FROM derived_assets WHERE id=$1 AND project_id=$2",
          [a.id, context.projectId],
        );
        if (
          existing.rows[0]?.storage_key !== artifact.storageKey ||
          existing.rows[0]?.content_sha256 !== artifact.sha256
        )
          throw new ToolError("invalid_output");
        await connection.query(
          "UPDATE editing_output_intents SET published=true WHERE execution_id=$1",
          [context.executionId],
        );
        await connection.query("COMMIT");
        published = true;
      } catch (e) {
        await connection.query("ROLLBACK");
        throw e;
      }
      return { output, costMicros: this.costMicros };
    } finally {
      let failed = false;
      try {
        if (context.signal.aborted && ownedKey && !published)
          await this.objects.remove(ownedKey, signature);
      } catch {
        failed = true;
      } finally {
        try {
          await stage.close();
        } catch {
          failed = true;
        }
        try {
          if (locked)
            await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
              context.executionId,
            ]);
        } catch {
          failed = true;
        }
        connection.release(failed ? new Error("Editing cleanup unconfirmed.") : undefined);
        cleanup.confirmed = !failed;
      }
    }
  }
  private async active(c: PoolClient, context: ToolContext, lock = false) {
    context.signal.throwIfAborted();
    const r = await c.query(
      `SELECT e.id FROM tool_executions e JOIN jobs j ON j.id=e.job_id
      JOIN projects p ON p.id=e.project_id JOIN project_memberships m ON m.project_id=p.id AND m.user_id=e.caller_id WHERE e.id=$1 AND e.project_id=$2 AND e.caller_id=$3 AND p.deleted_at IS NULL
      AND e.outcome='running' AND e.stop_code IS NULL AND e.admission_deadline_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint AND j.status='Running'
      AND m.role IN ('owner','editor') ${lock ? "FOR UPDATE OF e,j,p,m" : ""}`,
      [context.executionId, context.projectId, context.callerId],
    );
    if (r.rowCount !== 1) throw new ToolError("cancelled");
  }
  private async validate(file: string, output: Output, signal: AbortSignal) {
    const m = output.asset.artifact.metadata as {
      width: number;
      height: number;
      durationUs: string;
      videoDurationUs?: string;
      videoFrames?: number;
      audioSamples?: string;
      sourceVideoFrames?: number;
      spatialFrameCountBasis?: string;
      frameRate: { numerator: number; denominator: number };
      audioPresent: boolean;
    };
    const spatial = this.operation === "crop_video" || this.operation === "resize_video";
    // Pre-repair spatial descriptors cannot establish full source audio coverage.
    // Reject them rather than inferring an audio clock from shortened video metadata.
    if (
      spatial &&
      (m.videoFrames === undefined ||
        m.videoDurationUs === undefined ||
        m.audioSamples === undefined ||
        m.spatialFrameCountBasis !== "decoded_cfr_v1" ||
        m.sourceVideoFrames !== m.videoFrames)
    )
      throw new ToolError("invalid_output");
    const frames =
      m.videoFrames ??
      Number(
        (BigInt(m.videoDurationUs ?? m.durationUs) * BigInt(m.frameRate.numerator) +
          500000n * BigInt(m.frameRate.denominator)) /
          (1000000n * BigInt(m.frameRate.denominator)),
      );
    const contract: FixtureInput = {
      schemaVersion: 1,
      renderVersion: (output.asset.artifact.metadata.parameters as { renderVersion: string })
        .renderVersion,
      compositionId: "FixtureV1",
      width: m.width,
      height: m.height,
      frameRate: m.frameRate,
      durationInFrames: frames,
      props: { title: "media-edit", background: "#000000" },
      correlationId: "media-edit",
    };
    const verified = await validateOutput(
      file,
      contract,
      signal,
      m.audioPresent,
      !spatial || m.audioSamples === undefined ? undefined : BigInt(m.audioSamples),
    );
    if (
      verified.durationUs !== m.durationUs ||
      (m.videoDurationUs !== undefined && verified.videoDurationUs !== m.videoDurationUs)
    )
      throw new ToolError("invalid_output");
  }
}
