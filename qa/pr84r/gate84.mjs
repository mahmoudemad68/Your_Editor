// QA fail-closed gate (PR #84). Usage: node gate77.mjs <results.json> <required ids, comma/range list> [observed ids] [notVerifiable ids]
// Exits 1 if any required id is missing or is FAIL/ERROR/NOT_RUN, or an id outside the observed list is OBSERVED.
// NOT_VERIFIED is never PASS: it is only tolerated for listed ids and is reported as DISPOSITION_REQUIRED.
import { readFileSync, appendFileSync } from "node:fs";

const [file, requiredSpec, observedSpec = "", nvSpec = ""] = process.argv.slice(2);
const expand = (spec) => spec.split(",").filter(Boolean).flatMap((p) => {
  const m = /^([A-Z]+)(\d+)-(\d+)$/.exec(p.trim());
  return m ? Array.from({ length: Number(m[3]) - Number(m[2]) + 1 }, (_, i) => `${m[1]}${String(Number(m[2]) + i).padStart(m[2].length, "0")}`) : [p.trim()];
});
const required = expand(requiredSpec), observed = new Set(expand(observedSpec)), notVerifiable = new Set(expand(nvSpec));
let results = [];
try { results = JSON.parse(readFileSync(file, "utf8")).results; } catch { console.log(`GATE: results file unreadable: ${file}`); process.exit(1); }
const byId = new Map();
for (const r of results) byId.set(r.id, r); // last occurrence wins (a probe runs once per job)
const counts = {}, violations = [], disposition = [];
for (const id of required) {
  const r = byId.get(id);
  const s = r ? r.status : "MISSING";
  counts[s] = (counts[s] ?? 0) + 1;
  if (s === "PASS") continue;
  if (s === "OBSERVED" && observed.has(id)) continue;
  if (s === "NOT_VERIFIED" && notVerifiable.has(id)) { disposition.push(`${id}: ${JSON.stringify(r.actual?.reason ?? "")}`); continue; }
  violations.push(`${id}=${s}`);
}
const extra = [...byId.keys()].filter((id) => !required.includes(id));
const summary = [`GATE ${file}`, `required=${required.length} counts=${JSON.stringify(counts)}`, `violations=${violations.join(" ") || "none"}`,
  `disposition_required=${disposition.join(" | ") || "none"}`, `unlisted_ids=${extra.join(",") || "none"}`];
console.log(summary.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + summary.join("\n") + "\n```\n");
process.exit(violations.length || extra.length ? 1 : 0);
