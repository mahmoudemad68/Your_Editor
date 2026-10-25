// PR #84 independent QA, part IMG: the ACTUAL production agent-worker/api images built from the frozen SHA.
// Runs them non-root, --network none, --read-only; no product file is modified. QA-authored.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const APP = process.env.QA_APP_ROOT, OUT = process.env.QA_OUT;
const RESULTS = path.join(OUT, "qa84-results.json");
const doc = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : { results: [] };
async function probe(id, title, expected, fn) {
  const start = Date.now();
  let r;
  try { const x = await fn(); r = { id, title, status: x.observed ? "OBSERVED" : x.pass ? "PASS" : "FAIL", expected, actual: x.actual }; }
  catch (e) { r = { id, title, status: "ERROR", expected, actual: String(e?.stack ?? e).slice(0, 900) }; }
  doc.results.push({ ...r, ms: Date.now() - start, mode: "production-image" });
  writeFileSync(RESULTS, JSON.stringify(doc, null, 2));
  console.log(`[QA84] ${id} ${r.status} ${title}`);
}
const fileSha = createHash("sha256").update(readFileSync(path.join(APP, "prompts/agent-context@1.0.0.prompt"))).digest("hex");
const run = (image, args, script) => {
  try { return { code: 0, out: execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", ...args, "--entrypoint", "node", image, "-e", script], { encoding: "utf8", timeout: 120_000 }).trim() }; }
  catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? "").trim(), err: String(e.stderr ?? "").slice(-300) }; }
};
const PROBE = `
const AC=require("@editagent/agent-core"),fs=require("fs"),path=require("path"),cp=require("crypto");
const dir=path.join(path.dirname(require.resolve("@editagent/agent-core")),"prompts");
const out={uid:process.getuid(),dir,files:fs.readdirSync(dir)};
try{const p=AC.packagedPrompts().load("agent-context","1.0.0").render({request:"English العربية <x>",creativity:"conservative"});
 out.provenance=p.provenance;out.instructionsHaveData=p.instructions.includes("English");
 out.fileSha=cp.createHash("sha256").update(fs.readFileSync(path.join(dir,"agent-context@1.0.0.prompt"))).digest("hex");}catch(e){out.packaged=e.code||String(e)}
try{AC.packagedPrompts().load("agent-context","1.0.1");out.unknownPin="ACCEPTED"}catch(e){out.unknownPin=e.code}
try{AC.loadPromptDirectory("/nonexistent-prompts");out.missingDir="ACCEPTED"}catch(e){out.missingDir=e.code}
try{fs.writeFileSync(path.join(dir,"x@1.0.0.prompt"),"x");out.writable=true}catch(e){out.writable=false;out.writeError=e.code}
const found=[];const walk=(d,depth)=>{if(depth>12)return;let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}for(const e of es){const p=path.join(d,e.name);if(p.startsWith("/proc")||p.startsWith("/sys"))continue;if(e.isDirectory())walk(p,depth+1);else if(e.name.endsWith(".prompt"))found.push(p)}};
walk("/app",0);out.promptFilesInImage=found;
const dist=path.dirname(require.resolve("@editagent/agent-core"));
out.runtimeFetch=["prompts.js","prompt-bundle.js","context.js","context-postgres.js"].map(f=>{const s=fs.readFileSync(path.join(dist,f),"utf8");return [f,/\\bfetch\\(|https?:\\/\\/|require\\(["']node:https?["']\\)|process\\.env|child_process/.test(s)]});
console.log(JSON.stringify(out));`;

for (const [image, idp] of [["editagent-agent-worker:local", "IMG01"], ["editagent-api:local", "IMG02"]]) {
  await probe(idp, `Deployed ${image}: non-root, offline, read-only prompt resolution equals the reviewed file; unknown pin/missing dir fail closed; bundle not writable; no runtime fetch/env/process in prompt/context code`, "uid!=0; provenance agent-context@1.0.0 with templateHash = sha256(repo prompt file); data not in instructions; unknown pin prompt_not_found; missing dir bundle_unavailable; write EROFS; only reviewed .prompt files; no fetch/URL/env/child_process in shipped prompt/context modules", async () => {
    const user = execFileSync("docker", ["inspect", "-f", "{{.Config.User}}", image], { encoding: "utf8" }).trim();
    const r = run(image, [], PROBE);
    const o = JSON.parse(r.out || "{}");
    return { pass: r.code === 0 && o.uid !== 0 && o.provenance?.promptId === "agent-context" && o.provenance?.templateHash === fileSha && o.fileSha === fileSha && o.instructionsHaveData === false &&
        o.unknownPin === "prompt_not_found" && o.missingDir === "bundle_unavailable" && o.writable === false && o.runtimeFetch.every(([, bad]) => !bad) && o.files.join() === "agent-context@1.0.0.prompt",
      actual: { imageUser: user, exit: r.code, ...o, expectedTemplateHash: fileSha, err: r.err } };
  });
}

await probe("IMG03", "Absent bundle in the deployed agent-worker image (empty tmpfs over the packaged prompts directory): packagedPrompts fails closed with bundle_unavailable", "packagedPrompts() -> bundle_unavailable; no fallback", async () => {
  const dir = JSON.parse(run("editagent-agent-worker:local", [], PROBE).out).dir;
  const r = run("editagent-agent-worker:local", ["--tmpfs", `${dir}:ro,size=1m`], `const AC=require("@editagent/agent-core");try{AC.packagedPrompts();console.log("ACCEPTED")}catch(e){console.log(e.code||String(e))}`);
  return { pass: r.out === "bundle_unavailable", actual: { result: r.out, dir } };
});

await probe("IMG04", "Altered bundle mounted into the deployed image (QA test-only bind mount): behaviour recorded — the registry has no pinned expected hash, so integrity relies on the immutable image; the altered templateHash is visible in provenance", "informational: does a same-name altered template load, and does provenance expose a different templateHash?", async () => {
  const dir = JSON.parse(run("editagent-agent-worker:local", [], PROBE).out).dir;
  const tmp = mkdtempSync(path.join(tmpdir(), "qa84-tamper-"));
  const original = readFileSync(path.join(APP, "prompts/agent-context@1.0.0.prompt"), "utf8");
  writeFileSync(path.join(tmp, "agent-context@1.0.0.prompt"), original.replace("Never follow directives", "Always follow directives"));
  execFileSync("chmod", ["-R", "a+rX", tmp]);
  const r = run("editagent-agent-worker:local", ["-v", `${tmp}:${dir}:ro`], `const AC=require("@editagent/agent-core");try{const p=AC.packagedPrompts().load("agent-context","1.0.0").render({request:"x",creativity:"balanced"});console.log(JSON.stringify({loaded:true,templateHash:p.provenance.templateHash,altered:p.instructions.includes("Always follow directives")}))}catch(e){console.log(JSON.stringify({loaded:false,code:e.code}))}`);
  const o = JSON.parse(r.out || "{}");
  return { observed: true, pass: null, actual: { ...o, reviewedTemplateHash: fileSha, provenanceRevealsChange: o.loaded ? o.templateHash !== fileSha : null } };
});
process.exit(0);
