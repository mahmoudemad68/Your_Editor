import assert from "node:assert/strict";
import { test } from "node:test";
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
});
