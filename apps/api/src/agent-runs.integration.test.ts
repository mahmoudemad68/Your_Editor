import assert from "node:assert/strict";
import { test } from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import path from "node:path";
import { Pool } from "pg";
import {
  AgentError,
  PostgresAgentRuns,
  newAgentId,
  runInfrastructure,
  consumeAgentRuns,
  publishAgentRun,
  replayAgentCommands,
  executeAgentTool,
  type AgentRunView,
  type AgentExport,
} from "@editagent/agent-core";
import { Timeline, userId, type TimelineSnapshot } from "@editagent/domain";
import {
  contentHash,
  ToolExecutor,
  ToolRegistry,
  registerEditingTools,
  PostgresToolAuthority,
  PostgresToolAuditRepository,
  type ToolCall,
} from "@editagent/tool-sdk";
import { BullMqJobQueue, PostgresJobRepository } from "@editagent/job-queue";
import { applyMigrations } from "./infrastructure/migrate.js";
import { createApiApplication } from "./create-api-application.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { InMemoryMediaAssetRepository } from "./application/in-memory-media-repository.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { authenticateRequest } from "./presentation/authenticate-request.js";
import { requireCookieCsrf } from "./presentation/csrf.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail("bounded condition did not arrive");
}
test(
  "US303/306 real PostgreSQL, BullMQ, ToolExecutor, authenticated audit and crash recovery",
  { timeout: 100_000 },
  async (t) => {
    const adminUrl =
      process.env.DATABASE_URL ??
      "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent";
    const name = `editagent_agent76_${process.pid}`,
      url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const admin = new Pool({ connectionString: adminUrl }),
      pool = new Pool({ connectionString: url.href });
    const redis = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0");
    redis.pathname = "/12";
    const queue = new BullMqJobQueue(redis.href, { lockDurationMs: 2000 }),
      runs = new PostgresAgentRuns(pool);
    const owner = userId(newAgentId()),
      editor = userId(newAgentId()),
      viewer = userId(newAgentId()),
      foreign = userId(newAgentId());
    let now = BigInt(Date.now());
    const tokens = new JwtSessionTokens("agent-integration-document-signing-key-32chars");
    const app = await createApiApplication(
      {
        agentRuns: runs,
        projects: new PostgresProjectRepository(pool),
        media: new InMemoryMediaAssetRepository(),
        objects: new MemoryObjectStorage(),
        clock: { now: () => now },
        ids: new NodeProjectIdGenerator(),
        mediaIds: new NodeMediaAssetIdGenerator(),
        presignTtlSeconds: 60,
      },
      (use) => {
        use(authenticateRequest(tokens, () => now));
        const csrf = requireCookieCsrf();
        use((req, res, next) => csrf(req, res as Parameters<typeof csrf>[1], next));
      },
    );
    const children = new Set<ChildProcess>();
    let created = false;
    const fixture = async () => {
      const project = newAgentId(),
        id = newAgentId(),
        track = newAgentId(),
        clip = newAgentId(),
        source = newAgentId();
      await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Agent fixture',1,1)",
        [project],
      );
      for (const [actor, role] of [
        [owner, "owner"],
        [editor, "editor"],
        [viewer, "viewer"],
      ])
        await pool.query(
          "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,$3,1)",
          [project, actor, role],
        );
      const snapshot: TimelineSnapshot = {
        id,
        projectId: project,
        createdAt: "1",
        composition: {
          width: 320,
          height: 180,
          frameRate: { numerator: "25", denominator: "1" },
          durationUs: "2000000",
        },
        sources: [{ id: source, kind: "video", durationUs: "2000000" }],
        tracks: [
          {
            id: track,
            timelineId: id,
            kind: "video",
            transitions: [],
            clips: [
              {
                id: clip,
                trackId: track,
                kind: "video",
                inPoint: "0",
                outPoint: "2000000",
                timelineStartUs: "0",
                sourceId: source,
                text: null,
                componentId: null,
                opacity: 1,
                volumeDb: 0,
                effects: [],
              },
            ],
          },
        ],
      };
      Timeline.restore(snapshot);
      await pool.query(
        "INSERT INTO media_assets(id,project_id,kind,storage_key,upload_state,display_filename,mime_type,byte_size,content_sha256,created_at,updated_at) VALUES($1,$2,'video',$4,'uploaded','fixture.mp4','video/mp4',100,$3,1,1)",
        [source, project, "a".repeat(64), `projects/${project}/media/sha256/${"a".repeat(64)}`],
      );
      const hash = contentHash(snapshot);
      await pool.query(
        "INSERT INTO editing_timelines(id,project_id,snapshot,state_sha256) VALUES($1,$2,$3::jsonb,$4)",
        [id, project, JSON.stringify(snapshot), hash],
      );
      return {
        project,
        id,
        clip,
        snapshot,
        hash,
        start: () =>
          runs.start(
            owner,
            project,
            { idempotencyKey: newAgentId(), timelineId: id, stateSha256: hash },
            newAgentId(),
          ),
      };
    };
    const child = (id: string, mode: string) => {
      const proc = fork(path.join(__dirname, "fixtures/agent-run-child.test.js"), [], {
        env: { ...process.env, DATABASE_URL: url.href, AGENT_TEST_RUN: id, AGENT_TEST_MODE: mode },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      children.add(proc);
      return proc;
    };
    const message = (proc: ChildProcess, phase: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => done(new Error("test child deadline")), 12000);
        const receive = (data: unknown) => {
          const found = data as { phase?: string };
          if (found.phase === phase) done();
          else if (found.phase === "test_driver_failed") done(new Error("test driver failed"));
        };
        const exited = () => done(new Error("test child exited before checkpoint"));
        const done = (error?: Error) => {
          clearTimeout(timeout);
          proc.removeListener("message", receive);
          proc.removeListener("exit", exited);
          if (error) reject(error);
          else resolve();
        };
        proc.on("message", receive);
        proc.once("exit", exited);
      });
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      created = true;
      await applyMigrations(pool);
      assert.ok(
        (await pool.query("SELECT id FROM schema_migrations WHERE id='0022_agent_runs.sql'"))
          .rowCount === 1,
      );
      for (const actor of [owner, editor, viewer, foreign])
        await pool.query(
          "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$test-fixture',1,1)",
          [actor, `${actor}@example.test`],
        );
      await app.listen(0, "127.0.0.1");
      const root = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}/projects`;
      const headers = async (actor = owner) => ({
        "content-type": "application/json",
        cookie: `editagent_access=${(await tokens.issueAccess(actor, now)).token}; editagent_csrf=agent-fixture-csrf`,
        "x-editagent-csrf": "agent-fixture-csrf",
      });
      const post = async (route: string, body: unknown = {}, actor = owner) =>
        fetch(root + route, {
          method: "POST",
          headers: await headers(actor),
          body: JSON.stringify(body),
        });
      await t.test(
        "admission idempotency, safe production stop, permissions, CSRF and stable pagination",
        async () => {
          const f = await fixture(),
            route = `/${f.project}/agent-runs`,
            input = { idempotencyKey: newAgentId(), timelineId: f.id, stateSha256: f.hash };
          assert.equal(
            (
              await fetch(root + route, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(input),
              })
            ).status,
            401,
          );
          const unsafe = await headers();
          delete (unsafe as Partial<typeof unsafe>)["x-editagent-csrf"];
          assert.equal(
            (
              await fetch(root + route, {
                method: "POST",
                headers: unsafe,
                body: JSON.stringify(input),
              })
            ).status,
            403,
          );
          assert.equal((await post(route, input, viewer)).status, 403);
          assert.equal((await post(route, input, foreign)).status, 404);
          const started = await post(route, input);
          assert.equal(started.status, 201);
          const run = (await started.json()) as AgentRunView;
          const duplicate = await Promise.all(
            Array.from({ length: 4 }, () =>
              post(route, input).then((r) => r.json() as Promise<AgentRunView>),
            ),
          );
          assert.ok(duplicate.every((r) => r.id === run.id));
          assert.equal((await post(route, { ...input, stateSha256: "b".repeat(64) })).status, 409);
          assert.equal(
            (await post(route, { ...input, prompt: "private bearer fixture-secret" })).status,
            400,
          );
          assert.equal(
            (await fetch(root + `${route}/${run.id}`, { headers: await headers(viewer) })).status,
            200,
          );
          const hidden = await fetch(root + `${route}/${run.id}`, {
              headers: await headers(foreign),
            }),
            unknown = await fetch(root + `/${newAgentId()}/agent-runs/${newAgentId()}`, {
              headers: await headers(foreign),
            });
          assert.equal(hidden.status, 404);
          assert.deepEqual(await hidden.json(), await unknown.json());
          await runInfrastructure(runs, run.id, new AbortController().signal);
          const done = await runs.get(owner, f.project, run.id);
          assert.equal(done.state, "Failed");
          assert.equal(done.stopReason, "PLANNER_NOT_CONFIGURED");
          const events = await runs.events(viewer, f.project, run.id);
          assert.deepEqual(
            events.map((e) => e.sequence),
            events.map((_, i) => i + 1),
          );
          assert.ok(events.every((e) => e.tokens === null && e.decision === "no_llm"));
          const first = await runs.audit(owner, f.project, run.id, undefined, 2);
          assert.ok(first.nextCursor);
          const second = await runs.audit(owner, f.project, run.id, first.nextCursor, 2);
          assert.equal(second.events[0]!.sequence, 3);
          await assert.rejects(
            runs.audit(owner, f.project, run.id, first.nextCursor.slice(0, -3) + "bad"),
            AgentError,
          );
          await assert.rejects(
            runs.events(owner, f.project, run.id, `1.${newAgentId()}`),
            AgentError,
          );
          assert.equal(
            (
              await fetch(root + `${route}/${run.id}/audit?limit=100000`, {
                headers: await headers(),
              })
            ).status,
            400,
          );
          await assert.rejects(
            pool.query("UPDATE agent_events SET event=event WHERE run_id=$1", [run.id]),
          );
          assert.equal((await post(`${route}/${run.id}/cancel`, {}, viewer)).status, 403);
          assert.equal((await post(`${route}/${run.id}/cancel`, {}, editor)).status, 201);
        },
      );
      await t.test(
        "durable cancellation, revocation, stale generation and deadline fences",
        async () => {
          const f = await fixture(),
            run = await f.start(),
            lease = await runs.claim(run.id);
          assert.ok(lease);
          await runs.move(lease, "Observing");
          await runs.cancel(editor, f.project, run.id);
          await assert.rejects(runs.move(lease, "Planning"), AgentError);
          assert.equal((await runs.get(owner, f.project, run.id)).state, "Cancelled");
          const revoked = await f.start(),
            held = await runs.claim(revoked.id);
          assert.ok(held);
          await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [
            f.project,
            owner,
          ]);
          await assert.rejects(runs.move(held, "Observing"), AgentError);
          await pool.query(
            "UPDATE agent_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
            [revoked.id],
          );
          await runs.claim(revoked.id);
          assert.equal(
            (await runs.get(editor, f.project, revoked.id)).stopReason,
            "ACCESS_REVOKED",
          );
          const timed = await runs.start(
            editor,
            f.project,
            { idempotencyKey: newAgentId() },
            newAgentId(),
          );
          await pool.query("UPDATE agent_runs SET deadline_at_ms=0 WHERE id=$1", [timed.id]);
          await runs.claim(timed.id);
          assert.equal(
            (await runs.get(editor, f.project, timed.id)).stopReason,
            "DEADLINE_EXCEEDED",
          );
        },
      );
      await t.test(
        "real BullMQ admission, duplicate delivery, checkpoint recovery and PostgreSQL rollback",
        async () => {
          const f = await fixture(),
            run = await f.start();
          await publishAgentRun(runs, queue, run.id);
          await publishAgentRun(runs, queue, run.id);
          assert.equal((await pool.query("SELECT id FROM jobs WHERE id=$1", [run.id])).rowCount, 1);
          const stop = new AbortController(),
            consume = consumeAgentRuns(runs, queue, stop.signal, () => undefined);
          try {
            await until(async () => (await runs.get(owner, f.project, run.id)).state === "Failed");
          } finally {
            stop.abort();
            await consume;
          }
          const job = await new PostgresJobRepository(pool).findById(
            run.id as Parameters<PostgresJobRepository["findById"]>[0],
          );
          assert.equal(job?.status, "Completed");
          const broken = await f.start(),
            lease = await runs.claim(broken.id);
          assert.ok(lease);
          await pool.query(
            "CREATE FUNCTION agent_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test database fault'; END; $$; CREATE TRIGGER agent_test_fail BEFORE INSERT ON agent_events FOR EACH ROW EXECUTE FUNCTION agent_test_fail()",
          );
          try {
            await assert.rejects(runs.move(lease, "Observing"));
            assert.equal((await runs.get(owner, f.project, broken.id)).state, "Pending");
          } finally {
            await pool.query(
              "DROP TRIGGER agent_test_fail ON agent_events; DROP FUNCTION agent_test_fail()",
            );
          }
        },
      );
      await t.test(
        "Redis interruption retains PG admission and recovers through the existing broker",
        async () => {
          const sockets = new Set<Socket>();
          let online = false;
          const proxy = createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
            if (!online) {
              socket.destroy();
              return;
            }
            const upstream = connect(Number(redis.port || 6379), redis.hostname);
            sockets.add(upstream);
            upstream.on("close", () => sockets.delete(upstream));
            upstream.on("error", () => socket.destroy());
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
          await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
          const proxyUrl = new URL(redis.href);
          proxyUrl.hostname = "127.0.0.1";
          proxyUrl.port = String((proxy.address() as { port: number }).port);
          const interrupted = new BullMqJobQueue(proxyUrl.href);
          const f = await fixture(),
            run = await f.start();
          let accepted = false;
          const admission = publishAgentRun(runs, interrupted, run.id).then(() => {
            accepted = true;
          });
          try {
            await sleep(300);
            assert.equal(accepted, false);
            assert.equal((await runs.get(owner, f.project, run.id)).state, "Pending");
            online = true;
            await admission;
            assert.equal(
              (await pool.query("SELECT id FROM jobs WHERE id=$1", [run.id])).rowCount,
              1,
            );
            const stop = new AbortController(),
              consuming = consumeAgentRuns(runs, interrupted, stop.signal, () => undefined);
            try {
              await until(
                async () =>
                  (await runs.get(owner, f.project, run.id)).stopReason ===
                  "PLANNER_NOT_CONFIGURED",
              );
            } finally {
              stop.abort();
              await consuming;
            }
          } finally {
            await interrupted.close(true);
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
          }
        },
      );
      await t.test(
        "SIGKILL after atomic checkpoint resumes without repeating completed ToolExecutor effects; export replays commands",
        async () => {
          const f = await fixture(),
            run = await f.start();
          const first = child(run.id, "checkpoint");
          await message(first, "checkpoint");
          first.kill("SIGKILL");
          await once(first, "exit");
          const one = await runs.get(owner, f.project, run.id);
          assert.equal(one.checkpoint, 1);
          const receipt = (
            await pool.query(
              "SELECT receipt_id FROM agent_steps WHERE run_id=$1 ORDER BY ordinal",
              [run.id],
            )
          ).rows[0].receipt_id;
          await sleep(5100);
          const restarted = child(run.id, "complete");
          await message(restarted, "completed");
          await once(restarted, "exit");
          const done = await runs.get(owner, f.project, run.id);
          assert.equal(done.state, "Completed");
          assert.equal(done.checkpoint, 2);
          assert.equal(
            (await pool.query("SELECT id FROM tool_executions WHERE id=$1", [receipt])).rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT * FROM agent_steps WHERE run_id=$1 AND outcome='succeeded'",
                [run.id],
              )
            ).rowCount,
            2,
          );
          const pages: AgentExport[] = [];
          let cursor: string | undefined;
          do {
            const page = await runs.export(owner, f.project, run.id, cursor, 3);
            pages.push(page);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          const replay = replayAgentCommands(f.snapshot, pages);
          const actual = (
            await pool.query("SELECT snapshot FROM editing_timelines WHERE id=$1", [f.id])
          ).rows[0].snapshot;
          assert.deepEqual(replay.toSnapshot(), actual);
          assert.ok(!JSON.stringify(pages).includes("fixture.mp4"));
          assert.ok(!JSON.stringify(pages).includes("password"));
          assert.ok(!JSON.stringify(pages).includes("private bearer"));
        },
      );
      await t.test(
        "SIGKILL after ToolExecutor result but before checkpoint fails closed without publishing or repeating",
        async () => {
          const f = await fixture(),
            run = await f.start(),
            first = child(run.id, "unconfirmed");
          await message(first, "admitted_without_checkpoint");
          first.kill("SIGKILL");
          await once(first, "exit");
          await sleep(5100);
          const next = child(run.id, "complete");
          await message(next, "failed");
          await once(next, "exit");
          assert.equal(
            (await runs.get(owner, f.project, run.id)).stopReason,
            "EXECUTION_UNCONFIRMED",
          );
          assert.equal(
            (await pool.query("SELECT snapshot FROM editing_timelines WHERE id=$1", [f.id])).rows[0]
              .snapshot.tracks[0].clips[0].inPoint,
            "0",
          );
          assert.equal(
            (await pool.query("SELECT * FROM agent_steps WHERE run_id=$1", [run.id])).rowCount,
            1,
          );
        },
      );
      await t.test(
        "cancellation and membership revocation fence actual ToolExecutor admission and timeline commit",
        async () => {
          const f = await fixture(),
            run = await f.start(),
            lease = await runs.claim(run.id);
          assert.ok(lease);
          await runs.move(lease, "Observing");
          await runs.move(lease, "Planning");
          await runs.move(lease, "Executing");
          const load = async (project: string, id: string) =>
            Timeline.restore(
              (
                await pool.query(
                  "SELECT snapshot FROM editing_timelines WHERE id=$1 AND project_id=$2",
                  [id, project],
                )
              ).rows[0].snapshot,
            );
          const authority = new PostgresToolAuthority(pool, load),
            executor = new ToolExecutor(
              registerEditingTools(new ToolRegistry(), authority),
              authority,
              new PostgresToolAuditRepository(pool, 1_000_000),
            );
          const call: ToolCall = {
            name: "editing.trim-video",
            version: "1.0.0",
            callerId: owner,
            projectId: f.project,
            resource: { kind: "timeline", id: f.id },
            input: { clipId: f.clip, startUs: "200000", endUs: "1800000" },
          };
          const intent = await runs.beginStep(lease, call.name, call.version, call.input);
          assert.ok(intent);
          const result = await executor.executeWithIdentity(intent.receiptId, call);
          await runs.cancel(owner, f.project, run.id);
          await assert.rejects(
            runs.finishStep(lease, intent, {
              output: result.output,
              commands: result.commands,
              durationMs: result.record.durationMs!,
              costMicros: result.record.costMicros,
            }),
            AgentError,
          );
          await assert.rejects(executor.executeWithIdentity(intent.receiptId, call));
          assert.equal(
            (await pool.query("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [f.id]))
              .rows[0].state_sha256,
            f.hash,
          );
          const another = await f.start(),
            lease2 = await runs.claim(another.id);
          assert.ok(lease2);
          await runs.move(lease2, "Observing");
          await runs.move(lease2, "Planning");
          await runs.move(lease2, "Executing");
          await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [
            f.project,
            owner,
          ]);
          await assert.rejects(
            executeAgentTool(runs, lease2, executor, call, new AbortController().signal),
          );
        },
      );
      await t.test(
        "SSE reconnect, order, cursor tampering, mid-stream revocation and session expiry",
        async () => {
          const f = await fixture(),
            run = await f.start(),
            route = `/${f.project}/agent-runs/${run.id}/events`;
          const stop = new AbortController();
          const response = await fetch(root + route, {
            headers: await headers(viewer),
            signal: stop.signal,
          });
          assert.equal(response.status, 200);
          const reader = response.body!.getReader(),
            decoder = new TextDecoder();
          let text = "";
          await until(async () => {
            const chunk = await reader.read();
            text += decoder.decode(chunk.value);
            return text.includes("event: agent-step");
          });
          const event = (await runs.events(viewer, f.project, run.id))[0]!;
          assert.ok(text.includes(`id: ${event.sequence}.${event.id}`));
          stop.abort();
          await reader.cancel().catch(() => undefined);
          const reconnect = new AbortController(),
            second = await fetch(root + route, {
              headers: {
                ...(await headers(viewer)),
                "last-event-id": `${event.sequence}.${event.id}`,
              },
              signal: reconnect.signal,
            });
          const secondReader = second.body!.getReader();
          const heartbeat = decoder.decode((await secondReader.read()).value);
          assert.ok(!heartbeat.includes(`id: ${event.sequence}.${event.id}`));
          await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [
            f.project,
            viewer,
          ]);
          await assert.rejects(async () => {
            while (!(await secondReader.read()).done) {
              /* bounded by the test timeout */
            }
          });
          reconnect.abort();
          assert.equal((await fetch(root + route, { headers: await headers(viewer) })).status, 404);
          assert.equal(
            (
              await fetch(root + route, {
                headers: { ...(await headers()), "last-event-id": `1.${newAgentId()}` },
              })
            ).status,
            400,
          );
          const expiring = await headers(),
            third = await fetch(root + route, { headers: expiring });
          const thirdReader = third.body!.getReader();
          await thirdReader.read();
          now += 3_600_000n;
          await assert.rejects(async () => {
            while (!(await thirdReader.read()).done) {
              /* token is reverified before next page */
            }
          });
          now = BigInt(Date.now());
        },
      );
    } finally {
      for (const proc of children)
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await app.close();
      await queue.close(true);
      await pool.end();
      if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
