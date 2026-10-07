import assert from "node:assert/strict";
import { test } from "vitest";
import { instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { jobId, mediaAssetId } from "../../kernel/id.js";
import { Job, jobStatus } from "./job.js";

test("a new Job is Queued and references work without embedding the other aggregate", () => {
  const job = Job.create(
    jobId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f"),
    { kind: "media-asset", mediaAssetId: mediaAssetId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f") },
    instant(1n),
  );
  assert.equal(job.status, "Queued");
  assert.equal(job.subject.kind, "media-asset");
  assert.equal(Job.name, "Job");
  assert.equal(jobStatus("Failed"), "Failed");
  assert.throws(() => jobStatus("archived"), DomainError);
  const restored = Job.restore({
    id: job.id,
    subject: {
      kind: "media-asset",
      mediaAssetId: job.subject.kind === "media-asset" ? job.subject.mediaAssetId : "",
    },
    status: "Failed",
    createdAt: 2n,
    updatedAt: 8n,
  });
  assert.equal(restored.status, "Failed");
  assert.equal(restored.createdAt, 2n);
  assert.equal(restored.updatedAt, 8n);
  assert.equal(restored.subject.kind, "media-asset");
  assert.throws(() => new Job(job.id, job.subject, "archived", 2n, 8n), DomainError);
  assert.throws(
    () => new Job(job.id, job.subject, "Queued", 10n, 9n),
    /createdAt must be less than/,
  );
  assert.throws(
    () =>
      Job.restore({
        id: job.id,
        subject: { kind: "project", projectId: "018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f" },
        status: "Queued",
        createdAt: "10",
        updatedAt: "9",
      }),
    /createdAt must be less than/,
  );
});

test("illegal job transitions are rejected and legal ones record the next state", () => {
  const created = Job.create(
    jobId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f"),
    { kind: "media-asset", mediaAssetId: mediaAssetId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f") },
    instant(1n),
  );
  assert.throws(
    () => created.complete(instant(2n)),
    /Illegal job transition from Queued to Completed/,
  );
  assert.throws(
    () => created.fail(instant(2n), "no"),
    /Illegal job transition from Queued to Failed/,
  );
  assert.throws(
    () => created.retry(instant(2n), "no"),
    /Illegal job transition from Queued to Retrying/,
  );
  const running = created.start(instant(2n));
  assert.equal(running.status, "Running");
  assert.equal(running.attemptCount, 1);
  assert.throws(() => running.fail(instant(3n), "  "), /requires a reason/);
  const failed = running.fail(instant(3n), "disk corrupt");
  assert.equal(failed.status, "Failed");
  assert.equal(failed.failureReason, "disk corrupt");
  assert.throws(() => failed.start(instant(4n)), /Illegal job transition from Failed to Running/);
  const again = Job.create(created.id, created.subject, instant(1n)).start(instant(2n));
  const retrying = again.retry(instant(3n), "timeout");
  assert.equal(retrying.status, "Retrying");
  assert.throws(
    () => retrying.complete(instant(4n)),
    /Illegal job transition from Retrying to Completed/,
  );
  const second = retrying.start(instant(4n));
  assert.equal(second.attemptCount, 2);
  const done = second.complete(instant(5n));
  assert.equal(done.status, "Completed");
  assert.equal(done.failureReason, null);
  assert.throws(
    () => done.cancel(instant(6n)),
    /Illegal job transition from Completed to Cancelled/,
  );
  const cancelled = created.cancel(instant(2n));
  assert.equal(cancelled.status, "Cancelled");
  const runningCancelled = created.start(instant(2n)).cancel(instant(3n));
  assert.equal(runningCancelled.status, "Cancelled");
  assert.throws(
    () => runningCancelled.start(instant(4n)),
    /Illegal job transition from Cancelled to Running/,
  );
  const withPayload = Job.create(created.id, created.subject, instant(1n), {
    queueName: "media",
    jobType: "probe",
    idempotencyKey: "probe-1",
    timeoutMs: 1000,
    maxAttempts: 2,
    payload: { mediaAssetId: "asset" },
  });
  assert.deepEqual(withPayload.payload, { mediaAssetId: "asset" });
  assert.deepEqual(withPayload.start(instant(2n)).payload, { mediaAssetId: "asset" });
  const startedAtTen = created.start(instant(10n));
  assert.throws(
    () => startedAtTen.complete(instant(5n)),
    /cannot be earlier than the current updatedAt/,
  );
  assert.equal(startedAtTen.status, "Running");
  assert.equal(startedAtTen.complete(instant(10n)).status, "Completed");
});
