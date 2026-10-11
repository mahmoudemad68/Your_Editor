import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { timelineFixture } from "./timeline-mapping.test.js";
import { verifyStagedAssets } from "./verified-assets.js";
import { startBundleServer } from "./local-bundle-server.js";
test("verified assets reject extra metadata, traversal, symlinks and checksum substitution", async () => {
  const work = await mkdtemp(path.join(tmpdir(), "render-assets-"));
  try {
    const input = timelineFixture(),
      bytes = Buffer.from("trusted-content"),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const a = {
      sourceId: input.props.timeline.sources[0]!.id,
      kind: "video",
      durationUs: "3000000",
      sha256,
      byteSize: bytes.length,
      name: sha256 + ".mp4",
    };
    await writeFile(path.join(work, a.name), bytes);
    await assert.doesNotReject(verifyStagedAssets(input, [a], work, new AbortController().signal));
    for (const bad of [
      { ...a, name: "../x" },
      { ...a, url: "http://169.254.169.254" },
      { ...a, sourceId: "unknown" },
      { ...a, durationUs: "3000001" },
      { ...a, sha256: "a".repeat(64) },
      { ...a, byteSize: bytes.length + 1 },
    ])
      await assert.rejects(verifyStagedAssets(input, [bad], work, new AbortController().signal));
    await assert.rejects(verifyStagedAssets(input, [], work, new AbortController().signal));
    await rm(path.join(work, a.name));
    await writeFile(path.join(work, "elsewhere"), bytes);
    await symlink(path.join(work, "elsewhere"), path.join(work, a.name));
    await assert.rejects(verifyStagedAssets(input, [a], work, new AbortController().signal));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
test("loopback bundle serving is allowlisted and never proxies URLs or arbitrary local files", async () => {
  const work = await mkdtemp(path.join(tmpdir(), "render-http-"));
  let server: Awaited<ReturnType<typeof startBundleServer>> | undefined;
  try {
    await writeFile(path.join(work, "index.html"), "fixture");
    await writeFile(path.join(work, "a".repeat(64) + ".mp4"), "not-approved");
    server = await startBundleServer(work, work);
    assert.equal((await fetch(server.serveUrl + "/")).status, 200);
    for (const route of [
      "/public/" + "a".repeat(64) + ".mp4",
      "/etc/passwd",
      "/../../etc/passwd",
      "/http://169.254.169.254/latest/meta-data",
      "/%2e%2e/%2e%2e/etc/passwd",
    ])
      assert.equal((await fetch(server.serveUrl + route)).status, 404);
    assert.equal((await fetch(server.serveUrl + "/", { method: "POST" })).status, 405);
  } finally {
    await server?.close();
    await rm(work, { recursive: true, force: true });
  }
});
