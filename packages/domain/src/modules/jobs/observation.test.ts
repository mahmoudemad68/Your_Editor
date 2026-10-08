import { test, expect } from "vitest";
import { instant } from "../../kernel/clock.js";
import { JobAttempt } from "./job-attempt.js";
import { assertJobProgress, JOB_PROGRESS_STAGES } from "./job-events.js";

const ID = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
test("attempt history is immutable and rejects invalid chronology/numbers", () => {
  const started = JobAttempt.start(ID, ID, 2, instant(100n));
  const finished = started.finish("Failed", instant(200n), "  internal reason  ");
  expect(started.toSnapshot().finishedAt).toBeNull();
  expect(finished.toSnapshot()).toMatchObject({
    attemptNumber: 2,
    status: "Failed",
    reason: "internal reason",
    finishedAt: 200n,
  });
  expect(Object.isFrozen(finished)).toBe(true);
  expect(() => started.finish("Completed", instant(99n), null)).toThrow();
  for (const n of [0, -1, 1.5, NaN])
    expect(() => JobAttempt.start(ID, ID, n, instant(100n))).toThrow();
  expect(new JobAttempt(ID, ID, 1, "Running", 100n, null, " ").reason).toBeNull();
});
test("progress accepts only finite bounded percentages, known stages and positive attempts", () => {
  for (const stage of JOB_PROGRESS_STAGES) {
    for (const percentage of [0, 25.5, 100])
      expect(() => assertJobProgress({ stage, percentage, attempt: 2 })).not.toThrow();
  }
  for (const percentage of [-1, 101, NaN, Infinity])
    expect(() => assertJobProgress({ stage: "staging", percentage, attempt: 1 })).toThrow();
  for (const attempt of [0, -1, 1.5, Infinity])
    expect(() => assertJobProgress({ stage: "staging", percentage: 50, attempt })).toThrow();
});
