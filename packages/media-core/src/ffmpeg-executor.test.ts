import assert from "node:assert/strict";
import { test } from "node:test";
import { FfmpegExecutor, FfmpegError, parseFfmpegProgress } from "./ffmpeg-executor.js";
import { FfmpegBuilder } from "./ffmpeg-builder.js";

test("progress parser keeps exact integer timestamps", () => {
  assert.deepEqual(parseFfmpegProgress("frame=25\nout_time_us=9007199254740993\nprogress=end\n"), {
    frame: 25,
    outTimeUs: 9007199254740993n,
    finished: true,
  });
  assert.throws(() => parseFfmpegProgress("frame=-1\nout_time_us=NaN\n"));
});
test("real FFmpeg no-shell execution, nonzero and bounded diagnostics", async () => {
  const executor = new FfmpegExecutor();
  assert.match(
    (await executor.execute(["-version"], { timeoutMs: 5000 })).stdout.toString(),
    /ffmpeg version/,
  );
  await assert.rejects(
    executor.execute(["-version"], { timeoutMs: 5000, maxCaptureBytes: 1 }),
    (e: unknown) => e instanceof FfmpegError && e.code === "output_limit",
  );
  await assert.rejects(
    executor.execute(["-invalid-option"], { timeoutMs: 5000 }),
    (e: unknown) => e instanceof FfmpegError && e.code === "exit",
  );
  await assert.rejects(
    executor.execute([], { timeoutMs: 5000, executable: "/missing-runtime" }),
    (e: unknown) => e instanceof FfmpegError && e.code === "unavailable",
  );
});
test("timeout and abort kill/reap actual subprocess and release admission", async () => {
  // Node fixtures are only lifecycle tests; production cannot select executable through payload.
  const executor = new FfmpegExecutor();
  const fixture = require.resolve("../fixtures/bin/sleep.js");
  await assert.rejects(
    executor.execute([fixture], { executable: process.execPath, timeoutMs: 50 }),
    (e: unknown) => e instanceof FfmpegError && e.code === "timeout",
  );
  const controller = new AbortController();
  const running = executor.execute([fixture], {
    executable: process.execPath,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  await assert.rejects(
    executor.execute(["-version"], { timeoutMs: 5000 }),
    (e: unknown) => e instanceof FfmpegError && e.code === "busy",
  );
  controller.abort();
  await assert.rejects(running, (e: unknown) => e instanceof FfmpegError && e.code === "cancelled");
  assert.match(
    (await executor.execute(["-version"], { timeoutMs: 5000 })).stdout.toString(),
    /ffmpeg version/,
  );
});
test("real media progress uses independent bounded pipe", async () => {
  const args = FfmpegBuilder.input({ path: require.resolve("../fixtures/media/audio.wav") })
    .progress()
    .build();
  const progress: bigint[] = [];
  await new FfmpegExecutor().execute(args, {
    timeoutMs: 5000,
    onProgress: (p) => progress.push(p.outTimeUs),
  });
  assert.ok(progress.length > 0 && progress.at(-1)! > 0n);
});

test("real FFmpeg cancellation and timeout leave no owned process", async () => {
  for (const mode of ["timeout", "cancelled"] as const) {
    let pid = 0;
    const controller = new AbortController();
    const args = [
      ...FfmpegBuilder.input({ path: require.resolve("../fixtures/media/audio.wav") }).build(),
    ];
    args.splice(args.indexOf("-i"), 0, "-re");
    await assert.rejects(
      new FfmpegExecutor().execute(args, {
        timeoutMs: mode === "timeout" ? 50 : 5000,
        signal: controller.signal,
        onProcess: (id) => {
          pid = id;
          if (mode === "cancelled") controller.abort();
        },
      }),
      (e: unknown) => e instanceof FfmpegError && e.code === mode,
    );
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("low-level execution also rejects unsupported protocols and raw filter names before launch", async () => {
  const executor = new FfmpegExecutor();
  for (const args of [
    ["-i", "https://example.invalid/video", "-f", "null", "-"],
    ["-protocol_whitelist", "http", "-i", "/tmp/a", "-f", "null", "-"],
    ["-protocol_whitelist", "file", "-i", "/tmp/a", "-af", "movie=evil", "-f", "null", "-"],
    [
      "-protocol_whitelist",
      "file",
      "-i",
      "/tmp/a",
      "-af",
      "aresample=16000;movie=evil",
      "-f",
      "null",
      "-",
    ],
  ])
    await assert.rejects(executor.execute(args, { timeoutMs: 1000 }));
});

test("owned process-group cancellation also terminates and reaps a real descendant", async () => {
  let parentPid = 0,
    descendantPid = 0;
  const controller = new AbortController();
  const code =
    'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});child.on("exit",()=>process.exit(0));process.on("SIGTERM",()=>{});process.stdout.write(String(child.pid));';
  await assert.rejects(
    new FfmpegExecutor().execute(["-e", code], {
      executable: process.execPath,
      timeoutMs: 5000,
      signal: controller.signal,
      maxStdoutBytes: 100,
      onProcess: (pid) => {
        parentPid = pid;
      },
      onStdout: (bytes) => {
        descendantPid = Number(bytes.toString());
        controller.abort();
      },
    }),
    (e: unknown) => e instanceof FfmpegError && e.code === "cancelled",
  );
  assert.ok(parentPid > 0 && descendantPid > 0 && parentPid !== descendantPid);
  assert.throws(() => process.kill(parentPid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
});

test("executor does not pass service credentials to a subprocess", async () => {
  process.env["EDITAGENT_FFMPEG_TEST_SECRET"] = "test-only-value";
  try {
    const result = await new FfmpegExecutor().execute(
      ["-e", 'process.stdout.write(process.env.EDITAGENT_FFMPEG_TEST_SECRET ?? "absent")'],
      { executable: process.execPath, timeoutMs: 5000 },
    );
    assert.equal(result.stdout.toString(), "absent");
  } finally {
    delete process.env["EDITAGENT_FFMPEG_TEST_SECRET"];
  }
});

test("an overall AbortSignal deadline is classified as timeout, not user cancellation", async () => {
  await assert.rejects(
    new FfmpegExecutor().execute([require.resolve("../fixtures/bin/sleep.js")], {
      executable: process.execPath,
      timeoutMs: 5000,
      signal: AbortSignal.timeout(50),
    }),
    (e: unknown) => e instanceof FfmpegError && e.code === "timeout",
  );
});
