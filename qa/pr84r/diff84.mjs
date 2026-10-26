// PR #84 Independent Re-QA, part DF: reproduce the original QA failures on c049cbc and show the fixed behaviour on
// 5562e74 with identical inputs (library level, no database writes). QA-authored.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const OUT = process.env.QA_OUT, NEW = process.env.QA_APP_ROOT, OLD = process.env.QA_OLD_ROOT;
const load = (root) => {
  const r = createRequire(path.join(root, "packages/agent-core/package.json"));
  return { AC: r(path.join(root, "packages/agent-core/dist/index.js")), SDK: r("@editagent/tool-sdk") };
};
const versions = { old: load(OLD), fixed: load(NEW) };
const RESULTS = path.join(OUT, "qa84-results.json");
const doc = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : { results: [] };
const record = (id, title, expected, pass, actual) => {
  doc.results.push({ id, title, status: pass ? "PASS" : "FAIL", expected, actual, ms: 0, mode: "differential-old-vs-fixed" });
  writeFileSync(RESULTS, JSON.stringify(doc, null, 2));
  console.log(`[QA84R] ${id} ${pass ? "PASS" : "FAIL"} ${title}`);
};
const code = (f) => { try { f(); return "ACCEPTED"; } catch (e) { return e?.code ?? e?.constructor?.name; } };
const sha = (b) => createHash("sha256").update(b).digest("hex");

// F1: constructor-level policy acceptance of an asset/render pin (the original PG08 exposure required this acceptance).
const f1 = {};
for (const [label, { AC, SDK }] of Object.entries(versions)) {
  const reg = SDK.registerEditingTools(new SDK.ToolRegistry(), { authorize: async () => undefined, timeline: async () => { throw new Error("unused"); } });
  const pins = [{ name: "editing.trim-video", version: "1.0.0" }, { name: "editing.split-video", version: "1.0.0" }];
  f1[label] = {
    timelinePins: code(() => new AC.PostgresAgentContextSource({}, reg, { pins, creativity: ["balanced"] })),
    withCropVideo: code(() => new AC.PostgresAgentContextSource({}, reg, { pins: [...pins, { name: "editing.crop-video", version: "1.0.0" }], creativity: ["balanced"] })),
    withNormalizeAudio: code(() => new AC.PostgresAgentContextSource({}, reg, { pins: [{ name: "editing.normalize-audio", version: "1.0.0" }], creativity: ["balanced"] })),
  };
}
record("DF01", "F1 reproduction vs fix: c049cbc accepts an asset/render pin into the context policy (root of the PG08 exposure); 5562e74 refuses it while still accepting trim/split", "old: crop/normalize pins ACCEPTED; fixed: invalid_policy for both, trim+split ACCEPTED on both",
  f1.old.withCropVideo === "ACCEPTED" && f1.old.withNormalizeAudio === "ACCEPTED" && f1.fixed.withCropVideo === "invalid_policy" && f1.fixed.withNormalizeAudio === "invalid_policy" && f1.fixed.timelinePins === "ACCEPTED" && f1.old.timelinePins === "ACCEPTED", f1);

// F2: identical malformed inputs against both builds.
const meta = { schemaVersion: "1.0.0", id: "qa-prompt", version: "1.0.0", purpose: "QA fixture.", variables: { note: { type: "string", required: true, trust: "data" } } };
const good = Buffer.from(`---\n${JSON.stringify(meta)}\n---\nUse {{note}} as data. عربي 😀`, "utf8");
const bad = Buffer.concat([good, Buffer.from([0xc3, 0x28, 0xff, 0xfe])]);
const f2 = {};
for (const [label, { AC }] of Object.entries(versions)) {
  const dir = mkdtempSync(path.join(tmpdir(), `qa84r-df-${label}-`));
  writeFileSync(path.join(dir, "qa-prompt@1.0.0.prompt"), bad);
  let invalidFile, hashEqualsBytes = null;
  try { const t = AC.loadPromptDirectory(dir).load("qa-prompt", "1.0.0"); invalidFile = "ACCEPTED"; hashEqualsBytes = t.templateHash === sha(bad); } catch (e) { invalidFile = e.code; }
  rmSync(dir, { recursive: true, force: true });
  const hi = code(() => new AC.PromptTemplate(good.toString("utf8") + " \ud800")), lo = code(() => new AC.PromptTemplate(good.toString("utf8") + " \udc00"));
  let collide = null;
  if (hi === "ACCEPTED" && lo === "ACCEPTED") collide = new AC.PromptTemplate(good.toString("utf8") + " \ud800").templateHash === new AC.PromptTemplate(good.toString("utf8") + " \udc00").templateHash;
  const goodDir = mkdtempSync(path.join(tmpdir(), `qa84r-dfok-${label}-`)); writeFileSync(path.join(goodDir, "qa-prompt@1.0.0.prompt"), good);
  const validHash = AC.loadPromptDirectory(goodDir).load("qa-prompt", "1.0.0").templateHash === sha(good); rmSync(goodDir, { recursive: true, force: true });
  f2[label] = { invalidUtf8File: invalidFile, invalidFileHashEqualsBytes: hashEqualsBytes, loneSurrogates: [hi, lo], differentLoneSurrogatesSameHash: collide, validBilingualHashEqualsBytes: validHash };
}
record("DF02", "F2 reproduction vs fix: c049cbc accepts malformed UTF-8 with a non-byte hash and collides lone surrogates; 5562e74 rejects both and keeps exact-byte hashing for valid bilingual prompts", "old: invalid file ACCEPTED with hash != bytes, surrogates collide; fixed: bundle_unavailable, invalid_template x2, valid bilingual hash = bytes",
  f2.old.invalidUtf8File === "ACCEPTED" && f2.old.invalidFileHashEqualsBytes === false && f2.old.differentLoneSurrogatesSameHash === true &&
  f2.fixed.invalidUtf8File === "bundle_unavailable" && f2.fixed.loneSurrogates.every((c) => c === "invalid_template") && f2.fixed.validBilingualHashEqualsBytes === true, f2);
process.exit(0);
