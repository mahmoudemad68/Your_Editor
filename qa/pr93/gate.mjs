/** Fail-closed aggregate. PASS is the only silent success.
 * OBSERVED is accepted only when the id is listed and carries a written exclusion.
 * FAIL, ERROR, NOT_RUN, NOT_VERIFIED, missing rows, and unlisted OBSERVED fail the process.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const allow = new Set(
  (process.argv[3] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (!file) {
  console.error("usage: gate.mjs <results.json> [allowed-observed-ids]");
  process.exit(2);
}
const doc = JSON.parse(readFileSync(file, "utf8"));
const rows = Array.isArray(doc.results) ? doc.results : null;
const problems = [];
if (!rows || rows.length === 0) problems.push("NO_RESULTS");
const seen = new Set();
for (const row of rows ?? []) {
  if (!row || typeof row.id !== "string" || seen.has(row.id)) {
    problems.push(`BAD_ROW ${row?.id ?? ""}`);
    continue;
  }
  seen.add(row.id);
  if (row.status === "PASS") continue;
  if (
    row.status === "OBSERVED" &&
    allow.has(row.id) &&
    typeof row.exclusion === "string" &&
    row.exclusion.length > 40
  )
    continue;
  problems.push(`${row.id} ${row.status}`);
}
const counts = {};
for (const row of rows ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1;
console.log(JSON.stringify({ file, counts, problems }));
if (problems.length) process.exit(1);
