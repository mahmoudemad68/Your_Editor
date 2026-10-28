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
      "color=c=black:s=640x360:r=25:d=16",
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
        pixels: "640x360",
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
      const timelineId = await page
        .getByRole("region", { name: "Timeline" })
        .getAttribute("data-timeline-id");
      const readEditor = async () => {
        const response = await page.request.get(`/api/projects/${projectId}/editor/${timelineId}`);
        if (!response.ok()) throw new Error(`editor read ${response.status()}`);
        return (await response.json()).data;
      };
      const rangesOf = (data) =>
        data.timeline.tracks
          .flatMap((track) => track.clips)
          .map((clip) => [clip.inPoint, clip.outPoint, clip.timelineStartUs])
          .sort((a, b) => (BigInt(a[2]) < BigInt(b[2]) ? -1 : BigInt(a[2]) > BigInt(b[2]) ? 1 : 0));
      const posts = [];
      page.on("request", (request) => {
        if (request.method() !== "POST" || !/\/(trim|split)$/.test(request.url())) return;
        posts.push({ op: request.url().split("/").pop(), body: request.postDataJSON() });
      });
      await page.getByLabel("Caption highlight color").fill("#00ffff");
      const session = await page.context().newCDPSession(page);
      await session.send("Network.enable");
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 800,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await page.getByRole("button", { name: "Update caption style", exact: true }).click();
      await page.getByLabel("Trim end (timeline seconds)").fill("12");
      await page.getByRole("button", { name: "Apply trim", exact: true }).click();
      await page.getByLabel("Split at (timeline seconds)").fill("6");
      await page.getByRole("button", { name: "Split clip", exact: true }).click();
      await page.getByRole("button", { name: "Clip 2" }).waitFor({ timeout: 30000 });
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await session.detach();
      const raced = rangesOf(await readEditor());
      const raceOk =
        JSON.stringify(raced) ===
        JSON.stringify([
          ["0", "6000000", "0"],
          ["6000000", "12000000", "6000000"],
        ]);
      const requested = posts.filter(
        (post) =>
          (post.op === "trim" && post.body?.endUs === "12000000") ||
          (post.op === "split" && post.body?.atUs === "6000000"),
      );
      if (!raceOk || requested.length < 2) {
        return {
          status: "FAIL",
          expected: "rapid trim 12s and split 6s persist as [0,6s) and [6s,12s)",
          actual: { raced, posts: posts.map((post) => ({ op: post.op, body: post.body })) },
        };
      }
      await page.getByRole("button", { name: "Clip 2" }).click();
      await page.getByLabel("Split at (timeline seconds)").fill("8");
      await page.getByRole("button", { name: "Split clip", exact: true }).click();
      await page.getByRole("button", { name: "Clip 3" }).waitFor({ timeout: 30000 });
      const cut = rangesOf(await readEditor());
      const boundaryOk =
        JSON.stringify(cut) ===
        JSON.stringify([
          ["0", "6000000", "0"],
          ["6000000", "8000000", "6000000"],
          ["8000000", "12000000", "8000000"],
        ]);
      const splitAtEight = posts.some(
        (post) => post.op === "split" && post.body?.atUs === "8000000",
      );
      if (!boundaryOk || !splitAtEight) {
        return {
          status: "FAIL",
          expected: "explicit 8s split keeps the requested 6s and 12s boundaries",
          actual: { cut, splitAtEight },
        };
      }
      const edited = await readEditor();
      const csrf = await page.evaluate(() => {
        const part = document.cookie
          .split(";")
          .find((cookie) => cookie.trim().startsWith("editagent_csrf="));
        return part ? decodeURIComponent(part.trim().slice("editagent_csrf=".length)) : "";
      });
      const postEdit = (operation, data) =>
        page.request.post(`/api/projects/${projectId}/editor/${timelineId}/${operation}`, {
          data,
          headers: {
            "x-editagent-csrf": csrf,
            "x-request-id": `req_${randomUUID().replace(/-/g, "")}`,
          },
        });
      const stale = await Promise.all([
        postEdit("trim", {
          stateSha256: "a".repeat(64),
          clipId: edited.timeline.tracks[0].clips[0].id,
          startUs: "0",
          endUs: "1000000",
        }),
        postEdit("split", {
          stateSha256: "b".repeat(64),
          clipId: edited.timeline.tracks[0].clips[0].id,
          atUs: "1000000",
        }),
      ]);
      const staleLeak = [];
      for (const response of stale) {
        const text = await response.text();
        staleLeak.push(/caption_projection|min_duration|canonical_timeline|at \//.test(text));
      }
      const afterStale = await readEditor();
      const foreign = await page.request.post(
        `/api/projects/${projectId}/editor/${timelineId}/trim`,
        {
          data: {
            stateSha256: afterStale.stateSha256,
            clipId: "018fe277-6ec0-7000-8000-000000000099",
            startUs: "0",
            endUs: "1000000",
          },
        },
      );
      const foreignText = await foreign.text();
      const afterForeign = await readEditor();
      const controlsOk =
        stale.map((response) => response.status()).every((status) => status === 409) &&
        !staleLeak.some(Boolean) &&
        afterStale.stateSha256 === edited.stateSha256 &&
        foreign.status() >= 400 &&
        foreign.status() < 500 &&
        !/caption_projection|min_duration/.test(foreignText) &&
        afterForeign.stateSha256 === edited.stateSha256;
      const staleUndoResponse = page.waitForResponse(
        (response) => response.url().includes("/undo") && response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Undo last caption edit", exact: true }).click();
      const staleUndo = await staleUndoResponse;
      const afterUndo = await readEditor();
      await page.getByLabel("Caption highlight color").fill("#00ff00");
      await page.getByRole("button", { name: "Update caption style", exact: true }).click();
      const greenDeadline = Date.now() + 20000;
      let green = afterUndo;
      while (Date.now() < greenDeadline) {
        green = await readEditor();
        if (green.timeline.captionsV1?.[0]?.style.highlight === "#00ff00") break;
        await page.waitForTimeout(300);
      }
      const freshUndoResponse = page.waitForResponse(
        (response) => response.url().includes("/undo") && response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Undo last caption edit", exact: true }).click();
      const freshUndo = await freshUndoResponse;
      const freshDeadline = Date.now() + 20000;
      let afterFreshUndo = green;
      while (Date.now() < freshDeadline) {
        afterFreshUndo = await readEditor();
        if (afterFreshUndo.stateSha256 === afterUndo.stateSha256) break;
        await page.waitForTimeout(300);
      }
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
      const savedBody = { data: await readEditor() };
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
      const reloaded = rangesOf(savedBody.data);
      const evidence = savedBody.data?.timeline?.captionsV1?.[0]?.evidence?.kind;
      const boundSource = savedBody.data?.timeline?.captionsV1?.[0]?.sourceSha256;
      const undoOk =
        staleUndo.status() === 409 &&
        JSON.stringify(rangesOf(afterUndo)) === JSON.stringify(cut) &&
        green.timeline.captionsV1?.[0]?.style.highlight === "#00ff00" &&
        freshUndo.ok() &&
        afterFreshUndo.stateSha256 === afterUndo.stateSha256 &&
        JSON.stringify(reloaded) === JSON.stringify(cut);
      const overlapClip = savedBody.data.timeline.tracks.flatMap((track) => track.clips)[0];
      const overlapStart = BigInt(overlapClip.timelineStartUs);
      const overlapEnds = [overlapStart + 1_000_000n, overlapStart + 2_000_000n];
      const overlapResponses = await Promise.all(
        overlapEnds.map((endUs) =>
          postEdit("trim", {
            stateSha256: savedBody.data.stateSha256,
            clipId: overlapClip.id,
            startUs: overlapClip.timelineStartUs,
            endUs: String(endUs),
          }),
        ),
      );
      const overlapNext = await readEditor();
      const overlapClipNext = overlapNext.timeline.tracks
        .flatMap((track) => track.clips)
        .find((clip) => clip.id === overlapClip.id);
      const overlapEnd = overlapClipNext
        ? BigInt(overlapClipNext.timelineStartUs) +
          BigInt(overlapClipNext.outPoint) -
          BigInt(overlapClipNext.inPoint)
        : -1n;
      const overlapStatuses = overlapResponses.map((response) => response.status()).sort();
      const overlapOk =
        overlapStatuses[0] >= 200 &&
        overlapStatuses[0] < 300 &&
        overlapStatuses[1] === 409 &&
        overlapEnds.some((endUs) => overlapEnd === endUs);
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
        const renderNote = (() => {
          try {
            return execFileSync("docker", ["compose", "logs", "--tail", "40", "render-worker"], {
              cwd: app,
              encoding: "utf8",
              env: {
                ...process.env,
                COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? "qa93",
              },
            })
              .split("\n")
              .reverse()
              .find((line) => /error|fail|exceeds|version/i.test(line))
              ?.replace(/[^\x20-\x7E]/g, "?")
              .slice(0, 180);
          } catch {
            return undefined;
          }
        })();
        const failureReason = (() => {
          try {
            return execFileSync(
              "docker",
              [
                "compose",
                "exec",
                "-T",
                "postgres",
                "psql",
                "-U",
                "editagent",
                "-d",
                "editagent",
                "-Atc",
                "SELECT status || ' ' || coalesce(failure_reason,'') FROM jobs WHERE job_type='render.remotion' ORDER BY created_at DESC LIMIT 1",
              ],
              {
                cwd: app,
                encoding: "utf8",
                env: {
                  ...process.env,
                  COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? "qa93",
                },
              },
            )
              .replace(/[^\x20-\x7E]/g, "?")
              .trim()
              .slice(0, 180);
          } catch {
            return undefined;
          }
        })();
        return {
          status: "FAIL",
          expected: "render reaches Completed",
          actual: {
            ready,
            blocks,
            hashMatch: savedHash === sourceHash,
            evidence,
            sourceBound: boundSource === sourceSha,
            exportStatus,
            worker,
            renderNote,
            failureReason,
            undoOk,
            controlsOk,
            overlapOk,
            overlapStatuses,
            raced,
            cut,
          },
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
            "-count_frames",
            "-show_entries",
            "format=duration:stream=codec_name,codec_type,pix_fmt,width,height,avg_frame_rate,nb_read_frames",
            "-of",
            "json",
            file,
          ],
          { encoding: "utf8" },
        ),
      );
      const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
      const audioStream = probe.streams.find((stream) => stream.codec_type === "audio");
      const frameFile = path.join(outDir, "boundary-8s.png");
      execFileSync("ffmpeg", ["-y", "-ss", "8", "-i", file, "-frames:v", "1", frameFile], {
        stdio: "ignore",
      });
      const frames = Number(videoStream?.nb_read_frames ?? 0);
      const duration = Number(probe.format?.duration ?? 0);
      const timingOk =
        Math.abs(duration - 16) < 0.15 && frames === 400 && videoStream?.avg_frame_rate === "25/1";
      const ok =
        ready &&
        blocks > 0 &&
        savedHash === sourceHash &&
        persisted.includes(String(blocks)) &&
        evidence === "media-analysis" &&
        boundSource === sourceSha &&
        undoOk &&
        controlsOk &&
        overlapOk &&
        playback.width === 640 &&
        playback.height === 360 &&
        playback.current > 0 &&
        videoStream?.codec_name === "h264" &&
        (videoStream.pix_fmt === "yuv420p" || videoStream.pix_fmt === "yuvj420p") &&
        audioStream?.codec_name === "aac" &&
        timingOk &&
        media.ok() &&
        !exportStatus.includes("Invalid timeline render contract");
      return {
        status: ok ? "PASS" : "FAIL",
        expected: "16s 640x360 H.264/AAC 25fps 400-frame export with stable source words",
        actual: {
          blocks,
          ready,
          hashMatch: savedHash === sourceHash,
          evidence,
          sourceBound: boundSource === sourceSha,
          undoOk,
          controlsOk,
          overlapOk,
          overlapStatuses,
          playback,
          duration,
          frames,
          video: videoStream,
          audio: audioStream?.codec_name,
          exportSha: sha256(readFileSync(file)),
          frameSha: sha256(readFileSync(frameFile)),
          raced,
          cut,
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
