/** Actual Remotion still frames. Synthetic timing is labelled, never ASR accuracy evidence. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { captionPortalRegression } from "./caption-portal-regression.mjs";

export async function captionVisualProof(root, directory, privateDir) {
  const require = createRequire(path.join(root, "workers/render-worker/package.json"));
  const { openBrowser, selectComposition, renderStill } = require("@remotion/renderer");
  const domain = require("@editagent/domain");
  const { startBundleServer } = require("./dist/infrastructure/local-bundle-server.js");
  await mkdir(directory, { recursive: true });
  const server = await startBundleServer(
    path.join(root, "workers/render-worker/dist/bundle"),
    directory,
    [],
  );
  const browser = await openBrowser("chrome", {
    browserExecutable: process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? "/opt/google/chrome/chrome",
    chromiumOptions: { enableMultiProcessOnLinux: true },
    logLevel: "error",
  });
  const rows = [];
  const webRequire = createRequire(path.join(root, "apps/web/package.json"));
  let referenceBrowser;
  const referenceCache = new Map();
  let portalRegression;
  try {
    await mkdir(privateDir, { recursive: true });
    referenceBrowser = await webRequire("@playwright/test").chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? "/opt/google/chrome/chrome",
      // Match Remotion's raster profile, while keeping the DOM reference and
      // expected word indices independent of the production component.
      args: ["--no-sandbox", "--font-render-hinting=none", "--force-color-profile=srgb"],
    });
    portalRegression = await captionPortalRegression(referenceBrowser, server.serveUrl);
    const referenceContext = await referenceBrowser.newContext({
      offline: true,
      deviceScaleFactor: 1,
    });
    async function nativeReference(width, height, preset, zone, active) {
      const key = `${preset}-${active}`;
      if (referenceCache.has(key)) return referenceCache.get(key);
      const page = await referenceContext.newPage();
      try {
        await page.setViewportSize({ width, height });
        await page.setContent(
          '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#000}::highlight(reference-word){color:#ffff00}</style><div id="zone"><div id="text" dir="auto"></div></div>',
        );
        // Independent, fixed continuous-text browser reference. No React caption
        // component, production time mapper, word spans or remote resources.
        await page.evaluate(
          ({ zone, active }) => {
            const { document, CSS, Highlight } = globalThis;
            const outer = document.getElementById("zone"),
              text = document.getElementById("text");
            Object.assign(outer.style, {
              position: "absolute",
              left: `${zone.x}px`,
              top: `${zone.y}px`,
              width: `${zone.width}px`,
              height: `${zone.height}px`,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
            });
            Object.assign(text.style, {
              whiteSpace: "pre",
              fontFamily: '"DejaVu Sans", "Noto Color Emoji", sans-serif',
              fontSize: "28px",
              lineHeight: "1.5",
              textAlign: "center",
              unicodeBidi: "plaintext",
              color: "#ffffff",
              backgroundColor: "#000000",
              padding: "8px",
              webkitTextStroke: "0px #000000",
              textShadow: "0px 0px 0px #000000",
            });
            const words = ["السَّلَامُ", "عَلَيْكُمْ", "Hello <b>", "2026 👋"],
              ordinary = document.createTextNode("السَّلَامُ عَلَيْكُمْ\nHello <b> 2026 "),
              emoji = document.createElement("span");
            emoji.style.fontFamily = "Noto Color Emoji";
            emoji.textContent = "👋";
            text.append(ordinary, emoji);
            if (active >= 0) {
              const a = text.textContent.indexOf(words[active]),
                b = a + words[active].length,
                range = document.createRange();
              range.setStart(ordinary, a);
              if (b <= ordinary.length) range.setEnd(ordinary, b);
              else range.setEnd(emoji.firstChild, b - ordinary.length);
              CSS.highlights.set("reference-word", new Highlight(range));
            }
          },
          { zone, active },
        );
        const file = path.join(privateDir, `native-reference-${preset}-${active}.png`);
        await page.screenshot({ path: file, omitBackground: true });
        const pixels = execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            file,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { maxBuffer: width * height * 3 + 1024, timeout: 10000 },
        );
        referenceCache.set(key, pixels);
        return pixels;
      } finally {
        await page.close();
      }
    }
    for (const [width, height, preset] of [
      [720, 1280, "vertical"],
      [720, 720, "square"],
      [1280, 720, "landscape"],
    ]) {
      for (const [numerator, denominator] of [
        [25, 1],
        [30, 1],
        [30000, 1001],
      ]) {
        const rate = { numerator: BigInt(numerator), denominator: BigInt(denominator) },
          frame = BigInt(numerator === 25 ? 25 : 30);
        const word = (text, a, b) => ({
          text,
          startUs: String(domain.frameTime(a, rate)),
          endUs: String(domain.frameTime(b, rate)),
          confidence: null,
        });
        const style = {
          ...domain.DEFAULT_CAPTION_STYLE,
          fontSize: 28,
          preset,
          direction: "auto",
          shadowPx: 0,
        };
        const caption = {
          captionId: "018fe277-6ec0-7000-8000-000000000001",
          sourceClipId: "018fe277-6ec0-7000-8000-000000000002",
          startUs: "0",
          endUs: "4000000",
          style,
          lines: [
            [word("السَّلَامُ", frame, frame + 3n), word("عَلَيْكُمْ", frame + 6n, frame + 9n)],
            [
              word("Hello <b>", frame + 12n, frame + 15n),
              word("2026 👋", frame + 18n, frame + 21n),
            ],
          ],
        };
        const durationInFrames = Math.ceil((4 * numerator) / denominator),
          timing = { width, height, frameRate: { numerator, denominator }, durationInFrames };
        const props = {
          width,
          height,
          fps: numerator / denominator,
          durationInFrames,
          plan: { clips: [], timing, captionsV1: [caption] },
          assets: [],
          components: [],
          background: "#000000",
          captionStyle: {
            color: "#ffffff",
            background: "#000000",
            fontSize: 28,
            direction: "auto",
          },
        };
        const composition = await selectComposition({
          serveUrl: server.serveUrl,
          id: "TimelineV1",
          inputProps: props,
          puppeteerInstance: browser,
        });
        const zone = domain.safeCaptionZone(width, height, style),
          measurements = [];
        let baseRed = null,
          baseYellow = null;
        for (const delta of [-1, 0, 1, 3, 6, 9, 12, 15, 18, 21]) {
          const f = Number(frame) + delta,
            name = `${preset}-${numerator}-${denominator}-${f}.png`,
            output = path.join(directory, name);
          await writeFile(
            path.join(directory, "visual-report.json"),
            JSON.stringify({
              status: "RUNNING",
              phase: "render-still",
              preset,
              width,
              height,
              numerator,
              denominator,
              frame: f,
            }) + "\n",
          );
          await renderStill({
            serveUrl: server.serveUrl,
            composition,
            inputProps: props,
            frame: f,
            output,
            imageFormat: "png",
            puppeteerInstance: browser,
            logLevel: "error",
          });
          const pixels = execFileSync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-i",
              output,
              "-frames:v",
              "1",
              "-f",
              "rawvideo",
              "-pix_fmt",
              "rgb24",
              "pipe:1",
            ],
            { maxBuffer: width * height * 3 + 1024, timeout: 10000 },
          );
          assert.equal(pixels.length, width * height * 3);
          const red = Buffer.alloc(width * height);
          let yellow = 0,
            visible = 0;
          for (let i = 0; i < red.length; i++) {
            const r = pixels[i * 3],
              g = pixels[i * 3 + 1],
              b = pixels[i * 3 + 2],
              x = i % width,
              y = Math.floor(i / width);
            red[i] = r;
            if (Math.max(r, g, b) > 32) {
              visible++;
              assert.ok(
                x >= zone.x && x < zone.x + zone.width && y >= zone.y && y < zone.y + zone.height,
                "Caption pixels escaped safe zone",
              );
            }
            if (r > 180 && g > 180 && b < 70) yellow++;
          }
          assert.ok(visible > 100);
          const redHash = createHash("sha256").update(red).digest("hex");
          await writeFile(
            path.join(directory, "visual-report.json"),
            JSON.stringify({
              status: "RUNNING",
              phase: "check-timing-and-geometry",
              preset,
              width,
              height,
              numerator,
              denominator,
              frame: f,
              yellowPixels: yellow,
              baselineYellowPixels: baseYellow,
              geometryStable: baseRed === null || baseRed === redHash,
            }) + "\n",
          );
          if (baseRed === null) {
            baseRed = redHash;
            baseYellow = yellow;
          } else assert.equal(redHash, baseRed, "Highlight changed glyph geometry/shaping");
          const expected = new Map([
            [-1, -1],
            [0, 0],
            [1, 0],
            [3, -1],
            [6, 1],
            [9, -1],
            [12, 2],
            [15, -1],
            [18, 3],
            [21, -1],
          ]).get(delta);
          if (expected < 0) assert.equal(yellow, baseYellow);
          else assert.ok(yellow > baseYellow + 20, "Active word has no native range paint");
          const reference = await nativeReference(width, height, preset, zone, expected);
          let glyphUnion = 0,
            glyphIntersection = 0,
            highlightUnion = 0,
            highlightIntersection = 0;
          for (let i = 0; i < width * height; i++) {
            const a = pixels[i * 3] > 180,
              b = reference[i * 3] > 180;
            glyphUnion += Number(a || b);
            glyphIntersection += Number(a && b);
            const x = pixels[i * 3] > 180 && pixels[i * 3 + 1] > 180 && pixels[i * 3 + 2] < 70,
              y = reference[i * 3] > 180 && reference[i * 3 + 1] > 180 && reference[i * 3 + 2] < 70;
            highlightUnion += Number(x || y);
            highlightIntersection += Number(x && y);
          }
          const glyphIou = glyphIntersection / Math.max(1, glyphUnion),
            highlightIou = highlightIntersection / Math.max(1, highlightUnion);
          await writeFile(
            path.join(directory, "visual-report.json"),
            JSON.stringify({
              status: "RUNNING",
              phase: "compare-native-reference",
              preset,
              width,
              height,
              numerator,
              denominator,
              frame: f,
              expectedActiveWord: expected,
              glyphIou,
              highlightIou,
            }) + "\n",
          );
          assert.ok(
            glyphIou >= 0.98,
            "Caption glyphs differ from continuous native browser shaping",
          );
          assert.ok(
            highlightIou >= 0.95,
            "Wrong word painted against independent native Range reference",
          );
          measurements.push({
            frame: f,
            activeWord: expected,
            yellowPixels: yellow,
            safeZoneContained: true,
            independentNativeGlyphIou: glyphIou,
            independentNativeHighlightIou: highlightIou,
            geometrySha256: redHash,
            pngSha256: createHash("sha256")
              .update(await readFile(output))
              .digest("hex"),
            file: name,
          });
        }
        rows.push({
          width,
          height,
          preset,
          frameRate: { numerator, denominator },
          syntheticTiming: true,
          continuousShapedText: true,
          safeZone: zone,
          measurements,
        });
      }
    }
    await writeFile(
      path.join(directory, "visual-report.json"),
      JSON.stringify(
        {
          status: "PASS",
          evidence:
            "synthetic component timing; actual Remotion/browser pixels; not speech annotation accuracy",
          profiles: rows,
          portalRegression,
        },
        null,
        2,
      ) + "\n",
    );
    return rows;
  } finally {
    await referenceBrowser?.close();
    await browser.close({ silent: true });
    await server.close();
  }
}
