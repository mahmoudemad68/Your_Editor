/** Measure actual decoded MP4 paint at native word boundaries, not JSON alone. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
export async function captionBoundaryProof(root, directory, privateDir, exported, plan) {
  const progress = (phase, measurements = {}) =>
    writeFile(
      path.join(directory, "boundary-proof.json"),
      JSON.stringify({ status: "RUNNING", phase, ...measurements }) + "\n",
    );
  await progress("load-native-reference-renderer");
  const require = createRequire(path.join(root, "workers/render-worker/package.json"));
  const { openBrowser, selectComposition, renderStill } = require("@remotion/renderer");
  const { startBundleServer } = require("./dist/infrastructure/local-bundle-server.js");
  const server = await startBundleServer(
    path.join(root, "workers/render-worker/dist/bundle"),
    privateDir,
    [],
  );
  const browser = await openBrowser("chrome", {
    browserExecutable: process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? "/opt/google/chrome/chrome",
    logLevel: "error",
  });
  const all = plan.captionsV1.flatMap((c) =>
    c.lines.flat().map((w, i, a) => ({ caption: c, word: w, index: i, count: a.length })),
  );
  const selected = [
    all.find(
      (x) =>
        x.index > 0 &&
        x.index < x.count - 1 &&
        BigInt(x.word.startUs) < 8000000n &&
        BigInt(x.word.endUs) - BigInt(x.word.startUs) >= 120000n,
    ),
    all.find(
      (x) =>
        x.index > 0 &&
        x.index < x.count - 1 &&
        BigInt(x.word.startUs) >= 8000000n &&
        BigInt(x.word.endUs) - BigInt(x.word.startUs) >= 120000n,
    ),
  ];
  await progress("select-native-boundary-words", {
    englishCandidate: Boolean(selected[0]),
    arabicCandidate: Boolean(selected[1]),
  });
  assert.ok(selected.every(Boolean), "Missing a measurable interior word in either source portion");
  const pixels = (file) =>
    execFileSync(
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
      { maxBuffer: 360 * 640 * 3 + 1024, timeout: 10000 },
    );
  const yellow = (b, i) => b[i * 3] > 180 && b[i * 3 + 1] > 180 && b[i * 3 + 2] < 100;
  const rows = [];
  try {
    for (let part = 0; part < selected.length; part++) {
      const { caption, word, index } = selected[part];
      // Independent integer ceiling for this exact 25fps output clock.
      const first = Number((BigInt(word.startUs) + 39999n) / 40000n),
        end = Number((BigInt(word.endUs) + 39999n) / 40000n);
      const props = {
        width: 360,
        height: 640,
        fps: 25,
        durationInFrames: 400,
        assets: [],
        components: [],
        background: "#000000",
        captionStyle: { color: "#ffffff", background: "#000000", fontSize: 28, direction: "auto" },
        plan: { clips: [], timing: plan.timing, captionsV1: [caption] },
      };
      const composition = await selectComposition({
        serveUrl: server.serveUrl,
        id: "TimelineV1",
        inputProps: props,
        puppeteerInstance: browser,
      });
      await progress("render-native-word-reference", { sourcePart: part, frame: first });
      const reference = path.join(privateDir, `range-reference-${part}.png`);
      await renderStill({
        serveUrl: server.serveUrl,
        composition,
        inputProps: props,
        frame: first,
        output: reference,
        imageFormat: "png",
        puppeteerInstance: browser,
        logLevel: "error",
      });
      const expected = pixels(reference),
        mask = [];
      for (let i = 0; i < 360 * 640; i++) if (yellow(expected, i)) mask.push(i);
      await progress("validate-native-reference-mask", {
        sourcePart: part,
        frame: first,
        referenceMaskPixels: mask.length,
      });
      assert.ok(mask.length > 4, "Native active-word reference has no visible pixels");
      const measurements = [];
      for (const frame of [first - 1, first, first + 1, end - 1, end]) {
        const file = path.join(directory, `boundary-${part}-${frame}.png`);
        execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-y",
            "-i",
            exported,
            "-vf",
            `select=eq(n\\,${frame})`,
            "-frames:v",
            "1",
            file,
          ],
          { timeout: 10000, maxBuffer: 1048576 },
        );
        const actual = pixels(file),
          fraction = mask.filter((i) => yellow(actual, i)).length / mask.length;
        const active =
          BigInt(frame) * 40000n >= BigInt(word.startUs) &&
          BigInt(frame) * 40000n < BigInt(word.endUs);
        await writeFile(
          path.join(directory, "boundary-proof.json"),
          JSON.stringify({
            status: "RUNNING",
            sourcePart: part,
            frame,
            expectedActive: active,
            targetYellowFraction: fraction,
            referenceMaskPixels: mask.length,
          }) + "\n",
        );
        if (active)
          assert.ok(
            fraction >= 0.7,
            "Decoded MP4 did not highlight the expected native word frame",
          );
        else
          assert.ok(
            fraction <= 0.2,
            "Decoded MP4 retained highlight outside the native word interval",
          );
        measurements.push({
          frame,
          expectedActive: active,
          measuredActive: fraction >= 0.7,
          targetYellowFraction: fraction,
          file: path.basename(file),
          sha256: createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        });
      }
      const observedStart = measurements.find((m) => m.measuredActive).frame;
      const observedEnd = measurements.find((m) => m.frame >= end && !m.measuredActive).frame;
      assert.equal(observedStart - first, 0);
      assert.equal(observedEnd - end, 0);
      rows.push({
        sourcePart: part === 0 ? "licensed-en" : "licensed-ar",
        wordIndex: index,
        nativeStartUs: word.startUs,
        nativeEndUs: word.endUs,
        referenceMaskPixels: mask.length,
        firstFrame: first,
        endFrame: end,
        measuredOnsetErrorFrames: observedStart - first,
        measuredEndErrorFrames: observedEnd - end,
        measurements,
      });
    }
    await writeFile(
      path.join(directory, "boundary-proof.json"),
      JSON.stringify({ status: "PASS", rows }, null, 2) + "\n",
    );
    return rows;
  } finally {
    await browser.close({ silent: true });
    await server.close();
  }
}
