import { readFile } from "node:fs/promises";
import { PermanentJobError } from "@editagent/job-queue";
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
export class RemotionRenderStrategy implements IRenderStrategy {
  constructor(
    private objects: RenderObjects,
    private timeoutMs: number,
    private assets?: IRenderAssetResolver,
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
    const signature = createHash("sha256")
      .update(canonicalJson({ input, assets: resolved }))
      .digest("hex");
    const stage = await workspace();
    try {
      const existing = await this.objects.find(key, signature, signal);
      const output = path.join(stage.work, "output.mp4");
      if (existing) {
        await this.objects.stage(key, output, existing, signal);
        await validateOutput(output, input, signal);
        return {
          objectKey: key,
          ...existing,
          renderVersion: input.renderVersion,
          inputSha256: signature,
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
      await remoteRender(
        stage.token,
        input,
        this.timeoutMs,
        signal,
        progress,
        resolved.map(({ objectKey: _key, ...asset }) => asset),
      );
      await validateOutput(output, input, signal);
      const saved = await this.objects.put(key, signature, output, signal);
      signal.throwIfAborted();
      return {
        objectKey: key,
        ...saved,
        renderVersion: input.renderVersion,
        inputSha256: signature,
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
