import { readFile } from "node:fs/promises";
import { PermanentJobError } from "@editagent/job-queue";
import { FFprobeMediaProbe } from "@editagent/media-core";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  IRenderStrategy,
  RenderInput,
  RenderProgress,
  IRenderAssetResolver,
} from "../application/ports.js";
import { parseRenderInput, outputKey, canonicalJson } from "./contract.js";
import { remoteRender } from "./remote-render.js";
import { RenderObjects, workspace } from "./storage.js";
import { validateOutput } from "./probe-output.js";
import { compositionTiming } from "../application/timeline-mapping.js";
import { renderEngine } from "../application/strategy-selection.js";
import { expectedTimelineAudio } from "./audio-contract.js";
import { contentHash } from "@editagent/tool-sdk";
import { RenderValidationV1Schema } from "@editagent/schemas";
class StoredRenderStrategy implements IRenderStrategy {
  constructor(
    private objects: RenderObjects,
    private timeoutMs: number,
    private assets?: IRenderAssetResolver,
    private readonly engine: "remotion" | "ffmpeg" = "remotion",
  ) {}
  async discard(artifact: import("../application/ports.js").RenderArtifact) {
    await this.objects.remove(artifact.objectKey, artifact.inputSha256);
  }
  async render(
    raw: RenderInput,
    projectId: string,
    jobId: string,
    signal: AbortSignal,
    progress: (p: RenderProgress) => void,
  ) {
    const input = parseRenderInput(raw),
      key = outputKey(input.renderVersion, projectId, jobId);
    const catalog = JSON.parse(
      await readFile(path.join(__dirname, "../bundle/catalog.json"), "utf8"),
    ) as { renderVersion: string };
    if (input.renderVersion !== catalog.renderVersion)
      throw new PermanentJobError("Unsupported render version.");
    if (input.compositionId === "TimelineV1" && input.props.timeline.projectId !== projectId)
      throw new PermanentJobError("Timeline project does not match subject.");
    const resolved =
      input.compositionId === "TimelineV1"
        ? await this.assets?.resolve(projectId, input.props.timeline.sources, signal)
        : [];
    if (!resolved) throw new PermanentJobError("Asset resolver unavailable.");
    const audioPresent = expectedTimelineAudio(input, resolved);
    const signature = createHash("sha256")
      .update(canonicalJson({ input, assets: resolved }))
      .digest("hex");
    const stage = await workspace();
    try {
      const existing = await this.objects.find(key, signature, signal);
      const output = path.join(stage.work, "output.mp4");
      if (existing) {
        await this.objects.stage(key, output, existing, signal);
        const measured = await validateOutput(output, input, signal, audioPresent);
        return {
          objectKey: key,
          ...existing,
          renderVersion: input.renderVersion,
          inputSha256: signature,
          ...(input.compositionId === "TimelineV1"
            ? {
                validation: renderProof(
                  measured,
                  input,
                  jobId,
                  existing.sha256,
                  signature,
                  audioPresent,
                ),
              }
            : {}),
        };
      }
      const staged = new Set<string>();
      for (const asset of resolved) {
        if (!staged.has(asset.name))
          await this.objects.stage(
            asset.objectKey,
            path.join(stage.work, asset.name),
            asset,
            signal,
          );
        staged.add(asset.name);
      }
      let engine = this.engine;
      if (engine === "ffmpeg" && renderEngine(input) !== "ffmpeg") engine = "remotion";
      if (engine === "ffmpeg") {
        const probe = new FFprobeMediaProbe({ timeoutMs: 10000 });
        for (const asset of resolved) {
          if (
            !(await probe.supportsCutRendering(
              {
                filePath: path.join(stage.work, asset.name),
                signal,
              },
              compositionTiming(input).frameRate,
            ))
          ) {
            engine = "remotion";
            break;
          }
        }
      }
      await remoteRender(
        stage.token,
        input,
        this.timeoutMs,
        signal,
        progress,
        resolved.map(({ objectKey: _key, audioPresent: _audio, ...asset }) => asset),
        engine,
      );
      const measured = await validateOutput(output, input, signal, audioPresent);
      const saved = await this.objects.put(key, signature, output, signal);
      signal.throwIfAborted();
      return {
        objectKey: key,
        ...saved,
        renderVersion: input.renderVersion,
        inputSha256: signature,
        ...(input.compositionId === "TimelineV1"
          ? {
              validation: renderProof(
                measured,
                input,
                jobId,
                saved.sha256,
                signature,
                audioPresent,
              ),
            }
          : {}),
      };
    } finally {
      if (signal.aborted)
        try {
          await this.objects.remove(key, signature);
        } finally {
          await stage.close();
        }
      else await stage.close();
    }
  }
}
function renderProof(
  measured: Awaited<ReturnType<typeof validateOutput>>,
  input: Extract<RenderInput, { compositionId: "TimelineV1" }>,
  jobId: string,
  sha: string,
  signature: string,
  audioPresent: boolean,
) {
  return RenderValidationV1Schema.parse({
    schemaVersion: "1.0.0",
    jobId,
    artifactSha256: sha,
    inputSha256: signature,
    timelineSha256: contentHash(input.props.timeline),
    renderVersion: input.renderVersion,
    durationUs: measured.videoDurationUs,
    videoFrames: measured.decodedFrames,
    audioPresent,
    videoCodec: "h264",
    audioCodec: audioPresent ? "aac" : null,
    width: measured.width,
    height: measured.height,
    frameRate: measured.frameRate,
    validation: "render_worker_ffprobe_v1",
  });
}
export class RemotionRenderStrategy extends StoredRenderStrategy {}
export class FFmpegRenderStrategy extends StoredRenderStrategy {
  constructor(objects: RenderObjects, timeoutMs: number, assets: IRenderAssetResolver) {
    super(objects, timeoutMs, assets, "ffmpeg");
  }
}
