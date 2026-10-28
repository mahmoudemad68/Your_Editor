/** In-process ToolExecutor checks. A proposal receipt is not treated as a committed timeline. */
import { createRequire } from "node:module";
import path from "node:path";
import { check, results, writeReport } from "./report.mjs";

const app = process.env.QA_APP_ROOT;
const require = createRequire(path.join(app, "apps/api/package.json"));
const sdk = require("@editagent/tool-sdk");
const domain = require("@editagent/domain");
const rows = results();
const id = (n) => `018fe277-6ec0-7000-8000-${String(n).padStart(12, "0")}`;
const sha = "c".repeat(64);

function timeline() {
  return new domain.Timeline(id(1), id(2), "0", {
    composition: {
      width: 1280,
      height: 720,
      frameRate: domain.frameRate(25n, 1n),
      durationUs: 8_000_000n,
    },
    sources: [{ id: id(3), kind: "video", durationUs: "8000000" }],
    tracks: [
      new domain.Track(id(4), id(1), "video", [
        new domain.Clip(id(5), id(4), "0", "8000000", { sourceId: id(3) }),
      ]),
    ],
  });
}
function evidenceWords() {
  return [
    { text: "Hello", startUs: "0", endUs: "400000", confidence: 0.9 },
    { text: "السَّلَامُ", startUs: "500000", endUs: "900000", confidence: null },
  ];
}
class Audit {
  constructor() {
    this.rows = new Map();
  }
  async begin(record) {
    if (this.rows.has(record.id)) throw new sdk.ToolError("duplicate");
    this.rows.set(record.id, { ...record });
  }
  async reserve() {}
  async finish(recordId, outcome, code, costMicros, settlement = {}) {
    const row = this.rows.get(recordId);
    Object.assign(row, {
      outcome,
      code,
      costMicros,
      finishedAtMs: Date.now(),
      cleanupStatus: settlement.cleanupStatus ?? "not_required",
    });
    return row;
  }
  async attachJob() {}
  async recoverAdmissions() {
    return [];
  }
  async noteCleanupFailure() {}
  async requestStop() {}
  async confirmCleanup() {}
  async pendingRemote() {
    return [];
  }
  async get(recordId) {
    return this.rows.get(recordId) ?? null;
  }
  async list() {
    return [...this.rows.values()];
  }
}
function harness(role, stored = timeline()) {
  const audit = new Audit();
  const seen = [];
  const authority = {
    async authorize(call, permissions) {
      seen.push({ role, permissions: [...permissions], resource: call.resource.kind });
      if (role !== "owner" && role !== "editor") throw new sdk.ToolError("denied");
    },
    async timeline(projectId, timelineId) {
      if (projectId !== stored.projectId || timelineId !== stored.id)
        throw new sdk.ToolError("denied");
      return domain.Timeline.restore(stored.toSnapshot());
    },
  };
  const evidence = {
    async read(project, asset, sourceSha, documentSha) {
      if (
        project !== id(2) ||
        asset !== id(3) ||
        sourceSha !== sha ||
        documentSha !== "d".repeat(64)
      )
        throw new sdk.ToolError("invalid_subject");
      return { version: "1.2.0", durationUs: "8000000", words: evidenceWords() };
    },
  };
  const registry = sdk.registerCaptionTools(new sdk.ToolRegistry(), authority, evidence);
  return {
    executor: new sdk.ToolExecutor(registry, authority, audit),
    audit,
    stored,
    seen,
    registry,
  };
}
const style = { ...domain.DEFAULT_CAPTION_STYLE, preset: "landscape", fontSize: 28 };
function call(name, input, caller = id(7), project = id(2)) {
  return {
    name,
    version: "1.0.0",
    callerId: caller,
    projectId: project,
    resource: { kind: "timeline", id: id(1) },
    input,
  };
}

