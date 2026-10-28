/** Independent Remotion stills, H.264 decode, shaping, and safe-zone measurements. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { check, results, writeReport } from "./report.mjs";

const app = process.env.QA_APP_ROOT;
const outDir = process.env.QA_VISUAL_DIR ?? path.join(process.cwd(), "qa-out", "visual");
mkdirSync(outDir, { recursive: true });
const require = createRequire(path.join(app, "workers/render-worker/package.json"));
const { bundle } = require("@remotion/bundler");
const { openBrowser, selectComposition, renderStill, renderMedia } = require("@remotion/renderer");
const rows = results();
const width = 640;
const height = 360;
const chrome = process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome";

function zone(w, h) {
  const left = 60,
    right = 60,
    top = 80,
    bottom = 140,
    margin = 0;
  return {
    x: Math.ceil((w * (left + margin)) / 1000),
    y: Math.ceil((h * (top + margin)) / 1000),
    width: Math.floor((w * (1000 - left - right - 2 * margin)) / 1000),
    height: Math.floor((h * (1000 - top - bottom - 2 * margin)) / 1000),
  };
}
function classify(rgb, w, h, box) {
  let highlight = 0,
    pale = 0,
    ink = 0;
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = box.y; y < box.y + box.height; y += 2) {
    for (let x = box.x; x < box.x + box.width; x += 2) {
      const i = (y * w + x) * 3;
      const r = rgb[i],
        g = rgb[i + 1],
        b = rgb[i + 2];
      const bright = Math.max(r, g, b) > 32;
      if (r > 170 && g > 170 && b < 110 && r - b > 70 && g - b > 70) highlight += 1;
      else if (r > 190 && g > 190 && b > 190) pale += 1;
      if (bright) {
        ink += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    highlight,
    pale,
    ink,
    bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}
function pngRgb(file) {
  return execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: width * height * 3 + 1024 },
  );
}
function contained(bounds, box) {
  return (
    bounds &&
    bounds.x >= box.x &&
    bounds.y >= box.y &&
    bounds.x + bounds.width <= box.x + box.width + 2 &&
    bounds.y + bounds.height <= box.y + box.height + 2
  );
}

const style = {
  color: "#ffffff",
  background: "#000000",
  highlight: "#ffff00",
  outline: "#000000",
  outlinePx: 0,
  shadowPx: 0,
  font: "DejaVu Sans",
  fontSize: 64,
  direction: "auto",
  preset: "landscape",
  marginPermille: 0,
};
function caption(lines) {
  return {
    captionId: "018fe277-6ec0-7000-8000-000000000021",
    sourceClipId: "018fe277-6ec0-7000-8000-000000000022",
    startUs: "0",
    endUs: "400000",
    style,
    lines,
  };
}
const hello = caption([
  [
    { text: "HELLO", startUs: "80000", endUs: "160000", confidence: 1 },
    { text: "السَّلَامُ", startUs: "200000", endUs: "280000", confidence: null },
  ],
]);
function propsFor(lines, frames = 10) {
  return {
    width,
    height,
    fps: 25,
    durationInFrames: frames,
    plan: {
      clips: [],
      timing: {
        width,
        height,
        frameRate: { numerator: 25, denominator: 1 },
        durationInFrames: frames,
      },
      captionsV1: [caption(lines)],
    },
    assets: [],
    components: [],
    background: "#000000",
    captionStyle: { color: "#ffffff", background: "#000000", fontSize: 64, direction: "auto" },
  };
}

let browser;
let serveUrl;
const rendered = [];
try {
  const bundleDir = path.join(outDir, "bundle");
  serveUrl = await bundle({
    entryPoint: path.join(app, "workers/render-worker/src/composition/index.tsx"),
    outDir: bundleDir,
    enableCaching: false,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: { ...config.resolve?.extensionAlias, ".js": [".js", ".ts", ".tsx"] },
      },
    }),
  });
  browser = await openBrowser("chrome", {
    browserExecutable: chrome,
    chromiumOptions: { enableMultiProcessOnLinux: true },
    logLevel: "error",
  });
  const inputProps = propsFor(hello.lines);
  const composition = await selectComposition({
    serveUrl,
    id: "TimelineV1",
    inputProps,
    puppeteerInstance: browser,
  });
  for (let frame = 0; frame < 10; frame += 1) {
    const file = path.join(outDir, `native-${frame}.png`);
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      frame,
      output: file,
      imageFormat: "png",
      puppeteerInstance: browser,
      logLevel: "error",
    });
    rendered.push({ frame, ...classify(pngRgb(file), width, height, zone(width, height)) });
  }
} catch (error) {
  rows.push({
    id: "G1-RENDER",
    title: "Remotion native frames render",
    status: "ERROR",
    expected: "10 frames",
    actual: String(error?.stack ?? error).slice(0, 900),
    ms: 0,
  });
}

await check(
  rows,
  "G1-FRAME-SYNC",
  "HELLO highlight onset and end stay within one frame of the independent 25 fps map",
  () => {
    if (rendered.length !== 10) return { status: "ERROR", actual: { frames: rendered.length } };
    const active = rendered
      .filter((row) => row.frame < 5 && row.highlight >= 40)
      .map((row) => row.frame);
    const onsetError = (active[0] ?? 99) - 2;
    const endError = (active.length ? active[active.length - 1] + 1 : 99) - 4;
    const ok = active.length > 0 && Math.abs(onsetError) <= 1 && Math.abs(endError) <= 1;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "HELLO frames 2-3, error <= 1",
      actual: { active, onsetError, endError, highlight: rendered.map((row) => row.highlight) },
    };
  },
);

await check(
  rows,
  "G1-ARABIC-WINDOW",
  "Arabic word is inactive before its source interval and highlighted inside it",
  () => {
    if (rendered.length !== 10) return { status: "ERROR", actual: "no frames" };
    const before = rendered[4];
    const inside = rendered[5];
    const after = rendered[7];
    const ok =
      before.highlight < 40 && inside.highlight >= 40 && after.highlight < 40 && inside.ink > 20;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "frame 5 highlighted, 4 and 7 not",
      actual: {
        before: before.highlight,
        inside: inside.highlight,
        after: after.highlight,
        ink: inside.ink,
      },
    };
  },
);

await check(
  rows,
  "G1-SAFE-PIXELS",
  "Measured glyph ink stays inside the independent landscape safe rectangle",
  () => {
    const box = zone(width, height);
    const offenders = rendered
      .filter((row) => row.ink > 0 && !contained(row.bounds, box))
      .map((row) => row.frame);
    const visible = rendered.some((row) => row.ink > 20);
    return {
      status: visible && offenders.length === 0 ? "PASS" : "FAIL",
      expected: "ink inside safe zone",
      actual: { box, offenders, sample: rendered[2]?.bounds ?? null },
    };
  },
);

await check(
  rows,
  "G1-NEGATIVE-CONTROLS",
  "Missing, persistent, wrong-color, and shifted maps fail the fixed metric",
  () => {
    const box = zone(width, height);
    const blank = Buffer.alloc(width * height * 3);
    const yellow = Buffer.alloc(width * height * 3);
    const red = Buffer.alloc(width * height * 3);
    const white = Buffer.alloc(width * height * 3);
    for (let i = 0; i < yellow.length; i += 3) {
      yellow[i] = 255;
      yellow[i + 1] = 255;
      yellow[i + 2] = 0;
      red[i] = 255;
      red[i + 1] = 0;
      red[i + 2] = 0;
      white[i] = 255;
      white[i + 1] = 255;
      white[i + 2] = 255;
    }
    const active = (rgb) => classify(rgb, width, height, box).highlight >= 40;
    const missing = active(blank);
    const persistent = classify(yellow, width, height, box).highlight >= 40;
    const wrong = active(red);
    const noHighlight = active(white);
    const shifted = [0, 0, 0, 0, 80, 80, 0, 0, 0, 0];
    const shiftOnset = shifted.findIndex((value) => value >= 40);
    const shiftError = Math.abs(shiftOnset - 2);
    const ok =
      missing === false &&
      persistent === true &&
      wrong === false &&
      noHighlight === false &&
      shiftError > 1;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "controls fail the acceptance rule",
      actual: {
        missingRejected: !missing,
        persistentWouldFailInactive: persistent,
        wrongRejected: !wrong,
        noHighlightRejected: !noHighlight,
        shiftError,
      },
    };
  },
);

await check(
  rows,
  "G1-H264",
  "Remotion H.264/yuv420p decode stays within one frame of the native HELLO map",
  async () => {
    if (!browser || !serveUrl) return { status: "ERROR", actual: "renderer unavailable" };
    const inputProps = propsFor(hello.lines);
    const composition = await selectComposition({
      serveUrl,
      id: "TimelineV1",
      inputProps,
      puppeteerInstance: browser,
    });
    const mp4 = path.join(outDir, "caption-sync.mp4");
    await renderMedia({
      composition,
      serveUrl,
      inputProps,
      puppeteerInstance: browser,
      outputLocation: mp4,
      codec: "h264",
      pixelFormat: "yuv420p",
      crf: 23,
      x264Preset: "veryfast",
      concurrency: 1,
      timeoutInMilliseconds: 60000,
      logLevel: "error",
    });
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-count_frames",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=codec_name,pix_fmt,nb_read_frames,avg_frame_rate,width,height",
          "-of",
          "json",
          mp4,
        ],
        { encoding: "utf8" },
      ),
    );
    const stream = probe.streams[0];
    const raw = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", mp4, "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      { maxBuffer: width * height * 3 * 12 },
    );
    const frameBytes = width * height * 3;
    const count = Math.floor(raw.length / frameBytes);
    const decoded = [];
    for (let frame = 0; frame < count; frame += 1)
      decoded.push(
        classify(
          raw.subarray(frame * frameBytes, (frame + 1) * frameBytes),
          width,
          height,
          zone(width, height),
        ).highlight,
      );
    const active = decoded
      .map((value, frame) => (frame < 5 && value >= 40 ? frame : -1))
      .filter((frame) => frame >= 0);
    const onsetError = (active[0] ?? 99) - 2;
    const endError = (active.length ? active[active.length - 1] + 1 : 99) - 4;
    const pix = stream.pix_fmt;
    const ok =
      stream.codec_name === "h264" &&
      (pix === "yuv420p" || pix === "yuvj420p") &&
      Number(stream.width) === width &&
      Math.abs(onsetError) <= 1 &&
      Math.abs(endError) <= 1;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "h264 yuv420p, onset/end error <= 1",
      actual: {
        stream,
        frames: count,
        highlight: decoded,
        onsetError,
        endError,
        sha256: execFileSync("sha256sum", [mp4], { encoding: "utf8" }).slice(0, 64),
      },
    };
  },
);

await check(
  rows,
  "G1-SHAPING",
  "Joined Arabic is narrower than split letters, and the product ink follows the joined width",
  async () => {
    const html = path.join(outDir, "shaping.html");
    const phrase = "السَّلَامُ";
    const letters = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(phrase)].map(
      (item) => item.segment,
    );
    writeFileSync(
      html,
      `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#000;color:#fff;font-family:"DejaVu Sans";font-size:64px}#split span{display:inline-block}</style><div id="joined">${phrase}</div><div id="split">${letters.map((letter) => `<span>${letter}</span>`).join("")}</div><div id="plain">ب</div><div id="mark">بَّ</div><div id="literal">Hello &lt;b&gt;</div><div id="plainHello">Hello</div>`,
    );
    const { chromium } = createRequire(path.join(app, "apps/web/package.json"))("@playwright/test");
    const pageBrowser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
    try {
      const page = await pageBrowser.newPage({ viewport: { width: 900, height: 400 } });
      await page.goto("file://" + html);
      const sizes = await page.evaluate((phrase) => {
        const letters = [
          ...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(phrase),
        ].map((item) => item.segment);
        const ink = (text) => {
          const canvas = document.createElement("canvas");
          canvas.width = 900;
          canvas.height = 220;
          const context = canvas.getContext("2d");
          context.font = '64px "DejaVu Sans", sans-serif';
          context.fillStyle = "#fff";
          context.fillText(text, 8, 150);
          const data = context.getImageData(0, 0, 900, 220).data;
          let minX = 900,
            minY = 220,
            maxX = -1,
            maxY = -1,
            count = 0;
          for (let y = 0; y < 220; y += 1)
            for (let x = 0; x < 900; x += 1) {
              if (data[(y * 900 + x) * 4 + 3] > 16) {
                count += 1;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
              }
            }
          return {
            count,
            width: maxX < 0 ? 0 : maxX - minX + 1,
            height: maxY < 0 ? 0 : maxY - minY + 1,
          };
        };
        const joined = ink(`HELLO ${phrase}`);
        const broken = ink(`HELLO ${letters.join(" ")}`);
        return {
          joined,
          brokenWidth: broken.width,
          plain: ink("ب"),
          mark: ink("بَّ"),
          literal: ink("Hello <b>"),
          plainHello: ink("Hello"),
        };
      }, phrase);
      const productWidth = rendered[5]?.bounds?.width ?? 0;
      const closerToJoined =
        Math.abs(productWidth - sizes.joined.width) + 8 <
        Math.abs(productWidth - sizes.brokenWidth);
      const source =
        readFileSync(
          path.join(app, "workers/render-worker/src/composition/word-captions.tsx"),
          "utf8",
        ) +
        readFileSync(
          path.join(app, "workers/render-worker/src/composition/unicode-text.tsx"),
          "utf8",
        );
      const noHtml = !source.includes(".innerHTML") && !source.includes("dangerouslySetInnerHTML");
      const ok =
        sizes.joined.width < sizes.brokenWidth * 0.9 &&
        Math.abs(productWidth - sizes.joined.width) <= 16 &&
        closerToJoined &&
        sizes.mark.height > sizes.plain.height &&
        sizes.literal.width > sizes.plainHello.width + 8 &&
        noHtml &&
        productWidth > 10;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "joined narrower, product follows it, diacritics and literal markup stay visible",
        actual: { sizes, productWidth, closerToJoined, noHtml },
      };
    } finally {
      await pageBrowser.close();
    }
  },
);

await check(
  rows,
  "G1-STATIC-CAPTION",
  "Legacy static caption text still paints without word-highlight chroma",
  async () => {
    if (!browser || !serveUrl) return { status: "ERROR", actual: "renderer unavailable" };
    const inputProps = {
      width,
      height,
      fps: 25,
      durationInFrames: 2,
      plan: {
        clips: [
          {
            clip: { id: "018fe277-6ec0-7000-8000-000000000031", kind: "caption", text: "STATIC" },
            from: 0,
            durationInFrames: 2,
            sourceOffsetFrames: 0,
            opacity: 1,
            volume: 0,
            fadeInFrames: 0,
            holdFrames: 0,
            layer: 0,
          },
        ],
        timing: {
          width,
          height,
          frameRate: { numerator: 25, denominator: 1 },
          durationInFrames: 2,
        },
      },
      assets: [],
      components: [],
      background: "#000000",
      captionStyle: { color: "#ffffff", background: "#101010", fontSize: 48, direction: "ltr" },
    };
    const composition = await selectComposition({
      serveUrl,
      id: "TimelineV1",
      inputProps,
      puppeteerInstance: browser,
    });
    const file = path.join(outDir, "static-caption.png");
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      frame: 0,
      output: file,
      imageFormat: "png",
      puppeteerInstance: browser,
      logLevel: "error",
    });
    const measured = classify(pngRgb(file), width, height, { x: 0, y: 0, width, height });
    const ok = measured.pale > 30 && measured.highlight < 40;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "white static text and no yellow highlight",
      actual: measured,
    };
  },
);

if (browser) await browser.close({ silent: true }).catch(() => undefined);
const report = process.argv[2] ?? path.join(outDir, "visual.json");
await check(
  rows,
  "G1-MAPPING-CAUSE",
  "Public render errors stay sanitized while the internal mapping stage remains readable on the cause",
  () => {
    const mapping = require("./dist/application/timeline-mapping.js");
    const contract = require("./dist/infrastructure/contract.js");
    const domain = createRequire(path.join(app, "apps/api/package.json"))("@editagent/domain");
    const nid = (n) => `018fe277-6ec0-7000-8000-${String(n).padStart(12, "0")}`;
    const clip = (n, start, end) => ({
      id: nid(n),
      trackId: nid(3),
      kind: "video",
      inPoint: "0",
      outPoint: end,
      timelineStartUs: start,
      sourceId: nid(4),
      text: null,
      componentId: null,
      opacity: 1,
      volumeDb: 0,
      effects: [],
    });
    const input = {
      schemaVersion: 1,
      renderVersion: "a".repeat(64),
      compositionId: "TimelineV1",
      correlationId: "qa93-mapping",
      props: {
        background: "#000000",
        captionStyle: { color: "#ffffff", background: "#000000", fontSize: 24, direction: "auto" },
        components: [],
        timeline: {
          id: nid(1),
          projectId: nid(2),
          createdAt: "0",
          composition: {
            width: 640,
            height: 360,
            frameRate: { numerator: "25", denominator: "1" },
            durationUs: "16000000",
          },
          sources: [{ id: nid(4), kind: "video", durationUs: "16000000" }],
          tracks: [
            {
              id: nid(3),
              timelineId: nid(1),
              kind: "video",
              clips: [
                { ...clip(5, "0", "6000000"), outPoint: "6000000" },
                {
                  ...clip(6, "6000000", "12000000"),
                  inPoint: "6000000",
                  outPoint: "12000000",
                  timelineStartUs: "6000000",
                },
              ],
              transitions: [
                {
                  id: nid(7),
                  fromClipId: nid(5),
                  toClipId: nid(6),
                  kind: "cut",
                  durationUs: "0",
                },
              ],
            },
          ],
          captionsV1: [
            {
              schemaVersion: "1.0.0",
              id: nid(20),
              createdBy: nid(21),
              assetId: nid(4),
              sourceSha256: "b".repeat(64),
              sourceDurationUs: "16000000",
              evidence: { kind: "human-timed", documentSha256: "c".repeat(64), version: "1.0.0" },
              style: { ...domain.DEFAULT_CAPTION_STYLE, fontSize: 14 },
              rules: {
                maxCharacters: 32,
                maxLines: 2,
                maxCharactersPerSecond: 24,
                minDurationUs: "500000",
              },
              blocks: [
                {
                  startUs: "5800000",
                  endUs: "6300000",
                  lines: [
                    [{ text: "crossing", startUs: "5800000", endUs: "6200000", confidence: 0.8 }],
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const kept = contract.parseRenderInput(JSON.parse(JSON.stringify(input)));
    const words = mapping.mapTimeline(kept).captionsV1.flatMap((block) => block.lines.flat());
    const impossible = JSON.parse(JSON.stringify(input));
    impossible.props.timeline.tracks[0].transitions = [];
    impossible.props.timeline.tracks[0].clips = [
      {
        ...clip(5, "0", "200000"),
        inPoint: "11800000",
        outPoint: "12000000",
        timelineStartUs: "0",
      },
    ];
    impossible.props.timeline.captionsV1[0].blocks = [
      {
        startUs: "11800000",
        endUs: "12000000",
        lines: [[{ text: "tail", startUs: "11800000", endUs: "11950000", confidence: null }]],
      },
    ];
    let publicMessage = "";
    let stage = "";
    let reason = "";
    let causeEnumerable = true;
    let leaked = true;
    try {
      contract.parseRenderInput(impossible);
    } catch (error) {
      publicMessage = error?.message ?? "";
      stage = error?.cause?.stage ?? "";
      reason = error?.cause?.cause?.reason ?? "";
      causeEnumerable = Object.keys(error).includes("cause");
      leaked = JSON.stringify(error).includes("tail") || JSON.stringify(error).includes(stage);
    }
    const foreign = JSON.parse(JSON.stringify(input));
    foreign.props.timeline.captionsV1[0].assetId = nid(99);
    let foreignStage = "";
    let foreignPublic = "";
    let foreignLeak = true;
    try {
      contract.parseRenderInput(foreign);
    } catch (error) {
      foreignStage = error?.cause?.stage ?? "";
      foreignPublic = error?.message ?? "";
      foreignLeak = JSON.stringify(error).includes(nid(99));
    }
    const ok =
      words.some((item) => item.text === "crossing" && item.startUs === "5800000") &&
      publicMessage === "Invalid timeline render contract." &&
      stage === "caption_projection" &&
      reason === "min_duration" &&
      causeEnumerable === false &&
      leaked === false &&
      foreignStage === "canonical_timeline" &&
      foreignPublic === "Invalid timeline render contract." &&
      foreignLeak === false;
    return {
      status: ok ? "PASS" : "FAIL",
      expected:
        "sanitized public error, internal caption_projection/min_duration and canonical_timeline",
      actual: {
        kept: words.map((item) => item.text),
        publicMessage,
        stage,
        reason,
        causeEnumerable,
        leaked,
        foreignStage,
        foreignPublic,
        foreignLeak,
      },
    };
  },
);

writeReport(report, rows, { suite: "visual", productSha: process.env.QA_APP_SHA, width, height });
if (rows.some((row) => row.status !== "PASS")) process.exit(1);
