import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function benchmarkRoot() {
  return root;
}

export function loadSpec() {
  return JSON.parse(readFileSync(path.join(root, "spec.json"), "utf8"));
}

export function loadCaptions() {
  return JSON.parse(readFileSync(path.join(root, "captions.json"), "utf8"));
}