await check(
  rows,
  "G2-MANIFEST",
  "Caption manifests are closed, pinned, zero-cost, and limited to 10 seconds",
  () => {
    const manifests = sdk.captionToolManifests();
    const names = manifests.map((item) => `${item.name}@${item.version}`).sort();
    const closed = manifests.every(
      (item) =>
        item.inputSchema.additionalProperties === false &&
        item.outputSchema.additionalProperties === false &&
        item.timeoutMs === 10000 &&
        item.estimatedCostMicros === 0 &&
        item.maximumCostMicros === 0 &&
        item.schemaVersion === 1,
    );
    const perms = manifests
      .find((item) => item.name === "editing.add-caption")
      .permissions.join(",");
    const ok =
      names.join("|") === "editing.add-caption@1.0.0|editing.update-caption-style@1.0.0" &&
      closed &&
      perms === "project.read,timeline.propose,asset.read,analysis.read";
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "two closed 1.0.0 manifests",
      actual: { names, closed, perms },
    };
  },
);

await check(
  rows,
  "G2-PROPOSAL-NOT-COMMIT",
  "A successful add proposal leaves the stored timeline unchanged",
  async () => {
    const box = harness("owner");
    const before = JSON.stringify(box.stored.toSnapshot());
    const execution = domain.createUuidV7(Date.now(), Buffer.from("0123456789"));
    const result = await box.executor.executeWithIdentity(
      execution,
      call("editing.add-caption", {
        assetId: id(3),
        sourceSha256: sha,
        analysisSha256: "d".repeat(64),
        style,
      }),
    );
    const after = JSON.stringify(box.stored.toSnapshot());
    const command = result.commands[0];
    const words = command?.payload?.caption?.blocks?.flatMap((block) => block.lines.flat()) ?? [];
    const ok =
      before === after &&
      result.commands.length === 1 &&
      result.record.outcome === "succeeded" &&
      result.record.costMicros === 0 &&
      words.map((item) => item.text).join("|") === "Hello|السَّلَامُ" &&
      words[1].confidence === null;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "one proposal, stored timeline unchanged",
      actual: {
        commands: result.commands.length,
        outcome: result.record.outcome,
        cost: result.record.costMicros,
        unchanged: before === after,
        wordCount: words.length,
      },
    };
  },
);

await check(
  rows,
  "G2-AUTHZ-MATRIX",
  "Viewer, outsider, stale project, and extra caller fields cannot author captions",
  async () => {
    const input = { assetId: id(3), sourceSha256: sha, analysisSha256: "d".repeat(64), style };
    const cases = [];
    for (const role of ["viewer", "outsider"]) {
      const box = harness(role);
      try {
        await box.executor.execute(call("editing.add-caption", input));
        cases.push({ role, status: "accepted" });
      } catch (error) {
        cases.push({ role, status: error instanceof sdk.ToolError ? error.code : "other" });
      }
    }
    const foreign = harness("owner");
    try {
      await foreign.executor.execute(call("editing.add-caption", input, id(7), id(9)));
      cases.push({ role: "foreign-project", status: "accepted" });
    } catch (error) {
      cases.push({
        role: "foreign-project",
        status: error instanceof sdk.ToolError ? error.code : "other",
      });
    }
    const injected = harness("owner");
    try {
      await injected.executor.execute(
        call("editing.add-caption", {
          ...input,
          callerId: id(8),
          url: "http://127.0.0.1/x",
          css: "body{background:url(http://evil)}",
          command: "rm -rf /",
        }),
      );
      cases.push({ role: "injected", status: "accepted" });
    } catch (error) {
      cases.push({
        role: "injected",
        status: error instanceof sdk.ToolError ? error.code : "other",
      });
    }
    const denied = cases
      .filter((item) => item.role !== "injected")
      .every((item) => item.status === "denied");
    const closed = cases.find((item) => item.role === "injected")?.status === "invalid_input";
    return {
      status: denied && closed ? "PASS" : "FAIL",
      expected: "denied or invalid_input, no effect",
      actual: cases,
    };
  },
);

