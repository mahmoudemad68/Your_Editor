import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { benchmarkRoot, loadSpec } from "./load-spec.mjs";
import { startSampler } from "./resources.mjs";

const output = process.argv[2];
const caching = process.argv[3] !== "cold";
if (output === undefined) {
  process.stderr.write("usage: remotion-render.mjs <output.mp4> [warm|cold]\n");
  process.exit(1);
}

const spec = loadSpec();
const root = benchmarkRoot();
const source = path.join(root, "fixtures", "source-60s.mp4");
const publicDir = path.join(root, "public");
mkdirSync(publicDir, { recursive: true });
mkdirSync(path.dirname(output), { recursive: true });
copyFileSync(source, path.join(publicDir, "source-60s.mp4"));
if (!caching) {
  rmSync(path.join(root, "node_modules", ".cache"), { recursive: true, force: true });
}

const sampler = startSampler(process.pid);
const started = process.hrtime.bigint();
const bundleStarted = process.hrtime.bigint();
const serveUrl = await bundle({
  entryPoint: path.join(root, "src", "index.ts"),
  publicDir,
  enableCaching: caching,
});
const bundleSeconds = Number(process.hrtime.bigint() - bundleStarted) / 1e9;
const composition = await selectComposition({ serveUrl, id: "Spike60" });
const renderStarted = process.hrtime.bigint();
let firstFrameSeconds = null;
await renderMedia({
  composition,
  serveUrl,
  codec: "h264",
  outputLocation: output,
  crf: spec.crf,
  pixelFormat: spec.pixelFormat,
  x264Preset: spec.x264Preset,
  audioCodec: spec.audioCodec,
  audioBitrate: spec.audioBitrate,
  concurrency: spec.remotionConcurrency,
  chromiumOptions: { enableMultiProcessOnLinux: true },
  onProgress: (progress) => {
    if (firstFrameSeconds === null && progress.renderedFrames > 0) {
      firstFrameSeconds = Number(process.hrtime.bigint() - renderStarted) / 1e9;
    }
  },
});
const renderSeconds = Number(process.hrtime.bigint() - renderStarted) / 1e9;
const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
const resources = sampler.stop();
const browserInfo = await ensureBrowser({ logLevel: "error" });
const browserExecutable =
  typeof browserInfo === "string"
    ? browserInfo
    : (browserInfo?.executablePath ?? browserInfo?.path ?? null);
writeFileSync(
  `${output}.metrics.json`,
  `${JSON.stringify({
    wallSeconds,
    bundleSeconds,
    renderSeconds,
    firstFrameSeconds,
    startupSeconds: bundleSeconds + (firstFrameSeconds ?? 0),
    browserExecutable,
    ...resources,
  })}\n`,
);
