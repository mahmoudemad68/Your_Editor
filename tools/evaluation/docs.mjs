import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import prettier from "prettier";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function metricsMarkdown(registry) {
  const fields = [
    ["Definition", "definition"],
    ["Formula", "formula"],
    ["Unit", "unit"],
    ["Direction", "direction"],
    ["Aggregation", "aggregation"],
    ["Edge cases", "edgeCases"],
    ["Normalization / protocol", "normalization"],
    ["First reporting story", "firstReportingStory"],
    ["Roadmap rationale", "reportingRationale"],
  ];
  let text = `# Evaluation metrics\n\n<!-- Generated from metrics.json by tools/evaluation/docs.mjs. -->\n\nSchema ${registry.schemaVersion}; dataset ${registry.datasetVersion}. Machine outputs use ratios, milliseconds, seconds or typed counts exactly as specified below. A missing gold input produces no score, never an inferred reference.\n\n`;
  for (const metric of registry.metrics) {
    text += `## ${metric.name} (\`${metric.id}\`)\n\n`;
    for (const [label, key] of fields) text += `**${label}:** ${metric[key]}\n\n`;
    text += `**Required inputs:** ${metric.requiredInputs.join("; ")}.\n\n`;
  }
  return prettier.format(text, { parser: "markdown", printWidth: 100 });
}
export async function generateDocs(check, root = repositoryRoot) {
  const registry = JSON.parse(
    await readFile(resolve(root, "docs/evaluation/metrics.json"), "utf8"),
  );
  const output = await metricsMarkdown(registry);
  const path = resolve(root, "docs/evaluation/METRICS.md");
  if (check) {
    if ((await readFile(path, "utf8")) !== output)
      throw new Error("Metric documentation differs; run pnpm evaluation:docs");
  } else await writeFile(path, output);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateDocs(process.argv.includes("--check"));
