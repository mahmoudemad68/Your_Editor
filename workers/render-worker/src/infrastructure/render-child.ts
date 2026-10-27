import { loadRendererProcessConfig } from "./config.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openBrowser, selectComposition, renderMedia, makeCancelSignal } from "@remotion/renderer";
import { parseRenderInput } from "./contract.js";
import { startBundleServer } from "./local-bundle-server.js";
import { validateOutput } from "./probe-output.js";
import {
  compositionTiming,
  mapTimeline,
  captionFrameBoundaries,
} from "../application/timeline-mapping.js";
import type { VerifiedAsset } from "../application/ports.js";
import { verifyStagedAssets } from "./verified-assets.js";
import { exactEncoderTiming } from "./encoder-timing.js";
import { renderFfmpegCut } from "./ffmpeg-render.js";
import { parseMediaEdit, executeMediaEdit } from "./media-edit.js";
import { MediaEditInputError } from "./media-edit-error.js";
import { stagedExpectedAudio } from "./audio-contract.js";
const controller = new AbortController();
const cancel = makeCancelSignal();
controller.signal.addEventListener("abort", () => cancel.cancel(), { once: true });
let started = false;
async function run(
  raw: unknown,
  work: string,
  rawAssets: unknown,
  engine: "remotion" | "ffmpeg" | "media-edit",
) {
  const config = loadRendererProcessConfig();
  const bundle = path.join(__dirname, "../bundle");
  const catalog = JSON.parse(await readFile(path.join(bundle, "catalog.json"), "utf8")) as {
    renderVersion: string;
  };
  if (engine === "media-edit") {
    const input = parseMediaEdit(raw);
    if (input.renderVersion !== catalog.renderVersion) throw new Error("Render version mismatch.");
    const assets = await verifyStagedAssets(input, rawAssets, work, controller.signal);
    const output = await executeMediaEdit(input, assets, work, controller.signal, (p) =>
      process.send?.({ type: "progress", progress: p }),
    );
    await writeFile(path.join(work, "output.json"), JSON.stringify(output) + "\n", { flag: "wx" });
    return;
  }
  const input = parseRenderInput(raw);
  if (input.renderVersion !== catalog.renderVersion) throw new Error("Render version mismatch.");
  const assets = await verifyStagedAssets(input, rawAssets, work, controller.signal);
  const timing = compositionTiming(input);
  const audioPresent = await stagedExpectedAudio(input, assets, work, controller.signal);
  if (engine === "ffmpeg") {
    if (input.compositionId !== "TimelineV1") throw new Error("FFmpeg requires a timeline.");
    await renderFfmpegCut(input, assets, work, controller.signal, (progress) =>
      process.send?.({ type: "progress", progress }),
    );
    const output = await validateOutput(
      path.join(work, "output.mp4"),
      input,
      controller.signal,
      audioPresent,
    );
    await writeFile(path.join(work, "output.json"), JSON.stringify({ ...output, engine }) + "\n", {
      flag: "wx",
    });
    return;
  }
  const server = await startBundleServer(bundle, work, assets);
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
    controller.signal.throwIfAborted();
    browser = await openBrowser("chrome", {
      browserExecutable: config.browserExecutable,
      chromiumOptions: { enableMultiProcessOnLinux: true },
      logLevel: "error",
    });
    controller.signal.throwIfAborted();
    const plan = input.compositionId === "TimelineV1" ? mapTimeline(input) : undefined;
    const componentBoundaries = [
      ...(plan ? captionFrameBoundaries(plan) : []),
      ...(plan?.clips
        .filter((m) => m.clip.kind === "caption" || m.clip.kind === "graphics")
        .flatMap((m) => [m.from, m.from + m.durationInFrames + m.holdFrames])
        .filter((n) => n > 0 && n < timing.durationInFrames) ?? []),
    ];
    const props = {
      ...(input.compositionId === "FixtureV1" ? input.props : { ...input.props, plan, assets }),
      width: timing.width,
      height: timing.height,
      fps: timing.frameRate.numerator / timing.frameRate.denominator,
      durationInFrames: timing.durationInFrames,
    };
    const composition = await selectComposition({
      serveUrl: server.serveUrl,
      id: input.compositionId,
      inputProps: props,
      puppeteerInstance: browser,
    });
    await renderMedia({
      composition,
      serveUrl: server.serveUrl,
      inputProps: props,
      puppeteerInstance: browser,
      outputLocation: path.join(work, "output.mp4"),
      codec: "h264",
      pixelFormat: "yuv420p",
      crf: 23,
      x264Preset: "veryfast",
      ffmpegOverride: ({ args }) => exactEncoderTiming(args, timing.frameRate, componentBoundaries),
      offthreadVideoThreads: 2,
      offthreadVideoCacheSizeInBytes: 134217728,
      mediaCacheSizeInBytes: 134217728,
      concurrency: config.concurrency,
      timeoutInMilliseconds: 30000,
      cancelSignal: cancel.cancelSignal,
      logLevel: "error",
      onProgress: (p) => {
        process.send?.({
          type: "progress",
          progress: {
            renderedFrames: p.renderedFrames,
            encodedFrames: p.encodedFrames,
            totalFrames: timing.durationInFrames,
          },
        });
      },
    });
    controller.signal.throwIfAborted();
    const output = await validateOutput(
      path.join(work, "output.mp4"),
      input,
      controller.signal,
      audioPresent,
    );
    await writeFile(path.join(work, "output.json"), JSON.stringify(output) + "\n", { flag: "wx" });
  } finally {
    if (browser) await browser.close({ silent: true });
    await server.close();
  }
}
process.on("message", (m: unknown) => {
  if (!m || typeof m !== "object" || !("type" in m)) return;
  const v = m as {
    type: string;
    input: unknown;
    work: string;
    assets: VerifiedAsset[];
    engine?: "remotion" | "ffmpeg" | "media-edit";
  };
  if (v.type === "abort") {
    controller.abort();
    return;
  }
  if (v.type !== "start" || started) return;
  started = true;
  if (
    v.engine !== undefined &&
    v.engine !== "remotion" &&
    v.engine !== "ffmpeg" &&
    v.engine !== "media-edit"
  ) {
    send("failed");
    return;
  }
  void run(v.input, v.work, v.assets, v.engine ?? "remotion").then(
    () => send("completed"),
    (error: unknown) => send("failed", error),
  );
});
function send(type: string, error?: unknown) {
  // Bounded diagnostics stay on the private IPC channel; durable job errors remain generic.
  const detail =
    error instanceof Error
      ? error.message.slice(0, 512).replace(/https?:\/\/\S+|\/[^\s]+/g, "[resource]")
      : undefined;
  if (process.send)
    process.send(
      { type, detail, code: error instanceof MediaEditInputError ? "invalid_input" : undefined },
      () => process.exit(0),
    );
  else process.exit(1);
}
process.once("disconnect", () => controller.abort());
