/** Real, disposable GitHub artifact transport test. Never a candidate receipt. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import process from "node:process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  request,
  validateArtifact,
  unpackVerifiedZip,
  artifactRedirect,
  sha256,
  REPOSITORY_ID,
} from "./load-qualified-storage.mjs";

const API = "https://api.github.com/repos/mahmoudemad68/Your_Editor/";
const cap = 128 * 1024;
const number = (s) => {
  assert.match(String(s), /^[1-9][0-9]*$/);
  const n = Number(s);
  assert.ok(Number.isSafeInteger(n));
  return n;
};
const id = number(process.env.GITHUB_RUN_ID),
  attempt = number(process.env.GITHUB_RUN_ATTEMPT);
const artifactID = number(process.env.FIXTURE_ARTIFACT_ID);
const sha = process.env.TARGET_SHA;
assert.match(sha ?? "", /^[a-f0-9]{40}$/);
assert.equal(process.env.GITHUB_REPOSITORY, "mahmoudemad68/Your_Editor");
const mode = process.argv[2] ?? "verify";
if (mode === "deny") {
  await assert.rejects(
    () => request(`${API}actions/artifacts/${artifactID}/zip`, { bytes: true, cap }),
    (e) => e.http_status === 403,
  );
  console.log(
    JSON.stringify({
      test: "real missing actions:read",
      result: "PASS",
      status: 403,
      artifact_id: artifactID,
      run: id,
      attempt,
    }),
  );
} else {
  assert.equal(mode, "verify");
  // Shell must not depend on credentials injected only into JS Action handlers.
  assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, undefined);
  assert.equal(process.env.ACTIONS_RESULTS_URL, undefined);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sha);
  const run = await request(`${API}actions/runs/${id}`);
  assert.equal(run.id, id);
  assert.equal(run.run_attempt, attempt);
  assert.equal(run.event, "pull_request");
  assert.equal(run.head_sha, sha);
  assert.equal(run.repository.id, REPOSITORY_ID);
  assert.equal(run.head_repository.id, REPOSITORY_ID);
  assert.equal(run.path, ".github/workflows/pc100-artifact-integration.yml");
  assert.ok(run.pull_requests.some((p) => p.number === 100 && p.head.sha === sha));
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const commit = await request(`${API}git/commits/${sha}`);
  assert.equal(commit.tree.sha, tree);
  let upload;
  // Same-attempt metadata can lag a completed step; no job/workflow is retried.
  for (let n = 0; n < 6; n++) {
    const jobs = await request(`${API}actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`);
    upload = jobs.jobs
      .find((j) => j.name === "PC100 real REST transport")
      ?.steps.find((s) => s.name === "Upload disposable fixture");
    if (upload?.status === "completed" && upload.conclusion === "success") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(upload?.conclusion, "success");
  const metadata = await request(`${API}actions/artifacts/${artifactID}`);
  validateArtifact(metadata, run, artifactID, cap, upload);
  assert.equal(metadata.name, `pc100-rest-fixture-${id}-${attempt}`);
  assert.equal(metadata.digest, `sha256:${process.env.FIXTURE_ARTIFACT_DIGEST}`);
  let redirects = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).origin !== "https://api.github.com") {
      assert.equal(options.headers?.Authorization, undefined);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "manual");
      redirects++;
    }
    return fetch(url, options);
  };
  let raw;
  try {
    raw = await request(`${API}actions/artifacts/${artifactID}/zip`, { bytes: true, cap });
  } finally {
    globalThis.fetch = fetch;
  }
  assert.equal(raw.length, metadata.size_in_bytes);
  assert.equal(`sha256:${sha256(raw)}`, metadata.digest);
  assert.ok(redirects === 1, "Expected one real authenticated API -> storage redirect");
  const after = await request(`${API}actions/artifacts/${artifactID}`);
  assert.deepEqual(after, metadata);
  const freshRun = await request(`${API}actions/runs/${id}`);
  assert.equal(freshRun.run_attempt, attempt);
  assert.equal(freshRun.head_sha, sha);
  const parent = path.join(process.env.RUNNER_TEMP, "pc100-real-rest");
  await mkdir(parent, { recursive: false, mode: 0o700 });
  const out = path.join(parent, "verified");
  await unpackVerifiedZip(
    raw,
    metadata.digest,
    out,
    ["manifest.json", "payload.bin"],
    cap,
    "python3",
    true,
  );
  const payload = await readFile(path.join(out, "payload.bin"));
  const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest, {
    schema: "pc100-fixture-v1",
    H: sha,
    bytes: 65536,
    sha256: sha256(payload),
  });
  assert.equal(payload.length, 65536);
  const corrupted = Buffer.from(raw);
  corrupted[0] ^= 1;
  await assert.rejects(
    () =>
      unpackVerifiedZip(
        corrupted,
        metadata.digest,
        path.join(parent, "bad"),
        ["manifest.json", "payload.bin"],
        cap,
        "python3",
        true,
      ),
    /GITHUB_ARCHIVE_DIGEST_MISMATCH/,
  );
  assert.throws(() => artifactRedirect("https://attacker.example/"), /ARTIFACT_REDIRECT_REJECTED/);
  const token = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await assert.rejects(
      () => request(`${API}actions/artifacts/${artifactID}/zip`, { bytes: true, cap }),
      /ACTIONS_READ_TOKEN_MISSING/,
    );
  } finally {
    process.env.GITHUB_TOKEN = token;
  }
  await assert.rejects(
    () => request(`${API}actions/artifacts/9007199254740000/zip`, { bytes: true, cap }),
    (e) => e.http_status === 404,
  );
  const result = {
    test: "real shell REST transport",
    result: "PASS",
    H: sha,
    tree,
    run: id,
    attempt,
    workflow_id: run.workflow_id,
    artifact_id: artifactID,
    artifact_digest: metadata.digest,
    physical_bytes: raw.length,
    retention_days: 1,
    redirects,
    bearer_forwarded: false,
    shell_runtime_credentials_present: false,
    negative_controls: {
      corrupt_bytes: "PASS_LOCAL_MUTATION",
      invalid_redirect: "PASS_LOCAL_CONTROL",
      missing_token: "PASS_LOCAL_CONTROL",
      wrong_id: "PASS_REAL_404",
    },
  };
  await writeFile(path.join(parent, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  await rm(out, { recursive: true, force: true });
}
