/** Real process suspension + PostgreSQL generations + real render/export.
 * The model is the existing deterministic fixture. No private IPC is reported. */
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";

const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));
async function until(check, label, milliseconds = 15000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(label);
}
function worker(root, env, input) {
  const messages = [];
  const child = fork(path.join(root, "tools/render/agent-lease-worker.mjs"), [], {
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.on("message", (message) => messages.push(message));
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => {
      messages.push({ phase: "fixture_failed" });
      resolve({ code: -1, signal: null });
    });
  });
  child.send(input);
  return { child, messages, exit };
}
export async function runAgentLeaseProof({
  root,
  hostEnv,
  pool,
  queue,
  renderContainer,
  createScenario,
  json,
  core,
  port,
  probe,
  privateDir,
  restore,
  onPhase,
}) {
  assert.equal(process.platform, "linux");
  const measurements = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const fixture = await createScenario(),
      processes = [],
      prefix = "qa88-lease-" + randomBytes(6).toString("hex");
    let paused = false;
    try {
      onPhase("a-wait");
      execFileSync("docker", ["pause", renderContainer], { stdio: "ignore" });
      paused = true;
      const a = worker(root, hostEnv, { ...fixture, worker: "A", applicationName: prefix + "-A" });
      processes.push(a);
      const waitingA = await until(
        async () => a.messages.find((m) => m.phase === "render_wait"),
        "worker_a_not_waiting",
      );
      const first = (
        await pool.query("SELECT state,generation,checkpoint FROM agent_runs WHERE id=$1", [
          fixture.runId,
        ])
      ).rows[0];
      assert.equal(first.state, "Rendering");
      assert.equal(first.generation, 1);
      assert.equal(first.checkpoint, 2);
      const noTransactions = async () =>
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND xact_start IS NOT NULL",
              [prefix + "-A"],
            )
          ).rows[0].count,
        ) === 0;
      assert(await noTransactions());
      const stoppedAt = Date.now();
      assert(a.child.kill("SIGSTOP"));
      await sleep(5500);
      assert(await noTransactions());
      onPhase("b-takeover");
      const b = worker(root, hostEnv, { ...fixture, worker: "B", applicationName: prefix + "-B" });
      processes.push(b);
      const waitingB = await until(
        async () => b.messages.find((m) => m.phase === "render_wait"),
        "worker_b_not_waiting",
      );
      assert.equal(waitingB.jobId, waitingA.jobId);
      const successor = (
        await pool.query("SELECT state,generation,checkpoint FROM agent_runs WHERE id=$1", [
          fixture.runId,
        ])
      ).rows[0];
      assert.equal(successor.state, "Rendering");
      assert.equal(successor.generation, 2);
      // Direct boundary call must also fail: repairing only loop control flow
      // would leave the independent cancellation entry point unsafe.
      await assert.rejects(
        port.cancel(fixture.runId, fixture.projectId, waitingA.jobId, 1),
        core.AgentError,
      );
      await assert.rejects(
        port.cancel(fixture.runId, fixture.projectId, waitingA.jobId, 2),
        core.AgentError,
      );
      const pausedMs = Date.now() - stoppedAt;
      assert(pausedMs >= 5500);
      onPhase("a-fenced");
      assert(a.child.kill("SIGCONT"));
      a.child.send({ command: "release" });
      await until(
        async () => a.messages.some((m) => m.phase === "fenced"),
        "old_worker_not_fenced",
      );
      const aExit = await a.exit;
      assert.equal(aExit.code, 0);
      assert.equal(await queue.isCancelRequested(waitingA.jobId), false);
      assert.equal(
        (await json(`/projects/${fixture.projectId}/exports/${waitingA.jobId}`)).status,
        "Queued",
      );
      assert.equal(
        (await json(`/projects/${fixture.projectId}/agent-runs/${fixture.runId}`)).state,
        "Rendering",
      );
      execFileSync("docker", ["unpause", renderContainer], { stdio: "ignore" });
      paused = false;
      b.child.send({ command: "release" });
      onPhase("b-complete");
      await until(
        async () => b.messages.some((m) => m.phase === "finished"),
        "successor_not_finished",
        90000,
      );
      assert.equal((await b.exit).code, 0);
      const completed = await json(`/projects/${fixture.projectId}/agent-runs/${fixture.runId}`);
      assert.equal(completed.state, "Completed");
      assert.equal(completed.generation, 2);
      assert.equal(completed.checkpoint, 2);
      assert.equal(completed.planning.renderJobId, waitingA.jobId);
      const jobs = (
        await pool.query(
          "SELECT id FROM jobs WHERE subject_id=$1 AND job_type='render.remotion' AND payload->'props'->'timeline'->>'id'=$2",
          [fixture.projectId, fixture.plan.timelineId],
        )
      ).rows;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].id, waitingA.jobId);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM agent_steps WHERE run_id=$1 AND outcome='succeeded'",
            [fixture.runId],
          )
        ).rows[0].count,
        "2",
      );
      const edited = await json(
        `/projects/${fixture.projectId}/timelines/${fixture.plan.timelineId}`,
      );
      const proof = await json(
        `/projects/${fixture.projectId}/exports/${waitingA.jobId}/validation`,
      );
      core.validateRenderProof(proof, restore(edited.timeline), waitingA.jobId);
      onPhase("download-validation");
      const links = await json(`/projects/${fixture.projectId}/exports/${waitingA.jobId}/download`);
      const response = await globalThis.fetch(links.downloadUrl, {
        signal: globalThis.AbortSignal.timeout(10000),
      });
      assert(response.ok);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash("sha256").update(bytes).digest("hex"), proof.artifactSha256);
      const output = path.join(privateDir, `lease-${attempt}.mp4`);
      await writeFile(output, bytes);
      const media = probe(output),
        video = media.streams.find((s) => s.codec_type === "video"),
        audio = media.streams.find((s) => s.codec_type === "audio");
      assert.equal(video.codec_name, "h264");
      assert.equal(audio.codec_name, "aac");
      assert.equal(video.width, 320);
      assert.equal(video.height, 180);
      assert.equal(video.avg_frame_rate, "25/1");
      assert.equal(Number(video.nb_read_frames), 200);
      assert.equal(audio.sample_rate, "48000");
      assert.equal(audio.channels, 2);
      assert(Math.abs(Number(media.format.duration) - 8) <= 0.02);
      assert.equal(media.videoFrameTimes.length, 200);
      assert(media.videoFrameTimes.every((time, i) => Math.abs(time - i / 25) < 0.00001));
      assert.equal(await queue.isCancelRequested(waitingA.jobId), false);
      // Completed runs/jobs are idempotent and must never acquire cancel flags.
      await assert.rejects(
        port.cancel(fixture.runId, fixture.projectId, waitingA.jobId, 2),
        core.AgentError,
      );
      assert.equal(await queue.isCancelRequested(waitingA.jobId), false);
      measurements.push({
        attempt,
        pausedBeyondLeaseMs: pausedMs,
        oldWorkerFenced: true,
        successorGeneration: 2,
        committedEffects: 2,
        renderJobs: 1,
        cancelledUnexpectedly: false,
        suspendedWithOpenTransactions: false,
        validationAndDownloadVerified: true,
        independentFfprobeVerified: true,
        artifactSha256: proof.artifactSha256,
      });
    } finally {
      for (const p of processes) {
        if (p.child.exitCode === null && p.child.signalCode === null) {
          p.child.kill("SIGCONT");
          p.child.kill("SIGKILL");
        }
      }
      await Promise.all(processes.map((p) => p.exit));
      if (paused) execFileSync("docker", ["unpause", renderContainer], { stdio: "ignore" });
    }
  }
  // Legitimate cancellation must still work through the real loop, not only
  // through a direct port call. A separate render has no AgentRun binding.
  const fixture = await createScenario();
  let paused = false,
    a;
  try {
    onPhase("user-cancel-wait");
    execFileSync("docker", ["pause", renderContainer], { stdio: "ignore" });
    paused = true;
    a = worker(root, hostEnv, {
      ...fixture,
      worker: "A",
      applicationName: "qa88-user-cancel-" + randomBytes(6).toString("hex"),
    });
    const waiting = await until(
      async () => a.messages.find((m) => m.phase === "render_wait"),
      "cancel_worker_not_waiting",
    );
    const edited = await json(
      `/projects/${fixture.projectId}/timelines/${fixture.plan.timelineId}`,
    );
    const unrelated = await json(
      `/projects/${fixture.projectId}/timelines/${fixture.plan.timelineId}/render`,
      {
        stateSha256: edited.stateSha256,
        requestId: "req_" + core.newAgentId().replaceAll("-", ""),
      },
    );
    const cancelled = await json(
      `/projects/${fixture.projectId}/agent-runs/${fixture.runId}/cancel`,
      {},
    );
    assert.equal(cancelled.state, "Cancelled");
    assert.equal(cancelled.generation, 2);
    a.child.send({ command: "release" });
    await until(
      async () => a.messages.some((m) => m.phase === "fenced"),
      "cancel_cleanup_not_finished",
    );
    assert.equal((await a.exit).code, 0);
    assert.equal(
      (await json(`/projects/${fixture.projectId}/exports/${waiting.jobId}`)).status,
      "Cancelled",
    );
    assert.equal(await queue.isCancelRequested(unrelated.jobId), false);
    const response = await globalThis.fetch(
      fixture.apiOrigin + `/projects/${fixture.projectId}/exports/${waiting.jobId}/download`,
      {
        headers: {
          cookie: `editagent_access=${fixture.accessToken}; editagent_csrf=${fixture.csrf}`,
        },
        signal: globalThis.AbortSignal.timeout(5000),
      },
    );
    assert.equal(response.status, 409);
    await response.body?.cancel();
    execFileSync("docker", ["unpause", renderContainer], { stdio: "ignore" });
    paused = false;
    onPhase("unrelated-render-complete");
    await until(
      async () =>
        (await json(`/projects/${fixture.projectId}/exports/${unrelated.jobId}`)).status ===
        "Completed",
      "unrelated_render_not_completed",
      90000,
    );
    assert.equal(await queue.isCancelRequested(unrelated.jobId), false);
  } finally {
    if (a?.child.exitCode === null && a.child.signalCode === null) {
      a.child.kill("SIGCONT");
      a.child.kill("SIGKILL");
    }
    await a?.exit;
    if (paused) execFileSync("docker", ["unpause", renderContainer], { stdio: "ignore" });
  }
  return {
    status: "PASS",
    modelEvidence: "synthetic_replay",
    actualHostDriverProcesses: true,
    realPostgresRedisAndRender: true,
    measurements,
    legitimateUserCancellation: {
      status: "PASS",
      boundJobCancelled: true,
      downloadStatus: 409,
      unrelatedRenderCompleted: true,
    },
  };
}
