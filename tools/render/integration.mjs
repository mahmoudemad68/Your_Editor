import { createRequire } from "node:module";
import { URL } from "node:url";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";
/** No skipped Docker tests: exact production images, real queue, Chromium, FFprobe and S3. */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { startIntegrationServices } from "../../tests/integration/support/containers.mjs";
import { buildRenderImages } from "./build.mjs";
import {
  solidHash,
  verifyGoldenFrames,
  verifyAudioOffsets,
  verifySeparateAudioTrack,
} from "./golden-frames.mjs";
const root = new URL("../../", import.meta.url).pathname;
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 2097152 });
const nonce = randomBytes(6).toString("hex"),
  network = "render-proof-" + nonce,
  executor = "render-executor-" + nonce,
  coordinator = "render-coordinator-" + nonce,
  work = "render-work-" + nonce,
  control = "render-control-" + nonce;
if (!process.argv.includes("--no-build")) await buildRenderImages();
const services = await startIntegrationServices();
const s3 = new S3Client({
  endpoint: services.minio.endpoint,
  region: services.minio.region,
  credentials: services.minio.credentials,
  forcePathStyle: true,
});
const pool = new Pool({ connectionString: services.postgres.url });
try {
  for (const f of (await readdir(root + "apps/api/migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await pool.query(await readFile(root + "apps/api/migrations/" + f, "utf8"));
  await s3.send(new CreateBucketCommand({ Bucket: "editagent" }));
  docker(["network", "create", "--internal", network]);
  for (const [alias, service] of Object.entries(services).filter(([k]) =>
    ["postgres", "redis", "minio"].includes(k),
  ))
    docker(["network", "connect", "--alias", alias, network, service.container.getId()]);
  for (const [name, size] of [
    [work, "2147483648"],
    [control, "8388608"],
  ])
    docker([
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=tmpfs",
      "--opt",
      "device=tmpfs",
      "--opt",
      `o=size=${size},uid=10001,gid=10001,mode=0700,nosuid,nodev,noexec`,
      name,
    ]);
  const limits = [
    "--user",
    "10001:10001",
    "--init",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--ulimit",
    "fsize=1073741824:1073741824",
    "--ulimit",
    "nofile=1024:1024",
    "--mount",
    `type=volume,source=${work},target=/render-work`,
    "--mount",
    `type=volume,source=${control},target=/run/render`,
  ];
  docker([
    "run",
    "-d",
    "--name",
    executor,
    ...limits,
    "--network",
    "none",
    "--cpus",
    "2",
    "--memory",
    "6g",
    "--memory-swap",
    "6g",
    "--pids-limit",
    "256",
    "--shm-size",
    "1g",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=2147483648,mode=1777",
    "editagent-render-executor:test",
  ]);
  const database = new URL(services.postgres.url);
  database.hostname = "postgres";
  database.port = "5432";
  const environment = {
    DATABASE_URL: database.toString(),
    REDIS_URL: "redis://redis:6379",
    S3_ENDPOINT: "http://minio:9000",
    S3_BUCKET: "editagent",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: services.minio.credentials.accessKeyId,
    S3_SECRET_ACCESS_KEY: services.minio.credentials.secretAccessKey,
    EDITAGENT_RENDER_QUEUE: "render-idle",
  };
  docker([
    "run",
    "-d",
    "--name",
    coordinator,
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
    "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
    ...Object.entries(environment).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "editagent-render-coordinator:test",
  ]);
  const inspect = JSON.parse(docker(["inspect", executor]))[0];
  assert.equal(inspect.Config.User, "10001:10001");
  assert.equal(inspect.HostConfig.NetworkMode, "none");
  assert.equal(inspect.HostConfig.Privileged, false);
  assert.deepEqual(inspect.HostConfig.CapDrop, ["ALL"]);
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.PidsLimit, 256);
  assert.ok(inspect.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.ok(
    !inspect.HostConfig.SecurityOpt.some((x) => x.startsWith("seccomp=")),
    "Docker default seccomp must remain in force",
  );
  assert.ok(inspect.Mounts.every((x) => x.Type === "volume"));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      if (
        docker(["inspect", "--format", "{{.State.Health.Status}}", coordinator]).trim() ===
        "healthy"
      )
        break;
    } catch {
      /* cleanup tolerates already removed test resources */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(
    docker(["inspect", "--format", "{{.State.Health.Status}}", coordinator]).trim(),
    "healthy",
    docker(["logs", executor]),
  );
  const artifactDir = root + ".local/render-batch";
  await mkdir(artifactDir, { recursive: true });
  // Fixed samples and analytic expected hashes exist before any timeline render.
  const expectedBlack = solidHash(0),
    expectedWhite = solidHash(255);
  const sourceFile = artifactDir + "/black-white-source.mp4";
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=64x64:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=white:s=64x64:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=1",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:a",
    "aac",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "1",
    sourceFile,
  ]);
  const sourceBytes = await readFile(sourceFile),
    sha = createHash("sha256").update(sourceBytes).digest("hex");
  const { createUuidV7 } = createRequire(
    new URL("../../workers/render-worker/package.json", import.meta.url),
  )("@editagent/domain");
  const newId = () => createUuidV7(Date.now(), randomBytes(10)),
    fixtureProject = newId(),
    fixtureSource = newId();
  const sourceKey = `projects/${fixtureProject}/media/sha256/${sha}`;
  await pool.query(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Timeline proof',0,0)",
    [fixtureProject],
  );
  await pool.query(
    `INSERT INTO media_assets(id,project_id,kind,storage_key,display_filename,mime_type,byte_size,content_sha256,upload_state,duration,created_at,updated_at,inspection_status,container,video_codec,audio_codec,audio_channels,sample_rate,width,height,frame_rate_numerator,frame_rate_denominator,frame_rate_mode,validation_status,validation_policy_signature,validation_source_sha256,validation_checked_at)
     VALUES($1,$2,'video',$3,'black-white.mp4','video/mp4',$4,$5,'uploaded',2000000,0,0,'completed','mp4','h264','aac',1,48000,64,64,30,1,'constant','validated',$6,$5,0)`,
    [fixtureSource, fixtureProject, sourceKey, sourceBytes.length, sha, "a".repeat(64)],
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: "editagent",
      Key: sourceKey,
      Body: sourceBytes,
      ContentType: "video/mp4",
    }),
  );
  docker([
    "exec",
    executor,
    "node",
    "-e",
    `const assert=require('node:assert/strict');Promise.all(['http://169.254.169.254','http://1.1.1.1','http://minio:9000'].map(async u=>{let reached=false;try{await fetch(u,{signal:AbortSignal.timeout(500)});reached=true;}catch{}assert.equal(reached,false,'Network egress must fail');})).catch(e=>{console.error(e);process.exitCode=1;});`,
  ]);
  let missingControlsRejected = false;
  try {
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "10001:10001",
      "--read-only",
      "--cap-drop",
      "ALL",
      "editagent-render-executor:test",
      "node",
      "-e",
      "require('./dist/infrastructure/security.js').assertRenderIsolation()",
    ]);
  } catch {
    missingControlsRejected = true;
  }
  assert.equal(
    missingControlsRejected,
    true,
    "Missing mandatory isolation controls must prevent startup",
  );
  const script = await readFile(new URL("./proof.cjs", import.meta.url), "utf8");
  async function runProof(script) {
    return await new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", coordinator, "node"], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 600000);
      let text = "";
      child.stdout.on("data", (b) => {
        text += b;
        process.stdout.write(b);
      });
      child.once("error", (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(watchdog);
        if (code === 0) resolve(text);
        else reject(new Error("Production render proof failed " + code));
      });
      child.stdin.end(script);
    });
  }
  const output = await runProof(script);
  function parseEvidence(output, marker) {
    const line = output.split("\n").find((x) => x.startsWith(marker + " "));
    assert.ok(line, "Production proof did not return " + marker);
    return JSON.parse(line.slice(marker.length + 1));
  }
  const report = parseEvidence(output, "RENDER_EVIDENCE");
  const timelineScript =
    `require('node:process').env.EDITAGENT_PROOF_PROJECT=${JSON.stringify(fixtureProject)};require('node:process').env.EDITAGENT_PROOF_SOURCE=${JSON.stringify(fixtureSource)};\n` +
    (await readFile(new URL("./timeline-proof.cjs", import.meta.url), "utf8"));
  const timelineOutput = await runProof(timelineScript);
  const timelineReport = parseEvidence(timelineOutput, "TIMELINE_EVIDENCE");
  timelineReport.expectedBlack = expectedBlack;
  timelineReport.expectedWhite = expectedWhite;
  for (const artifact of timelineReport.artifacts) {
    const object = await s3.send(new GetObjectCommand({ Bucket: "editagent", Key: artifact.key }));
    const file = artifactDir + "/" + artifact.label + ".mp4";
    await writeFile(file, await object.Body.transformToByteArray());
    const details = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
        { encoding: "utf8" },
      ),
    );
    const v = details.streams.find((x) => x.codec_type === "video");
    assert.equal(v.width, 64);
    assert.equal(v.height, 64);
    assert.equal(v.avg_frame_rate, artifact.label === "fractional-cut" ? "30000/1001" : "30/1");
    artifact.ffprobe = {
      fps: v.avg_frame_rate,
      width: v.width,
      height: v.height,
      duration: details.format.duration,
      codec: v.codec_name,
      audio: details.streams.find((x) => x.codec_type === "audio")?.codec_name,
    };
    artifact.goldenFrames = verifyGoldenFrames(file, artifact.label);
    if (artifact.label === "cut-offset-gap") artifact.audioOffsets = verifyAudioOffsets(file);
    if (artifact.label === "audio-track-offset")
      artifact.audioOffsets = verifySeparateAudioTrack(file);
  }
  report.timeline = timelineReport;
  const expatVersion = docker([
    "exec",
    executor,
    "node",
    "-e",
    "const fs=require('node:fs');const b=fs.readFileSync('/usr/local/lib/libexpat.so.1');if(!b.includes(Buffer.from('expat_2.9.0')))throw new Error('Unexpected Expat version');console.log(JSON.stringify({version:'2.9.0',sha256:require('node:crypto').createHash('sha256').update(b).digest('hex')}))",
  ]);
  assert.ok(
    report.firstProcesses.some((p) => p.expatLibrary?.startsWith("/usr/local/lib/libexpat.so.1")),
    "Real Chrome must load the fixed Expat library",
  );
  const browsers = report.firstProcesses.filter((p) =>
    p.argv?.some((a) => a.includes("chrome-headless-shell")),
  );
  assert.ok(browsers.length > 0 && browsers.every((p) => p.uid === "10001"));
  const coordinatorIdentity = docker([
    "exec",
    coordinator,
    "node",
    "-p",
    "process.getuid()+':'+process.getgid()",
  ]).trim();
  assert.equal(coordinatorIdentity, "10001:10001");
  report.versions = {
    chromium: docker([
      "exec",
      executor,
      "/opt/chromium/chrome-headless-shell-linux64/chrome-headless-shell",
      "--version",
    ]).trim(),
    ffmpeg: docker(["exec", coordinator, "ffmpeg", "-version"]).split("\n")[0],
    ffprobe: docker(["exec", coordinator, "ffprobe", "-version"]).split("\n")[0],
    node: docker(["exec", coordinator, "node", "--version"]).trim(),
    remotion: docker([
      "exec",
      coordinator,
      "node",
      "-p",
      "require('remotion/package.json').version",
    ]).trim(),
    react: docker([
      "exec",
      coordinator,
      "node",
      "-p",
      "require('react/package.json').version",
    ]).trim(),
  };
  assert.match(report.versions.chromium, /157\.0\.8080\.0/);
  report.security = {
    chromiumNoSandbox: browsers.some((p) => p.argv.includes("--no-sandbox")),
    chromiumDisableSetuidSandbox: browsers.some((p) => p.argv.includes("--disable-setuid-sandbox")),
    expat: JSON.parse(expatVersion),
    missingControlsRejected,
    networkEgressRejected: true,
    productionUid: 10001,
    coordinatorIdentity,
    noHostBindMounts: true,
  };
  // Independent process-identity proof after cancellation, in the browser's PID namespace.
  const check = `const fs=require('node:fs');const ids=${JSON.stringify([...report.cancellationProcesses, ...report.timeoutProcesses])};for(const p of ids){try{const f=fs.readFileSync('/proc/'+p.pid+'/stat','utf8').split(') ')[1].split(' ');if(f[19]===p.start)throw new Error('Browser/renderer PID survives cancellation');}catch(e){if(e.code!=='ENOENT')throw e;}}if(fs.readdirSync('/tmp').some(x=>x.startsWith('render-')))throw new Error('Temporary workspace leaked');`;
  docker(["exec", executor, "node", "-e", check]);
  const dir = root + ".local/render-batch";
  await mkdir(dir, { recursive: true });
  const object = await s3.send(
    new GetObjectCommand({ Bucket: "editagent", Key: report.outputKey }),
  );
  await writeFile(dir + "/fixture.mp4", await object.Body.transformToByteArray());
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", dir + "/fixture.mp4"],
      { encoding: "utf8" },
    ),
  );
  const video = probe.streams.find((x) => x.codec_type === "video");
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(video.avg_frame_rate, "30/1");
  assert.ok(Math.abs(Number(probe.format.duration) - 5) <= 1 / 60);
  assert.equal(video.codec_name, "h264");
  // A decodable H.264 file in the wrong container must never pass the MP4 contract.
  const wrongContainer = dir + "/wrong-container.mkv";
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    dir + "/fixture.mp4",
    "-c",
    "copy",
    "-f",
    "matroska",
    wrongContainer,
  ]);
  // docker cp cannot write through a read-only root even when /tmp is tmpfs.
  // Stream the test bytes to the existing non-root process instead; keep all
  // production filesystem restrictions in force.
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      coordinator,
      "node",
      "-e",
      "require('node:fs').writeFileSync('/tmp/wrong-container.mkv',require('node:fs').readFileSync(0),{flag:'wx',mode:0o600})",
    ],
    { input: await readFile(wrongContainer) },
  );
  docker([
    "exec",
    coordinator,
    "node",
    "-e",
    `const fs=require('node:fs/promises');const assert=require('node:assert/strict');const {validateOutput}=require('./dist/infrastructure/probe-output.js');const catalog=require('./dist/bundle/catalog.json');(async()=>{try{await assert.rejects(validateOutput('/tmp/wrong-container.mkv',{schemaVersion:1,renderVersion:catalog.renderVersion,compositionId:'FixtureV1',correlationId:'container-negative',width:320,height:180,frameRate:{numerator:30,denominator:1},durationInFrames:150,props:{title:'Container test',background:'#000000'}}));}finally{await fs.rm('/tmp/wrong-container.mkv',{force:true});}})().catch(()=>process.exitCode=1);`,
  ]);
  report.wrongContainerRejected = true;
  report.ffprobe = {
    duration: probe.format.duration,
    width: video.width,
    height: video.height,
    fps: video.avg_frame_rate,
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
  };
  report.container = {
    uid: inspect.Config.User,
    network: "none",
    capDrop: inspect.HostConfig.CapDrop,
    memory: inspect.HostConfig.Memory,
    pids: inspect.HostConfig.PidsLimit,
    readOnly: true,
  };
  await writeFile(dir + "/report.json", JSON.stringify(report, null, 2) + "\n");
  console.log("Render integration PASS. Evidence: .local/render-batch/report.json");
} catch (error) {
  for (const name of [executor, coordinator]) {
    try {
      console.error(docker(["logs", "--tail", "20", name]));
    } catch {
      /* startup may not have created it */
    }
  }
  throw error;
} finally {
  await pool.end();
  s3.destroy();
  for (const name of [coordinator, executor])
    try {
      docker(["rm", "-f", name]);
    } catch {
      /* cleanup tolerates already removed test resources */
    }
  for (const name of [work, control])
    try {
      docker(["volume", "rm", name]);
    } catch {
      /* cleanup tolerates already removed test resources */
    }
  await services.close();
  try {
    docker(["network", "rm", network]);
  } catch {
    /* cleanup tolerates a network that was not created */
  }
}