await check(
  rows,
  "G2-MALFORMED",
  "Overlong, wrong-color, unknown-font, and shell-like style values are rejected",
  async () => {
    const box = harness("owner");
    const bad = [
      { ...style, color: "red" },
      { ...style, font: "Comic Sans" },
      { ...style, color: "#ffffff;background:url(http://x)" },
      { ...style, fontSize: 1000 },
    ];
    const codes = [];
    for (const item of bad) {
      try {
        await box.executor.execute(
          call("editing.add-caption", {
            assetId: id(3),
            sourceSha256: sha,
            analysisSha256: "d".repeat(64),
            style: item,
          }),
        );
        codes.push("accepted");
      } catch (error) {
        codes.push(error instanceof sdk.ToolError ? error.code : "other");
      }
    }
    const huge = "x".repeat(70_000);
    try {
      await box.executor.execute(
        call("editing.add-caption", {
          assetId: id(3),
          sourceSha256: sha,
          analysisSha256: huge,
          style,
        }),
      );
      codes.push("accepted");
    } catch (error) {
      codes.push(error instanceof sdk.ToolError ? error.code : "other");
    }
    const snapshot = box.stored.toSnapshot();
    const ok = codes.every((code) => code === "invalid_input") && !snapshot.captionsV1;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "five invalid_input results",
      actual: { codes, captions: Boolean(snapshot.captionsV1) },
    };
  },
);

await check(
  rows,
  "G2-STYLE-PRESERVES-WORDS",
  "Style update changes only style and keeps exact words and source times",
  async () => {
    const stored = timeline();
    const box = harness("owner", stored);
    const execution = domain.createUuidV7(Date.now(), Buffer.from("abcdef0123"));
    const added = await box.executor.executeWithIdentity(
      execution,
      call("editing.add-caption", {
        assetId: id(3),
        sourceSha256: sha,
        analysisSha256: "d".repeat(64),
        style,
      }),
    );
    const caption = added.commands[0].payload.caption;
    const withCaption = domain.applyCommand(stored, added.commands[0]).timeline;
    const beforeWords = JSON.stringify(withCaption.captionsV1[0].blocks);
    const styled = harness("owner", withCaption);
    const next = { ...style, highlight: "#00ffff", direction: "rtl" };
    const updated = await styled.executor.execute(
      call("editing.update-caption-style", { captionId: caption.id, style: next }, id(7)),
    );
    const payload = updated.commands[0].payload;
    const styledTimeline = domain.applyCommand(withCaption, updated.commands[0]).timeline;
    const sameWords =
      JSON.stringify(styledTimeline.captionsV1[0].blocks) === beforeWords &&
      styledTimeline.captionsV1[0].style.highlight === "#00ffff";
    const wrong = harness("editor", withCaption);
    let wrongCode = "accepted";
    try {
      await wrong.executor.execute(
        call("editing.update-caption-style", { captionId: caption.id, style: next }, id(8)),
      );
    } catch (error) {
      wrongCode = error instanceof sdk.ToolError ? error.code : "other";
    }
    const ok =
      updated.commands[0].type === "UpdateCaptionStyle" &&
      payload.style.highlight === "#00ffff" &&
      sameWords &&
      wrongCode === "denied";
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "style changes, words stay, other creator denied",
      actual: {
        type: updated.commands[0].type,
        highlight: payload.style.highlight,
        sameWords,
        wrongCode,
      },
    };
  },
);

