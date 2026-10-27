/** Additional real browser proof on the retained production services and renderer. */
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { buildProductImages } from "../test/compose-build.mjs";
import process from "node:process";
import console from "node:console";
import path from "node:path";
import { runAgentLoopProof } from "./agent-loop-proof.mjs";

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return value;
}
async function ready(probe, exited) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited?.()) throw new Error("Demo service exited before readiness");
    try {
      if ((await probe()).ok) return;
    } catch {
      /* startup is still bounded */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Demo service did not become ready");
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function runGraduationDemo({
  root,
  services,
  s3,
  network,
  limits,
  docker,
  launch,
  makeInput,
  probe,
  codeIdentity,
  renderVersion,
}) {
  const privateDir = path.join(root, ".local/graduation-demo/private");
  const publicDir = path.join(root, ".local/graduation-demo-public");
  await mkdir(privateDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });
  await rm(path.join(privateDir, "browser-result.json"), { force: true });
  // Public artifacts are an exact allowlist. Raw logs/native output stay in privateDir.
  for (const file of [
    "report.json",
    "upload-inspection.png",
    "analysis-status.png",
    "timeline.png",
    "export.png",
    "demo-export.mp4",
  ])
    await rm(path.join(publicDir, file), { force: true });
  const nonce = randomBytes(6).toString("hex"),
    databaseName = `graduation_${nonce}`,
    bucket = `graduation-${nonce}`;
  const names = [
    `graduation-media-${nonce}`,
    `graduation-ai-${nonce}`,
    `graduation-render-${nonce}`,
  ];
  const children = [];
  const admin = new Pool({ connectionString: services.postgres.url });
  let phase = "build-and-setup";
  try {
    await buildProductImages(root, ["media-worker"]);
    // The required ASR container step built this exact source revision and pinned models.
    docker(["image", "inspect", "editagent-ai-asr:test"]);
    phase = "demo-database-create";
    await admin.query(`CREATE DATABASE ${databaseName}`); // generated identifier, no domain fixture inserts
    const hostPg = new URL(services.postgres.url);
    hostPg.pathname = `/${databaseName}`;
    const internalPg = new URL(hostPg);
    internalPg.hostname = "postgres";
    internalPg.port = "5432";
    const hostRedis = new URL(services.redis.url);
    hostRedis.pathname = "/9";
    const apiPort = await port(),
      webPort = await port(),
      webUrl = `http://127.0.0.1:${webPort}`;
    if (!/^[a-f0-9]{64}$/.test(renderVersion))
      throw new Error("Missing immutable render catalog identity");
    phase = "demo-storage-create";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    // The pinned community MinIO rejects PUT ?cors. This test fixture uses
    // server-side loopback-origin CORS; production SeaweedFS policy is unchanged.
    // Require its real browser-facing preflight rather than assume support.
    phase = "demo-browser-storage-preflight";
    for (const method of ["PUT", "GET"]) {
      const cors = await globalThis.fetch(
        `${services.minio.endpoint}/${bucket}/browser-preflight`,
        {
          method: "OPTIONS",
          headers: {
            origin: webUrl,
            "access-control-request-method": method,
            "access-control-request-headers": "content-type",
          },
          signal: globalThis.AbortSignal.timeout(5000),
        },
      );
      if (
        !cors.ok ||
        cors.headers.get("access-control-allow-origin") !== webUrl ||
        !(cors.headers.get("access-control-allow-methods") ?? "").split(/,\s*/).includes(method)
      )
        throw new Error("Demo storage does not allow the actual browser origin/method");
      await cors.body?.cancel();
    }
    const shared = {
      S3_BUCKET: bucket,
      S3_REGION: services.minio.region,
      S3_ACCESS_KEY_ID: services.minio.credentials.accessKeyId,
      S3_SECRET_ACCESS_KEY: services.minio.credentials.secretAccessKey,
      EDITAGENT_ASR_MODEL: "small",
      EDITAGENT_ASR_CPU_THREADS: "2",
    };
    const hostEnv = {
      ...process.env,
      ...shared,
      DATABASE_URL: hostPg.href,
      REDIS_URL: hostRedis.href,
      S3_ENDPOINT: services.minio.endpoint,
      S3_PUBLIC_ENDPOINT: services.minio.endpoint,
      EDITAGENT_RENDER_VERSION: renderVersion,
      PORT: String(apiPort),
      HOST: "127.0.0.1",
      AUTH_JWT_SECRET: randomBytes(32).toString("hex"),
      AUTH_COOKIE_SECURE: "false",
      AUTH_TRUSTED_ORIGINS: webUrl,
      EDITAGENT_RUNTIME: "development",
    };
    const api = launch(process.execPath, ["dist/main.js"], {
      cwd: path.join(root, "apps/api"),
      env: hostEnv,
      log: path.join(privateDir, "api.log"),
    });
    children.push(api);
    phase = "api-readiness";
    await ready(
      () =>
        globalThis.fetch(`http://127.0.0.1:${apiPort}/ready`, {
          signal: globalThis.AbortSignal.timeout(2000),
        }),
      api.exited,
    );
    const webRequire = createRequire(path.join(root, "apps/web/package.json"));
    const web = launch(
      process.execPath,
      [
        webRequire.resolve("next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(webPort),
      ],
      {
        cwd: path.join(root, "apps/web"),
        env: { ...hostEnv, API_BASE_URL: `http://127.0.0.1:${apiPort}` },
        log: path.join(privateDir, "web.log"),
      },
    );
    children.push(web);
    await ready(
      () => globalThis.fetch(webUrl + "/sign-in", { signal: globalThis.AbortSignal.timeout(2000) }),
      web.exited,
    );
    const internalEnv = {
      ...shared,
      DATABASE_URL: internalPg.href,
      REDIS_URL: "redis://redis:6379/9",
      S3_ENDPOINT: "http://minio:9000",
    };
    const envArgs = Object.entries(internalEnv).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);
    phase = "production-workers";
    docker([
      "run",
      "-d",
      "--name",
      names[0],
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
      "1",
      "--memory",
      "1g",
      "--memory-swap",
      "1g",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777",
      ...envArgs,
      "editagent-media-worker:local",
    ]);
    docker([
      "run",
      "-d",
      "--name",
      names[1],
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
      "2",
      "--memory",
      "3g",
      "--memory-swap",
      "3g",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
      ...envArgs,
      "editagent-ai-asr:test",
    ]);
    docker([
      "run",
      "-d",
      "--name",
      names[2],
      ...limits,
      "--network",
      network,
      "--cpus",
      "1",
      "--memory",
      "1g",
      "--memory-swap",
      "1g",
      "--pids-limit",
      "64",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
      ...envArgs,
      "editagent-render-coordinator:test",
    ]);
    for (const name of names) {
      const deadline = Date.now() + 60_000;
      let healthy = false;
      while (Date.now() < deadline) {
        try {
          healthy =
            docker(["inspect", "--format", "{{.State.Health.Status}}", name]).trim() === "healthy";
        } catch {
          /* bounded startup */
        }
        if (healthy) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!healthy) throw new Error("Production demo worker readiness failed");
    }
    await makeInput(path.join(root, ".local/graduation-demo/demo-input.mp4"));
    phase = "actual-browser-journey";
    const browser = launch(
      process.execPath,
      [
        webRequire.resolve("@playwright/test/cli"),
        "test",
        "--config",
        "tests/graduation-demo.config.ts",
      ],
      {
        cwd: path.join(root, "apps/web"),
        env: { ...process.env, GRADUATION_DEMO_URL: webUrl },
        log: path.join(privateDir, "browser.log"),
      },
    );
    children.push(browser);
    if ((await browser.wait(390_000)) !== 0) {
      try {
        const failure = JSON.parse(
          await readFile(path.join(privateDir, "browser-result.json"), "utf8"),
        );
        const stages = [
          "authentication",
          "upload-and-inspection",
          "real-analysis",
          "timeline-editing",
          "production-render",
          "playback-and-download",
        ];
        if (failure.status === "FAIL" && stages.includes(failure.phase))
          phase = "browser-" + failure.phase;
      } catch {
        /* Missing private result does not expose raw browser logs. */
      }
      throw new Error("Browser journey did not pass");
    }
    const result = JSON.parse(await readFile(path.join(privateDir, "browser-result.json"), "utf8"));
    if (result.status !== "PASS" || result.mockData !== false)
      throw new Error("Missing real browser evidence");
    if (
      result.analysisSourceSha256 !==
      digest(await readFile(path.join(root, ".local/graduation-demo/demo-input.mp4")))
    )
      throw new Error("Analysis is not bound to the actual uploaded source");
    phase = "independent-media-verification";
    const outputFile = path.join(privateDir, "export.mp4"),
      document = probe(outputFile);
    const video = document.streams.find((stream) => stream.codec_type === "video");
    const audio = document.streams.find((stream) => stream.codec_type === "audio");
    const frames = document.videoFrameTimes;
    if (
      !video ||
      video.codec_name !== "h264" ||
      video.width !== 320 ||
      video.height !== 180 ||
      video.avg_frame_rate !== "25/1" ||
      Number(video.nb_read_frames) !== 200 ||
      Math.abs(Number(document.format.duration) - 8) > 0.02 ||
      !audio ||
      audio.codec_name !== "aac" ||
      audio.sample_rate !== "48000" ||
      audio.channels !== 2
    )
      throw new Error("Downloaded output violates the expected media clock/codec contract");
    if (
      !Array.isArray(frames) ||
      frames.length !== 200 ||
      frames.some((time, index) => !Number.isFinite(time) || Math.abs(time - index / 25) > 0.00001)
    )
      throw new Error("Downloaded output has an invalid presentation-frame cadence");
    const fixtureManifest = JSON.parse(
      await readFile(path.join(root, "tests/fixtures/asr/manifest.json"), "utf8"),
    );
    const audioFixture = fixtureManifest.fixtures.find((item) => item.file === "en.wav");
    await copyFile(outputFile, path.join(publicDir, "demo-export.mp4"));
    await writeFile(
      path.join(publicDir, "report.json"),
      JSON.stringify(
        {
          status: "PASS",
          ...codeIdentity,
          ...result,
          renderVersion,
          source: {
            inputSha256: digest(
              await readFile(path.join(root, ".local/graduation-demo/demo-input.mp4")),
            ),
            audioFixtureSha256: audioFixture.sha256,
            originalSourceSha256: audioFixture.sourceSha256,
            sourceId: audioFixture.sourceId,
            license: audioFixture.license,
            visual:
              "Repository-generated geometric animation; original synthetic audio replaced with the licensed human-speech fixture.",
          },
          export: {
            sha256: digest(await readFile(outputFile)),
            bytes: (await readFile(outputFile)).length,
            durationSeconds: document.format.duration,
            width: video.width,
            height: video.height,
            codec: video.codec_name,
            pixelFormat: video.pix_fmt,
            frameRate: video.avg_frame_rate,
            frameCount: video.nb_read_frames,
            timeBase: video.time_base,
            startTime: video.start_time,
            frameTiming: {
              framesVerified: frames.length,
              firstPts: frames[0],
              lastPts: frames.at(-1),
              expectedStepSeconds: 0.04,
            },
            audioCodec: audio.codec_name,
            audioSampleRate: audio.sample_rate,
            audioChannels: audio.channels,
          },
          acceptance:
            "Graduation demo proof only; H1/H2/H3, WER and full production acceptance remain separate.",
        },
        null,
        2,
      ) + "\n",
    );
    console.info(
      "GRADUATION_DEMO PASS: actual browser, durable editing, production workers, playback, download and independent FFprobe.",
    );
    phase = "controlled-agent-replay-render";
    await runAgentLoopProof({
      root,
      hostEnv,
      webUrl,
      result,
      probe,
      codeIdentity,
      renderContainer: names[2],
    });
    console.info(
      "CONTROLLED_AGENT_LOOP PASS: actual packaged worker, persisted trim/split, real render, browser and MP4; synthetic replay only.",
    );
    return;
  } catch (error) {
    await writeFile(path.join(privateDir, "driver-error.txt"), String(error.stack ?? error), {
      mode: 0o600,
    });
    await writeFile(
      path.join(publicDir, "report.json"),
      JSON.stringify({ status: "FAIL", phase, ...codeIdentity, fullDemoProven: false }) + "\n",
    );
    for (const name of names) {
      try {
        await writeFile(
          path.join(privateDir, name + ".log"),
          docker(["logs", "--tail", "100", name]),
          { mode: 0o600 },
        );
      } catch {
        /* not started */
      }
    }
  } finally {
    await admin.end();
    for (const child of children.reverse()) await child.close();
    for (const name of names) {
      try {
        docker(["rm", "-f", name]);
      } catch {
        /* already absent */
      }
    }
  }
  // The original cause is retained privately; never attach its operands to CI.
  throw new Error(`Graduation demo failed at ${phase}; raw details remain local.`);
}
