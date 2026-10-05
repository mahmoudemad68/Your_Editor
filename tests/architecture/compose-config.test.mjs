import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

const defaultServices = [
  "agent-worker",
  "ai-worker",
  "api",
  "media-worker",
  "postgres",
  "redis",
  "render-worker",
  "seaweed-filer",
  "seaweed-master",
  "seaweed-s3",
  "seaweed-volume",
  "web",
];

function compose(args) {
  return execFileSync("docker", ["compose", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function serviceNames(args) {
  return compose([...args, "config", "--services"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

test("committed Compose config is valid for the default stack and the gpu profile", () => {
  const source = readFileSync(path.join(root, "compose.yaml"), "utf8");
  assert.equal(source.includes("gpus:"), false);
  assert.match(source, /driver: nvidia/);
  assert.match(source, /count: all/);
  assert.match(source, /capabilities: \[gpu\]/);
  assert.match(source, /profiles: \["gpu"\]/);

  const defaultConfig = compose(["config"]);
  const gpuConfig = compose(["--profile", "gpu", "config"]);
  assert.deepEqual(serviceNames([]), defaultServices);
  assert.deepEqual(
    serviceNames(["--profile", "gpu"]),
    [...defaultServices, "ai-worker-gpu"].sort(),
  );

  assert.equal(defaultConfig.includes("ai-worker-gpu"), false);
  assert.equal(defaultConfig.includes("cuda"), false);
  assert.match(defaultConfig, /EDITAGENT_AI_DEVICE: cpu/);

  const gpuService =
    gpuConfig.match(/\n {2}ai-worker-gpu:\n(?<body>[\s\S]*?)(?=\n {2}[^\s])/)?.groups?.body ?? "";
  assert.match(gpuService, /driver: nvidia/);
  assert.match(gpuService, /capabilities:\n\s+- gpu/);
  assert.match(gpuService, /count: (?:all|-1)/);
  assert.match(gpuService, /EDITAGENT_AI_DEVICE: cuda/);
  assert.equal(gpuService.includes("EDITAGENT_AI_DEVICE: cpu"), false);
});