await check(
  rows,
  "G2-TINY-EVIDENCE",
  "Postgres evidence reader rejects a Tiny model document",
  async () => {
    const asset = id(3);
    const project = id(2);
    const document = (model) => ({
      schemaVersion: "1.0.0",
      mediaAssetId: asset,
      source: { sha256: sha, durationUs: "8000000" },
      provenance: { producer: "qa", producerVersion: "1.0.0" },
      sections: {
        metadata: { status: "not_available" },
        audio: { status: "not_available" },
        scenes: { status: "not_available" },
        faces: { status: "not_available" },
        objects: { status: "not_available" },
        transcript: {
          status: "completed",
          provenance: {
            analyzer: "qa",
            analyzerVersion: "1.0.0",
            sourceSha256: sha,
            configurationSha256: "e".repeat(64),
            model: { name: model, version: "qa", sha256: "f".repeat(64) },
          },
          data: {
            language: "en",
            segments: [
              {
                id: "s",
                text: "Hello",
                startUs: "0",
                endUs: "400000",
                words: [{ text: "Hello", startUs: "0", endUs: "400000", confidence: 1 }],
              },
            ],
          },
        },
      },
    });
    const read = async (model) => {
      const body = document(model);
      const pool = {
        async query() {
          return { rows: [{ document: body, duration: "8000000" }] };
        },
      };
      const reader = new sdk.PostgresCaptionEvidence(pool);
      try {
        const value = await reader.read(
          project,
          asset,
          sha,
          sdk.contentHash(body),
          new AbortController().signal,
        );
        return { code: "accepted", words: value.words.length };
      } catch (error) {
        return { code: error instanceof sdk.ToolError ? error.code : "other" };
      }
    };
    const tiny = await read("faster-whisper-tiny");
    const small = await read("faster-whisper-small");
    return {
      status:
        tiny.code === "invalid_subject" && small.code === "accepted" && small.words === 1
          ? "PASS"
          : "FAIL",
      expected: "tiny rejected, small accepted",
      actual: { tiny, small },
    };
  },
);

await check(
  rows,
  "G2-DUPLICATE-ADMISSION",
  "The same execution id is not applied twice",
  async () => {
    const box = harness("owner");
    const execution = domain.createUuidV7(Date.now(), Buffer.from("0011223344"));
    const input = call("editing.add-caption", {
      assetId: id(3),
      sourceSha256: sha,
      analysisSha256: "d".repeat(64),
      style,
    });
    await box.executor.executeWithIdentity(execution, input);
    let code = "accepted";
    try {
      await box.executor.executeWithIdentity(execution, input);
    } catch (error) {
      code = error instanceof sdk.ToolError ? error.code : "other";
    }
    return {
      status: code !== "accepted" && box.audit.rows.size === 1 ? "PASS" : "FAIL",
      expected: "second admission rejected",
      actual: { code, rows: box.audit.rows.size },
    };
  },
);

await check(
  rows,
  "G2-DEADLINE",
  "A stalled evidence read is bounded by the 10 second manifest deadline",
  async () => {
    const stored = timeline();
    const audit = new Audit();
    const authority = {
      async authorize() {},
      async timeline() {
        return domain.Timeline.restore(stored.toSnapshot());
      },
    };
    const evidence = { read: () => new Promise(() => {}) };
    const registry = sdk.registerCaptionTools(new sdk.ToolRegistry(), authority, evidence);
    const executor = new sdk.ToolExecutor(registry, authority, audit);
    const started = Date.now();
    let code = "accepted";
    try {
      await executor.execute(
        call("editing.add-caption", {
          assetId: id(3),
          sourceSha256: sha,
          analysisSha256: "d".repeat(64),
          style,
        }),
      );
    } catch (error) {
      code = error instanceof sdk.ToolError ? error.code : "other";
    }
    const elapsed = Date.now() - started;
    const ok =
      (code === "timed_out" || code === "cancelled") &&
      elapsed >= 9_000 &&
      elapsed < 15_000 &&
      !stored.toSnapshot().captionsV1;
    return {
      status: ok ? "PASS" : "FAIL",
      expected: "deadline around 10s without a stored caption",
      actual: { code, elapsed },
    };
  },
);

const out = process.argv[2] ?? "/tmp/qa93-tools.json";
writeReport(out, rows, { suite: "tools", productSha: process.env.QA_APP_SHA });
if (rows.some((row) => row.status !== "PASS")) process.exit(1);
