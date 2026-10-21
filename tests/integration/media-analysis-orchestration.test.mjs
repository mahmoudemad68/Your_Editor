import assert from "node:assert/strict";
import console from "node:console";
import { randomBytes, createHash } from "node:crypto";
import { readFile, readdir, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Pool } from "pg";
import {
  S3Client,
  CopyObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  createUuidV7,
  jobId,
  projectId,
  mediaAssetId,
  userId,
} from "../../packages/domain/dist/index.js";
import { BullMqJobQueue, PostgresJobRepository } from "../../packages/job-queue/dist/index.js";
import { PostgresAnalysis, analysisConfiguration } from "@editagent/analysis-core";
import {
  parseValidationPolicy,
  validationPolicySignature,
} from "../../packages/shared/dist/index.js";
import {
  validateMediaAnalysisV1,
  validateMediaAnalysisV1_1,
} from "../../packages/schemas/dist/index.js";
import { startIntegrationServices } from "./support/containers.mjs";
import {
  privateAsrDiagnostic,
  privateAsrIntegrationTest as test,
} from "./support/private-asr-diagnostics.mjs";
import { GetMediaAnalysis } from "../../apps/api/dist/application/media-analysis.js";
import { GetMediaDetails } from "../../apps/api/dist/application/media-details.js";
import { PostgresMediaAssetRepository } from "../../apps/api/dist/infrastructure/postgres-media-repository.js";
import { PostgresProjectRepository } from "../../apps/api/dist/infrastructure/postgres-project-repository.js";

const root = path.resolve(import.meta.dirname, "../..");
const apiRequire = createRequire(path.join(root, "apps/api/package.json"));
const { createApiApplication } = apiRequire("./dist/create-api-application.js");
const { authenticateRequest } = apiRequire("./dist/presentation/authenticate-request.js");
const { JwtSessionTokens } = apiRequire("./dist/infrastructure/jwt-session-tokens.js");
const id = () => createUuidV7(Date.now(), randomBytes(10));
async function command(bin, args, env) {
  const child = spawn(bin, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (error += c));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, error);
  return output;
}

