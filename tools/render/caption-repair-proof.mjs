/** Coding Agent regression for QA93-F1; never imports or changes independent QA code. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import { Pool } from "pg";

const sha = (b) => createHash("sha256").update(b).digest("hex");
export async function runCaptionRepairProof({
  root,
  hostEnv,
  webUrl,
  launch,
  probe,
  codeIdentity,
  restartApi,
}) {
  const privateDir = path.join(root, ".local/caption-repair-private"),
    publicDir = path.join(root, ".local/caption-public"),
    webRequire = createRequire(path.join(root, "apps/web/package.json")),
    renderRequire = createRequire(path.join(root, "workers/render-worker/package.json")),
    pool = new Pool({ connectionString: hostEnv.DATABASE_URL });
  await mkdir(privateDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });
  // Only our disposable synchronization files, never frozen artifacts or user files.
  for (const file of ["restart-checkpoint.json", "api-restarted.json", "browser-result.json"])
    await rm(path.join(privateDir, file), { force: true });
  let child,
    phase = "licensed-ar-en-source",
    mapping = { status: "NOT_RUN" },
    evidence = {};
  const report = (status) =>
    writeFile(
      path.join(publicDir, "repair-report.json"),
      JSON.stringify({ status, phase, ...codeIdentity, ...evidence, mapping, mockData: false }) +
        "\n",
    );
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, "tests/fixtures/asr/manifest.json"), "utf8"),
    );
    const sources = ["ar.wav", "en.wav"].map((file) => ({
      file,
      entry: manifest.fixtures.find((f) => f.file === file),
      path: path.join(root, "tests/fixtures/asr", file),
    }));
    for (const source of sources)
      assert.equal(sha(await readFile(source.path)), source.entry.sha256);
    const media = path.join(privateDir, "source.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        sources[0].path,
        "-i",
        sources[1].path,
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
        media,
      ],
      { timeout: 30000, maxBuffer: 1048576 },
    );
    evidence = {
      sourceSha256: sha(await readFile(media)),
      sourceOrder: "AR_THEN_EN",
      licensedSources: sources.map(({ file, entry }) => ({
        file,
        sha256: entry.sha256,
        license: entry.license,
      })),
      gold: "NONE_actual_Small_recognition",
    };
    phase = "real-small-browser-edit-and-api-restart";
    await report("RUNNING");
    child = launch(
      process.execPath,
      [
        webRequire.resolve("@playwright/test/cli"),
        "test",
        "--config",
        "tests/caption-demo.config.ts",
        "repair.spec.ts",
      ],
      {
        cwd: path.join(root, "apps/web"),
        env: { ...process.env, CAPTION_DEMO_URL: webUrl },
        log: path.join(privateDir, "browser.log"),
      },
    );
    let checkpoint;
    const until = Date.now() + 240000;
    while (Date.now() < until && !child.exited()) {
      try {
        checkpoint = JSON.parse(
          await readFile(path.join(privateDir, "restart-checkpoint.json"), "utf8"),
        );
        break;
      } catch {
        /* private barrier not reached */
      }
      await delay(200);
    }
    assert.ok(checkpoint, "Browser must reach the real persisted edit checkpoint.");
    const readState = async () =>
      (
        await pool.query(
          "SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2",
          [checkpoint.timelineId, checkpoint.projectId],
        )
      ).rows[0];
    const before = await readState();
    assert.equal(before.state_sha256, checkpoint.stateSha256);
    assert.deepEqual(before.snapshot, checkpoint.timeline);
    await restartApi();
    assert.deepEqual(await readState(), before);
    // Diagnose the ACTUAL database snapshot with the same production parser.
    // Raw causes, native text and resource identities stay private. Public output
    // contains only a closed set of typed stage/reason values and hashes/counts.
    const { parseRenderInput, TimelineRenderContractError } = renderRequire(
        "./dist/infrastructure/contract.js",
      ),
      { TimelineMappingError, mapTimeline } = renderRequire(
        "./dist/application/timeline-mapping.js",
      ),
      { CaptionReadabilityError } = renderRequire("@editagent/domain"),
      catalog = JSON.parse(
        await readFile(path.join(root, "workers/render-worker/dist/bundle/catalog.json"), "utf8"),
      );
    const input = {
      schemaVersion: 1,
      renderVersion: catalog.renderVersion,
      compositionId: "TimelineV1",
      correlationId: "req_" + "a".repeat(32),
      props: {
        timeline: before.snapshot,
        background: "#000000",
        components: [],
        captionStyle: { color: "#ffffff", background: "#000000", fontSize: 28, direction: "auto" },
      },
    };
    try {
      parseRenderInput(input);
      const plan = mapTimeline(input),
        caption = before.snapshot.captionsV1[0],
        retained = caption.blocks
          .flatMap((block) => block.lines.flat())
          .filter((word) => BigInt(word.startUs) >= 0n && BigInt(word.endUs) <= 12000000n),
        projected = plan.captionsV1.flatMap((block) => block.lines.flat());
      // Full tuples, not counts. These requested edits retain source [0,12s).
      assert.deepEqual(projected, retained);
      assert.ok(
        plan.captionsV1.every(
          (block) => BigInt(block.startUs) >= 0n && BigInt(block.endUs) <= 12000000n,
        ),
      );
      evidence = {
        ...evidence,
        retainedWordCount: retained.length,
        projectedWordTupleSha256: sha(JSON.stringify(projected)),
        retainedWordTupleSha256: sha(JSON.stringify(retained)),
        completeRetainedNativeWords: true,
      };
      mapping = { status: "PASS" };
    } catch (error) {
      await writeFile(
        path.join(privateDir, "mapping-cause.txt"),
        String(error.stack) +
          "\n" +
          String(error.cause?.stack) +
          "\n" +
          String(error.cause?.cause?.stack),
        { mode: 0o600 },
      );
      mapping = {
        status: "FAIL",
        stage:
          error instanceof TimelineRenderContractError &&
          error.cause instanceof TimelineMappingError
            ? error.cause.stage
            : "other",
        reason:
          error.cause?.cause instanceof CaptionReadabilityError
            ? error.cause.cause.reason
            : "other",
      };
    }
    evidence = {
      ...evidence,
      sourceSha256: checkpoint.sourceSha256,
      stateSha256: checkpoint.stateSha256,
      wordTupleSha256: checkpoint.wordTupleSha256,
      wordCount: checkpoint.wordCount,
      qaOrderedTupleSha256: checkpoint.qaOrderedTupleSha256,
      controlledResponseLatencyMs: checkpoint.controlledResponseLatencyMs,
      requestedTrimEndUs: checkpoint.requestedTrimEndUs,
      requestedSplitAtUs: checkpoint.requestedSplitAtUs,
      actualClipRanges: before.snapshot.tracks.flatMap((track) =>
        track.clips.map((clip) => ({
          inPoint: clip.inPoint,
          outPoint: clip.outPoint,
          timelineStartUs: clip.timelineStartUs,
        })),
      ),
      model: checkpoint.model,
      apiRestarted: true,
      databaseSnapshotUnchanged: true,
    };
    await report("RUNNING");
    await writeFile(path.join(privateDir, "api-restarted.json"), "ready", { mode: 0o600 });
    phase = "real-render-playback-and-download";
    assert.equal(await child.wait(210000), 0, "Real browser render/playback/download must pass.");
    const result = JSON.parse(await readFile(path.join(privateDir, "browser-result.json"), "utf8"));
    assert.equal(result.status, "PASS");
    assert.equal(result.mockData, false);
    assert.equal(result.stateSha256, checkpoint.stateSha256);
    assert.equal(result.wordTupleSha256, checkpoint.wordTupleSha256);
    assert.equal(mapping.status, "PASS");
    phase = "requested-versus-persisted-edit-coordinates";
    assert.deepEqual(evidence.actualClipRanges, [
      { inPoint: "0", outPoint: "6000000", timelineStartUs: "0" },
      { inPoint: "6000000", outPoint: "12000000", timelineStartUs: "6000000" },
    ]);
    phase = "ffprobe-and-persisted-native-word-integrity";
    const exported = path.join(privateDir, "repair-export.mp4"),
      measured = probe(exported),
      video = measured.streams.find((s) => s.codec_type === "video"),
      audio = measured.streams.find((s) => s.codec_type === "audio");
    assert.equal(video.codec_name, "h264");
    assert.equal(audio.codec_name, "aac");
    assert.equal(video.width, 640);
    assert.equal(video.height, 360);
    assert.equal(video.avg_frame_rate, "25/1");
    assert.equal(Number(video.nb_read_frames), 400);
    assert.equal(measured.videoFrameTimes.length, 400);
    for (let i = 0; i < 400; i++)
      assert.ok(Math.abs(measured.videoFrameTimes[i] - i / 25) < 0.00001);
    assert.ok(Math.abs(Number(measured.format.duration) - 16) < 0.02);
    assert.equal(audio.sample_rate, "48000");
    assert.equal(audio.channels, 2);
    assert.deepEqual(await readState(), before);
    await copyFile(exported, path.join(publicDir, "repair-export.mp4"));
    phase = "explicit-source-boundary-render-regression";
    const boundary = result.boundaryRegression;
    assert.equal(boundary.actualTool, true);
    assert.equal(boundary.actualRender, true);
    assert.equal(boundary.actualPlayback, true);
    assert.equal(boundary.actualDownload, true);
    const boundaryDb = (
      await pool.query(
        "SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2",
        [boundary.timelineId, checkpoint.projectId],
      )
    ).rows[0];
    assert.equal(boundaryDb.state_sha256, boundary.stateSha256);
    assert.deepEqual(boundaryDb.snapshot, boundary.timeline);
    const boundaryInput = { ...input, props: { ...input.props, timeline: boundaryDb.snapshot } };
    parseRenderInput(boundaryInput);
    const boundaryPlan = mapTimeline(boundaryInput),
      native = before.snapshot.captionsV1[0].blocks.flatMap((block) => block.lines.flat()),
      actual = boundaryPlan.captionsV1.flatMap((block) => block.lines.flat());
    assert.deepEqual(actual, native);
    const boundaryExport = path.join(privateDir, "repair-boundary-export.mp4"),
      boundaryMedia = probe(boundaryExport),
      boundaryVideo = boundaryMedia.streams.find((s) => s.codec_type === "video"),
      boundaryAudio = boundaryMedia.streams.find((s) => s.codec_type === "audio");
    assert.equal(boundaryVideo.codec_name, "h264");
    assert.equal(boundaryAudio.codec_name, "aac");
    assert.equal(boundaryVideo.width, 640);
    assert.equal(boundaryVideo.height, 360);
    assert.equal(boundaryVideo.avg_frame_rate, "25/1");
    assert.equal(Number(boundaryVideo.nb_read_frames), 400);
    assert.ok(Math.abs(Number(boundaryMedia.format.duration) - 16) < 0.02);
    assert.equal(boundaryAudio.sample_rate, "48000");
    assert.equal(boundaryAudio.channels, 2);
    assert.equal(boundaryMedia.videoFrameTimes.length, 400);
    for (let i = 0; i < 400; i++)
      assert.ok(Math.abs(boundaryMedia.videoFrameTimes[i] - i / 25) < 0.00001);
    await copyFile(boundaryExport, path.join(publicDir, "repair-boundary-export.mp4"));
    const boundaryEvidence = {
      status: "PASS",
      sourceSha256: checkpoint.sourceSha256,
      stateSha256: boundary.stateSha256,
      sourceWordCount: native.length,
      projectedWordCount: actual.length,
      originalNativeTupleSha256: sha(JSON.stringify(native)),
      projectedNativeTupleSha256: sha(JSON.stringify(actual)),
      clipRanges: [
        { inPoint: "0", outPoint: "8000000", timelineStartUs: "0" },
        { inPoint: "8000000", outPoint: "16000000", timelineStartUs: "8000000" },
      ],
      actualRender: true,
      actualPlayback: true,
      actualDownload: true,
      exportSha256: sha(await readFile(boundaryExport)),
      measuredMedia: {
        videoCodec: boundaryVideo.codec_name,
        audioCodec: boundaryAudio.codec_name,
        width: boundaryVideo.width,
        height: boundaryVideo.height,
        frameRate: boundaryVideo.avg_frame_rate,
        frameCount: 400,
        durationSeconds: Number(boundaryMedia.format.duration),
        audioSampleRate: Number(boundaryAudio.sample_rate),
        audioChannels: boundaryAudio.channels,
        maxFrameClockErrorSeconds: Math.max(
          ...boundaryMedia.videoFrameTimes.map((t, i) => Math.abs(t - i / 25)),
        ),
      },
    };
    evidence = {
      ...evidence,
      staleUndoFenced: result.staleUndoFenced,
      currentStateUndo: result.actualUndo,
      trimEndUs: result.trimmedAtUs,
      splitAtUs: result.splitAtUs,
      actualRender: true,
      actualPlayback: true,
      actualDownload: true,
      exportSha256: sha(await readFile(exported)),
      boundaryRegression: boundaryEvidence,
      measuredMedia: {
        videoCodec: video.codec_name,
        audioCodec: audio.codec_name,
        width: video.width,
        height: video.height,
        frameRate: video.avg_frame_rate,
        frameCount: 400,
        durationSeconds: Number(measured.format.duration),
        audioSampleRate: Number(audio.sample_rate),
        audioChannels: audio.channels,
        maxFrameClockErrorSeconds: Math.max(
          ...measured.videoFrameTimes.map((t, i) => Math.abs(t - i / 25)),
        ),
      },
      compositionDurationNote:
        "Clip trimmed to 12 seconds; existing explicit 16-second composition is retained.",
    };
    phase = "real-browser-concurrent-trim-regression";
    const concurrency = result.concurrencyRegression;
    assert.deepEqual(concurrency.statuses, [200, 409]);
    assert.equal(concurrency.staleReplayStatus, 409);
    assert.equal(concurrency.reloadPreservedWinner, true);
    const concurrentDb = (
      await pool.query(
        "SELECT snapshot,state_sha256 FROM editing_timelines WHERE id=$1 AND project_id=$2",
        [concurrency.timelineId, checkpoint.projectId],
      )
    ).rows[0];
    assert.equal(concurrentDb.state_sha256, concurrency.stateSha256);
    assert.deepEqual(concurrentDb.snapshot, concurrency.timeline);
    assert.equal(concurrentDb.snapshot.tracks[0].clips[0].outPoint, concurrency.winnerEndUs);
    assert.deepEqual(
      concurrentDb.snapshot.captionsV1[0].blocks.flatMap((block) => block.lines.flat()),
      native,
    );
    evidence = {
      ...evidence,
      concurrencyRegression: {
        status: "PASS",
        statuses: concurrency.statuses,
        staleReplayStatus: concurrency.staleReplayStatus,
        basisSha256: concurrency.basisSha256,
        stateSha256: concurrency.stateSha256,
        winnerEndUs: concurrency.winnerEndUs,
        databaseMatchesWinner: true,
        reloadPreservedWinner: true,
        originalWordsPreserved: true,
      },
    };
    phase = "complete";
    await report("PASS");
  } catch (error) {
    await writeFile(path.join(privateDir, "driver-error.txt"), String(error.stack ?? error), {
      mode: 0o600,
    });
    await report("FAIL");
    throw new Error(
      "Caption trim/split/restart real-service proof failed; see sanitized repair report.",
      { cause: error },
    );
  } finally {
    await child?.close();
    await pool.end();
  }
}
