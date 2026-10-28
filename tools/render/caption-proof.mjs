/** Bounded captions-only qualification on existing real demo infrastructure. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { setTimeout } from "node:timers";
import { captionVisualProof } from "./caption-visual-proof.mjs";
import { captionBoundaryProof } from "./caption-boundary-proof.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
export async function runCaptionProof({
  root,
  hostEnv,
  webUrl,
  launch,
  probe,
  codeIdentity,
  docker,
  network,
  internalEnv,
}) {
  const directory = path.join(root, ".local/caption-public"),
    privateDir = path.join(root, ".local/caption-private");
  await mkdir(directory, { recursive: true });
  await mkdir(privateDir, { recursive: true });
  const webRequire = createRequire(path.join(root, "apps/web/package.json")),
    renderRequire = createRequire(path.join(root, "workers/render-worker/package.json"));
  const pool = new Pool({ connectionString: hostEnv.DATABASE_URL });
  let browserProcess,
    phase = "immutable-bilingual-source",
    agentName = null,
    measuredMedia = null,
    licensedSources = [];
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, "tests/fixtures/asr/manifest.json"), "utf8"),
    );
    const files = ["en.wav", "ar.wav"].map((file) => ({
      file,
      path: path.join(root, "tests/fixtures/asr", file),
      entry: manifest.fixtures.find((x) => x.file === file),
    }));
    for (const f of files) assert.equal(sha(await readFile(f.path)), f.entry.sha256);
    licensedSources = files.map((f) => ({
      file: f.file,
      sha256: f.entry.sha256,
      sourceSha256: f.entry.sourceSha256,
      sourceScopeUs: f.entry.sourceScopeUs,
      license: f.entry.license,
      adaptation:
        "Licensed 8-second EN and AR excerpts concatenated, AAC encoded and combined with the repository-generated visual; caption text is actual Small recognition, not human gold.",
      provenance: "tests/fixtures/asr/manifest.json",
    }));
    const visual = path.join(root, "tests/fixtures/media/talking-head.mp4"),
      mediaManifest = JSON.parse(
        await readFile(path.join(root, "tests/fixtures/media/manifest.json"), "utf8"),
      );
    assert.equal(
      sha(await readFile(visual)),
      mediaManifest.fixtures.find((x) => x.file === "talking-head.mp4").sha256,
    );
    const source = path.join(privateDir, "source.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-stream_loop",
        "-1",
        "-i",
        visual,
        "-i",
        files[0].path,
        "-i",
        files[1].path,
        "-filter_complex",
        "[1:a:0][2:a:0]concat=n=2:v=0:a=1[a];[0:v:0]scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2[v]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        "16",
        "-r",
        "25",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        source,
      ],
      { timeout: 30000, maxBuffer: 1048576 },
    );
    phase = "actual-browser-caption-journey";
    browserProcess = launch(
      process.execPath,
      [
        webRequire.resolve("@playwright/test/cli"),
        "test",
        "--config",
        "tests/caption-demo.config.ts",
        "journey.spec.ts",
      ],
      {
        cwd: path.join(root, "apps/web"),
        env: { ...process.env, CAPTION_DEMO_URL: webUrl },
        log: path.join(privateDir, "browser.log"),
      },
    );
    if ((await browserProcess.wait(390000)) !== 0) {
      const failed = JSON.parse(
        await readFile(path.join(privateDir, "browser-result.json"), "utf8").catch(() => "{}"),
      );
      if (
        [
          "authentication",
          "upload-inspection",
          "real-small-analysis",
          "caption-tool-persistence",
          "real-remotion-render",
        ].includes(failed.phase)
      )
        phase = `browser-${failed.phase}`;
      throw new Error("caption_browser_failed");
    }
    const result = JSON.parse(await readFile(path.join(privateDir, "browser-result.json"), "utf8"));
    assert.equal(result.status, "PASS");
    assert.equal(result.mockData, false);
    assert.equal(result.sourceSha256, sha(await readFile(source)));
    // This is only the newly generated, licensed qualification export, never
    // user media or a private diagnostic. Retain it even if later qualification
    // rejects it; the report must remain FAIL until every assertion passes.
    await copyFile(
      path.join(privateDir, "caption-export.mp4"),
      path.join(directory, "caption-export.mp4"),
    );
    phase = "persisted-state-and-agent-restart";
    const before = (
      await pool.query(
        "SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2",
        [result.timelineId, result.projectId],
      )
    ).rows[0];
    assert.equal(before.state_sha256, result.stateSha256);
    const commandsBefore = (
      await pool.query(
        "SELECT count(*) AS count FROM editing_caption_commands WHERE timeline_id=$1",
        [result.timelineId],
      )
    ).rows[0].count;
    agentName = `caption-agent-${randomBytes(6).toString("hex")}`;
    // Normal packaged worker only: no controlled planner entry, key or provider flag.
    docker([
      "run",
      "-d",
      "--name",
      agentName,
      "--network",
      network,
      "--user",
      "10001:10001",
      "--init",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--cpus",
      "0.5",
      "--memory",
      "256m",
      "--pids-limit",
      "64",
      "-e",
      `DATABASE_URL=${internalEnv.DATABASE_URL}`,
      "-e",
      `REDIS_URL=${internalEnv.REDIS_URL}`,
      "editagent-agent-qualification:test",
    ]);
    const ready = async () => {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        try {
          if (
            docker(["inspect", "--format", "{{.State.Health.Status}}", agentName]).trim() ===
            "healthy"
          )
            return;
        } catch {
          /*bounded startup*/
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("caption_agent_readiness_failed");
    };
    await ready();
    docker(["restart", agentName]);
    await ready();
    const after = (
      await pool.query("SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1", [
        result.timelineId,
      ])
    ).rows[0];
    assert.deepEqual(after, before);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) AS count FROM editing_caption_commands WHERE timeline_id=$1",
          [result.timelineId],
        )
      ).rows[0].count,
      commandsBefore,
    );
    docker(["rm", "-f", agentName]);
    agentName = null;
    phase = "independent-video-clock-and-native-caption-frames";
    const exported = path.join(privateDir, "caption-export.mp4"),
      media = probe(exported),
      video = media.streams.find((s) => s.codec_type === "video"),
      audio = media.streams.find((s) => s.codec_type === "audio");
    measuredMedia = {
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      frameRate: video?.avg_frame_rate ?? null,
      frameCount: Number(video?.nb_read_frames ?? 0),
      durationSeconds: Number(media.format.duration),
      audioSampleRate: Number(audio?.sample_rate ?? 0),
      audioChannels: audio?.channels ?? null,
      decodedFrameCount: media.videoFrameTimes.length,
      maximumFrameClockErrorSeconds: Math.max(
        ...media.videoFrameTimes.map((t, i) => Math.abs(t - i / 25)),
      ),
    };
    assert.equal(video.codec_name, "h264");
    assert.equal(audio.codec_name, "aac");
    assert.equal(video.width, 360);
    assert.equal(video.height, 640);
    assert.equal(video.avg_frame_rate, "25/1");
    assert.equal(Number(video.nb_read_frames), 400);
    assert.ok(Math.abs(Number(media.format.duration) - 16) < 0.02);
    assert.equal(audio.sample_rate, "48000");
    assert.equal(audio.channels, 2);
    assert.equal(media.videoFrameTimes.length, 400);
    for (let i = 0; i < 400; i++) assert.ok(Math.abs(media.videoFrameTimes[i] - i / 25) < 0.00001);
    phase = "map-persisted-caption-timeline";
    // Visible real English and Arabic source portions, selected by immutable
    // concatenation coordinates, not by guessing language from recognized text.
    const mapping = renderRequire("./dist/application/timeline-mapping.js");
    const catalog = JSON.parse(
      await readFile(path.join(root, "workers/render-worker/dist/bundle/catalog.json"), "utf8"),
    );
    const input = {
      schemaVersion: 1,
      compositionId: "TimelineV1",
      renderVersion: catalog.renderVersion,
      correlationId: "req_" + "a".repeat(32),
      props: {
        timeline: result.timeline,
        background: "#000000",
        components: [],
        captionStyle: { color: "#ffffff", background: "#000000", fontSize: 28, direction: "auto" },
      },
    };
    const plan = mapping.mapTimeline(input);
    phase = "decoded-native-word-boundary-proof";
    let actualFrames, boundaryError;
    try {
      actualFrames = await captionBoundaryProof(root, directory, privateDir, exported, plan);
    } catch (error) {
      boundaryError = error;
    }
    phase = "actual-remotion-visual-profile-matrix";
    let visualProfiles, visualError;
    try {
      visualProfiles = await captionVisualProof(
        root,
        path.join(directory, "visual"),
        path.join(privateDir, "native-reference"),
      );
    } catch (error) {
      visualError = error;
    }
    // Independent bounded suites run sequentially even when one fails. Both must
    // pass; preserve causes privately instead of losing unrelated visual proof.
    if (boundaryError || visualError) {
      phase = boundaryError
        ? "decoded-native-word-boundary-proof"
        : "actual-remotion-visual-profile-matrix";
      throw new AggregateError(
        [boundaryError, visualError].filter(Boolean),
        "Caption frame qualification failed.",
      );
    }
    await copyFile(exported, path.join(directory, "caption-export.mp4"));
    const captionRecord = (
      await pool.query(
        "SELECT count(*) AS count FROM editing_caption_commands WHERE timeline_id=$1 AND status='committed'",
        [result.timelineId],
      )
    ).rows[0].count;
    const report = {
      status: "PASS",
      ...codeIdentity,
      modelEvidence: "real-pinned-small-asr; no LLM",
      productionPlannerEnabled: false,
      actualUpload: true,
      actualAnalysis: true,
      actualTool: true,
      persistedAndReloaded: true,
      actualUndo: true,
      actualRender: true,
      actualPlayback: true,
      actualDownload: true,
      mockData: false,
      sourceSha256: result.sourceSha256,
      wordTupleSha256: result.wordTupleSha256,
      wordCount: result.wordCount,
      blocks: result.blocks,
      model: result.model,
      persistedCommandCount: Number(captionRecord),
      normalAgentWorkerRestartPreservedState: true,
      sourceFixtures: licensedSources,
      renderVersion: catalog.renderVersion,
      captionComponent: catalog.components,
      export: {
        sha256: sha(await readFile(exported)),
        bytes: (await readFile(exported)).length,
        durationSeconds: media.format.duration,
        width: video.width,
        height: video.height,
        videoCodec: video.codec_name,
        audioCodec: audio.codec_name,
        frameRate: video.avg_frame_rate,
        framesVerified: 400,
      },
      measuredMedia,
      actualBoundaryFrames: actualFrames,
      visualProfileCount: visualProfiles.length,
      limitations: {
        cp1: "NOT_VERIFIED",
        cp2: "NOT_MET",
        tinyArabic: "NOT_QUALIFIED",
        fullUs305Ac1: "NOT_MET_DEPENDENCY",
        liveProvider: "NOT_QUALIFIED",
        faceAvoidance: "NOT_CLAIMED",
      },
    };
    await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    return;
  } catch (error) {
    await writeFile(path.join(privateDir, "driver-error.txt"), String(error.stack ?? error), {
      mode: 0o600,
    });
    await writeFile(
      path.join(directory, "report.json"),
      JSON.stringify({
        status: "FAIL",
        phase,
        ...codeIdentity,
        measuredMedia,
        sourceFixtures: licensedSources,
      }) + "\n",
    );
  } finally {
    if (browserProcess) await browserProcess.close();
    await pool.end();
    if (agentName)
      try {
        docker(["rm", "-f", agentName]);
      } catch {
        /*owned test worker only*/
      }
  }
  // The original cause is retained in the private driver-error file, not CI logs.
  throw new Error(`Caption qualification failed at ${phase}; private details are not published.`);
}