async function until(probe, label, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`State did not arrive: ${label}`);
}
function consumer(env, analyzer) {
  const child = spawn(
    path.join(root, "workers/ai-worker/.venv/bin/python"),
    [
      "-c",
      `import asyncio,json,time
from editagent_ai_worker.infrastructure.job_queue import BullMqConsumer,run_analysis_handler
async def run():
 c=BullMqConsumer(${JSON.stringify("REDIS_URL")},${JSON.stringify("DATABASE_URL")},"media-analysis-v1-${analyzer}",30000,run_analysis_handler)
 try:
  deadline=time.monotonic()+60
  while time.monotonic()<deadline:
   result=await c.consume_one()
   if result.get("status") in {"Completed","Cancelled","Failed"}:
    print(json.dumps(result),flush=True);return
   await asyncio.sleep(.02)
  raise RuntimeError("Recovery did not converge")
 finally: await c.close()
import os
# Connection settings remain environment-owned; no command text comes from a job.
asyncio.run(run())`
        .replace('"REDIS_URL"', 'os.environ["REDIS_URL"]')
        .replace('"DATABASE_URL"', 'os.environ["DATABASE_URL"]'),
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { child, exit, output: () => stdout, diagnostics: () => stderr };
}
async function notRunning(pid) {
  try {
    return (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].startsWith("Z");
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

test(
  "US-210 real PG/Redis/S3 and CPU ASR/VAD: durable delivery, partial failure, rerun and revocation",
  { timeout: 420000 },
  async () => {
    let services, pool, queue, s3, containerName, networkName, app;
    const temp = await mkdtemp(path.join(tmpdir(), "analysis-integration-"));
    try {
      services = await startIntegrationServices();
      pool = new Pool({ connectionString: services.postgres.url });
      for (const file of (await readdir(path.join(root, "apps/api/migrations")))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(path.join(root, "apps/api/migrations", file), "utf8"));
      queue = new BullMqJobQueue(services.redis.url);
      s3 = new S3Client({
        endpoint: services.minio.endpoint,
        region: services.minio.region,
        credentials: services.minio.credentials,
        forcePathStyle: true,
      });
      const bucket = "analysis-test";
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      const project = id(),
        owner = id(),
        editor = id(),
        asset = id();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$fixture',0,0)",
        [owner, owner + "@example.test"],
      );
      await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Analysis fixture',0,0)",
        [project],
      );
      await pool.query(
        "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'owner',0)",
        [project, owner],
      );
      await pool.query(
        "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$fixture',0,0)",
        [editor, editor + "@example.test"],
      );
      await pool.query(
        "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'editor',0)",
        [project, editor],
      );
      const sourceFile = path.join(temp, "source.mp4");
      await command(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-threads",
          "1",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:size=160x120:rate=30:duration=8",
          "-i",
          path.join(root, "tests/fixtures/asr/en.wav"),
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "libx264",
          "-threads:v",
          "1",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          sourceFile,
        ],
        process.env,
      );
      const sourceBytes = await readFile(sourceFile);
      const { FFprobeMediaProbe } = await import("../../packages/media-core/dist/index.js");
      const inspected = await new FFprobeMediaProbe().inspect({ filePath: sourceFile });
      const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
      const original = `projects/${project}/media/sha256/${sourceHash}`;

      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: original, Body: sourceBytes }));

      await pool.query(
        `INSERT INTO media_assets(id,project_id,kind,storage_key,display_filename,mime_type,byte_size,
        content_sha256,upload_state,duration,created_at,updated_at,inspection_status,container,video_codec,width,height,
        display_width,display_height,rotation,frame_rate_numerator,frame_rate_denominator,
        audio_codec,sample_rate,audio_channels,frame_rate_mode,validation_status,validation_policy_signature,
        validation_source_sha256,validation_checked_at)
        VALUES($1,$2,'video',$3,'fixture.mp4','video/mp4',$4,$5,'uploaded',8000000,0,0,'completed','mp4',
          'h264',160,120,160,120,0,30,1,'aac',16000,1,'constant','validated',$5,$5,0)`,
        [asset, project, original, sourceBytes.length, sourceHash],
      );
      await pool.query("UPDATE media_assets SET streams=$2 WHERE id=$1", [
        asset,
        JSON.stringify(inspected.streams),
      ]);
      const env = {
        ...process.env,
        DATABASE_URL: services.postgres.url,
        REDIS_URL: services.redis.url,
        S3_ENDPOINT: services.minio.endpoint,
        S3_BUCKET: bucket,
        S3_ACCESS_KEY_ID: services.minio.credentials.accessKeyId,
        S3_SECRET_ACCESS_KEY: services.minio.credentials.secretAccessKey,
        S3_REGION: services.minio.region,
        EDITAGENT_ASR_MODEL: "tiny",
        EDITAGENT_ASR_MODEL_ROOT: path.join(root, ".local/asr-models"),
      };
      const store = new PostgresAnalysis(pool);
      await pool.query("UPDATE media_assets SET validation_policy_signature=$2 WHERE id=$1", [
        asset,
        validationPolicySignature(parseValidationPolicy(env)),
      ]);
      await store.scheduleDerivations(queue, "analysis-derivation-test");
      await store.scheduleDerivations(queue, "analysis-derivation-test");
      const derivation = (
        await pool.query("SELECT id FROM jobs WHERE job_type='media.derive' AND subject_id=$1", [
          asset,
        ])
      ).rows[0];
      assert.ok(derivation);
      // Actual automatic US-128 admission -> BullMQ -> production child handler
      // creates all immutable proxies/audio before analysis can be discovered.
      await command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import {Pool} from 'pg'; import {randomBytes} from 'node:crypto';
        import {BullMqJobQueue,PostgresJobRepository,runNextJob} from './packages/job-queue/dist/index.js';
        import {createUuidV7,instant} from './packages/domain/dist/index.js';
        import {ChildProcessJobSupervisor} from './workers/media-worker/dist/infrastructure/child-job-supervisor.js';
        const pool=new Pool({connectionString:process.env.DATABASE_URL});const queue=new BullMqJobQueue(process.env.REDIS_URL);
        try {
          const deps={jobs:new PostgresJobRepository(pool),queue,supervisor:new ChildProcessJobSupervisor(),now:()=>instant(BigInt(Date.now())),newAttemptId:()=>createUuidV7(Date.now(),randomBytes(10))};
          await runNextJob(deps,'analysis-derivation-test',{modulePath:${JSON.stringify(path.join(root, "workers/media-worker/dist/handlers/media-jobs.js"))},exportName:'handleMediaJob'});
          const row=(await pool.query('SELECT status,failure_reason FROM jobs WHERE id=$1',[${JSON.stringify(derivation.id)}])).rows[0];
          if(row.status!=='Completed')throw new Error('Automatic derivation failed: '+row.status);
        } finally {await queue.close(true);await pool.end();}
      `,
        ],
        env,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM derived_assets WHERE media_asset_id=$1 AND metadata->>'variant' IN ('asr','mix')",
            [asset],
          )
        ).rows[0].count,
        "2",
      );
      await Promise.all([
        store.discover(analysisConfiguration({ EDITAGENT_ASR_MODEL: "tiny" })),
        store.discover(analysisConfiguration({ EDITAGENT_ASR_MODEL: "tiny" })),
      ]);
      console.info("US210_PHASE derivation-and-discovery-complete");
      assert.equal((await pool.query("SELECT count(*) FROM analysis_tasks")).rows[0].count, "3");
      assert.equal(
        (await pool.query("SELECT count(*) FROM jobs WHERE job_type LIKE 'analysis.%'")).rows[0]
          .count,
        "3",
      );
      // Fresh recovery instance proves jobs/publication intent survive coordinator loss.
      await new PostgresAnalysis(pool).recover(queue);

      if (process.env.EDITAGENT_TEST_ASR_CONTAINER === "1") {
        networkName = "asr-proof-" + randomBytes(6).toString("hex");
        containerName = networkName + "-worker";
        await command("docker", ["network", "create", "--internal", networkName], process.env);
        for (const [service, alias] of [
          [services.postgres, "postgres"],
          [services.redis, "redis"],
          [services.minio, "s3"],
        ])
          await command(
            "docker",
            ["network", "connect", "--alias", alias, networkName, service.container.getId()],
            process.env,
          );
        const pg = new URL(services.postgres.url);
        pg.hostname = "postgres";
        pg.port = "5432";
        const containerEnv = {
          ...env,
          DATABASE_URL: pg.href,
          REDIS_URL: "redis://redis:6379",
          S3_ENDPOINT: "http://s3:9000",
          EDITAGENT_ASR_MODEL_ROOT: "/app/.venv/share/editagent/asr-models",
        };
        const args = [
          "run",
          "-d",
          "--name",
          containerName,
          "--network",
          networkName,
          "--user",
          "10001:10001",
          "--init",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--memory",
          "3g",
          "--memory-swap",
          "3g",
          "--cpus",
          "2",
          "--pids-limit",
          "128",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
          "-e",
          "NO_PROXY=postgres,redis,s3,127.0.0.1,localhost",
          "-e",
          "no_proxy=postgres,redis,s3,127.0.0.1,localhost",
        ];
        for (const key of [
          "DATABASE_URL",
          "REDIS_URL",
          "S3_ENDPOINT",
          "S3_BUCKET",
          "S3_ACCESS_KEY_ID",
          "S3_SECRET_ACCESS_KEY",
          "S3_REGION",
          "EDITAGENT_ASR_MODEL",
          "EDITAGENT_ASR_MODEL_ROOT",
        ])
          args.push("-e", `${key}=${containerEnv[key]}`);
        args.push("editagent-ai-asr:test");
        await command("docker", args, process.env);
        const probe = async (route) =>
          Number(
            (
              await command(
                "docker",
                [
                  "exec",
                  containerName,
                  "python",
                  "-c",
                  `import urllib.request,urllib.error
try: print(urllib.request.urlopen('http://127.0.0.1:3200/${route}',timeout=5).status)
except urllib.error.HTTPError as error: print(error.code)
except (urllib.error.URLError, TimeoutError): print(0)`,
                ],
                process.env,
              )
            ).trim(),
          );
        await until(async () => (await probe("ready")) === 200, "production image ready");
        console.info("US210_PHASE production-container-ready");
        for (const analyzer of ["transcript", "speech"])
          await until(
            async () => {
              const row = (
                await pool.query(
                  "SELECT j.status,t.failure->>'code' AS failure_code FROM jobs j JOIN analysis_tasks t ON t.job_id=j.id WHERE t.analyzer=$1",
                  [analyzer],
                )
              ).rows[0];
              if (row.status === "Failed") {
                const safe = new Set([
                  "timeout",
                  "unsupported",
                  "processing_failed",
                  "cancelled",
                  "invalid_input",
                ]);
                console.info(
                  "US210_STATUS",
                  JSON.stringify({
                    analyzer,
                    status: "Failed",
                    failureCode: safe.has(row.failure_code) ? row.failure_code : "unclassified",
                  }),
                );
              }
              assert.notEqual(row.status, "Failed");
              return row.status === "Completed";
            },
            `container ${analyzer} complete`,
            120000,
          );
        const uid = Number(
          (await command("docker", ["exec", containerName, "id", "-u"], process.env)).trim(),
        );
        assert.equal(uid, 10001);
        await command(
          "docker",
          ["network", "disconnect", networkName, services.minio.container.getId()],
          process.env,
        );
        assert.equal(await probe("ready"), 503);
        assert.equal(await probe("health"), 200);
        await command(
          "docker",
          ["network", "connect", "--alias", "s3", networkName, services.minio.container.getId()],
          process.env,
        );
        await until(async () => (await probe("ready")) === 200, "S3 readiness recovered");
        await command(
          "docker",
          [
            "exec",
            containerName,
            "python",
            "-c",
            "import socket; s=socket.socket();s.settimeout(1)\ntry: s.connect(('1.1.1.1',80));raise SystemExit('Unexpected network access')\nexcept OSError: pass\nfinally: s.close()",
          ],
          process.env,
        );
        await mkdir(path.join(root, ".local/asr-batch"), { recursive: true });
        await writeFile(
          path.join(root, ".local/asr-batch/container-evidence.json"),
          JSON.stringify({
            uid,
            model: "tiny",
            device: "cpu",
            computeType: "int8",
            actualAsr: true,
            actualVad: true,
            s3DisconnectedReady: 503,
            liveness: 200,
            recoveryReady: 200,
            externalNetworkDenied: true,
            sourceSha256: sourceHash,
          }),
        );
        await command("docker", ["stop", "--time", "5", containerName], process.env);
      }
      const python = ["run", "--no-sync", "--project", "workers/ai-worker", "python"];
      for (const analyzer of process.env.EDITAGENT_TEST_ASR_CONTAINER === "1"
        ? []
        : ["transcript", "speech"]) {
        await command(
          "uv",
          [
            ...python,
            "-c",
            `import asyncio; from editagent_ai_worker.infrastructure.job_queue import BullMqConsumer,run_analysis_handler
async def run():
 c=BullMqConsumer(${JSON.stringify(services.redis.url)},${JSON.stringify(services.postgres.url)},"media-analysis-v1-${analyzer}",30000,run_analysis_handler)
 try:
  result=await c.consume_one()
  assert result["status"]=="Completed",result
 finally: await c.close()
asyncio.run(run())`,
          ],
          env,
        ).catch(async (error) => {
          await privateAsrDiagnostic(
            "analysis-failure",
            (
              await pool.query(
                "SELECT analyzer,configuration,result_attempt,failure FROM analysis_tasks",
              )
            ).rows,
          );
          throw error;
        });
      }
      // Real durable failed acoustic Job; other production analyzer receipts survive.
      const jobs = new PostgresJobRepository(pool);
      const task = (await pool.query("SELECT job_id FROM analysis_tasks WHERE analyzer='audio'"))
        .rows[0];
      const queued = await jobs.findById(jobId(task.job_id));
      const running = queued.start(BigInt(Date.now()));
      await jobs.save(running);
      await jobs.save(running.fail(BigInt(Date.now() + 1), "Analysis input is invalid."));
      await store.recover(queue);
      let document = validateMediaAnalysisV1_1(await store.read(asset, project, sourceHash));
      assert.equal(document.sections.transcript.status, "completed");
      assert.equal(document.sections.audio.status, "failed");
      const before = JSON.stringify(document.sections.transcript);
      const legacy = validateMediaAnalysisV1({ ...document, schemaVersion: "1.0.0" });
      await pool.query("UPDATE media_analyses SET document=$2 WHERE media_asset_id=$1", [
        asset,
        legacy,
      ]);
      assert.equal((await store.read(asset, project, sourceHash)).schemaVersion, "1.0.0");
      const rerun = await store.retry(asset, project, "audio", task.job_id);
      await store.recover(queue);
      // Run the acoustic retry through the actual production queue/supervisor/handler.
      await command(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import {Pool} from 'pg';
        import {randomBytes} from 'node:crypto';
        import {BullMqJobQueue,PostgresJobRepository,runNextJob} from './packages/job-queue/dist/index.js';
        import {createUuidV7,instant} from './packages/domain/dist/index.js';
        import {ChildProcessJobSupervisor} from './workers/media-worker/dist/infrastructure/child-job-supervisor.js';
        const pool=new Pool({connectionString:process.env.DATABASE_URL});
        const queue=new BullMqJobQueue(process.env.REDIS_URL);
        try {
          const deps={jobs:new PostgresJobRepository(pool),queue,supervisor:new ChildProcessJobSupervisor(),now:()=>instant(BigInt(Date.now())),newAttemptId:()=>createUuidV7(Date.now(),randomBytes(10))};
          const deadline=Date.now()+60000;
          while(Date.now()<deadline) {
            await runNextJob(deps,'media-analysis-v1-audio',{modulePath:${JSON.stringify(path.join(root, "workers/media-worker/dist/handlers/analysis-audio.js"))},exportName:'handleAudioAnalysis'});
            const row=(await pool.query('SELECT status FROM jobs WHERE id=$1',[${JSON.stringify(rerun)}])).rows[0];
            if(row.status==='Completed') break;
            if(row.status==='Failed') throw new Error('Acoustic production handler failed');
          }
          if((await pool.query('SELECT status FROM jobs WHERE id=$1',[${JSON.stringify(rerun)}])).rows[0].status!=='Completed') throw new Error('Acoustic queue did not converge');
        } finally {await queue.close(true);await pool.end();}
      `,
        ],
        env,
      );
      await Promise.all([store.recover(queue), new PostgresAnalysis(pool).recover(queue)]);
      document = validateMediaAnalysisV1_1(await store.read(asset, project, sourceHash));
      assert.equal(document.sections.audio.status, "completed");
      assert.ok(document.sections.audio.data.speech);
      assert.equal(JSON.stringify(document.sections.transcript), before);
      const media = new PostgresMediaAssetRepository(pool);
      const getter = new GetMediaAnalysis(
        new GetMediaDetails(new PostgresProjectRepository(pool), media),
        store,
        media,
      );
      await getter.execute(userId(owner), projectId(project), mediaAssetId(asset));
      await assert.rejects(getter.execute(userId(id()), projectId(project), mediaAssetId(asset)));
      // Exercise the real HTTP controller and production bearer-token middleware,
      // retaining the same session across membership revocation.
      const tokens = new JwtSessionTokens(randomBytes(32).toString("hex"));
      const access = await tokens.issueAccess(userId(editor), BigInt(Date.now()));
      app = await createApiApplication(
        {
          projects: new PostgresProjectRepository(pool),
          media,
          analysis: store,
          clock: { now: () => BigInt(Date.now()) },
          ids: { next: id },
          mediaIds: { next: id },
          objects: {},
          presignTtlSeconds: 900,
        },
        (use) => use(authenticateRequest(tokens, () => BigInt(Date.now()))),
      );
      await app.listen(0, "127.0.0.1");
      const apiUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
      const headers = { Authorization: `Bearer ${access.token}` };
      assert.equal((await fetch(`${apiUrl}/media/${asset}/analysis`)).status, 401);
      const response = await fetch(`${apiUrl}/media/${asset}/analysis`, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(validateMediaAnalysisV1_1(await response.json()), document);
      assert.equal(
        (await fetch(`${apiUrl}/projects/${id()}/media/${asset}/analysis`, { headers })).status,
        404,
      );
      await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [
        project,
        editor,
      ]);
      await assert.rejects(getter.executeForAsset(userId(editor), mediaAssetId(asset)));
      assert.equal((await fetch(`${apiUrl}/media/${asset}/analysis`, { headers })).status, 404);
      await app.close();
      app = undefined;
      // Real SIGKILL during native inference: restart must retain the durable attempt
      // identity, reclaim the lease, stop the orphan child and complete exactly once.
      const priorTranscript = (
        await pool.query(
          "SELECT job_id FROM analysis_tasks WHERE analyzer='transcript' ORDER BY generation DESC LIMIT 1",
        )
      ).rows[0].job_id;
      const crashJob = await store.retry(asset, project, "transcript", priorTranscript, owner);
      // A rolling-upgrade worker must not acknowledge a new-algorithm intent
      // with absent or old implementation metadata, even if the section itself
      // is otherwise valid. Exercise the actual deferred PostgreSQL fence.
      for (const parameters of [
        null,
        { asr: { alignmentAlgorithm: "ct2-contextual-v5" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v6" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v7" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v8" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v9" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v12" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v13" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v14" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v15" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v16" } },
        { asr: { alignmentAlgorithm: "ct2-contextual-v17" } },
      ]) {
        const connection = await pool.connect();
        try {
          await connection.query("BEGIN");
          await connection.query("UPDATE jobs SET status='Running',attempt_count=1 WHERE id=$1", [
            crashJob,
          ]);
          await connection.query(
            "UPDATE analysis_tasks SET result=$2,result_attempt=1,inference_parameters=$3 WHERE job_id=$1",
            [crashJob, document.sections.transcript, parameters],
          );
          await assert.rejects(
            connection.query("COMMIT"),
            (error) =>
              error.code === "23514" && error.message === "Analysis runtime version mismatch",
          );
        } finally {
          await connection.query("ROLLBACK");
          connection.release();
        }
        const fenced = (
          await pool.query(
            "SELECT j.status,t.result,t.inference_parameters FROM jobs j JOIN analysis_tasks t ON t.job_id=j.id WHERE j.id=$1",
            [crashJob],
          )
        ).rows[0];
        assert.equal(fenced.status, "Queued");
        assert.equal(fenced.result, null);
        assert.equal(fenced.inference_parameters, null);
      }
      await store.recover(queue);
      const crashing = consumer(env, "transcript");
      const childInfo = await until(() => {
        const line = crashing
          .diagnostics()
          .split("\n")
          .find((line) => line.includes('"event": "analysis.inference.started"'));
        return line ? JSON.parse(line) : null;
      }, "native inference active");
      assert.equal(
        (await pool.query("SELECT status FROM jobs WHERE id=$1", [crashJob])).rows[0].status,
        "Running",
      );
      crashing.child.kill("SIGKILL");
      assert.equal((await crashing.exit).signal, "SIGKILL");
      await until(() => notRunning(childInfo.pid), "parent-death child termination");
      await new PostgresAnalysis(pool).recover(queue);
      const restarted = consumer(env, "transcript");
      assert.equal((await restarted.exit).code, 0, restarted.diagnostics());
      assert.equal(
        JSON.parse(restarted.output()).status,
        "Completed",
        restarted.diagnostics() +
          JSON.stringify(
            (
              await pool.query("SELECT status,failure_reason,attempt_count FROM jobs WHERE id=$1", [
                crashJob,
              ])
            ).rows,
          ),
      );
      const crashState = (
        await pool.query(
          "SELECT j.status,j.attempt_count,t.result_attempt,t.result,t.inference_parameters FROM jobs j JOIN analysis_tasks t ON t.job_id=j.id WHERE j.id=$1",
          [crashJob],
        )
      ).rows[0];
      assert.equal(crashState.status, "Completed");
      assert.equal(crashState.attempt_count, 2);
      assert.equal(crashState.result_attempt, 2);
      assert.ok(crashState.result);
      // The production image and the restarted real native consumer must retain
      // every canonical word, timestamp, confidence and provenance field.
      assert.deepEqual(crashState.result, document.sections.transcript);
      await assert.rejects(
        pool.query("UPDATE analysis_tasks SET inference_parameters=$2 WHERE job_id=$1", [
          crashJob,
          { asr: { alignmentAlgorithm: "ct2-contextual-v5" } },
        ]),
        (error) => error.code === "23514" && error.message === "Analysis result is immutable",
      );
      await store.recover(queue);
      // Cancellation through the real queue path while native ASR is active.
      const cancelJob = await store.retry(asset, project, "transcript", crashJob, owner);
      await store.recover(queue);
      const cancelling = consumer(env, "transcript");
      const cancelChild = await until(() => {
        const line = cancelling
          .diagnostics()
          .split("\n")
          .find((line) => line.includes('"event": "analysis.inference.started"'));
        return line ? JSON.parse(line) : null;
      }, "cancellable native inference active");
      await queue.requestCancel(cancelJob);
      assert.equal((await cancelling.exit).code, 0, cancelling.diagnostics());
      assert.equal(JSON.parse(cancelling.output()).status, "Cancelled");
      await until(() => notRunning(cancelChild.pid), "cancelled native child termination");
      assert.equal(
        (await pool.query("SELECT result FROM analysis_tasks WHERE job_id=$1", [cancelJob])).rows[0]
          .result,
        null,
      );
      await store.recover(queue);
      // Deferred admission must reject a late receipt and a terminal write must
      // remain distinguishable; no stale worker can resurrect this cancellation.
      await assert.rejects(
        pool.query(
          "UPDATE analysis_tasks SET result=$2,result_attempt=1,inference_parameters=$3 WHERE job_id=$1",
          [cancelJob, crashState.result, crashState.inference_parameters],
        ),
        (error) => error.code === "23514" && error.message === "Analysis result admission fenced",
      );
      assert.equal(
        (await pool.query("UPDATE jobs SET status='Running' WHERE id=$1", [cancelJob])).rowCount,
        0,
      );
      await assert.rejects(store.retry(asset, project, "transcript", cancelJob, id()));
      // Kill admission after its PG transaction, before any Redis publication.
      // A second validated source shares fixture bytes, never fabricated results.
      const deadlineProject = id(),
        deadlineAsset = id();
      await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Deadline fixture',0,0)",
        [deadlineProject],
      );
      await pool.query(
        "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'owner',0)",
        [deadlineProject, owner],
      );
      const deadlineKey = original.replace(project, deadlineProject);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: deadlineKey, Body: sourceBytes }));
      await pool.query(
        "INSERT INTO media_assets SELECT (jsonb_populate_record(NULL::media_assets,to_jsonb(m)||$2::jsonb)).* FROM media_assets m WHERE id=$1",
        [
          asset,
          JSON.stringify({
            id: deadlineAsset,
            project_id: deadlineProject,
            storage_key: deadlineKey,
          }),
        ],
      );
      // Same immutable input bytes may back distinct owned derived identities.
      // Deadline recovery must fence the job before any inference can read them.
      for (const d of (
        await pool.query("SELECT id,storage_key FROM derived_assets WHERE media_asset_id=$1", [
          asset,
        ])
      ).rows) {
        const key = d.storage_key.replace(project, deadlineProject).replace(asset, deadlineAsset);
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: key,
            CopySource: `${bucket}/${d.storage_key}`,
          }),
        );
        await pool.query(
          "INSERT INTO derived_assets SELECT (jsonb_populate_record(NULL::derived_assets,to_jsonb(d)||$2::jsonb)).* FROM derived_assets d WHERE id=$1",
          [
            d.id,
            JSON.stringify({
              id: id(),
              media_asset_id: deadlineAsset,
              project_id: deadlineProject,
              storage_key: key,
            }),
          ],
        );
      }
      const admission = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import {Pool} from 'pg';
        import {PostgresAnalysis,analysisConfiguration} from '@editagent/analysis-core';
        const pool=new Pool({connectionString:process.env.DATABASE_URL});
        await new PostgresAnalysis(pool).discover(analysisConfiguration({EDITAGENT_ASR_MODEL:'tiny',EDITAGENT_ASR_TIMEOUT_MS:'1000'}));
        process.kill(process.pid,'SIGKILL');
      `,
        ],
        { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] },
      );
      const admissionSignal = await new Promise((resolve, reject) => {
        admission.once("error", reject);
        admission.once("exit", (_code, signal) => resolve(signal));
      });
      assert.equal(admissionSignal, "SIGKILL");
      const pending = (
        await pool.query(
          "SELECT t.job_id,t.published,j.status FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id WHERE t.media_asset_id=$1 AND t.analyzer='transcript'",
          [deadlineAsset],
        )
      ).rows[0];
      assert.equal(pending.status, "Queued");
      assert.equal(pending.published, false);
      await command("docker", ["pause", services.redis.container.getId()], process.env);
      try {
        const started = Date.now();
        await new PostgresAnalysis(pool).recover(queue);
        assert.ok(Date.now() - started < 8000, "Recovery remains bounded while Redis is paused");
      } finally {
        await command("docker", ["unpause", services.redis.container.getId()], process.env);
      }
      await until(async () => {
        await Promise.all([store.recover(queue), new PostgresAnalysis(pool).recover(queue)]);
        return (
          (await pool.query("SELECT status FROM jobs WHERE id=$1", [pending.job_id])).rows[0]
            .status === "Cancelled"
        );
      }, "expired admission converges after Redis resumes");
      // A late broker delivery sees the durable cancellation and cannot infer.
      const lateJob = await new PostgresJobRepository(pool).findById(jobId(pending.job_id));
      await queue.enqueue({
        id: lateJob.id,
        queueName: lateJob.queueName,
        jobType: lateJob.jobType,
        idempotencyKey: lateJob.idempotencyKey,
        subject: lateJob.subject,
        payload: lateJob.payload,
        timeoutMs: lateJob.timeoutMs,
        maxAttempts: lateJob.maxAttempts,
        backoffBaseMs: 1000,
      });
      const expiredConsumer = consumer(env, "transcript");
      assert.equal((await expiredConsumer.exit).code, 0, expiredConsumer.diagnostics());
      assert.equal(JSON.parse(expiredConsumer.output()).status, "Cancelled");
      assert.ok(!expiredConsumer.diagnostics().includes("analysis.inference.started"));
      const expired = (
        await pool.query("SELECT result,failure,applied FROM analysis_tasks WHERE job_id=$1", [
          pending.job_id,
        ])
      ).rows[0];
      assert.equal(expired.result, null);
      assert.equal(expired.failure.code, "timeout");
      assert.equal(expired.applied, true);
      const timeoutJob = await store.retry(
        deadlineAsset,
        deadlineProject,
        "transcript",
        pending.job_id,
        owner,
      );
      await store.recover(queue);
      const timedConsumer = consumer(env, "transcript");
      assert.equal((await timedConsumer.exit).code, 0, timedConsumer.diagnostics());
      assert.equal(JSON.parse(timedConsumer.output()).status, "Failed");
      const timedState = (
        await pool.query("SELECT status,attempt_count,failure_reason FROM jobs WHERE id=$1", [
          timeoutJob,
        ])
      ).rows[0];
      assert.equal(
        timedState.attempt_count,
        1,
        "An exhausted absolute deadline cannot admit another attempt",
      );
      assert.equal(timedState.failure_reason, "timed out");
      await store.recover(queue);
      assert.equal(
        (
          await pool.query("SELECT result,failure FROM analysis_tasks WHERE job_id=$1", [
            timeoutJob,
          ])
        ).rows[0].result,
        null,
      );
      assert.equal(
        validateMediaAnalysisV1_1(await store.read(deadlineAsset, deadlineProject, sourceHash))
          .sections.transcript.failure.code,
        "timeout",
      );
      await pool.query(
        "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'editor',0)",
        [project, editor],
      );
      const revokedJob = await store.retry(asset, project, "transcript", cancelJob, editor);
      await store.recover(queue);
      const revokedConsumer = consumer(env, "transcript");
      const revokedChild = await until(() => {
        const line = revokedConsumer
          .diagnostics()
          .split("\n")
          .find((line) => line.includes('"event": "analysis.inference.started"'));
        return line ? JSON.parse(line) : null;
      }, "authorized inference active before revocation");
      await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [
        project,
        editor,
      ]);
      assert.equal((await revokedConsumer.exit).code, 0, revokedConsumer.diagnostics());
      assert.equal(JSON.parse(revokedConsumer.output()).status, "Failed");
      assert.equal(
        (await pool.query("SELECT result FROM analysis_tasks WHERE job_id=$1", [revokedJob]))
          .rows[0].result,
        null,
      );
      await until(() => notRunning(revokedChild.pid), "revoked inference process reaped");
      await store.recover(queue);
      const noAudioFile = path.join(temp, "no-audio.mp4");
      await command(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:size=160x120:rate=30:duration=0.5",
          "-an",
          "-c:v",
          "libx264",
          "-threads:v",
          "1",
          "-pix_fmt",
          "yuv420p",
          noAudioFile,
        ],
        process.env,
      );
      const noAudioBytes = await readFile(noAudioFile),
        noAudioHash = createHash("sha256").update(noAudioBytes).digest("hex"),
        noAudioId = id();
      const noAudioKey = `projects/${project}/media/sha256/${noAudioHash}`;
      const noAudioProbe = await new FFprobeMediaProbe().inspect({ filePath: noAudioFile });
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: noAudioKey, Body: noAudioBytes }));
      await pool.query(
        "INSERT INTO media_assets SELECT (jsonb_populate_record(NULL::media_assets,to_jsonb(m)||$2::jsonb)).* FROM media_assets m WHERE id=$1",
        [
          asset,
          JSON.stringify({
            id: noAudioId,
            storage_key: noAudioKey,
            content_sha256: noAudioHash,
            byte_size: noAudioBytes.length,
            validation_source_sha256: noAudioHash,
            duration: "500000",
            audio_codec: null,
            sample_rate: null,
            audio_channels: null,
            streams: noAudioProbe.streams,
          }),
        ],
      );
      await store.discover(analysisConfiguration({ EDITAGENT_ASR_MODEL: "tiny" }));
      const unsupported = validateMediaAnalysisV1_1(
        await store.read(noAudioId, project, noAudioHash),
      );
      assert.equal(unsupported.sections.metadata.status, "completed");
      assert.equal(unsupported.sections.transcript.failure.code, "unsupported");
      assert.equal(unsupported.sections.audio.failure.code, "unsupported");
      assert.equal(
        (
          await pool.query("SELECT count(*) FROM analysis_tasks WHERE media_asset_id=$1", [
            noAudioId,
          ])
        ).rows[0].count,
        "0",
      );
      const originalAfter = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: original }));
      assert.equal(
        createHash("sha256")
          .update(await originalAfter.Body.transformToByteArray())
          .digest("hex"),
        sourceHash,
      );
      console.log(
        "ANALYSIS_REAL_SERVICES",
        JSON.stringify({
          automaticDerivation: true,
          transcript: "completed",
          speech: "completed",
          partialFailure: true,
          rerun: true,
          concurrentRecovery: true,
          coordinatorSigkillRecovered: true,
          nativeChildStopped: true,
          liveQueueCancellation: true,
          staleReceiptFenced: true,
          admissionSigkillRecovered: true,
          redisPauseDeadlineFenced: true,
          expiredDeadlineDoesNotRetry: true,
          noAudioFailsExplicitly: true,
          sourceImmutable: true,
          revocationDenied: true,
          revocationDuringInferenceFenced: true,
        }),
      );
    } finally {
      await app?.close();
      if (containerName) {
        await command("docker", ["logs", "--tail", "30", containerName], process.env)
          .then((log) => privateAsrDiagnostic("container-log", log))
          .catch(() => undefined);
        await command(
          "docker",
          [
            "exec",
            containerName,
            "python",
            "-c",
            `import os,json
from editagent_ai_worker.infrastructure.readiness import dependencies_ready,storage_ready
print(json.dumps({"readyFile":os.path.isfile('/tmp/editagent.ready'),"pgRedis":dependencies_ready(os.environ['DATABASE_URL'],os.environ['REDIS_URL']),"s3":storage_ready(os.environ['S3_ENDPOINT'],os.environ['S3_REGION'],os.environ['S3_BUCKET'],os.environ['S3_ACCESS_KEY_ID'],os.environ['S3_SECRET_ACCESS_KEY'])}))`,
          ],
          process.env,
        )
          .then((log) => privateAsrDiagnostic("container-dependencies", log))
          .catch(() => undefined);
      }
      if (containerName)
        await command("docker", ["rm", "-f", containerName], process.env).catch(() => undefined);
      await queue?.close(true);
      s3?.destroy();
      await pool?.end();
      await services?.close();
      if (networkName)
        await command("docker", ["network", "rm", networkName], process.env).catch(() => undefined);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
