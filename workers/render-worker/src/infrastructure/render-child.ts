import { loadRendererProcessConfig } from "./config.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openBrowser, selectComposition, renderMedia, makeCancelSignal } from "@remotion/renderer";
import { parseRenderInput } from "./contract.js";
import { startBundleServer } from "./local-bundle-server.js";
import { validateOutput } from "./probe-output.js";
import { compositionTiming, mapTimeline } from "../application/timeline-mapping.js";
import type { VerifiedAsset } from "../application/ports.js";
import { verifyStagedAssets } from "./verified-assets.js";
import { exactEncoderTiming } from "./encoder-timing.js";
const controller = new AbortController();
const cancel = makeCancelSignal();
controller.signal.addEventListener("abort", () => cancel.cancel(), { once: true });
let started = false;
async function run(raw: unknown, work: string, rawAssets: unknown) {
  const config = loadRendererProcessConfig();
  const input = parseRenderInput(raw);
  const bundle = path.join(__dirname, "../bundle");
  const catalog = JSON.parse(await readFile(path.join(bundle, "catalog.json"), "utf8")) as {
    renderVersion: string;
  };
  if (input.renderVersion !== catalog.renderVersion) throw new Error("Render version mismatch.");
  const assets = await verifyStagedAssets(input, rawAssets, work, controller.signal);
  const timing = compositionTiming(input);
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
    const props = {
      ...(input.compositionId === "FixtureV1"
        ? input.props
        : { ...input.props, plan: mapTimeline(input), assets }),
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
      ffmpegOverride: ({ args }) => exactEncoderTiming(args, timing.frameRate),
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
    const output = await validateOutput(path.join(work, "output.mp4"), input, controller.signal);
    await writeFile(path.join(work, "output.json"), JSON.stringify(output) + "\n", { flag: "wx" });
  } finally {
    if (browser) await browser.close({ silent: true });
    await server.close();
  }
}
process.on("message", (m: unknown) => {
  if (!m || typeof m !== "object" || !("type" in m)) return;
  const v = m as { type: string; input: unknown; work: string; assets: VerifiedAsset[] };
  if (v.type === "abort") {
    controller.abort();
    return;
  }
  if (v.type !== "start" || started) return;
  started = true;
  void run(v.input, v.work, v.assets).then(
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
  if (process.send) process.send({ type, detail }, () => process.exit(0));
  else process.exit(1);
}
process.once("disconnect", () => controller.abort());
