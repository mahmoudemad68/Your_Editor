/** Shared result records for the independent QA harness. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function results() {
  return [];
}

export async function check(rows, id, title, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    const status = value?.status;
    if (!["PASS", "FAIL", "ERROR", "NOT_RUN", "OBSERVED", "NOT_VERIFIED"].includes(status))
      throw new Error(`Probe ${id} returned ${status}`);
    rows.push({
      id,
      title,
      status,
      expected: value.expected ?? "",
      actual: value.actual ?? null,
      ...(value.exclusion ? { exclusion: value.exclusion } : {}),
      ms: Date.now() - started,
    });
    console.log(`[QA93] ${id} ${status} ${title}`);
  } catch (error) {
    rows.push({
      id,
      title,
      status: "ERROR",
      expected: "",
      actual: String(error?.stack ?? error).slice(0, 900),
      ms: Date.now() - started,
    });
    console.log(`[QA93] ${id} ERROR ${title}`);
  }
}

export function writeReport(file, rows, extra = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ generatedAt: new Date().toISOString(), ...extra, results: rows }, null, 2),
  );
}
