// Merges "QA88_RESULTS <json>" lines from provider runs (host + packaged image) into one results file. Missing -> no rows (gate: MISSING).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const [out, ...inputs] = process.argv.slice(2);
const results = [];
for (const f of inputs) {
  if (!existsSync(f)) continue;
  const line = readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("QA88_RESULTS "));
  if (line) results.push(...JSON.parse(line.slice("QA88_RESULTS ".length)));
}
writeFileSync(out, JSON.stringify({ appSha: process.env.QA_APP_SHA, generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`collected ${results.length} provider probe results`);
