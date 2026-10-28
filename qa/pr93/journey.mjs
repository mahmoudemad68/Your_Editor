/** Fresh browser journey over real API, Small ASR, and the render worker. Transcript text is hashed, not published. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { check, results, writeReport } from "./report.mjs";

const app = process.env.QA_APP_ROOT;
const outDir = process.env.QA_JOURNEY_DIR ?? path.join(process.cwd(), "qa-out", "journey");
mkdirSync(outDir, { recursive: true });
const require = createRequire(path.join(app, "apps/web/package.json"));
const { chromium } = require("@playwright/test");
const { parseMediaAnalysis } = createRequire(path.join(app, "apps/api/package.json"))(
  "@editagent/schemas",
);
const rows = results();
const chrome = process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function ffmpeg(args) {
  execFileSync("ffmpeg", args, { stdio: "inherit" });
}

let sourceFile = "";
let sourceSha = "";
await check(
  rows,
  "G3-SOURCE",
  "Fresh AR-then-EN media is built from the licensed fixture bytes",
  () => {
    const manifest = JSON.parse(
      readFileSync(path.join(app, "tests/fixtures/asr/manifest.json"), "utf8"),
    );
    const files = ["ar.wav", "en.wav"].map((file) => {
      const bytes = readFileSync(path.join(app, "tests/fixtures/asr", file));
      const entry = manifest.fixtures.find((item) => item.file === file);
      return {
        file,
        digest: sha256(bytes),
        expected: entry.sha256,
        license: entry.license.id,
        source: entry.sourceSha256,
      };
    });
    if (files.some((item) => item.digest !== item.expected))
      return {
        status: "FAIL",
        expected: "fixture hashes",
        actual: files.map(({ file, digest, expected }) => ({ file, match: digest === expected })),
      };
    sourceFile = path.join(outDir, "source.mp4");
    ffmpeg([
      "-y",
      "-v",
      "error",
      "-i",
      path.join(app, "tests/fixtures/asr/ar.wav"),
      "-i",
      path.join(app, "tests/fixtures/asr/en.wav"),
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=25:d=16",
      "-filter_complex",
      "[0:a][1:a]concat=n=2:v=0:a=1[a]",
      "-map",
      "2:v",
      "-map",
      "[a]",
      "-t",
      "16",
      "-r",
      "25",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-ar",
      "48000",
      sourceFile,
    ]);
    sourceSha = sha256(readFileSync(sourceFile));
    return {
      status: "PASS",
      expected: "new mux from licensed excerpts",
      actual: {
        sourceSha,
        licenses: files.map(({ file, license, source }) => ({ file, license, source })),
        order: "ar-then-en",
        pixels: "320x180",
      },
    };
  },
);

const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3000" });
  const page = await context.newPage();
  const email = `qa93-${randomUUID()}@example.test`;
  const password = `Qa93-${randomUUID()}!`;
  let projectId = "";
  let assetId = "";
  let analysis = null;

  await check(
    rows,
    "G3-DENIED-AND-MALICIOUS",
    "Outsider navigation and a CSRF-less caption post fail before the successful path",
    async () => {
      await page.goto("http://127.0.0.1:3000/sign-up");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign up", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
      await page.getByRole("button", { name: "Create project", exact: true }).first().click();
      await page.getByLabel("Project name", { exact: true }).fill("QA93 captions");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await page.getByRole("link", { name: "Open project" }).click();
      projectId = new URL(page.url()).pathname.split("/").pop();
      const hostile = await page.request.post(
        `/api/projects/${projectId}/editor/018fe277-6ec0-7000-8000-000000000099/captions`,
        {
          data: {
            style: { color: "url(http://127.0.0.1/x)" },
            assetId: "not-a-uuid",
            sourceSha256: "sh",
            analysisSha256: "sh",
          },
          headers: { "content-type": "application/json" },
        },
      );
      const outsider = await browser.newContext();
      const other = await outsider.newPage();
      const otherEmail = `qa93-out-${randomUUID()}@example.test`;
      await other.goto("http://127.0.0.1:3000/sign-up");
      await other.getByLabel("Email", { exact: true }).fill(otherEmail);
      await other.getByLabel("Password", { exact: true }).fill(password);
      await other.getByRole("button", { name: "Sign up", exact: true }).click();
      await other.getByRole("button", { name: "Sign out", exact: true }).waitFor();
      await other.goto(`http://127.0.0.1:3000/projects/${projectId}`);
      await other
        .getByRole("heading", { name: "Project is not available" })
        .waitFor({ timeout: 20000 });
      const leaked = (await other.locator("body").innerText()).includes("QA93 captions");
      await outsider.close();
      const ok = hostile.status() >= 400 && hostile.status() < 500 && !leaked;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "hostile post rejected and outsider sees no project",
        actual: { hostile: hostile.status(), leaked },
      };
    },
  );

  await check(
    rows,
    "G3-FAILED-JOB",
    "An invalid upload fails inspection before the licensed media succeeds",
    async () => {
      const bad = path.join(outDir, "bad.mp4");
      writeFileSync(bad, Buffer.from("not a media file"));
      await page.locator("#media-file").setInputFiles(bad);
      const region = page.getByRole("region", { name: "Inspection job" });
      await region.waitFor({ timeout: 30000 });
      const failed = await region
        .getByText("Failed", { exact: true })
        .waitFor({ timeout: 60000 })
        .then(
          () => true,
          () => false,
        );
      return {
        status: failed ? "PASS" : "FAIL",
        expected: "inspection Failed",
        actual: { failed },
      };
    },
  );

  await check(
    rows,
    "G3-SMALL-ANALYSIS",
    "Real Small analysis of the fresh media returns words in both halves",
    async () => {
      await page.locator("#media-file").setInputFiles(sourceFile);
      await page
        .getByRole("region", { name: "Inspection job" })
        .getByText("Completed", { exact: true })
        .waitFor({ timeout: 90000 });
      const href = await page
        .getByRole("region", { name: "Media Library" })
        .getByRole("link", { name: "Edit video" })
        .getAttribute("href");
      assetId = new URL(href, page.url()).searchParams.get("media");
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        const response = await page.request.get(
          `/api/projects/${projectId}/media/${assetId}/analysis`,
        );
        if (response.ok()) {
          const parsed = parseMediaAnalysis((await response.json()).data);
          if (
            parsed.sections.transcript.status === "completed" &&
            parsed.sections.audio.status === "completed"
          ) {
            analysis = parsed;
            break;
          }
        }
        await page.waitForTimeout(1000);
      }
      if (!analysis || analysis.sections.transcript.status !== "completed")
        return {
          status: "FAIL",
          expected: "completed Small transcript",
          actual: { status: analysis?.sections?.transcript?.status ?? "missing" },
        };
      const model = analysis.sections.transcript.provenance.model;
      const words = analysis.sections.transcript.data.segments.flatMap((segment) => segment.words);
      const tupleHash = sha256(
        JSON.stringify(
          words.map((word) => [word.startUs, word.endUs, word.confidence ?? null, word.text]),
        ),
      );
      const first = words.filter((word) => BigInt(word.startUs) < 8_000_000n).length;
      const second = words.filter((word) => BigInt(word.startUs) >= 8_000_000n).length;
      const ok =
        model?.name === "faster-whisper-small" &&
        model.sha256 === "4e456821bbeabf0923f07220a86c1c14a8820bc83e78ae638d4474207b70aedd" &&
        first > 0 &&
        second > 0;
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "pinned Small model and both time halves",
        actual: {
          model: model?.name,
          modelSha: model?.sha256,
          words: words.length,
          first,
          second,
          tupleHash,
          sourceSha,
        },
      };
    },
  );

  await check(
    rows,
    "G3-CAPTION-RENDER",
    "Authorized captions, edit, trim, split, undo, restart, render, playback, and download",
    async () => {
      if (!analysis) return { status: "ERROR", actual: "analysis missing" };
      await page
        .getByRole("region", { name: "Media Library" })
        .getByRole("link", { name: "Edit video" })
        .click();
      await page.getByRole("button", { name: "Create timeline from video", exact: true }).click();
      const timeline = page.getByRole("region", { name: "Timeline" });
      await timeline.waitFor();
      const sourceWords = analysis.sections.transcript.data.segments.flatMap(
        (segment) => segment.words,
      );
      const sourceHash = sha256(
        JSON.stringify(
          sourceWords.map((word) => [word.startUs, word.endUs, word.confidence ?? null, word.text]),
        ),
      );
      await page
        .getByRole("button", { name: "Add word-synchronized captions", exact: true })
        .click();
      await page.getByRole("status").waitFor({ timeout: 60000 });
      const blocks = Number((await page.getByRole("status").innerText()).split(" ")[0]);
      await page.getByLabel("Caption highlight color").fill("#00ffff");
      await page.getByRole("button", { name: "Update caption style", exact: true }).click();
      await page.getByLabel("Trim end (timeline seconds)").fill("12");
      await page.getByRole("button", { name: "Apply trim", exact: true }).click();
      await page.getByLabel("Split at (timeline seconds)").fill("6");
      await page.getByRole("button", { name: "Split clip", exact: true }).click();
      await page.getByRole("button", { name: "Clip 2" }).waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Undo last caption edit", exact: true }).click();
      await page.reload();
      await page.getByRole("status").waitFor();
      execFileSync("docker", ["compose", "restart", "api"], {
        cwd: app,
        env: { ...process.env, COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? "qa93" },
        stdio: "inherit",
      });
      const readyDeadline = Date.now() + 60000;
      let ready = false;
      while (Date.now() < readyDeadline) {
        try {
          const response = await fetch("http://127.0.0.1:3001/ready");
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* restart */
        }
        await page.waitForTimeout(1000);
      }
      await page.reload();
      const persisted = await page.getByRole("status").innerText();
      const timelineId = await page
        .getByRole("region", { name: "Timeline" })
        .getAttribute("data-timeline-id");
      const savedBody = await (
        await page.request.get(`/api/projects/${projectId}/editor/${timelineId}`)
      ).json();
      const savedWords =
        savedBody.data?.timeline?.captionsV1?.[0]?.blocks?.flatMap((block) => block.lines.flat()) ??
        [];
      const savedHash = sha256(
        JSON.stringify(
          savedWords.map((word) => [word.startUs, word.endUs, word.confidence ?? null, word.text]),
        ),
      );
      await page.getByRole("button", { name: "Render saved timeline", exact: true }).click();
      const exportRegion = page.getByRole("region", { name: "Export job" });
      await exportRegion.waitFor({ timeout: 30000 });
      const exportDeadline = Date.now() + 360000;
      let exportStatus = "";
      while (Date.now() < exportDeadline) {
        exportStatus = (await exportRegion.getByRole("status").innerText()).trim();
        if (/^(Completed|Failed|Cancelled)\b/.test(exportStatus)) break;
        await page.waitForTimeout(2000);
      }
      if (!exportStatus.startsWith("Completed")) {
        const worker = (() => {
          try {
            return execFileSync(
              "docker",
              [
                "compose",
                "ps",
                "--format",
                "{{.Service}} {{.State}} {{.Health}}",
                "render-worker",
                "render-executor",
              ],
              {
                cwd: app,
                encoding: "utf8",
                env: {
                  ...process.env,
                  COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? "qa93",
                },
              },
            ).trim();
          } catch {
            return "unavailable";
          }
        })();
        return {
          status: "FAIL",
          expected: "render reaches Completed",
          actual: { ready, blocks, hashMatch: savedHash === sourceHash, exportStatus, worker },
        };
      }
      const downloadUrl = await page
        .getByRole("link", { name: "Download MP4" })
        .getAttribute("href");
      const video = page.getByRole("region", { name: "Export job" }).locator("video");
      await video.waitFor();
      const playback = await video.evaluate(async (element) => {
        element.muted = true;
        await element.play();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          width: element.videoWidth,
          height: element.videoHeight,
          current: element.currentTime,
          paused: element.paused,
        };
      });
      const media = await page.request.get(downloadUrl);
      const file = path.join(outDir, "export.mp4");
      writeFileSync(file, Buffer.from(await media.body()));
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_name,codec_type,pix_fmt,width,height,avg_frame_rate,nb_frames",
            "-of",
            "json",
            file,
          ],
          { encoding: "utf8" },
        ),
      );
      const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
      const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
      const ok =
        ready &&
        blocks > 0 &&
        savedHash === sourceHash &&
        persisted.includes(String(blocks)) &&
        playback.width === 320 &&
        videoStream?.codec_name === "h264" &&
        videoStream.pix_fmt === "yuv420p" &&
        audioStream?.codec_name === "aac" &&
        media.ok();
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "persisted words, H.264/AAC playback",
        actual: {
          blocks,
          ready,
          hashMatch: savedHash === sourceHash,
          playback,
          video: videoStream,
          audio: audioStream?.codec_name,
          exportSha: sha256(readFileSync(file)),
        },
      };
    },
  );
} finally {
  await browser.close();
}

writeReport(process.argv[2] ?? path.join(outDir, "journey.json"), rows, {
  suite: "journey",
  productSha: process.env.QA_APP_SHA,
  sourceSha,
});
if (rows.some((row) => row.status !== "PASS")) process.exit(1);
